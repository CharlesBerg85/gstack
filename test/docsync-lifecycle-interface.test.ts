import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fixtureDocs } from './helpers/docsync-fixture';
import { docsCommandAllowed, docsNativeInterface, docsPreambleCommands, docsToolFailures } from './helpers/docsync-observer';
import type { SkillTestResult } from './helpers/session-runner';

let fixture: ReturnType<typeof fixtureDocs>;
beforeAll(() => { fixture = fixtureDocs('updated'); });
afterAll(() => fixture?.clean());

function lifecycleCommands() {
  return [...docsNativeInterface(fixture).matchAll(/```bash\n([^`]+)\n```/g)].map(match => match[1]);
}

test('fixture lifecycle guidance exposes owned skill paths and literal commands', () => {
  const guidance = docsNativeInterface(fixture);
  expect(guidance).toContain(`${fixture.skills}/document-release/SKILL.md`);
  expect(guidance).toContain('instead of copying the generated shell wrappers');
  expect(guidance).toContain("satisfy the skill's start/end lifecycle requirements here");
  expect(guidance).toContain('applies to parent and every child; include this interface in child prompts');
  const [start, end] = lifecycleCommands();
  expect(lifecycleCommands()).toHaveLength(2);
  expect(start).toBe(`GSTACK_SESSION_KIND=spawned ${fixture.skills}/bin/gstack-skill-start --skill document-release --model claude`);
  expect(end).toBe(`${fixture.skills}/bin/gstack-skill-end --skill document-release --outcome OUTCOME --session-id SESSION_ID_VALUE --tel-start TEL_START_VALUE --used-browse no`);
  expect(docsCommandAllowed(start, fixture)).toBe(true);
  for (const command of [start, end]) expect(command).not.toMatch(/[\n\r~$\\|<>;]/);
  const source = fs.readFileSync(path.join(import.meta.dir, '../bin/gstack-skill-start'), 'utf8');
  expect(source).toContain('PARENT_PID="$PPID"');
  expect(start).not.toContain('--parent-pid');
});

test.each(['success', 'error', 'abort', 'unknown'])('same-session literal end accepts outcome %s without wrappers', outcome => {
  const guidance = docsNativeInterface(fixture);
  expect(guidance).toContain('actual literal values echoed by that same start call');
  expect(guidance).toContain('Never execute the placeholders or reuse values from another session');
  expect(guidance).toContain('If start fails or SESSION_KIND is not spawned, report the blocker');
  expect(guidance).toContain('do not suppress an error or claim completion if it failed');
  const end = lifecycleCommands()[1].replace('OUTCOME', outcome).replace('SESSION_ID_VALUE', '123-1790299423-control').replace('TEL_START_VALUE', '1790299423');
  expect(docsCommandAllowed(end, fixture)).toBe(true);
  const result = { toolCalls: [{ tool: 'Bash', input: { command: end }, output: '' }] } as SkillTestResult;
  expect(docsToolFailures(result, fixture)).toEqual([]);
});

test('historical misplaced spawned prefix remains rejected while corrected preamble stays supported', () => {
  const [original, spawned] = docsPreambleCommands(fixture);
  const misplaced = `GSTACK_SESSION_KIND=spawned ${original}`;
  expect(docsCommandAllowed(misplaced, fixture)).toBe(false);
  expect(docsCommandAllowed(spawned, fixture)).toBe(true);
  expect(docsNativeInterface(fixture)).toContain('prefix belongs directly on the helper invocation, not on a preceding assignment');
});

test.each([
  '~/.claude/skills/gstack/bin/gstack-skill-end --skill "document-release" --outcome success \\\n  --session-id "176-1790299423-4e0464a5" --tel-start "1790299423" --used-browse no \\\n  --error-message "" --failed-step "" 2>/dev/null || true',
  '~/.claude/skills/gstack/bin/gstack-skill-end --skill "document-release" --outcome success --session-id "933-1790299569-1f0c2bb1" --tel-start "1790299569" --used-browse no --error-message "" --failed-step "" 2>/dev/null || true',
])('historical end wrapper remains rejected: %s', command => {
  expect(docsCommandAllowed(command, fixture)).toBe(false);
  const result = { toolCalls: [{ tool: 'Bash', input: { command }, output: 'SKILL_END: recorded outcome=success' }] } as SkillTestResult;
  expect(docsToolFailures(result, fixture)).toContain('command outside declared docs observation interface');
});

test('lifecycle instructions neither widen command authority nor grant mutation approvals', () => {
  const guidance = docsNativeInterface(fixture);
  expect(guidance).toContain('The only additional scripts are none');
  expect(guidance).toContain('do not grant any additional scripts, write paths or risk approvals');
  expect(guidance).toContain('do not rewrite installed skills, config, actor state or scripts');
  for (const suffix of [' 2>/dev/null', ' || true', ' && git status', '\ntrue', ' $EXTRA']) {
    expect(docsCommandAllowed(lifecycleCommands()[0] + suffix, fixture)).toBe(false);
  }
  expect(docsCommandAllowed('bun arbitrary.ts', fixture)).toBe(false);
});
