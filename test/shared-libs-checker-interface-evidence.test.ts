import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { hasTrustedSharedLibsCheck, hasTrustedReviewStartRead } from './helpers/shared-libs-review-start-evidence';
import {
  createSharedLibsFixture, fixtureGit, fixtureWorkingTree, fixtureWrite, installNormalizingFilter,
  reviewLifecycleInstructions, reviewRevalidationPrompt, reviewRecords, seedReviewSources, seedSkippedAdvisory,
  SHARED_LIBS_ROOT, shellQuote, toolCommandTrace,
  type SharedLibsFixture,
} from './helpers/shared-libs-eval-fixture';
import { preparePathEligibilityFixture, type PathEligibilityFixture } from './helpers/shared-libs-path-fixture';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';

const helper = path.join(SHARED_LIBS_ROOT, 'bin/gstack-review-log');
const fixtures: SharedLibsFixture[] = [];
const captures = new Map<string, any>();
const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-shared-libs.test.ts'), 'utf8');
const pathSource = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-shared-libs-paths.test.ts'), 'utf8');
const pathKinds = ['symlinks', 'submodule', 'ignored', 'legacy', 'assume-unchanged', 'skip-worktree', 'removed-filter'] as const;

async function capture(change: string, prepared?: PathEligibilityFixture) {
  const f = prepared?.fixture ?? createSharedLibsFixture(`checker-${change}`);
  fixtures.push(f);
  let current = prepared?.current;
  if (!current) {
    seedReviewSources(f);
    fixtureWrite(f, 'src/retry-worker.ts', fs.readFileSync(path.join(f.repo, 'src/retry-worker.ts'), 'utf8')
      .replace('const unusedRetryDiagnostic = "unused";\n', ''));
    if (change === 'filtered') installNormalizingFilter(f);
    const { action: _action, ...finding } = await seedSkippedAdvisory(f);
    current = finding;
    if (change === 'branch') fixtureGit(f, 'checkout', '-b', 'feature-a');
    if (change === 'secondary') fixtureWrite(f, 'src/retry-route.ts',
      fs.readFileSync(path.join(f.repo, 'src/retry-route.ts'), 'utf8') + '// Changed caller\n');
    if (change === 'filtered') fixtureWrite(f, 'src/retry-route.ts',
      fs.readFileSync(path.join(f.repo, 'src/retry-route.ts'), 'utf8') + '// RAW-ONLY changed caller\n');
  }
  const events: any[] = [];
  const invoke = (command: string) => {
    const id = `call-${events.length}`;
    events.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
    const output = execFileSync('bash', ['-c', command], { cwd: f.repo, env: { ...process.env, ...f.env },
      encoding: 'utf8', timeout: 30_000 });
    events.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] } });
    return output.trim();
  };
  const instructions = fs.readFileSync(reviewLifecycleInstructions(f), 'utf8');
  const startCommand = instructions.match(/```bash\n(DIFF_BASE=\$[\s\S]*?)\n```/)?.[1];
  expect(startCommand).toBeDefined();
  const token = invoke(startCommand!).split('\n')[0];
  for (const file of current.evidence_paths) invoke(`cat ${shellQuote(file)}`);
  invoke(`bun -e 'const { sharedLibsFingerprint } = await import(process.argv[1]); console.log(sharedLibsFingerprint(JSON.parse(await Bun.stdin.text())));' ${shellQuote(path.join(SHARED_LIBS_ROOT, 'lib/review-evidence.ts'))} <<'FINDING'\n${JSON.stringify(current)}\nFINDING`);
  const checkAt = events.length;
  const receipt = JSON.parse(invoke(`${shellQuote(helper)} --check-shared-libs ${token} <<'FINDING'\n${JSON.stringify(current)}\nFINDING`));
  const finishAt = events.length;
  invoke(`${shellQuote(helper)} ${shellQuote(JSON.stringify({ skill: 'review', status: 'clean', issues_found: 0,
    completed: true, converged: true, findings: change === 'unchanged' ? [] : [{ ...current, action: 'skipped' }] }))}
    --finish ${token}`.replace('\n    ', ' ') + ` && ${shellQuote(path.join(SHARED_LIBS_ROOT, 'bin/gstack-review-read'))}`);
  const expected = { helper, repo: f.repo, state: f.state, slug: 'fixture-shared-libs',
    directory: path.join(f.state, 'projects/fixture-shared-libs/.review-starts'),
    branch: fixtureGit(f, 'symbolic-ref', '--quiet', '--short', 'HEAD'), wtree: fixtureWorkingTree(f),
    startedAt: receipt.review_start.started_at, finding: current, reusable: change === 'unchanged',
    coveredPaths: receipt.snapshot.covered_paths };
  return { f, current, token, receipt, events, checkAt, finishAt, expected, prepared };
}

