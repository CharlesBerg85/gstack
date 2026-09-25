import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  callerExcerpt, callerSnapshot, callerTools, createQaCallerFixture, qaCallerInstructions,
  QA_CALLER_CASES, QA_CALLER_TEST_MS,
  qaCallerSessionOptions, qaCallerCommandAllowed, readCallerReceipt, retainQaCallerEvidence, runQaCaller, validateCallerEvidence,
  type CallerProbe, type CallerReceipt, type QaCallerFixture,
} from './helpers/qa-callers-fixture';
import type { runSkillTest, SkillTestResult } from './helpers/session-runner';
import { SESSION_DRAIN_GRACE_MS } from './helpers/session-runner';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { readQACheckpointFiles } from './helpers/qa-checkpoint-evidence';
import { generateQAExploratory, generateQAReview, generateQAReviewPreflight } from '../scripts/resolvers/qa';
import { HOST_PATHS } from '../scripts/resolvers/types';

function nativeCall(id: string, name: string, input: object, output: string, parent: string | null = null, failed = false) {
  return [
    { type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }] } },
    { type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: failed }] } },
  ];
}

const snapshot = callerSnapshot({ 'scale.ts': 'return n+n', 'README.md': 'double an integer' });
const happy: CallerProbe = { id: 'probe-happy', charter: 'happy', input: '3', snapshot, status: 'pass', stdout: '6\n', stderr: '', exit: 0 };
const adverse: CallerProbe = { id: 'probe-invalid', charter: 'adverse', input: 'no', snapshot, status: 'pass', stdout: '', stderr: 'integer required: 0..9\n', exit: 2 };
const diffPreface = 'DIFF_BASE=$(git merge-base origin/main HEAD) && ';
const capturedNativeDiffs = [
  `${diffPreface}git diff --name-status "$DIFF_BASE"`,
  `${diffPreface}git diff "$DIFF_BASE" -- . ':(exclude)*test*' ':(exclude)*fixture*' ':(exclude)*.spec.*'`,
  `${diffPreface}git diff --stat "$DIFF_BASE" -- '*test*' '*fixture*' '*.spec.*'`,
];
const generatedReviewRecord = (bin: string, token: string) => `${bin} '{"skill":"adversarial-review","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","status":"clean","source":"in-host","host":"claude","outside_provider":"codex","outside_status":"unavailable","phase":"adversarial","tier":"always","gate":"informational","commit":"'"$(git rev-parse --short HEAD)"'","completed":true,"converged":true}' --finish ${token}`;
const checkpointRoots: string[] = [];
afterEach(() => { for (const root of checkpointRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function checkpointSequence(probes: CallerProbe[], reportRoot: string) {
  const transcript: unknown[] = [];
  const files: Record<string, string> = {};
  for (const [index, probe] of probes.entries()) {
    if (index) {
      const previous = probes[index - 1];
      const name = `exploration-${String(index).padStart(3, '0')}.json`;
      const content = JSON.stringify({ observationCommand: `bun scripts/probe.ts ${previous.input}`, observed: previous, hypothesis: 'The next distinct input should follow the documented CLI contract.', nextCommand: `bun scripts/probe.ts ${probe.input}` });
      files[name] = content;
      fs.writeFileSync(path.join(reportRoot, name), content, { mode: 0o600 });
      transcript.push(...nativeCall(`checkpoint-${index}`, 'Write', { file_path: path.join(reportRoot, name), content }, 'File created successfully'));
    }
    transcript.push(...nativeCall(probe.id, 'Bash', { command: `bun scripts/probe.ts ${probe.input}` }, JSON.stringify(probe), null, probe.exit !== 0));
  }
  return { transcript, checkpointFiles: files, reportMarkdown: Object.keys(files).map(name => `[Checkpoint](${name})`).join('\n') };
}

function evidence() {
  const probes = [happy, adverse].map(probe => ({ ...probe }));
  const reportRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qc-notes-'));
  checkpointRoots.push(reportRoot);
  const checkpoints = checkpointSequence(probes, reportRoot);
  return {
    caller: 'review' as const,
    result: { exitReason: 'success', transcript: [
      ...nativeCall('parent', 'Read', { file_path: '/fixture/caller-review.md' }, 'parent workflow'),
      ...nativeCall('shared', 'Read', { file_path: '/runtime/qa/sections/exploratory.md' }, 'shared method'),
      ...nativeCall('functional', 'Read', { file_path: '/runtime/qa/sections/system-functional.md' }, 'functional method'),
      ...checkpoints.transcript,
    ] as unknown[] },
    probes,
    receipt: { status: 'pass', probes: probes.map(probe => probe.id), remaining: [] } as CallerReceipt,
    currentSnapshot: snapshot,
    requiredCharters: ['happy', 'adverse'],
    mutations: [] as string[],
    observerComplete: true,
    reportRoot,
    checkpointFiles: checkpoints.checkpointFiles,
    reportMarkdown: checkpoints.reportMarkdown,
  };
}

function rebuildCheckpoints(observed: ReturnType<typeof evidence>) {
  const checkpoints = checkpointSequence(observed.probes, observed.reportRoot);
  observed.result.transcript = observed.result.transcript.slice(0, 6).concat(checkpoints.transcript);
  observed.checkpointFiles = checkpoints.checkpointFiles;
  observed.reportMarkdown = checkpoints.reportMarkdown;
}

describe('caller native-event observer controls', () => {
  test('a full parent section Read cannot substitute for actual method Reads', () => {
    const observed = evidence();
    observed.result.transcript.splice(0, 6, ...nativeCall('parent', 'Read', { file_path: '/fixture/caller-review.md' }, qaCallerInstructions('review')));
    const errors = validateCallerEvidence(observed);
    expect(errors).toEqual(['missing executed resource read: /qa/sections/exploratory.md', 'missing executed resource read: /qa/sections/system-functional.md']);
  });

  test('late-input synthetic replay keeps stale adverse coverage and overall remaining separate from passing happy proof', () => {
    const observed = evidence();
    const current = { ...happy, id: 'current-happy', snapshot: 'changed-fixture-inputs' };
    observed.probes.push(current);
    observed.currentSnapshot = current.snapshot;
    observed.receipt.probes = [current.id, adverse.id];
    observed.receipt.remaining = ['rerun rejection against changed fixture inputs'];
    rebuildCheckpoints(observed);
    expect(validateCallerEvidence(observed)).toEqual(['false green for charter: adverse', 'blocked, failing or incomplete coverage reported green']);
    observed.receipt.remaining = [];
    expect(validateCallerEvidence(observed)).toEqual(['missing current charter: adverse', 'false green for charter: adverse']);
    const freshAdverse = { ...adverse, id: 'current-adverse', snapshot: current.snapshot };
    observed.probes.push(freshAdverse);
    observed.receipt.probes = [current.id, freshAdverse.id];
    rebuildCheckpoints(observed);
    expect(validateCallerEvidence(observed)).toEqual([]);
    observed.result.transcript.splice(-4, 2);
    expect(validateCallerEvidence(observed).some(error => error.includes('checkpoint'))).toBe(true);
  });

  test('a defect replay note must copy the immediately prior result, not the older failing receipt', () => {
    const observed = evidence();
    observed.probes[0].status = 'fail';
    observed.probes.push({ ...observed.probes[0], id: 'defect-replay' });
    observed.receipt.status = 'fail';
    rebuildCheckpoints(observed);
    expect(validateCallerEvidence(observed)).toEqual([]);
    const file = path.join(observed.reportRoot, 'exploration-002.json');
    const note = JSON.parse(observed.checkpointFiles['exploration-002.json']);
    note.observationCommand = 'bun scripts/probe.ts 3';
    note.observed = observed.probes[0];
    const content = JSON.stringify(note);
    fs.writeFileSync(file, content, { mode: 0o600 });
    observed.checkpointFiles['exploration-002.json'] = content;
    for (const event of observed.result.transcript as any[]) for (const block of event.message.content) {
      if (block.type === 'tool_use' && block.name === 'Write' && block.input.file_path === file) block.input.content = content;
    }
    expect(validateCallerEvidence(observed)).toContain('QA checkpoint: Missing unique completed checkpoint before probe: bun scripts/probe.ts 3');
  });
  test('caller acceptance requires causal persisted checkpoints for every subsequent probe', () => {
    const observed = evidence();
    expect(validateCallerEvidence(observed)).toEqual([]);
    const original = observed.result.transcript.slice();
    observed.result.transcript.splice(8, 2);
    expect(validateCallerEvidence(observed).some(error => /checkpoint/i.test(error))).toBe(true);
    observed.result.transcript = original;
    const result = observed.result.transcript[9] as any;
    result.message.content[0].is_error = true;
    expect(validateCallerEvidence(observed).some(error => /checkpoint/i.test(error))).toBe(true);
    result.message.content[0].is_error = false;
    observed.reportMarkdown = 'No links';
    expect(validateCallerEvidence(observed).some(error => /checkpoint/i.test(error))).toBe(true);
  });

  test('changed-input rechecks need a fresh checkpoint and wrong fixture UUID stays forbidden', () => {
    const observed = evidence();
    const fresh = { ...happy, id: 'fresh-probe', snapshot: 'changed-input' };
    observed.probes.push(fresh);
    observed.result.transcript.push(...nativeCall(fresh.id, 'Bash', { command: 'bun scripts/probe.ts 3' }, JSON.stringify(fresh)));
    expect(validateCallerEvidence(observed).some(error => /checkpoint/i.test(error))).toBe(true);
    rebuildCheckpoints(observed);
    expect(validateCallerEvidence(observed)).toEqual([]);
    const attempted = path.join(observed.reportRoot + '-mistyped-uuid', 'exploration-003.json');
    observed.result.transcript.push(...nativeCall('wrong-path', 'Write', { file_path: attempted, content: '{}' }, 'not authorized', null, true));
    expect(validateCallerEvidence({ ...observed, fixtureRoot: observed.reportRoot }).some(error => /write outside/.test(error))).toBe(true);
  });
  test('literal directory operands and installed bookkeeping substitutions are closed classes', () => {
    for (const command of ['ls reports', 'ls -la -- "reports"', "ls -- 'space name' reports", "ls -- 'git push; $(touch forged)'", generatedReviewRecord('/runtime/bin/gstack-review-log', 'native-token')]) {
      expect(qaCallerCommandAllowed(command), command).toBe(true);
      const observed = evidence();
      observed.result.transcript.push(...nativeCall('inventory', 'Bash', { command }, 'native output'));
      expect(validateCallerEvidence(observed)).toEqual([]);
    }
    for (const command of ['ls $HOME', 'ls *', 'ls "$(touch forged)"', 'ls reports > forged', 'ls reports; touch forged', 'ls --format=long reports',
      generatedReviewRecord('/runtime/bin/gstack-review-log', 'native-token').replace('date -u +%Y-%m-%dT%H:%M:%SZ', 'date -u +%Y; touch forged'),
      generatedReviewRecord('/runtime/bin/gstack-review-log', 'native-token').replace('"timestamp":', '"other":'),
      generatedReviewRecord('/runtime/bin/gstack-review-log', 'native-token').replace('git rev-parse --short HEAD', 'git -c core.hooksPath=forged rev-parse --short HEAD'),
      generatedReviewRecord('/runtime/bin/gstack-review-log', 'native-token') + '; touch forged']) {
      expect(qaCallerCommandAllowed(command), command).toBe(false);
      const observed = evidence();
      observed.result.transcript.push(...nativeCall('rejected', 'Bash', { command }, 'not authorized', null, true));
      expect(validateCallerEvidence(observed)).toContain('command outside declared caller observation interface');
    }
  });
  test('credits paired commands and real rejection-as-designed, not final prose', () => {
    const observed = evidence();
    observed.result.transcript.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'Nothing was run. Everything is green.' }] } });
    expect(validateCallerEvidence(observed)).toEqual([]);
  });

  test('unexecuted promises, echoed receipt ids and empty captures earn no credit', () => {
    const absent = evidence();
    absent.result.transcript = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Read exploratory.md and tested happy plus invalid paths. All pass.' }] } }];
    expect(validateCallerEvidence(absent).length).toBeGreaterThan(0);
    const echo = evidence();
    echo.result.transcript = echo.result.transcript.slice(0, 6).concat(nativeCall('echo', 'Bash', { command: "echo 'bun scripts/probe.ts 3; probe-happy probe-invalid'" }, JSON.stringify(happy) + '\n' + JSON.stringify(adverse)));
    expect(validateCallerEvidence(echo).filter(error => error.includes('missing native command'))).toHaveLength(2);
  });

  test('missing, orphaned and duplicated native events fail closed', () => {
    expect(() => callerTools(nativeCall('one', 'Read', {}, 'text').slice(0, 1))).toThrow('incomplete');
    expect(() => callerTools(nativeCall('one', 'Read', {}, 'text').slice(1))).toThrow('no matching call');
    const event = nativeCall('one', 'Read', {}, 'text')[0];
    expect(() => callerTools([event, event])).toThrow('Ambiguous');
    const incomplete = evidence();
    incomplete.observerComplete = false;
    expect(validateCallerEvidence(incomplete)).toContain('observer incomplete');
  });

  test('parent-scoped reused native tool ids retain distinct child attribution', () => {
    const tools = callerTools([
      ...nativeCall('same', 'Read', { file_path: 'parent' }, 'parent-output'),
      ...nativeCall('same', 'Read', { file_path: 'child' }, 'child-output', 'agent-id'),
    ]);
    expect(tools.map(tool => [tool.parent, tool.output])).toEqual([[null, 'parent-output'], ['agent-id', 'child-output']]);
  });

  test('the bounded caller command interface rejects custom interpreters and composed probe scripts', () => {
    for (const command of ['python3 -c "import mmap"', 'bun -e "1"', 'node writer.js', 'bun scripts/probe.ts 3; echo forged', 'git diff && python3 exploit.py']) {
      expect(qaCallerCommandAllowed(command)).toBe(false);
    }
    for (const command of ['bun scripts/probe.ts 3', "bun scripts/probe.ts '3oops'", 'git diff origin/main', 'git ls-files --others --exclude-standard']) {
      expect(qaCallerCommandAllowed(command)).toBe(true);
    }
    const generated = 'DIFF_BASE=$(git merge-base origin/main HEAD)\ngit diff "$DIFF_BASE"';
    expect(qaCallerCommandAllowed(generated, [generated])).toBe(true);
    expect(qaCallerCommandAllowed(generated + '\nnode hidden.js', [generated])).toBe(false);
  });

  test('the relocated native reviewer can record its own attempt without gaining shell authority', () => {
    const bin = '/fixture/runtime/bin/gstack-review-log';
    expect(qaCallerCommandAllowed(`${bin} --start adversarial-review`)).toBe(true);
    expect(qaCallerCommandAllowed(`${bin} '{"skill":"adversarial-review","completed":true}' --finish native-token`)).toBe(true);
    expect(qaCallerCommandAllowed(`${bin} '{"skill":"adversarial-review","completed":false,"converged":false}'`)).toBe(true);
    expect(qaCallerCommandAllowed(`${bin} '{"skill":"adversarial-review","completed":true}'`)).toBe(false);
    expect(qaCallerCommandAllowed(`${bin} '{"skill":"review","completed":true}'`)).toBe(false);
    expect(qaCallerCommandAllowed(`${bin} '{"skill":"ship"}' --finish native-token`)).toBe(false);
    expect(qaCallerCommandAllowed(`${bin} --start adversarial-review; node hidden.js`)).toBe(false);
  });

  test('captured native diffs belong to a literal read-only class, not a spelling allowlist', () => {
    for (const command of [...capturedNativeDiffs, 'git merge-base origin/main HEAD', "git diff origin/main -- 'git push; $(touch forged)'"]) {
      expect(qaCallerCommandAllowed(command), command).toBe(true);
      const observed = evidence();
      observed.result.transcript.push(...nativeCall('diff', 'Bash', { command }, 'native diff output', 'native-reviewer'));
      expect(validateCallerEvidence(observed)).toEqual([]);
    }
    for (const mode of ['', ' --stat', ' --numstat', ' --name-only', ' --name-status']) {
      for (const [prefix, base] of [['', ''], ['', ' origin/main'], [diffPreface, ' "$DIFF_BASE"']]) {
        for (const selection of ['', ' -- scale.ts', " -- '*.ts' ':(exclude)*test*'", ' -- "space name.ts"']) {
          for (const arguments_ of [mode + base, base + mode]) {
            const command = `${prefix}git diff${arguments_}${selection}`;
            expect(qaCallerCommandAllowed(command), command).toBe(true);
          }
        }
      }
    }
  });

  test('diff grammar rejects write options, hidden evaluation, arbitrary bases and composition', () => {
    for (const command of [
      'git diff --output=forged origin/main', 'git diff origin/main --output forged',
      'git diff --no-index scale.ts forged', 'git diff --ext-diff origin/main',
      'git diff --textconv origin/main', 'git -c diff.external=writer diff origin/main',
      'GIT_EXTERNAL_DIFF=writer git diff origin/main', 'git --no-pager diff origin/main',
      'git diff HEAD', 'git diff origin/other', 'git diff "$DIFF_BASE"',
      'git diff --stat --numstat origin/main', 'git diff origin/main --stat --name-only',
      'git diff origin/main -- *.ts', 'git diff origin/main -- $HOME',
      'git diff origin/main -- "$(touch forged)"', 'git diff origin/main -- `touch forged`',
      'git diff origin/main -- <(touch forged)', 'git diff origin/main -- scale.ts > forged',
      'git diff origin/main -- scale.ts; touch forged', 'git diff origin/main && git add .',
      'git diff origin/main\nnode hidden.js', 'git diff origin/main -- "a\\$(touch forged)"',
      'git diff origin/main -- "unterminated', "git diff origin/main -- 'line\nbreak'",
      `${diffPreface}git diff "$DIFF_BASE"; git reset --hard`,
      `${diffPreface}git diff "$DIFF_BASE" && touch forged`,
      `${diffPreface}git diff "$DIFF_BASE" --output=forged`,
      `${diffPreface}git diff "$DIFF_BASE" -- "$(touch forged)"`,
      `${diffPreface}git diff $DIFF_BASE`, `${diffPreface}git diff origin/main`,
      'DIFF_BASE=$(git merge-base origin/main HEAD; touch forged) && git diff "$DIFF_BASE"',
      'DIFF_BASE=$(git merge-base origin/main HEAD) ; git diff "$DIFF_BASE"',
      'DIFF_BASE=$(git -c alias.merge-base=writer merge-base origin/main HEAD) && git diff "$DIFF_BASE"',
      'DIFF_BASE=$(git merge-base origin/other HEAD) && git diff "$DIFF_BASE"',
    ]) {
      expect(qaCallerCommandAllowed(command), command).toBe(false);
      const observed = evidence();
      observed.result.transcript.push(...nativeCall('diff', 'Bash', { command }, 'rejected', 'native-reviewer', true));
      expect(validateCallerEvidence(observed)).toContain('command outside declared caller observation interface');
    }
    for (const command of ['git merge main', 'git push; touch forged', 'git -c core.hooksPath=hooks commit', `${diffPreface}git diff "$DIFF_BASE"; git reset --hard`]) {
      const observed = evidence();
      observed.result.transcript.push(...nativeCall('mutation', 'Bash', { command }, 'denied', 'native-reviewer', true));
      expect(validateCallerEvidence(observed)).toContain('unauthorized git/publication action');
    }
  });

  test('native CLI arguments include absence and literal text without granting shell evaluation', () => {
    for (const executable of ['scripts/probe.ts', 'cli.ts']) {
      for (const argument of ['', ' 0', ' λ', " ''", " 'bad input; $(touch forged)'", ' "bad input; invalid"']) {
        expect(qaCallerCommandAllowed(`bun ${executable}${argument}`), argument).toBe(true);
      }
      for (const argument of [' *', ' $HOME', ' $(touch forged)', ' `touch forged`', ' "$(touch forged)"', ' 3 > forged', ' 3\nnode hidden.js', " 'one' 'two'", " 'unterminated", ' a\\ b']) {
        expect(qaCallerCommandAllowed(`bun ${executable}${argument}`), argument).toBe(false);
      }
    }
    const observed = evidence();
    observed.result.transcript.push(...nativeCall('literal', 'Bash', { command: "bun scripts/probe.ts 'git push; $(touch forged)'" }, 'literal input rejected'));
    expect(validateCallerEvidence(observed)).toEqual([]);
    observed.result.transcript.push(...nativeCall('composed', 'Bash', { command: 'bun scripts/probe.ts 3; git push' }, 'not authorized'));
    expect(validateCallerEvidence(observed)).toContain('unauthorized git/publication action');
  });

  test('failed or out-of-order resource reads do not satisfy automatic invocation', () => {
    const failed = evidence();
    failed.result.transcript.splice(2, 2, ...nativeCall('shared', 'Read', { file_path: '/runtime/qa/sections/exploratory.md' }, 'missing file', null, true));
    expect(validateCallerEvidence(failed).some(error => error.includes('missing executed resource'))).toBe(true);
    const late = evidence();
    late.result.transcript = late.result.transcript.slice(6).concat(late.result.transcript.slice(0, 6));
    expect(validateCallerEvidence(late).some(error => error.includes('preceded'))).toBe(true);
  });

  test('browser setup, full-skill recursion and child mutation attempts are rejected', () => {
    for (const [name, input, parent] of [
      ['Read', { file_path: '/runtime/qa/sections/browser-setup.md' }, null],
      ['Read', { file_path: '/runtime/devex-review/SKILL.md' }, null],
      ['Read', { file_path: '/runtime/qa/SKILL.md' }, 'agent'],
      ['Skill', { skill: 'review' }, 'agent'],
      ['Skill', { skill: 'gstack-ship' }, 'agent'],
      ['Edit', { file_path: '/fixture/cli.test.ts', old_string: 'old', new_string: 'new' }, 'agent'],
      ['Bash', { command: 'git commit -am "unauthorized"' }, 'agent'],
      ['Bash', { command: 'git push origin feature' }, null],
    ] as const) {
      const observed = evidence();
      observed.result.transcript.push(...nativeCall('forbidden', name, input, 'denied', parent, true));
      expect(validateCallerEvidence(observed).length, JSON.stringify(input)).toBeGreaterThan(0);
    }
  });

  test('shell write-and-restore, rename, deletion and commit observations are violations even with a clean final tree', () => {
    for (const file of ['scale.ts', 'cli.test.ts', 'renamed.ts', '.git/refs/heads/caller-change']) {
      const observed = evidence();
      observed.mutations.push(file);
      expect(validateCallerEvidence(observed)).toContain(`unauthorized mutation: ${file}`);
    }
  });

  test('same-input passing reruns are detected while reproducing a failure is allowed', () => {
    const observed = evidence();
    const repeated = { ...happy, id: 'probe-duplicate' };
    observed.probes.push(repeated);
    observed.result.transcript.push(...nativeCall('duplicate', 'Bash', { command: 'bun scripts/probe.ts 3' }, JSON.stringify(repeated)));
    expect(validateCallerEvidence(observed)).toContain('duplicate unchanged passing probe: probe-duplicate');
    observed.probes[0].status = 'fail';
    repeated.status = 'fail';
    observed.receipt.status = 'fail';
    rebuildCheckpoints(observed);
    expect(validateCallerEvidence(observed)).toEqual([]);
  });

  test('late source, test, contract or fixture inputs cannot reuse stale passing proof', () => {
    for (const file of ['scale.ts', 'cli.test.ts', 'README.md', 'fixture.json']) {
      const observed = evidence();
      observed.currentSnapshot = callerSnapshot({ [file]: 'changed' });
      expect(validateCallerEvidence(observed).filter(error => error.includes('false green'))).toHaveLength(2);
      const fresh = observed.probes.map(probe => ({ ...probe, id: `${probe.id}-fresh`, snapshot: observed.currentSnapshot }));
      observed.probes.push(...fresh);
      observed.result.transcript.push(...fresh.flatMap(probe => nativeCall(probe.id, 'Bash', { command: `bun scripts/probe.ts ${probe.input}` }, JSON.stringify(probe))));
      observed.receipt.probes = fresh.map(probe => probe.id);
      rebuildCheckpoints(observed);
      expect(validateCallerEvidence(observed)).toEqual([]);
    }
  });

  test('unavailable, incomplete, timed-out and unobserved probes never become green', () => {
    for (const status of ['blocked', 'inconclusive', 'fail'] as const) {
      const observed = evidence();
      observed.probes[1].status = status;
      expect(validateCallerEvidence(observed).some(error => error.includes('reported green'))).toBe(true);
    }
    const timeout = evidence();
    timeout.result.exitReason = 'timeout';
    expect(validateCallerEvidence(timeout)).toContain('session did not complete: timeout');
    const unseen = evidence();
    unseen.receipt.probes.push('fictional');
    expect(validateCallerEvidence(unseen)).toContain('receipt references an unobserved probe');
  });

  test('additional required plan contracts cannot disappear behind an ordinary smoke pass', () => {
    const observed = evidence();
    observed.requiredCharters.push('plan:nine');
    expect(validateCallerEvidence(observed)).toContain('false green for charter: plan:nine');
  });

  test('one successful adverse zero cannot replace both distinct smoke scenarios', () => {
    const observed = evidence();
    const zero = { ...adverse, id: 'probe-zero', input: '0', exit: 0, stdout: '0\n', stderr: '' };
    observed.probes = [zero];
    observed.receipt.probes = [zero.id];
    fs.rmSync(path.join(observed.reportRoot, 'exploration-001.json'));
    rebuildCheckpoints(observed);
    expect(validateCallerEvidence(observed)).toEqual(['missing current charter: happy', 'false green for charter: happy']);
  });

  test('successful plan nine covers happy and plan while preserving a distinct adverse check', () => {
    const observed = evidence();
    const boundary = { ...happy, id: 'probe-nine', input: '9', charter: 'plan:nine', stdout: '18\n' };
    observed.probes[0] = boundary;
    observed.receipt.probes[0] = boundary.id;
    observed.requiredCharters.push('plan:nine');
    rebuildCheckpoints(observed);
    expect(validateCallerEvidence(observed)).toEqual([]);
    observed.receipt.probes = [boundary.id];
    expect(validateCallerEvidence(observed)).toContain('false green for charter: adverse');
    observed.receipt.probes = [adverse.id];
    expect(validateCallerEvidence(observed)).toContain('false green for charter: happy');
    expect(validateCallerEvidence(observed)).toContain('false green for charter: plan:nine');
  });
});

