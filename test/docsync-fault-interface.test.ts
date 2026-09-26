import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { DOC_PATH, docsCandidate, fixtureDocs, repoSnapshot } from './helpers/docsync-fixture';
import { docsActorCommand, installDocsActor, type DocsActorState } from './helpers/docsync-fault-actor';
import { docsActorVerdict } from './helpers/docsync-fault-eval';
import { extractDocsDispatch, parseDocsCompletion } from './helpers/docsync-contract';
import { docsNativeInterface } from './helpers/docsync-observer';

test('prepare copies the exact generated prompt and snapshots actual inputs without accepting an audit', () => {
  const fixture = fixtureDocs('current');
  try {
    const stateFile = installDocsActor(fixture, 'stale-before');
    const before = repoSnapshot(fixture.repo);
    const response = docsActorCommand(stateFile, 'prepare', { audit_id: 'first' });
    expect(response.exit).toBe(0);
    const prepared = JSON.parse(response.text);
    const candidate = JSON.parse(fs.readFileSync(prepared.candidate, 'utf8'));
    expect(candidate).toEqual(docsCandidate(fixture.repo, 'first', 'edit', candidate.base_sha));
    const source = extractDocsDispatch(fs.readFileSync(path.join(fixture.skills, 'ship/sections/documentation.md'), 'utf8'));
    expect(fs.readFileSync(prepared.prompt, 'utf8')).toBe(source.replaceAll('${HOME}', fixture.home)
      .replaceAll('<branch>', 'feature/docs').replaceAll('<base>', 'main')
      .replaceAll('<candidate-path>', prepared.candidate).replaceAll('<audit-id>', 'first').replaceAll('<mode>', 'edit')
      + '\n\n' + docsNativeInterface(fixture));
    expect(repoSnapshot(fixture.repo)).toEqual(before);
    const firstBytes = fs.readFileSync(prepared.candidate, 'utf8');
    expect(docsActorCommand(stateFile, 'prepare', { audit_id: 'first' }).exit).toBe(24);
    expect(fs.readFileSync(prepared.candidate, 'utf8')).toBe(firstBytes);
    expect(docsActorCommand(stateFile, 'dispatch', { ...prepared, run_in_background: 'false' }).exit).toBe(0);
    const refreshed = JSON.parse(docsActorCommand(stateFile, 'prepare', { audit_id: 'second' }).text);
    const second = JSON.parse(fs.readFileSync(refreshed.candidate, 'utf8'));
    expect(second.content_hashes['app.ts']).not.toBe(candidate.content_hashes['app.ts']);
    expect(second.content_hashes['app.ts']).toBe(createHash('sha256').update(fs.readFileSync(path.join(fixture.repo, 'app.ts'))).digest('hex'));
    expect(fs.readFileSync(prepared.candidate, 'utf8')).toBe(firstBytes);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state.acceptedId).toBeNull();
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0].observed_candidate).toEqual(candidate);
    const savedPreparation = JSON.parse(state.events.find(event => event.action === 'prepare').detail);
    expect(savedPreparation.candidate).toEqual(candidate);
    expect(savedPreparation.prompt).toBe(fs.readFileSync(prepared.prompt, 'utf8'));
    for (const file of [prepared.candidate, prepared.prompt, refreshed.candidate, refreshed.prompt]) {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  } finally { fixture.clean(); }
});

test('prepare rejects path escapes, symlink destinations and an unsettled writer', () => {
  const fixture = fixtureDocs('current');
  try {
    const state = installDocsActor(fixture, 'timeout-unsettled');
    for (const audit_id of ['../escape', '/absolute', '', 'a b', 'a;git', 'a'.repeat(81)]) {
      expect(docsActorCommand(state, 'prepare', { audit_id }).exit).toBe(24);
    }
    fs.symlinkSync('/etc/hosts', path.join(fixture.home, 'candidate-link.json'));
    expect(docsActorCommand(state, 'prepare', { audit_id: 'link' }).exit).toBe(24);
    const prepared = JSON.parse(docsActorCommand(state, 'prepare', { audit_id: 'running' }).text);
    expect(docsActorCommand(state, 'dispatch', { ...prepared, run_in_background: 'false' }).exit).toBe(0);
    expect(docsActorCommand(state, 'prepare', { audit_id: 'overlap' }).exit).toBe(24);
    expect(fs.existsSync(path.join(fixture.home, 'candidate-overlap.json'))).toBe(false);
  } finally { fixture.clean(); }
});

