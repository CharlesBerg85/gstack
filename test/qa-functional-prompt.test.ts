import { expect, test } from 'bun:test';
import { qaFunctionalPrompt, QA_FUNCTIONAL_CASES } from './helpers/qa-functional-eval';
import { qaCommandAllowed } from './helpers/qa-functional-observer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('the native launcher consumes the family-specific actor boundary', () => {
  const source = readFileSync(join(import.meta.dir, 'helpers/qa-functional-eval.ts'), 'utf8');
  expect(source).toContain('prompt: qaFunctionalPrompt(entry)');
  for (const entry of QA_FUNCTIONAL_CASES) {
    const prompt = qaFunctionalPrompt(entry);
    expect(prompt).toContain(`Read ${entry.mode}/SKILL.md`);
    expect(prompt).toContain('successful Write result before the next probe');
    expect(prompt).toContain('no shell composition, scripts or added path operands');
    expect(prompt).toContain('ONLY complete JSON actually emitted');
    expect(prompt).toContain('never a combined command list');
    expect(prompt).toContain('Put tests, raw CLI diagnostics, launch failures and timeouts in Markdown');
    expect(prompt).toContain(entry.family === 'cli'
      ? 'The generic wrapper does NOT support wait'
      : 'bun cancel.ts is a CLI-only entrypoint, not part of this fixture');
    expect(prompt).not.toContain('parseInt');
  }
});

test('declared examples respect the existing closed native grammar', () => {
  for (const command of ['pwd', 'ls', 'ls -la', 'git status --short', 'git status --porcelain',
    'git branch --show-current', 'git diff', 'git diff --stat', 'git rev-parse HEAD', 'bun --version',
    'date -u +%Y-%m-%dT%H:%M:%SZ', 'bun test', 'bun test test/contract.test.ts',
    'bun run probe -- balance', 'bun run probe -- export', 'bun run probe -- apply id 7',
    'bun run probe -- apply', 'bun cancel.ts', ...['happy', 'reject', 'duplicate', 'partial',
      'concurrent-ab', 'concurrent-ba', 'cancel', 'dependency'].map(name => `bun run probe -- ${name}`)]) {
    expect(qaCommandAllowed(command)).toBe(true);
  }
  for (const command of ['ls -la .qa-state qa-reports', 'ls -la .qa-state', 'ls -la qa-reports', 'bun run probe -- wait bad 7',
    'git rev-parse HEAD; bun --version', 'bun run probe -- happy && bun run probe -- partial']) {
    expect(qaCommandAllowed(command)).toBe(false);
  }
});

test('report-only exploration requires a completed written checkpoint before the next probe', () => {
  const section = readFileSync(join(import.meta.dir, '../qa-only/sections/exploratory.md'), 'utf8');
  const positions = ['1. First demonstrate a successful operation', '2. **Write before probing.**', '3. Run that exact probe']
    .map(marker => section.indexOf(marker));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(section).toContain('exploration-NNN.json');
  expect(section).toContain("Use the caller's report directory");
  expect(section).toContain('invocation-owned subdirectory');
  expect(section).toContain('after resolving ownership');
  expect(section).toContain('observationCommand, observed, hypothesis, nextCommand');
  expect(section).toContain('Wait for the successful Write result');
  expect(section).toContain('Bash captions, private thinking and retrospective notes do not count');
  expect(section).toContain('Link each checkpoint in the final report');
  expect(section).not.toContain('a separate assistant text message');
});

test('surface evidence checks defer to one exploratory execution sequence', () => {
  const source = readFileSync(join(import.meta.dir, '../scripts/resolvers/qa.ts'), 'utf8');
  expect(source).toContain('This loop owns execution order; surface methods supply contracts and evidence checks');
  expect(source).toContain('Do not batch probes across a checkpoint');
  expect(source).toContain('Follow the shared exploratory loop\'s order and written checkpoints');
  expect(source).toContain('Re-run the exact failing command/request from the same initial fixture state');
  expect(source).toContain('A different malformed input or a regression test is not that replay');
});

test('all public callers directly require the functional method before exploration', () => {
  for (const skill of ['qa', 'qa-only', 'review', 'ship']) {
    const file = skill === 'ship' ? 'ship/sections/review-army.md' : `${skill}/SKILL.md`;
    const source = readFileSync(join(import.meta.dir, '..', file), 'utf8');
    expect(source).toMatch(/Functional surfaces[^\n]*\n[^\n]*Read[^\n]*system-functional\.md/);
    expect(source).toContain('Browser surfaces only');
  }
});