beforeAll(async () => {
  for (const change of ['unchanged', 'secondary', 'branch', 'filtered']) captures.set(change, await capture(change));
  for (const kind of pathKinds) captures.set(`path-${kind}`, await capture(`path-${kind}`, preparePathEligibilityFixture(kind)));
}, 120_000);
afterAll(() => { for (const fixture of fixtures) fs.rmSync(fixture.root, { recursive: true, force: true }); });

function replay(change = 'unchanged') { return structuredClone(captures.get(change)); }
function call(run: any, at = run.checkAt) { return run.events[at].message.content[0]; }
function result(run: any, at = run.checkAt) { return run.events[at + 1].message.content[0]; }
function alterReceipt(run: any, change: (receipt: any) => void) {
  const receipt = JSON.parse(result(run).content);
  change(receipt);
  result(run).content = JSON.stringify(receipt);
}

function pathCallback(run: any, overrides: Record<string, any> = {}) {
  const start = pathSource.indexOf('async function exerciseEligibility(');
  const end = pathSource.indexOf('\ndescribeE2E(', start);
  const readStart = pathSource.indexOf('function sourceReadTrace(');
  expect(start).toBeGreaterThan(readStart);
  expect(end).toBeGreaterThan(start);
  const rows: any[] = [];
  const native = { events: run.events, exitReason: 'success', output: '', toolCalls: run.events
    .filter((event: any) => event.type === 'assistant')
    .map((event: any) => ({ tool: event.message.content[0].name, input: event.message.content[0].input })) };
  const exercise = new Function('deps', new Bun.Transpiler({ loader: 'ts' }).transformSync(`const {
    captures, preparePathEligibilityFixture, fs, path, reviewLifecycleInstructions, reviewRevalidationPrompt,
    runSharedInteractive, readRequests, toolCommandTrace, fixtureGit, fixtureWorkingTree, reviewRecords, expect,
    CAPTURE_LONG_MS, hasTrustedSharedLibsCheck, SHARED_LIBS_ROOT } = deps;
    ${pathSource.slice(readStart, end)} return exerciseEligibility;`))({
    captures: { runAttempt: async (_name: string, _kinds: string[], _timeout: number, work: any) =>
      work({ add: (scenario: string, row: any) => rows.push({ scenario, row }) }) },
    preparePathEligibilityFixture: () => run.prepared,
    fs: { ...fs, rmSync: (directory: string) => { expect(directory).toBe(run.f.root); } }, path,
    reviewLifecycleInstructions, reviewRevalidationPrompt,
    runSharedInteractive: async (_fixture: any, _name: string, _prompt: string, choice: string) => {
      expect(choice).toBe('skip');
      return { result: native, questions: [{}] };
    },
    readRequests: () => [], toolCommandTrace, fixtureGit, fixtureWorkingTree, reviewRecords, expect,
    CAPTURE_LONG_MS, hasTrustedSharedLibsCheck, SHARED_LIBS_ROOT, ...overrides,
  });
  return { rows, invoke: () => exercise('shared-libs-review-path-eligibility', [run.kind]) };
}