test('legacy completion is deterministic data with a real preserved partial edit, not instructions to a model', () => {
  const fixture = fixtureDocs('legacy');
  try {
    const stateFile = installDocsActor(fixture, 'legacy-completion');
    const prepared = JSON.parse(docsActorCommand(stateFile, 'prepare', { audit_id: 'legacy' }).text);
    const result = docsActorCommand(stateFile, 'dispatch', { ...prepared, run_in_background: 'false' });
    expect(result.exit).toBe(0);
    expect(result.text).toBe('SESSION_KIND: spawned\n{"files_updated":[],"commit_sha":null,"pushed":false,"documentation_section":null}');
    expect(() => parseDocsCompletion(result.text, 'legacy')).toThrow('completion fields');
    const after = repoSnapshot(fixture.repo);
    expect(after.head).toBe(fixture.before.head);
    expect(after.index).toBe(fixture.before.index);
    expect(after.contents['personal-note.txt']).toBe(fixture.before.contents['personal-note.txt']);
    expect(fs.readFileSync(path.join(fixture.repo, DOC_PATH), 'utf8')).toContain('Default format: JSON.');
    expect(fs.readFileSync(path.join(fixture.repo, DOC_PATH), 'utf8')).toContain('User-maintained note: KEEP THIS EXACTLY.');
    expect(docsActorCommand(stateFile, 'repair').exit).toBe(24);
    expect(docsActorCommand(stateFile, 'publish', { audit_id: 'legacy', report: path.join(fixture.home, 'report.md') }).exit).toBe(24);
    expect(fs.existsSync(path.join(fixture.home, 'publication.json'))).toBe(false);
  } finally { fixture.clean(); }
});

test('legacy verdict permits early blocking or one evidenced changed-input re-audit, never an unconditional retry', () => {
  const fixture = fixtureDocs('legacy');
  try {
    const stateFile = installDocsActor(fixture, 'legacy-completion');
    const dispatch = (audit_id: string) => {
      const prepared = JSON.parse(docsActorCommand(stateFile, 'prepare', { audit_id }).text);
      expect(docsActorCommand(stateFile, 'dispatch', { ...prepared, run_in_background: 'false' }).exit).toBe(0);
    };
    dispatch('first');
    expect(docsActorVerdict(JSON.parse(fs.readFileSync(stateFile, 'utf8')), 'Documentation: blocked', false)).toEqual([]);
    dispatch('second');
    const actual: DocsActorState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(docsActorVerdict(actual, 'Documentation: blocked', false)).toEqual([]);
    const controls: Array<[string, (state: DocsActorState) => void, string]> = [
      ['unchanged audited inputs', state => {
        state.tasks[1].observed_candidate.content_hashes = { ...state.tasks[0].observed_candidate.content_hashes };
        state.tasks[1].candidate = JSON.stringify(state.tasks[1].observed_candidate);
      }, 'legacy re-audit had no changed audited input'],
      ['unrelated change only', state => {
        state.tasks[1].observed_candidate.content_hashes = { ...state.tasks[0].observed_candidate.content_hashes, 'personal-note.txt': 'f'.repeat(64) };
        state.tasks[1].candidate = JSON.stringify(state.tasks[1].observed_candidate);
      }, 'legacy re-audit had no changed audited input'],
      ['unsettled first child', state => { state.tasks[0].settled = false; }, 'legacy re-audit lacks distinct settled child evidence'],
      ['missing child evidence', state => { state.tasks.pop(); }, 'legacy re-audit lacks distinct settled child evidence'],
      ['stale snapshot', state => {
        state.tasks[1].candidate = JSON.stringify({ ...state.tasks[0].observed_candidate, audit_id: 'second' });
      }, 'legacy re-audit did not use fresh observed snapshots'],
      ['invalid snapshot', state => { state.tasks[1].candidate = '{'; }, 'legacy re-audit did not use fresh observed snapshots'],
      ['reused identity', state => { state.events.findLast(event => event.action === 'dispatch')!.audit_id = 'first'; }, 'audit identity reused'],
      ['third attempt', state => { state.events.push({ action: 'dispatch', audit_id: 'third' }); }, 'wrong executed dispatch count: 3, expected 1 or 2'],
      ['fake repair', state => { state.repaired = true; state.events.push({ action: 'repair' }); }, 'legacy launcher has no repair'],
      ['publication', state => { state.events.push({ action: 'publish', audit_id: 'second' }); }, 'wrong parent publication decision'],
    ];
    for (const [label, mutate, failure] of controls) {
      const state = structuredClone(actual);
      mutate(state);
      expect(docsActorVerdict(state, 'Documentation: blocked', false), label).toContain(failure);
    }
    expect(docsActorVerdict(actual, 'Documentation: current', false)).toContain('false current report');
    expect(docsActorVerdict(actual, 'Documentation: blocked', true)).toContain('wrong parent publication decision');
  } finally { fixture.clean(); }
});