describe('generated actual parent paths', () => {
  test('authored parent QA owns ordered loading, execution and current-input finalization', () => {
    for (const skillName of ['review', 'ship']) {
      const ctx = { skillName, tmplPath: `${skillName}/SKILL.md.tmpl`, host: 'claude' as const, paths: HOST_PATHS.claude };
      const parent = generateQAReview(ctx);
      const phases = [skillName === 'review' ? "1. Complete Step 4's method Reads before probing" : '1. Load methods before any QA or explicit-verification probe', '2. List the checks that must pass', '3. Run the checks without repairing the product', '4. Check for changes before reporting'];
      const positions = phases.map(phase => parent.indexOf(phase));
      expect(positions.every(position => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      const load = skillName === 'review' ? generateQAReviewPreflight(ctx) : parent.slice(positions[0], positions[1]);
      if (skillName === 'review') {
        expect(parent.slice(positions[0], positions[1])).toContain("Complete Step 4's method Reads before probing");
      }
      expect(load).toContain('{{QA_RESOURCE:scope}}');
      expect(load).toContain('sections/exploratory.md');
      expect(load).toContain('sections/system-functional.md');
      expect(load).toContain('Caller/report templates cannot replace these method Reads');
      const flat = parent.replace(/\s+/g, ' ');
      expect(flat).toContain('Discovery is report-only');
      expect(flat).toContain('Follow the numbered Probe loop in `sections/exploratory.md` for discovery, replays and revalidation');
      expect(flat).toContain('Before reporting, read updates from any dispatched agents');
      expect(flat).toContain('repeat affected review and probes through the same loop without resetting its checkpoint sequence');
      expect(flat).toContain('Pass only when all required checks pass on the current inputs');
      expect(flat).toContain('list every failed, blocked, inconclusive or not-run required check otherwise');
    }
  });

  test('authored shared loop preserves complete safe observations and re-enters checkpoints after input changes', () => {
    const text = generateQAExploratory({ skillName: 'qa', tmplPath: 'qa/SKILL.md.tmpl', host: 'claude', paths: HOST_PATHS.claude }).replace(/\s+/g, ' ');
    for (const contract of ['immediately preceding completed probe', 'copy every key and value', 'nonsecret source/fixture identity hashes', 'Interpretations belong in hypothesis, not observed', 'Terminal summaries belong in the report, not a checkpoint', 'return to step 2 for each affected revalidation', 'Pass requires all required current-input contracts to pass with no required remainder']) {
      expect(text).toContain(contract);
    }
  });
  test('the shared smoke has explicit limits without waiving required plan checks', () => {
    const body = fs.readFileSync(path.join(import.meta.dir, '../qa/sections/exploratory.md'), 'utf8').replace(/\s+/g, ' ');
    expect(body).toContain('Stop after 5 minutes or 12 probes, whichever comes first');
    expect(body).toContain('Bound commands by remaining time');
    expect(body).toContain('Explicit plan checks remain required beyond this smoke budget');
    expect(body).toContain('make /review incomplete.');
    expect(body).toContain('They block /ship absent explicit user acceptance of that named risk');
  });

  test('excerpt extraction fails loudly instead of producing an empty passing fixture', () => {
    expect(callerExcerpt('before\nSTART\nbody\nEND\nafter', 'START', 'END')).toBe('START\nbody\n');
    expect(() => callerExcerpt('START without end', 'START', 'END')).toThrow('boundary');
    expect(() => callerExcerpt('START START END', 'START', 'END')).toThrow('boundary');
  });

  test('the review fixture admits only the actual native read-only diff fragments', () => {
    const fixture = createQaCallerFixture('review-exploratory-small-cli', { installRuntime: false });
    try {
      const command = 'DIFF_BASE=$(git merge-base origin/main HEAD) && git diff --name-status "$DIFF_BASE"';
      expect(fixture.workflowCommands).toContain(command);
      expect(qaCallerCommandAllowed(command, fixture.workflowCommands)).toBe(true);
      expect(qaCallerCommandAllowed(command + '; node hidden.js', fixture.workflowCommands)).toBe(false);
      expect(qaCallerCommandAllowed(command.replace('git diff', 'git reset'), fixture.workflowCommands)).toBe(false);
      expect(qaCallerSessionOptions(fixture, 'free-control').prompt).toContain('the native reviewer is still required');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  for (const caller of ['review', 'ship'] as const) {
    test(`${caller} uses its generated parent entrypoint, not an isolated explorer prompt`, () => {
      const excerpt = qaCallerInstructions(caller);
      if (caller === 'review') {
        expect(excerpt).toContain('### Step 4.7: Exploratory QA (before Fix-First)');
        expect(excerpt).toContain('**Test stub override:**');
        expect(excerpt.indexOf('### Step 4.7: Exploratory QA')).toBeLessThan(excerpt.indexOf('## Step 5: Fix-First Review'));
        expect(excerpt.indexOf('/review/sections/adversarial.md')).toBeGreaterThan(excerpt.indexOf('### Step 4.7: Exploratory QA'));
        expect(excerpt.indexOf('/review/sections/adversarial.md')).toBeLessThan(excerpt.indexOf('## Step 5: Fix-First Review'));
      } else {
        expect(excerpt).toContain('/ship/sections/plan-completion.md');
        expect(excerpt).toContain('/ship/sections/review-army.md');
        expect(excerpt).not.toContain('/ship/sections/greptile.md');
      }
    });
  }
});

describe('real caller-specific native fixture and capture boundary', () => {
  const fixtureFor = async (id: Parameters<typeof createQaCallerFixture>[0]) => {
    const fixture = createQaCallerFixture(id, { instructions: 'Free fixture control: no agent instructions or workflow credit.', installRuntime: false });
    await fixture.observe();
    return fixture;
  };
  const probe = (fixture: QaCallerFixture, value: string) => spawnSync(process.execPath, ['scripts/probe.ts', value], { cwd: fixture.cwd, encoding: 'utf8', timeout: 5000 });
  const dispose = async (fixture: QaCallerFixture) => { await fixture.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); };

  test('actual runner receives a safe receipt interface without scenario answers or a duplicate QA workflow', async () => {
    const fixture = await fixtureFor('ship-exploratory-small-cli');
    try {
      fixture.config = path.join(fixture.root, 'callback-config');
      await runQaCaller(fixture, 'free-receipt-interface', async options => {
        expect(options.prompt).toContain('status is the overall supplied phase gate, not whether some probes passed');
        expect(options.prompt).toContain('Pass requires no remaining required contracts or gates');
        expect(options.prompt).toContain('Optional unavailable providers and later stages outside this excerpt are not required remainder');
        expect(options.prompt).not.toMatch(/bun scripts\/probe\.ts \d|exploration-[0-9]{3}|snapshot.*must|plan:nine|adverse/i);
        const readme = fs.readFileSync(path.join(fixture.cwd, 'README.md'), 'utf8');
        expect(readme).toContain('Every diagnostic receipt field is synthetic, nonsecret evidence');
        expect(readme).toContain('snapshot identifies the owned source and fixture inputs');
        expect(readme).not.toMatch(/checkpoint|exploration-NNN|hypothesis|nextCommand/);
        return { exitReason: 'success', transcript: [] } as unknown as SkillTestResult;
      });
    } finally { await dispose(fixture); }
  });

  test('caller fixtures canonicalize an aliased temporary parent before checkpoint validation', async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qc-temp-alias-'));
    const target = path.join(root, 'actual');
    const alias = path.join(root, 'alias');
    fs.mkdirSync(target);
    fs.symlinkSync(target, alias);
    const previous = process.env.TMPDIR;
    let fixture: QaCallerFixture | undefined;
    try {
      process.env.TMPDIR = alias;
      expect(os.tmpdir()).toBe(alias);
      fixture = createQaCallerFixture('ship-exploratory-small-cli', { installRuntime: false });
      expect(fixture.root).toBe(fs.realpathSync(fixture.root));
      expect(path.dirname(fixture.root)).toBe(target);
      expect(readQACheckpointFiles(path.join(fixture.cwd, 'reports'))).toEqual({});
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      if (fixture) await dispose(fixture);
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(process.env.TMPDIR).toBe(previous);
  });

  test('actual runner callback binds a successful pre-probe Write to native JSON and retained files', async () => {
    const fixture = await fixtureFor('review-exploratory-small-cli');
    try {
      fixture.config = path.join(fixture.root, 'callback-config');
      const reportRoot = path.join(fixture.cwd, 'reports');
      const result = await runQaCaller(fixture, 'free-checkpoint-callback', async options => {
        const transcript: unknown[] = evidence().result.transcript.slice(0, 6);
        const execute = (value: string) => {
          const command = `bun scripts/probe.ts ${value}`;
          const actual = spawnSync('bash', ['-c', command], { cwd: options.workingDirectory, env: { ...process.env, ...options.env }, encoding: 'utf8', timeout: 5000 });
          expect(actual.status).toBe(value === '3' ? 0 : 2);
          const observed = JSON.parse(actual.stdout);
          transcript.push(...nativeCall(observed.id, 'Bash', { command }, actual.stdout, null, actual.status !== 0));
          return observed;
        };
        const prior = execute('3');
        const content = JSON.stringify({ observationCommand: 'bun scripts/probe.ts 3', observed: prior, hypothesis: 'The invalid input should reject with exit two and the documented stderr.', nextCommand: 'bun scripts/probe.ts no' });
        const file = path.join(reportRoot, 'exploration-001.json');
        fs.writeFileSync(file, content, { mode: 0o600 });
        transcript.push(...nativeCall('checkpoint', 'Write', { file_path: file, content }, `File created successfully at: ${file}`));
        execute('no');
        fs.writeFileSync(path.join(reportRoot, 'review.md'), '[Reasoning](exploration-001.json)');
        return { exitReason: 'success', transcript } as SkillTestResult;
      });
      await fixture.close();
      const input = {
        caller: fixture.caller, result, probes: fixture.probes(),
        receipt: { status: 'pass' as const, probes: fixture.probes().map(probe => probe.id), remaining: [] },
        requiredCharters: ['happy', 'adverse'], currentSnapshot: fixture.snapshot(), mutations: fixture.mutationEvents,
        observerComplete: fixture.observation?.complete === true && !fixture.observerErrors.length,
        fixtureRoot: fixture.cwd, reportRoot, checkpointFiles: readQACheckpointFiles(reportRoot),
        reportMarkdown: fs.readFileSync(path.join(reportRoot, 'review.md'), 'utf8'),
      };
      expect(validateCallerEvidence(input)).toEqual([]);
      result.transcript.splice(8, 2);
      expect(validateCallerEvidence(input).some(error => /checkpoint/i.test(error))).toBe(true);
    } finally { await dispose(fixture); }
  });

  test('actual runner callback executes literal listing and installed bookkeeping without mutation authority', async () => {
    const fixture = await fixtureFor('ship-exploratory-small-cli');
    try {
      fixture.config = path.join(fixture.root, 'callback-config');
      const result = await runQaCaller(fixture, 'free-native-interface', async options => {
        const observed = evidence();
        const execute = (id: string, command: string) => {
          expect(qaCallerCommandAllowed(command, fixture.workflowCommands), command).toBe(true);
          const actual = spawnSync('bash', ['-c', command], { cwd: options.workingDirectory, env: { ...process.env, ...options.env }, encoding: 'utf8', timeout: 5000 });
          expect(actual.status, actual.stderr).toBe(0);
          observed.result.transcript.push(...nativeCall(id, 'Bash', { command }, actual.stdout));
          return actual.stdout.trim();
        };
        const bin = path.join(import.meta.dir, '../bin/gstack-review-log');
        execute('listing', 'ls -la -- reports');
        const token = execute('start', `${bin} --start adversarial-review`);
        execute('finish', generatedReviewRecord(bin, token));
        expect(validateCallerEvidence(observed)).toEqual([]);
        const records = (fs.readdirSync(fixture.state, { recursive: true }) as string[]).filter(file => file.endsWith('.jsonl')).flatMap(file => fs.readFileSync(path.join(fixture.state, file), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));
        const record = records.find(record => record.skill === 'adversarial-review');
        expect(record?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        expect(record?.commit).toMatch(/^[0-9a-f]{7,40}$/);
        return observed.result as SkillTestResult;
      });
      expect(result.exitReason).toBe('success');
      const literal = "ls -- 'git push; $(touch forged)'";
      expect(qaCallerCommandAllowed(literal)).toBe(true);
      const absent = spawnSync('bash', ['-c', literal], { cwd: fixture.cwd, encoding: 'utf8', timeout: 5000 });
      expect(absent.status).toBe(2);
      expect(absent.stderr).toContain('git push; $(touch forged)');
      expect(fs.existsSync(path.join(fixture.cwd, 'forged'))).toBe(false);
      await fixture.close();
      expect(fixture.observerErrors).toEqual([]);
      expect(fixture.mutationEvents).toEqual([]);
    } finally { await dispose(fixture); }
  });

  test('permitted missing and quoted CLI inputs execute literally under the real observer', async () => {
    const fixture = await fixtureFor('ship-exploratory-small-cli');
    try {
      for (const [argument, input] of [['', ''], [" 'git push; $(touch forged)'", 'git push; $(touch forged)'], [' "invalid; text"', 'invalid; text']]) {
        const command = `bun scripts/probe.ts${argument}`;
        expect(qaCallerCommandAllowed(command)).toBe(true);
        const result = spawnSync('bash', ['-c', command], { cwd: fixture.cwd, encoding: 'utf8', timeout: 5000 });
        expect(result.status).toBe(2);
        expect(JSON.parse(result.stdout)).toMatchObject({ input, status: 'pass', exit: 2 });
      }
      await fixture.close();
      expect(fs.existsSync(path.join(fixture.cwd, 'forged'))).toBe(false);
      expect(fixture.observerErrors).toEqual([]);
      expect(fixture.mutationEvents).toEqual([]);
    } finally { await dispose(fixture); }
  });

  test('allowed diff modes and literal pathspecs execute as read-only Git arguments', async () => {
    const fixture = await fixtureFor('ship-exploratory-small-cli');
    try {
      const env = qaCallerSessionOptions(fixture, 'free-diff-control').env;
      const execute = (command: string) => {
        expect(qaCallerCommandAllowed(command), command).toBe(true);
        const result = spawnSync('bash', ['-c', command], { cwd: fixture.cwd, env: { ...process.env, ...env, DIFF_BASE: 'untrusted-inherited-value' }, encoding: 'utf8', timeout: 5000 });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe('');
        return result.stdout;
      };
      for (const mode of ['', '--stat', '--numstat', '--name-only', '--name-status']) {
        const expected = spawnSync('git', ['diff', ...(mode ? [mode] : []), 'origin/main', '--', '*.ts', ':(exclude)*test*'], { cwd: fixture.cwd, encoding: 'utf8', timeout: 5000 });
        expect(expected.status).toBe(0);
        expect(expected.stdout).toContain('scale.ts');
        for (const [prefix, base] of [['', ''], ['', ' origin/main'], [diffPreface, ' "$DIFF_BASE"']]) {
          const option = mode ? ` ${mode}` : '';
          for (const arguments_ of [option + base, base + option]) {
            expect(execute(`${prefix}git diff${arguments_} -- '*.ts' ':(exclude)*test*'`)).toBe(expected.stdout);
          }
        }
      }
      for (const command of capturedNativeDiffs) execute(command);
      for (const selection of ["'$(touch forged)'", "'git push; touch forged'", '"space name.ts"', '--output=forged', '--ext-diff']) {
        expect(execute(`git diff origin/main -- ${selection}`)).toBe('');
      }
      await fixture.close();
      expect(fs.existsSync(path.join(fixture.cwd, 'forged'))).toBe(false);
      expect(fixture.observation?.complete).toBe(true);
      expect(fixture.observerErrors).toEqual([]);
      expect(fixture.mutationEvents).toEqual([]);
    } finally { await dispose(fixture); }
  });

  test('every caller reserves completion within the unchanged capture and turn budgets', async () => {
    expect(CAPTURE_MS).toBe(300_000);
    expect(QA_CALLER_TEST_MS).toBe(CAPTURE_MS + SESSION_DRAIN_GRACE_MS + 10_000);
    for (const caseId of QA_CALLER_CASES) {
      const fixture = createQaCallerFixture(caseId, { installRuntime: false });
      try {
        const options = qaCallerSessionOptions(fixture, 'free-reserve-contract');
        expect(options.timeout).toBe(300_000);
        expect(options.maxTurns).toBe(25);
        expect(options.completionReserveMs).toBe(75_000);
        expect(options.completionReserveMs).toBe(options.timeout! / 4);
        expect(options).not.toHaveProperty('model');
        expect(options).not.toHaveProperty('tools');
        expect(options.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'Agent', 'Skill', 'AskUserQuestion']);
        expect(options.prompt).toContain('Keep normal parent decision gates.');
        expect(options.prompt).toContain('the native reviewer is still required');
        expect(options.prompt).toContain('first unresolved approval gate');
        expect(options.prompt).toContain('at most one output mode: --stat, --numstat, --name-only, or --name-status');
        expect(options.prompt).toContain(diffPreface);
        expect(options.prompt).toContain('optional literal pathspec arguments after --');
        expect(qaCallerCommandAllowed('date -u +%Y-%m-%dT%H:%M:%SZ')).toBe(true);
        expect(() => readCallerReceipt(fixture)).toThrow();
      } finally { await fixture.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); }
    }
  });

  test('supplied earlier-phase context names readable installed assets without recursive discovery', () => {
    const fixture = createQaCallerFixture('review-exploratory-small-cli');
    try {
      const prompt = qaCallerSessionOptions(fixture, 'free-control').prompt;
      for (const relative of ['review/checklist.md', 'qa/templates/functional-report-template.md']) {
        const asset = path.join(fixture.runtime, relative);
        expect(prompt).toContain(asset);
        expect(fs.readFileSync(asset, 'utf8').length).toBeGreaterThan(200);
      }
      expect(prompt).toContain('Pass these same command and write boundaries to any child');
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  });

  test('the caller phase starts with cross-project onboarding already resolved in its owned state', () => {
    const fixture = createQaCallerFixture('ship-exploratory-small-cli', { installRuntime: false });
    try {
      const preference = spawnSync('bash', [path.join(import.meta.dir, '../bin/gstack-config'), 'get', 'cross_project_learnings'], {
        cwd: fixture.cwd, env: { ...process.env, GSTACK_HOME: fixture.state }, encoding: 'utf8', timeout: 5000,
      });
      expect(preference.status).toBe(0);
      expect(preference.stdout.trim()).toBe('false');
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  });

  test('the resumed review phase receives a real start token bound to its current fixture snapshot', () => {
    const fixture = createQaCallerFixture('review-exploratory-small-cli', { installRuntime: false });
    try {
      expect(fixture.reviewStart).toMatch(/^[0-9a-f-]{36}$/);
      const files = fs.readdirSync(fixture.state, { recursive: true }) as string[];
      const captures = files.filter(file => file.endsWith(`${fixture.reviewStart}.json`));
      expect(captures).toHaveLength(1);
      const start = JSON.parse(fs.readFileSync(path.join(fixture.state, captures[0]), 'utf8'));
      expect(start).toMatchObject({ skill: 'review', repo: fs.realpathSync(fixture.cwd), branch: 'caller-change' });
      expect(start.wtree).toMatch(/^[0-9a-f]{40,64}$/);
      expect(qaCallerSessionOptions(fixture, 'free-phase-context').prompt).toContain(`REVIEW_START=${fixture.reviewStart}`);
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  });

  test('the declared phase interface rejects re-entering setup and composing shell inventory', () => {
    const fixture = createQaCallerFixture('ship-exploratory-small-cli', { installRuntime: false });
    try {
      const prompt = qaCallerSessionOptions(fixture, 'free-phase-interface').prompt;
      expect(prompt).toContain('do not read or invoke the full parent SKILL.md');
      expect(prompt).toContain('without fetch');
      expect(prompt).toContain('even read-only commands must not be chained');
      expect(prompt).not.toMatch(/bun scripts\/probe\.ts \d|invalid input|highest.risk/i);
      expect(qaCallerCommandAllowed('pwd && ls -la')).toBe(false);
      expect(qaCallerCommandAllowed('git fetch origin main')).toBe(false);
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  });

  test('all five caller options declare diagnostic checkpoints apart from suite verification', async () => {
    for (const caseId of QA_CALLER_CASES) {
      const fixture = createQaCallerFixture(caseId, { installRuntime: false });
      try {
        const prompt = qaCallerSessionOptions(fixture, 'free-diagnostic-checkpoint-contract').prompt;
        expect(prompt).toContain('Use diagnostic-client commands such as `bun scripts/probe.ts <literal>` for exploratory discoveries and their checkpoint evidence.');
        expect(prompt).toContain('A required `bun run test` is separate suite verification: report it as verification, never as a diagnostic observation or checkpoint anchor/target.');
        expect(prompt).toContain('Write each diagnostic checkpoint directly to `reports/exploration-NNN.json`, not inside a nested directory.');
      } finally { await fixture.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); }
    }
    expect(qaCallerCommandAllowed('bun scripts/probe.ts 3')).toBe(true);
    expect(qaCallerCommandAllowed('bun run test')).toBe(true);
    expect(qaCallerCommandAllowed('bun scripts/probe.ts 3; bun run test')).toBe(false);
  });

  test('authorized review bookkeeping leaves the observed product and real Git metadata untouched', async () => {
    const fixture = await fixtureFor('ship-exploratory-small-cli');
    try {
      const start = spawnSync('bash', [path.join(import.meta.dir, '../bin/gstack-review-log'), '--start', 'review'], {
        cwd: fixture.cwd,
        env: { ...process.env, GSTACK_HOME: fixture.state, ...fixture.gitEnvironment },
        encoding: 'utf8', timeout: 5000,
      });
      expect(start.status).toBe(0);
      expect(start.stdout.trim()).toMatch(/^[0-9a-f-]{36}$/);
      await fixture.close();
      expect(fixture.observerErrors).toEqual([]);
      expect(fixture.mutationEvents).toEqual([]);
      expect(fs.realpathSync(fixture.gitEnvironment.GIT_OBJECT_DIRECTORY).startsWith(fixture.state + path.sep)).toBe(true);
      const env = qaCallerSessionOptions(fixture, 'free-bookkeeping-state').env;
      expect(env).toMatchObject(fixture.gitEnvironment);
    } finally { await dispose(fixture); }
  });

  test('real generated runtime and shared resource pointers stay inside the private skill view', async () => {
    const fixture = createQaCallerFixture('ship-exploratory-small-cli');
    try {
      const identity = spawnSync('git', ['config', '--local', 'user.name'], { cwd: fixture.cwd, encoding: 'utf8', timeout: 5000 });
      expect(identity.status).toBe(0);
      expect(identity.stdout.trim()).toBe('QA Caller Fixture');
      await fixture.observe();
      const registered = path.join(fixture.config, 'skills/qa/sections/exploratory.md');
      expect(fs.realpathSync(registered).startsWith(fixture.root + path.sep)).toBe(true);
      expect(fs.readFileSync(registered, 'utf8')).toContain('# Shared exploratory QA');
      expect(fs.readFileSync(path.join(fixture.cwd, 'caller-ship.md'), 'utf8')).toContain(fixture.runtime + '/ship/sections/review-army.md');
      expect(probe(fixture, '3').status).toBe(0);
      await fixture.close();
      expect(fixture.observation?.complete).toBe(true);
      expect(fixture.observerErrors).toEqual([]);
    } finally { await dispose(fixture); }
  });

  test('native probes expose exact streams, seeded defect and unchanged-input fingerprints', async () => {
    const fixture = await fixtureFor('review-exploratory-small-cli');
    try {
      expect(probe(fixture, '3').status).toBe(0);
      expect(probe(fixture, 'no').status).toBe(2);
      expect(probe(fixture, '0').status).toBe(2);
      expect(fixture.probes().map(({ input, stdout, stderr, exit, status }) => ({ input, stdout, stderr, exit, status }))).toEqual([
        { input: '3', stdout: '6\n', stderr: '', exit: 0, status: 'pass' },
        { input: 'no', stdout: '', stderr: 'integer required: 0..9\n', exit: 2, status: 'pass' },
        { input: '0', stdout: '', stderr: 'integer required: 0..9\n', exit: 2, status: 'fail' },
      ]);
      expect(fixture.probes().every(result => result.snapshot === fixture.snapshot())).toBe(true);
      expect(fs.existsSync(path.join(fixture.cwd, 'PLAN.md'))).toBe(false);
    } finally { await dispose(fixture); }
  });

  test('missing native prerequisite blocks the real CLI as well as its diagnostic client', async () => {
    const fixture = await fixtureFor('ship-exploratory-unavailable');
    try {
      expect(probe(fixture, '3').status).not.toBe(0);
      expect(fixture.probes()).toEqual([expect.objectContaining({ status: 'blocked', stdout: '' })]);
      expect(fixture.probes()[0].stderr).not.toBe('');
      const direct = spawnSync(process.execPath, ['cli.ts', '3'], { cwd: fixture.cwd, encoding: 'utf8', timeout: 5000 });
      expect(direct.status).not.toBe(0);
      expect(direct.stderr).toContain('vendor/native-engine.ts');
    } finally { await dispose(fixture); }
  });

  test('actual write watcher observes transient edits, rename and deletion', async () => {
    const fixture = await fixtureFor('ship-exploratory-small-cli');
    try {
      const file = path.join(fixture.cwd, 'scale.ts'), original = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, 'temporary violation');
      fs.writeFileSync(file, original);
      const renamed = path.join(fixture.cwd, 'renamed.ts');
      fs.renameSync(file, renamed);
      fs.renameSync(renamed, file);
      fs.writeFileSync(path.join(fixture.cwd, 'created.test.ts'), 'test');
      fs.unlinkSync(path.join(fixture.cwd, 'created.test.ts'));
      await Bun.sleep(50);
      await fixture.close();
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
      expect(fixture.mutationEvents).toContain('scale.ts');
      expect(fixture.mutationEvents).toContain('renamed.ts');
      expect(fixture.mutationEvents).toContain('created.test.ts');
      expect(fixture.observation?.complete).toBe(true);
      expect(fixture.observerErrors).toEqual([]);
      expect(validateCallerEvidence({ ...evidence(), mutations: fixture.mutationEvents }))
        .toContain('unauthorized mutation: scale.ts');
    } finally { await dispose(fixture); }
  });

  test('late candidate coordinator changes consumed bytes and does not label its own write an agent violation', async () => {
    const fixture = await fixtureFor('ship-exploratory-late-input');
    try {
      const original = fixture.snapshot();
      probe(fixture, '3'); probe(fixture, 'no');
      await Bun.sleep(50);
      expect(fixture.lateApplied).toBe(true);
      expect(fixture.snapshot()).not.toBe(original);
      expect(fixture.probes().every(result => result.snapshot === original)).toBe(true);
      expect(fixture.mutationEvents).toEqual([]);
      probe(fixture, '3');
      expect(fixture.probes().at(-1)?.snapshot).toBe(fixture.snapshot());
      await fixture.close();
      expect(fixture.mutationEvents).toEqual([]);
    } finally { await dispose(fixture); }
  });

  test('actual runner callback receives the parent request and hermetic state without teaching the probes', async () => {
    const fixture = await fixtureFor('ship-exploratory-small-cli');
    try {
      fixture.config = path.join(fixture.root, 'callback-control-config');
      const options = qaCallerSessionOptions(fixture, 'free-callback-control');
      let received: Parameters<typeof runSkillTest>[0] | undefined;
      const sentinel = { exitReason: 'timeout', transcript: [] } as unknown as SkillTestResult;
      const result = await runQaCaller(fixture, 'free-callback-control', async supplied => { received = supplied; return sentinel; });
      expect(result).toBe(sentinel);
      expect(received).toEqual(options);
      expect(options.env?.GSTACK_HOME).toBe(fixture.state);
      expect(options.env?.GSTACK_STATE_ROOT).toBe(fixture.state);
      expect(options.allowedTools).toContain('Edit');
      expect(options.allowedTools).toContain('Bash');
      expect(options.prompt).toContain(`This excerpt comes from ${fixture.runtime}/${fixture.caller}/SKILL.md`);
      expect(options.prompt).toContain('not from the excerpt file or product directory');
      expect(options.prompt).not.toMatch(/bun scripts\/probe\.ts \d|invalid input|highest.risk/i);
      expect(() => readCallerReceipt(fixture)).toThrow();
      fs.writeFileSync(path.join(fixture.cwd, 'reports/receipt.json'), '{"status":"pass","probes":"none"}');
      expect(() => readCallerReceipt(fixture)).toThrow('Malformed');
    } finally { await dispose(fixture); }
  });

  test('native diagnostic evidence remains private and survives fixture cleanup', async () => {
    const fixture = await fixtureFor('ship-exploratory-small-cli');
    const artifacts = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qc-proof-'));
    try {
      probe(fixture, '3');
      probe(fixture, 'no');
      const notes = checkpointSequence(fixture.probes(), path.join(fixture.cwd, 'reports'));
      await fixture.close();
      retainQaCallerEvidence(fixture, artifacts, { transcript: notes.transcript } as SkillTestResult);
      await dispose(fixture);
      expect(fs.existsSync(fixture.root)).toBe(false);
      const rows = fs.readFileSync(path.join(artifacts, 'native-probes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows).toEqual([expect.objectContaining({ input: '3', status: 'pass', stdout: '6\n' }), expect.objectContaining({ input: 'no', status: 'pass', exit: 2 })]);
      expect(fs.readFileSync(path.join(artifacts, 'exploration-001.json'), 'utf8')).toBe(notes.checkpointFiles['exploration-001.json']);
      expect(fs.statSync(path.join(artifacts, 'exploration-001.json')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(artifacts).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(artifacts, 'native-probes.jsonl')).mode & 0o777).toBe(0o600);
    } finally {
      if (fs.existsSync(fixture.root)) await dispose(fixture);
      fs.rmSync(artifacts, { recursive: true, force: true });
    }
  });

  test('unsafe checkpoint links retain private failure evidence without reading or modifying their targets', async () => {
    for (const kind of ['symlink', 'hardlink'] as const) {
      const fixture = await fixtureFor('ship-exploratory-small-cli');
      const artifacts = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qc-link-proof-'));
      const source = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qc-link-source-'));
      try {
        const target = path.join(source, 'untouched.txt');
        const sentinel = 'Unsafe target bytes must never enter retained checkpoint evidence.';
        fs.writeFileSync(target, sentinel, { mode: 0o640 });
        fs.utimesSync(target, new Date(1000), new Date(2000));
        const note = path.join(fixture.cwd, 'reports/exploration-001.json');
        if (kind === 'symlink') fs.symlinkSync(target, note);
        else fs.linkSync(target, note);
        const targetBefore = fs.statSync(target);
        const linkBefore = fs.lstatSync(note);
        probe(fixture, '3');
        const nativeProbe = fixture.probes()[0];
        const result = { exitReason: 'success', transcript: nativeCall('native-probe', 'Bash', { command: 'bun scripts/probe.ts 3' }, JSON.stringify(nativeProbe)) } as SkillTestResult;
        fs.writeFileSync(path.join(fixture.cwd, 'reports/review.md'), 'Original report: checkpoint capture must fail.');
        fs.writeFileSync(path.join(fixture.cwd, 'reports/receipt.json'), JSON.stringify({ status: 'blocked', probes: [nativeProbe.id], remaining: ['unsafe checkpoint'] }));
        await fixture.close();
        const observed = evidence();
        expect(validateCallerEvidence({ ...observed, reportRoot: path.join(fixture.cwd, 'reports'), checkpointFiles: {} }).some(error => /unsafe.*checkpoint/i.test(error))).toBe(true);
        retainQaCallerEvidence(fixture, artifacts, result);
        expect(fs.statSync(target)).toMatchObject({ ino: targetBefore.ino, mode: targetBefore.mode, size: targetBefore.size, atimeMs: targetBefore.atimeMs, mtimeMs: targetBefore.mtimeMs });
        expect(fs.lstatSync(note)).toMatchObject({ ino: linkBefore.ino, mode: linkBefore.mode, size: linkBefore.size, mtimeMs: linkBefore.mtimeMs });
        expect(fs.readFileSync(target, 'utf8')).toBe(sentinel);
        expect(fs.readFileSync(path.join(artifacts, 'checkpoint-capture-error.txt'), 'utf8')).toContain('Unsafe checkpoint file: exploration-001.json');
        expect(fs.existsSync(path.join(artifacts, 'exploration-001.json'))).toBe(false);
        expect(JSON.parse(fs.readFileSync(path.join(artifacts, 'native-events.json'), 'utf8'))).toEqual(result.transcript);
        expect(fs.readFileSync(path.join(artifacts, 'native-probes.jsonl'), 'utf8')).toContain(nativeProbe.id);
        expect(JSON.parse(fs.readFileSync(path.join(artifacts, 'observer.json'), 'utf8'))).toMatchObject({ exitReason: 'success', snapshot: fixture.snapshot() });
        expect(fs.readFileSync(path.join(artifacts, 'report.md'), 'utf8')).toBe('Original report: checkpoint capture must fail.');
        expect(JSON.parse(fs.readFileSync(path.join(artifacts, 'receipt.json'), 'utf8'))).toMatchObject({ status: 'blocked', remaining: ['unsafe checkpoint'] });
        await dispose(fixture);
        expect(fs.existsSync(fixture.root)).toBe(false);
        expect(fs.readFileSync(target, 'utf8')).toBe(sentinel);
        expect(fs.statSync(artifacts).mode & 0o777).toBe(0o700);
        for (const file of fs.readdirSync(artifacts)) {
          expect(fs.statSync(path.join(artifacts, file)).mode & 0o777).toBe(0o600);
          expect(fs.readFileSync(path.join(artifacts, file), 'utf8')).not.toContain(sentinel);
        }
      } finally {
        if (fs.existsSync(fixture.root)) await dispose(fixture);
        fs.rmSync(artifacts, { recursive: true, force: true });
        fs.rmSync(source, { recursive: true, force: true });
      }
    }
  });
});
