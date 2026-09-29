/**
 * Fail-open regression suite for the paid lane verdict. Synthetic slice
 * artifacts go through the real `--report` CLI path (the command the workflow
 * report jobs run), so a change to the gate cannot turn a real failure green
 * without one of these cases going red. Landed before the panel-verdict gate
 * change; every later gate change extends it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseRunManifest, type PaidRunManifest, type SliceResult } from '../scripts/test-paid-shards';

const ROOT = path.resolve(import.meta.dir, '..');
const RULE_A = 'test/skill-e2e-fail-open-alpha.test.ts';
const RULE_B = 'test/skill-e2e-fail-open-beta.test.ts';

let base: string;
beforeAll(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-fail-open-')); });
afterAll(() => { fs.rmSync(base, { recursive: true, force: true }); });

type Outcome = SliceResult['outcomes'][number];
const passed = (file: string, extra: Partial<Outcome> = {}): Outcome =>
  ({ files: [file], status: 'passed', exitCode: 0, elapsedMs: 1_000, executedTests: 1, skippedTests: 0, ...extra });

function manifest(entries: PaidRunManifest['entries'], sliceCount: number): PaidRunManifest {
  return parseRunManifest(JSON.stringify({ version: 1, tier: 'periodic', evalsAll: true, sliceCount,
    selectionReason: 'fail-open fixture', profile: 'full', selection: { e2e: null, judges: null }, entries }));
}

let caseCounter = 0;
function report(plan: PaidRunManifest, slices: SliceResult[], collectors: Record<string, unknown> = {}) {
  const dir = path.join(base, `case-${++caseCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(plan));
  for (const slice of slices) fs.writeFileSync(path.join(dir, `slice-${slice.sliceIndex}.json`), JSON.stringify(slice));
  for (const [name, body] of Object.entries(collectors)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
  }
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/test-paid-shards.ts'), '--tier', plan.tier, '--report', dir],
    { cwd: ROOT, encoding: 'utf8', timeout: 30_000, env: { ...process.env, EVALS_TIER: plan.tier } });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}`, dir };
}

const slice = (sliceIndex: number, sliceCount: number, outcomes: Outcome[]): SliceResult =>
  ({ version: 1, tier: 'periodic', profile: 'full', selection: { e2e: null, judges: null }, sliceIndex, sliceCount, outcomes });

describe('rule shards stay fail-closed through --report', () => {
  const plan = manifest([
    { file: RULE_A, slice: 1, status: 'planned' },
    { file: RULE_B, slice: 2, status: 'planned' },
  ], 2);

  test('all planned rule shards passed: green', () => {
    const r = report(plan, [slice(1, 2, [passed(RULE_A)]), slice(2, 2, [passed(RULE_B)])]);
    expect(r.status, r.out).toBe(0);
  });

  test('a failed rule shard: red, naming the file', () => {
    const r = report(plan, [slice(1, 2, [passed(RULE_A, { status: 'failed', exitCode: 1 })]), slice(2, 2, [passed(RULE_B)])]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`${RULE_A}: failed`);
  });

  test('a timed-out rule shard: red', () => {
    const r = report(plan, [slice(1, 2, [passed(RULE_A, { status: 'timed-out', exitCode: null })]), slice(2, 2, [passed(RULE_B)])]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`${RULE_A}: timed-out`);
  });

  test('a missing slice artifact: red', () => {
    const r = report(plan, [slice(1, 2, [passed(RULE_A)])]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('slice 2/2 reported NO result');
  });

  test('a planned shard no slice reported: red', () => {
    const r = report(plan, [slice(1, 2, [passed(RULE_A)]), slice(2, 2, [])]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`planned ${RULE_B} (slice 2) was never reported`);
  });

  test('a hollow shard under EVALS_ALL: red', () => {
    const r = report(plan, [slice(1, 2, [passed(RULE_A, { status: 'passed-empty', executedTests: 0 })]), slice(2, 2, [passed(RULE_B)])]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`${RULE_A}: passed-empty`);
  });

  test('a never-started shard: red', () => {
    const r = report(plan, [slice(1, 2, [passed(RULE_A, { status: 'never-started', exitCode: null, executedTests: null })]), slice(2, 2, [passed(RULE_B)])]);
    expect(r.status).toBe(1);
  });

  test('a failed collector record under a passing shard: red', () => {
    const r = report(plan, [slice(1, 2, [passed(RULE_A)]), slice(2, 2, [passed(RULE_B)])], {
      'shards/skill-e2e-fail-open-alpha/run.json': { tier: 'e2e', total_tests: 1, total_cost_usd: 0,
        tests: [{ name: 'alpha', suite: 's', tier: 'e2e', passed: false, duration_ms: 1, cost_usd: 0 }] },
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain('1 unapproved final collector failure(s)');
  });

  test('a shard reported by the wrong slice: red', () => {
    const r = report(plan, [slice(1, 2, [passed(RULE_A), passed(RULE_B)]), slice(2, 2, [])]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`${RULE_B} planned for slice 2 but reported by slice 1`);
  });
});