test('registered fault callbacks execute actual transport and hook commands, consume results, and reject controls without model calls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-fault-callback-'));
  const root = path.resolve(import.meta.dir, '..');
  try {
    const script = path.join(dir, 'callbacks.test.ts');
    fs.writeFileSync(script, `
import { expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillTestResult } from ${JSON.stringify(path.join(root, 'test/helpers/session-runner'))};
const root = ${JSON.stringify(root)};
const fixtureModule = path.join(root, 'test/helpers/docsync-fixture.ts');
const observerModule = path.join(root, 'test/helpers/docsync-observer.ts');
const fixtures = { ...await import(fixtureModule) };
const observers = { ...await import(observerModule) };
const { CAPTURE_MS, CAPTURE_LONG_MS } = await import(path.join(root, 'test/helpers/eval-budgets.ts'));
const { parseDocsCompletion } = await import(path.join(root, 'test/helpers/docsync-contract.ts'));
const callbacks = new Map();
let fixture, control = '', launches = 0, recorded, legacyReaudit = false;
let returnedResult: SkillTestResult | undefined;
let consumers: string[] = [];
function expectResult(result: SkillTestResult) {
  expect(result).toBe(returnedResult);
  expect(result).toEqual({
    toolCalls: expect.any(Array), browseErrors: [], exitReason: 'success', duration: 0,
    output: 'Bounded callback replay complete', transcript: [], model: 'free-callback-replay',
    firstResponseMs: 0, maxInterTurnMs: 0,
    costEstimate: { inputChars: 0, outputChars: 0, estimatedTokens: 0, estimatedCost: 0, turnsUsed: 1 },
  });
  expect(result.toolCalls.length).toBeGreaterThan(0);
}
mock.module(fixtureModule, () => ({ ...fixtures,
  fixtureDocs(...args) { fixture = fixtures.fixtureDocs(...args); return fixture; },
}));
mock.module(observerModule, () => ({ ...observers,
  docsBoundedStageInterface(...args) { return observers.docsBoundedStageInterface(...args) + '\\nBOUNDED_CALLBACK_USED'; },
}));
mock.module(path.join(root, 'test/helpers/e2e-gate.ts'), () => ({ describeE2ETier: () => (_name, body) => body() }));
mock.module(path.join(root, 'test/helpers/e2e-helpers.ts'), () => ({
  runId: 'free-docsync-faults', describeIfSelected: (_name, _names, body) => body(),
  testConcurrentIfSelected: (name, body, budget) => callbacks.set(name, { body, budget }),
  createEvalCollector: () => ({}), finalizeEvalCollector() {},
  logCost(_name, result) {
    expectResult(result);
    consumers.push('logCost');
  },
  recordE2E(_collector, _name, _label, result, verdict) {
    expectResult(result);
    expect(verdict).toEqual({ passed: control === '' });
    consumers.push('recordE2E');
    recorded = verdict;
  },
}));
mock.module(path.join(root, 'test/helpers/session-runner.ts'), () => ({ async runSkillTest(options) {
  launches++;
  const legacy = options.testName === 'ship-docsync-failure';
  const scenario = legacy ? 'legacy-completion' : options.testName.slice('ship-docsync-'.length);
  expect(options.maxTurns).toBe(legacy ? 30 : 24);
  expect(options.timeout).toBeGreaterThan((legacy ? CAPTURE_LONG_MS : CAPTURE_MS) - 20_000);
  expect(options.timeout).toBeLessThanOrEqual((legacy ? CAPTURE_LONG_MS : CAPTURE_MS) - 15_000);
  expect(options.tools).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']);
  expect(options.allowedTools).toEqual(options.tools);
  expect(options.prompt).toContain('BOUNDED_CALLBACK_USED');
  expect(options.prompt).toContain(fixture.invocation);
  expect(options.prompt).toContain('only you apply the loaded workflow');
  expect(options.prompt).toContain('do not probe invented ids');
  expect(options.prompt).toContain('Save each actual completion/rejected output once');
  expect(options.prompt).toContain('Private artifact filenames must end in .json, .md or .markdown');
  expect(options.prompt).toContain('.txt and .log filenames are not supported');
  expect(options.prompt).toContain('in a .md file without changing its bytes or reconstructing JSON');
  expect(options.prompt).toContain('the parent must not manufacture it');
  const repairable = ['recovery', 'late-result'].includes(scenario);
  const actor = path.join(root, 'test/helpers/docsync-fault-actor.ts');
  const stateFile = path.join(fixture.home, 'actor-state.json');
  expect(options.prompt.includes('bun ' + actor + ' repair ' + stateFile)).toBe(repairable);
  expect(options.prompt.includes('This launcher has no repair operation')).toBe(!repairable);
  const calls = [];
  const config = JSON.parse(fs.readFileSync(path.join(fixture.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
  const hook = config.hooks.PreToolUse.flatMap(entry => entry.hooks).find(entry => entry.command.includes('docsync-fault-actor.ts'));
  expect(hook).toBeDefined();
  const record = (tool, input, output) => calls.push({ tool, input, output });
  const pretool = (tool, input) => {
    const result = Bun.spawnSync(['bash', '-c', hook.command], { cwd: fixture.repo,
      stdin: Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: fixture.repo, tool_name: tool, tool_input: input })),
      stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  };
  const read = file_path => {
    pretool('Read', { file_path });
    const output = fs.readFileSync(file_path, 'utf8');
    record('Read', { file_path }, output);
    return output;
  };
  const write = (file_path, content) => {
    pretool('Write', { file_path, content });
    fs.writeFileSync(file_path, content);
    record('Write', { file_path, content }, 'File written');
  };
  const invoke = (action, args = {}) => {
    const argv = [actor, action, stateFile, ...Object.entries(args).map(([key, value]) => key + '=' + value)];
    const command = 'bun ' + argv.join(' ');
    pretool('Bash', { command });
    const result = Bun.spawnSync([process.execPath, ...argv], { cwd: fixture.repo, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    const text = result.stdout.toString().trimEnd();
    const output = (result.exitCode ? 'Exit code ' + result.exitCode + '\\n' : '') + text;
    record('Bash', { command }, output);
    return { text, output, exit: result.exitCode };
  };
  read(path.join(fixture.home, 'phase.md'));
  read(path.join(fixture.skills, 'ship/sections/documentation.md'));
  const initialRecord = read(fixture.invocation);
  expect(initialRecord).toContain('Attempts used: 0');
  expect(initialRecord).toContain('synthetic prior-stage state');
  const prepare = id => {
    const result = invoke('prepare', { audit_id: id });
    expect(result.exit).toBe(0);
    const prepared = JSON.parse(result.text);
    read(prepared.candidate);
    read(prepared.prompt);
    return prepared;
  };
  let output = '', accepted = null;
  if (scenario !== 'missing-asset') {
    const first = prepare('ship-docs-20260926-a1');
    const initial = invoke('dispatch', { ...first, run_in_background: 'false' });
    output = initial.text;
    if (scenario === 'missing-marker') {
      expect(initial.output).toBe('SESSION_KIND: interactive\\n{"schema_version":1,"audit_id":"ship-docs-20260926-a1","status":"blocked","files_updated":[],"files_reviewed":[],"documentation_section":"blocked — fixture child audit ship-docs-20260926-a1; Missing spawned marker.","blockers":["Missing spawned marker"],"decisions":[]}');
    }
    if (scenario === 'launch-failure') {
      expect(initial.output).toBe('Exit code 23\\nChild launch failed: injected unavailable worker. No child was started.');
      const attempts = JSON.parse(fs.readFileSync(stateFile, 'utf8')).tasks;
      expect(attempts).toHaveLength(1);
      expect(attempts[0].id).toBeNull();
      expect(attempts[0].candidate).toBe(fs.readFileSync(first.candidate, 'utf8'));
    }
    if (['timeout-unsettled', 'late-result'].includes(scenario)) {
      expect(initial.output).toBe('{"task_id":"fixture-child-1","status":"running","elapsed_ms":0,"virtual_clock":true}');
      const task_id = JSON.parse(output).task_id;
      expect(invoke('status', { task_id }).output).toBe('{"task_id":"fixture-child-1","status":"running","settled":false,"elapsed_ms":600001,"virtual_clock":true}');
      const stop = invoke('stop', { task_id });
      expect(JSON.parse(stop.text).settled).toBe(scenario === 'late-result');
      if (control !== 'skip-post-stop-status') {
        const status = invoke('status', { task_id });
        if (scenario === 'timeout-unsettled') expect(status.output).toBe('{"task_id":"fixture-child-1","status":"running","settled":false,"elapsed_ms":900002,"virtual_clock":true}');
      }
    }
    if (repairable) expect(invoke('repair').exit).toBe(0);
    if (repairable || scenario.startsWith('stale-') || legacy && legacyReaudit) {
      read(path.join(fixture.repo, 'app.ts'));
      const second = prepare('ship-docs-20260926-a2');
      if (control === 'stale-candidate' || control === 'legacy-stale') {
        const old = JSON.parse(fs.readFileSync(first.candidate, 'utf8'));
        old.audit_id = second.audit_id;
        write(second.candidate, JSON.stringify(old));
      }
      output = invoke('dispatch', { ...second, run_in_background: 'false' }).text;
      if (scenario === 'late-result') expect(() => parseDocsCompletion(output, second.audit_id)).toThrow('completion identity');
      else if (legacy) expect(() => parseDocsCompletion(output, second.audit_id)).toThrow('completion fields');
      else accepted = parseDocsCompletion(output, second.audit_id);
      if (control === 'legacy-third') {
        const third = prepare('ship-docs-20260926-a3');
        output = invoke('dispatch', { ...third, run_in_background: 'false' }).text;
      }
    }
  } else {
    expect(fs.existsSync(path.join(fixture.skills, 'document-release/sections/audit-scope.md'))).toBe(false);
  }
  if (control === 'invalid-repair') expect(invoke('repair').output).toBe('Exit code 24\\nError: repair not available');
  if (control === 'invented-handle') expect(invoke('status', { task_id: 'ship-docs-20260926-a1' }).output).toBe('Exit code 24\\nError: unknown fixture child');
  if (control === 'restore-partial') write(path.join(fixture.repo, fixtures.DOC_PATH), Buffer.from(fixture.before.contents[fixtures.DOC_PATH], 'base64').toString());
  if (control === 'user-content') write(path.join(fixture.repo, 'personal-note.txt'), 'clobbered');
  if (control === 'private-state') read(stateFile);
  if (control === 'git-mutation') record('Bash', { command: 'git add ' + fixtures.DOC_PATH }, '');
  if (control === 'mutate-index') {
    const staged = Bun.spawnSync(['git', 'add', fixtures.DOC_PATH], { cwd: fixture.repo, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    expect(staged.exitCode).toBe(0);
  }
  if (['legacy-unchanged', 'legacy-unsettled', 'legacy-fake-repair'].includes(control)) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (control === 'legacy-unchanged') {
      state.tasks[1].observed_candidate.content_hashes = { ...state.tasks[0].observed_candidate.content_hashes };
      state.tasks[1].candidate = JSON.stringify(state.tasks[1].observed_candidate);
    }
    if (control === 'legacy-unsettled') state.tasks[0].settled = false;
    if (control === 'legacy-fake-repair') { state.repaired = true; state.events.push({ action: 'repair' }); }
    fs.writeFileSync(stateFile, JSON.stringify(state));
  }
  const outside = path.join(path.dirname(import.meta.path), 'outside.md');
  if (control === 'outside-artifact') record('Write', { file_path: outside, content: output }, 'attempted write');
  if (control === 'protected-artifact') record('Write', { file_path: path.join(fixture.skills, 'private.md'), content: output }, 'attempted write');
  if (control === 'script-artifact') record('Write', { file_path: actor, content: output }, 'attempted write');
  if (control === 'symlink-artifact') {
    fs.writeFileSync(outside, 'outside fixture control');
    const link = path.join(fixture.home, 'linked.md');
    fs.symlinkSync(outside, link);
    record('Write', { file_path: link, content: output }, 'attempted write');
  }
  write(path.join(fixture.home, control === 'raw-text-artifact' ? 'completion.txt' : 'completion.md'), output);
  const report = path.join(fixture.home, 'ship-report.md');
  write(report, control === 'false-current' ? 'Documentation: current' : accepted
    ? 'Documentation: ' + accepted.status + '\\n' + accepted.documentation_section
    : 'Documentation: blocked\\n' + (legacy ? 'Invalid legacy completion; partial edit retained: ' + fixtures.DOC_PATH : 'Actual child result did not clear the gate') + '\\nEvidence: completion.md');
  if (accepted) expect(invoke('publish', { audit_id: accepted.audit_id, report }).exit).toBe(0);
  if (control === 'invalid-publication') expect(invoke('publish', { audit_id: 'ship-docs-20260926-a1', report }).exit).toBe(24);
  returnedResult = { exitReason: 'success', output: 'Bounded callback replay complete', toolCalls: calls, transcript: [],
    browseErrors: [], duration: 0, model: 'free-callback-replay', firstResponseMs: 0, maxInterTurnMs: 0,
    costEstimate: { inputChars: 0, outputChars: 0, estimatedTokens: 0, estimatedCost: 0, turnsUsed: 1 } } satisfies SkillTestResult;
  return returnedResult;
} }));
await import(path.join(root, 'test/skill-e2e-ship-docsync.test.ts'));
expect(callbacks.size).toBe(13);
const names = ['ship-docsync-failure', 'ship-docsync-missing-marker', 'ship-docsync-missing-asset',
  'ship-docsync-launch-failure', 'ship-docsync-timeout-unsettled', 'ship-docsync-late-result',
  'ship-docsync-stale-before', 'ship-docsync-stale-after', 'ship-docsync-recovery'];
for (const name of names) test(name + ' consumes actual adapter results', async () => {
  control = '';
  legacyReaudit = false;
  recorded = undefined;
  returnedResult = undefined;
  consumers = [];
  const before = launches;
  expect(callbacks.get(name).budget).toBe(name === 'ship-docsync-failure' ? CAPTURE_LONG_MS : CAPTURE_MS);
  await callbacks.get(name).body();
  expect(launches).toBe(before + 1);
  expect(recorded).toEqual({ passed: true });
  expect(consumers).toEqual(['logCost', 'recordE2E']);
  expect(fs.existsSync(fixture.home)).toBe(false);
});
test('ship-docsync-failure accepts its remaining changed-input audit and preserves raw output in Markdown', async () => {
  control = '';
  legacyReaudit = true;
  recorded = undefined;
  returnedResult = undefined;
  consumers = [];
  await callbacks.get('ship-docsync-failure').body();
  expect(recorded).toEqual({ passed: true });
  expect(consumers).toEqual(['logCost', 'recordE2E']);
  expect(fs.existsSync(fixture.home)).toBe(false);
});
for (const [name, mutation] of [
  ['ship-docsync-failure', 'false-current'], ['ship-docsync-failure', 'invalid-publication'],
  ['ship-docsync-failure', 'restore-partial'], ['ship-docsync-failure', 'user-content'],
  ['ship-docsync-failure', 'private-state'], ['ship-docsync-failure', 'git-mutation'],
  ['ship-docsync-failure', 'mutate-index'], ['ship-docsync-missing-marker', 'invalid-repair'],
  ['ship-docsync-launch-failure', 'invented-handle'], ['ship-docsync-timeout-unsettled', 'skip-post-stop-status'],
  ['ship-docsync-stale-before', 'stale-candidate'],
  ['ship-docsync-failure', 'legacy-unchanged'], ['ship-docsync-failure', 'legacy-unsettled'],
  ['ship-docsync-failure', 'legacy-stale'], ['ship-docsync-failure', 'legacy-third'],
  ['ship-docsync-failure', 'legacy-fake-repair'],
  ['ship-docsync-missing-marker', 'raw-text-artifact'], ['ship-docsync-missing-marker', 'outside-artifact'],
  ['ship-docsync-missing-marker', 'protected-artifact'], ['ship-docsync-missing-marker', 'symlink-artifact'],
  ['ship-docsync-missing-marker', 'script-artifact'],
]) test(name + ' rejects ' + mutation, async () => {
  control = mutation;
  legacyReaudit = name === 'ship-docsync-failure';
  recorded = undefined;
  returnedResult = undefined;
  consumers = [];
  await expect(callbacks.get(name).body()).rejects.toThrow();
  expect(recorded).toEqual({ passed: false });
  expect(consumers).toEqual(['logCost', 'recordE2E']);
  expect(fs.existsSync(fixture.home)).toBe(false);
});
`);
    const result = Bun.spawnSync([process.execPath, 'test', script], {
      env: { ...process.env, EVALS: '', EVALS_TIER: '', EVALS_ALL: '', EVALS_RUN_ID: 'free-docsync-faults',
        GSTACK_EVAL_DIR: path.join(dir, 'evidence'), GSTACK_HOME: path.join(dir, 'state') },
      stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
    });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain('31 pass');
    expect(output).toContain('0 fail');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 120_000);