describe('native executable shared-code checker evidence', () => {
  test.each(['unchanged', 'secondary', 'branch', 'filtered'])('real %s checker receipt supplies the mechanical proof without manual trace words', change => {
    const run = replay(change);
    expect(run.receipt.reusable).toBe(change === 'unchanged');
    expect(hasTrustedSharedLibsCheck(run.events, run.expected)).toBe(true);
    expect(JSON.stringify(run.events)).not.toMatch(/check-attr|ls-files|canReuseSharedLibsAdvisory/);
    expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(false);
  });

  test.each(['literal cd', 'literal token assignment', 'native text blocks', 'native Read callers'])('preserves the bounded %s interface', form => {
    const run = replay();
    if (form === 'literal cd') call(run).input.command = `cd ${shellQuote(run.f.repo)} && ${call(run).input.command}`;
    if (form === 'literal token assignment') call(run).input.command = `TOKEN=${run.token}; `
      + call(run).input.command.replace(run.token, '"$TOKEN"');
    if (form === 'native text blocks') result(run).content = [{ type: 'text', text: result(run).content }];
    if (form === 'native Read callers') {
      for (let at = 2; at <= run.current.evidence_paths.length * 2; at += 2) {
        call(run, at).name = 'Read';
        call(run, at).input = { file_path: run.current.evidence_paths[at / 2 - 1] };
      }
    }
    expect(hasTrustedSharedLibsCheck(run.events, run.expected)).toBe(true);
  });

  test('the generated Step 3 start precedes diff output without losing the printed token', () => {
    const run = replay();
    expect(call(run, 0).input.command).toContain('DIFF_BASE=$(git merge-base origin/main HEAD)');
    expect(call(run, 0).input.command).toContain('git diff "$DIFF_BASE"');
    expect(result(run, 0).content).toStartWith(run.token + '\n');
    expect(result(run, 0).content).toContain('diff --git');
    expect(hasTrustedSharedLibsCheck(run.events, run.expected)).toBe(true);
  });

  test.each(['direct', 'assigned'])('retains %s start invocation proof', form => {
    const run = replay();
    call(run, 0).input.command = form === 'direct' ? `${shellQuote(helper)} --start review`
      : `REVIEW_START=$(${shellQuote(helper)} --start review); echo "$REVIEW_START"`;
    result(run, 0).content = run.token + '\n';
    expect(hasTrustedSharedLibsCheck(run.events, run.expected)).toBe(true);
  });

  test.each(['repo', 'branch', 'wtree', 'started_at', 'skill'])('rejects a mismatched start %s', field => {
    const run = replay();
    alterReceipt(run, receipt => { receipt.review_start[field] = 'foreign'; });
    expect(hasTrustedSharedLibsCheck(run.events, run.expected)).toBe(false);
  });

  test.each(['fingerprint', 'wtree', 'branch_id', 'partial coverage', 'extra coverage', 'duplicate coverage',
    'false', 'string true', 'missing decision', 'missing snapshot', 'missing start'])('rejects invalid %s', kind => {
    const run = replay();
    alterReceipt(run, receipt => {
      if (kind === 'fingerprint') receipt.fingerprint = 'shared-libs:' + 'a'.repeat(64);
      if (kind === 'wtree') receipt.snapshot.wtree = 'a'.repeat(40);
      if (kind === 'branch_id') receipt.snapshot.branch_id = createHash('sha256').update('feature-a').digest('hex');
      if (kind === 'partial coverage') receipt.snapshot.covered_paths.pop();
      if (kind === 'extra coverage') receipt.snapshot.covered_paths.push('src/unread.ts');
      if (kind === 'duplicate coverage') receipt.snapshot.covered_paths.push(receipt.snapshot.covered_paths[0]);
      if (kind === 'false') receipt.reusable = false;
      if (kind === 'string true') receipt.reusable = 'true';
      if (kind === 'missing decision') delete receipt.reusable;
      if (kind === 'missing snapshot') delete receipt.snapshot;
      if (kind === 'missing start') delete receipt.review_start;
    });
    expect(hasTrustedSharedLibsCheck(run.events, run.expected)).toBe(false);
  });

  test('even matching partial expectation and result cannot prove reusable coverage', () => {
    const run = replay();
    run.expected.coveredPaths.pop();
    alterReceipt(run, receipt => { receipt.snapshot.covered_paths = run.expected.coveredPaths; });
    expect(hasTrustedSharedLibsCheck(run.events, run.expected)).toBe(false);
  });

  test.each(['missing result', 'error result', 'unpaired result', 'assistant result', 'private result', 'caption',
    'echo', 'inert heredoc', 'quoted invocation', 'conditional invocation', 'forged appended result', 'foreign helper',
    'wrong token', 'wrong finish token', 'wrong start token', 'unknown token variable', 'rebound token variable',
    'foreign cwd', 'foreign state', 'source caption', 'missing caller read', 'errored caller read',
    'echo start', 'echo finish', 'inert batched start', 'forged base command', 'token only in diff',
    'private events', 'check before start', 'read after check',
    'receipt after finish', 'missing finish', 'failed finish'])('rejects %s', kind => {
    const run = replay();
    if (kind === 'missing result') run.events.splice(run.checkAt + 1, 1);
    if (kind === 'error result') result(run).is_error = true;
    if (kind === 'unpaired result') result(run).tool_use_id = 'foreign';
    if (kind === 'assistant result') run.events[run.checkAt + 1].type = 'assistant';
    if (kind === 'private result') run.events[run.checkAt + 1] = { type: 'fixture_result', content: result(run).content };
    if (kind === 'caption') call(run).input = { command: 'true', description: call(run).input.command };
    if (kind === 'echo') call(run).input.command = `echo ${shellQuote(result(run).content)}`;
    if (kind === 'inert heredoc') call(run).input.command = `cat <<'SOURCE'\n${call(run).input.command}\nSOURCE`;
    if (kind === 'quoted invocation') call(run).input.command = `printf '%s' ${shellQuote(call(run).input.command)}`;
    if (kind === 'conditional invocation') call(run).input.command = `false && ${call(run).input.command}`;
    if (kind === 'forged appended result') call(run).input.command += `\necho ${shellQuote(result(run).content)}`;
    if (kind === 'foreign helper') call(run).input.command = call(run).input.command.replace(helper, '/foreign/gstack-review-log');
    if (kind === 'wrong token') call(run).input.command = call(run).input.command.replace(run.token, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    if (kind === 'wrong finish token') call(run, run.finishAt).input.command = call(run, run.finishAt).input.command.replace(run.token, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    if (kind === 'wrong start token') result(run, 0).content = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    if (kind === 'unknown token variable') call(run).input.command = call(run).input.command.replace(run.token, '"$UNKNOWN"');
    if (kind === 'rebound token variable') call(run).input.command = `TOKEN=${run.token}; TOKEN=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa; `
      + call(run).input.command.replace(run.token, '"$TOKEN"');
    if (kind === 'foreign cwd') call(run).input.command = `cd /foreign; ${call(run).input.command}`;
    if (kind === 'foreign state') call(run).input.command = `GSTACK_HOME=/foreign; ${call(run).input.command}`;
    if (kind === 'source caption') call(run, 2).input = { command: 'true', description: 'cat src/retry-worker.ts' };
    if (kind === 'missing caller read') run.events.splice(2, 2);
    if (kind === 'errored caller read') result(run, 2).is_error = true;
    if (kind === 'echo start') call(run, 0).input.command = `echo ${shellQuote(call(run, 0).input.command)}`;
    if (kind === 'echo finish') call(run, run.finishAt).input.command = `echo ${shellQuote(call(run, run.finishAt).input.command)}`;
    if (kind === 'inert batched start') call(run, 0).input.command = `cat <<'SOURCE'\n${call(run, 0).input.command}\nSOURCE`;
    if (kind === 'forged base command') call(run, 0).input.command = call(run, 0).input.command.replace('git merge-base origin/main HEAD', 'echo fake-base');
    if (kind === 'token only in diff') result(run, 0).content = `diff --git a/file b/file\n+${run.token}\n`;
    if (kind === 'private events') run.events = [{ type: 'fixture_events', events: run.events }];
    if (kind === 'check before start') run.events = [...run.events.slice(run.checkAt, run.checkAt + 2), ...run.events.slice(0, run.checkAt), ...run.events.slice(run.finishAt)];
    if (kind === 'read after check') run.events = [...run.events.slice(0, 2), ...run.events.slice(4, run.finishAt), ...run.events.slice(2, 4), ...run.events.slice(run.finishAt)];
    if (kind === 'receipt after finish') run.events = [...run.events.slice(0, run.checkAt + 1), ...run.events.slice(run.finishAt), run.events[run.checkAt + 1]];
    if (kind === 'missing finish') run.events.splice(run.finishAt);
    if (kind === 'failed finish') result(run, run.finishAt).is_error = true;
    expect(hasTrustedSharedLibsCheck(run.events, run.expected)).toBe(false);
  });

  test.each(['unchanged', 'secondary', 'branch', 'filtered'])('the registered native %s acceptance callback consumes the checker result and coverage', change => {
    const scenario = source.slice(source.indexOf("test('shared-libs-review-revalidation'"));
    const marker = '}, result => {';
    const start = scenario.indexOf(marker) + marker.length;
    const body = scenario.slice(start, scenario.indexOf('\n        });', start));
    const verify = new Function('deps', 'result', new Bun.Transpiler({ loader: 'ts' }).transformSync(`const {
      change, questions, expect, toolCommandTrace, reviewRecords, createHash, path, f, current,
      fixtureGit, fixtureWorkingTree, hasTrustedReviewStartRead, hasTrustedSharedLibsCheck, SHARED_LIBS_ROOT
    } = deps; ${body}`));
    const run = replay(change);
    const native = { events: run.events, toolCalls: run.events.filter((event: any) => event.type === 'assistant')
      .map((event: any) => ({ tool: event.message.content[0].name, input: event.message.content[0].input })) };
    let checks = 0;
    const deps = { change, questions: change === 'unchanged' ? [] : [{}], expect, toolCommandTrace,
      reviewRecords, createHash, path, f: run.f, current: run.current, fixtureGit, fixtureWorkingTree,
      hasTrustedReviewStartRead, SHARED_LIBS_ROOT, hasTrustedSharedLibsCheck: (events: unknown[], expected: any) => {
        checks++;
        expect(events).toBe(run.events);
        expect(expected).toEqual(run.expected);
        return hasTrustedSharedLibsCheck(events, expected);
      } };
    verify(deps, native);
    expect(checks).toBe(1);
    expect(() => verify({ ...deps, hasTrustedSharedLibsCheck: () => false }, native)).toThrow();
    const partial = structuredClone(native);
    partial.events[run.checkAt + 1].message.content[0].content = JSON.stringify({ ...run.receipt,
      snapshot: { ...run.receipt.snapshot, covered_paths: [] } });
    expect(() => verify({ ...deps, hasTrustedSharedLibsCheck }, partial)).toThrow();
    for (const invalid of ['false', 'missing', 'error', 'caption', 'unread caller']) {
      const changed = structuredClone(native);
      const block = changed.events[run.checkAt + 1].message.content[0];
      if (invalid === 'false') block.content = JSON.stringify({ ...run.receipt, reusable: !run.expected.reusable });
      if (invalid === 'missing') changed.events.splice(run.checkAt + 1, 1);
      if (invalid === 'error') block.is_error = true;
      if (invalid === 'caption') changed.events[run.checkAt].message.content[0].input = { command: 'true', description: call(run).input.command };
      if (invalid === 'unread caller') changed.events.splice(2, 2);
      expect(() => verify({ ...deps, hasTrustedSharedLibsCheck }, changed)).toThrow();
    }
    expect(() => verify({ ...deps, questions: change === 'unchanged' ? [{}] : [] }, native)).toThrow();
    expect(() => verify({ ...deps, reviewRecords: () => [] }, native)).toThrow();
  });

  test.each(pathKinds)('the actual %s callback consumes false proof and enforces final excluded coverage', async kind => {
    const run = replay(`path-${kind}`);
    run.kind = kind;
    expect(run.receipt.reusable).toBe(false);
    let checks = 0;
    const adapter = pathCallback(run, { hasTrustedSharedLibsCheck: (events: unknown[], expected: any) => {
      checks++;
      expect(events).toBe(run.events);
      expect(expected).toEqual(run.expected);
      return hasTrustedSharedLibsCheck(events, expected);
    } });
    await adapter.invoke();
    expect(checks).toBe(1);
    expect(adapter.rows).toMatchObject([{ scenario: kind, row: { passed: true } }]);
    const refused = pathCallback(run, { hasTrustedSharedLibsCheck: () => false });
    await expect(refused.invoke()).rejects.toThrow();
    expect(refused.rows).toMatchObject([{ scenario: kind, row: { passed: false } }]);
    if (kind !== 'legacy' && kind !== 'removed-filter') {
      const forged = pathCallback(run, { hasTrustedSharedLibsCheck: () => true,
        reviewRecords: (fixture: SharedLibsFixture) => {
          const records = reviewRecords(fixture);
          records.at(-1).findings[0].snapshot_covered_paths = [...run.current.evidence_paths];
          return records;
        } });
      await expect(forged.invoke()).rejects.toThrow();
      expect(forged.rows).toMatchObject([{ scenario: kind, row: { passed: false } }]);
    }
  });

  test.each(['true', 'error', 'missing result', 'partial coverage', 'caption', 'unread caller', 'wrong tree', 'late receipt'])(
    'the actual symlink callback rejects %s instead of waiving path eligibility', async invalid => {
      const run = replay('path-symlinks');
      run.kind = 'symlinks';
      if (invalid === 'true') alterReceipt(run, receipt => { receipt.reusable = true; });
      if (invalid === 'error') result(run).is_error = true;
      if (invalid === 'missing result') run.events.splice(run.checkAt + 1, 1);
      if (invalid === 'partial coverage') alterReceipt(run, receipt => { receipt.snapshot.covered_paths = []; });
      if (invalid === 'caption') call(run).input = { command: 'true', description: call(run).input.command };
      if (invalid === 'unread caller') run.events.splice(4, 2);
      if (invalid === 'wrong tree') alterReceipt(run, receipt => { receipt.snapshot.wtree = 'a'.repeat(40); });
      if (invalid === 'late receipt') run.events = [...run.events.slice(0, run.checkAt + 1), ...run.events.slice(run.finishAt), run.events[run.checkAt + 1]];
      const adapter = pathCallback(run);
      await expect(adapter.invoke()).rejects.toThrow();
      expect(adapter.rows).toMatchObject([{ scenario: 'symlinks', row: { passed: false } }]);
    });
});
