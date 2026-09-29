/**
 * Sliced-lane wiring pins for the paid CI workflows — the successor to
 * evals-workflow-matrix.test.ts, which enforced completeness of a
 * hand-enumerated 17-row matrix (and carried KNOWN_MATRIX_GAPS /
 * KNOWN_TIER_UNSET burn-down ratchets for the files that matrix missed).
 * The matrix is deleted: the sliced lane's planner derives the gate census
 * from the runner itself (collectPaidTestFiles + tier selection), so "every
 * gate-hosting file is in the census" is true BY CONSTRUCTION and the
 * burn-down ratchets retired with the rows.
 *
 * What still needs pinning is the WIRING — the yml plumbing that free tests
 * are the only guard for:
 *   - the legacy matrix (and its `needs: evals` serialization) stays deleted,
 *   - planner/executor/report all run tier=gate and agree on the slice count,
 *   - both surviving lanes register skills through the SHARED composite that
 *     carries the fail-fast dangling-symlink/frontmatter verification loop
 *     (the sliced + periodic copies had silently dropped it — the loop was
 *     written after a silent "Unknown command" + 35-min-timeout incident),
 *   - the PR comment survives the matrix-report deletion (it moved into
 *     slices-report, keyed on the same "## E2E Evals" upsert marker).
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { buildRunManifest, parseCliOptions, sliceExecutionOrder, sliceSupervisedWallMs, CI_SETUP_ALLOWANCE_MINUTES } from '../scripts/test-paid-shards';

const ROOT = path.join(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const evalsYml = read('.github/workflows/evals.yml');
const periodicYml = read('.github/workflows/evals-periodic.yml');
const marathonYml = read('.github/workflows/evals-marathon.yml');
const registerAction = read('.github/actions/register-gstack-skills/action.yml');

/** Every planner site: its manifest path and budget (`--slice-budget S --jobs J`). */
function plannerSites(source: string): Array<{ manifest: string; budgetSeconds: number; jobs: number }> {
  return [...source.matchAll(/--emit-plan\s+(\S+)\s+--slice-budget\s+(\d+)\s+--jobs\s+(\d+)/g)]
    .map((m) => ({ manifest: m[1]!, budgetSeconds: Number(m[2]), jobs: Number(m[3]) }));
}

type Step = { id?: string; name?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> };
type Job = { needs?: string[]; env?: Record<string, string>; outputs?: Record<string, string>; 'timeout-minutes': string | number;
  strategy?: { 'max-parallel': number; matrix: { slice: string } }; steps: Step[] };

/**
 * An executor's matrix and timeout must come from the planner step that wrote
 * the manifest it downloads: `slices` from `[range(1; .sliceCount + 1)]` and
 * `timeout-minutes` from `.plan.ciTimeoutMinutes`, never hand-written numbers.
 */
function expectPlannedExecutor(source: string, executorName: string, prefix: string) {
  const workflow = Bun.YAML.parse(source) as { jobs: Record<string, Job> };
  const planner = workflow.jobs['plan-slices']!;
  const executor = workflow.jobs[executorName]!;
  expect(executor.needs).toContain('plan-slices');
  expect(executor.strategy!.matrix.slice).toBe(`\${{ fromJSON(needs.plan-slices.outputs.${prefix}slices) }}`);
  expect(executor['timeout-minutes']).toBe(`\${{ fromJSON(needs.plan-slices.outputs.${prefix}timeout_minutes) }}`);
  const [stepId] = /^\$\{\{ steps\.([\w-]+)\.outputs\.slices \}\}$/.exec(planner.outputs![`${prefix}slices`]!)!.slice(1);
  expect(planner.outputs![`${prefix}timeout_minutes`]).toBe(`\${{ steps.${stepId}.outputs.timeout_minutes }}`);
  const matrixStep = planner.steps.find(step => step.id === stepId)!;
  const manifest = /jq -c '\[range\(1; \.sliceCount \+ 1\)\]' (\S+)\)/.exec(matrixStep.run!)![1]!;
  expect(matrixStep.run).toContain(`jq -e '.plan.ciTimeoutMinutes' ${manifest})`);
  const emit = planner.steps.filter(step => step.run?.includes(`--emit-plan ${manifest} `));
  expect(emit).toHaveLength(1);
  const execute = executor.steps.filter(step => step.run?.includes('--plan '));
  expect(execute).toHaveLength(1);
  expect(execute[0]!.run).toContain(`--plan ${manifest} --slice \${{ matrix.slice }}`);
  expect(executor.steps.some(step => step.with?.path === manifest.replace(/\/manifest\.json$/, ''))).toBe(true);
  // The planner packs for exactly the executor's worker count.
  const site = plannerSites(emit[0]!.run!)[0]!;
  expect(execute[0]!.env?.EVALS_JOBS).toBe(String(site.jobs));
  return { site, emit: emit[0]!, execute: execute[0]!, executor, planner };
}

describe('evals.yml sliced-lane wiring (post-matrix)', () => {
  test('the legacy matrix job stays deleted', () => {
    // Row-enumeration shapes from the deleted matrix. Any reappearance means
    // someone is re-growing a hand-maintained enumeration next to a lane
    // whose census is derived — the drift class the deletion killed.
    expect(evalsYml).not.toMatch(/^\s+suite:\s*$/m);
    expect(evalsYml).not.toMatch(/^\s+file: test\//m);
    expect(evalsYml).not.toContain('needs: [build-image, evals]');
    expect(evalsYml).not.toMatch(/^\s+needs: evals\s*$/m);
  });

  test('no workflow-level EVALS_TIER env (each command sets its own)', () => {
    // The workflow-level `EVALS_TIER: gate` was dead config once every
    // consumer set its own; a resurrected copy would silently leak gate
    // semantics into steps that must choose explicitly.
    expect(evalsYml).not.toMatch(/^env:[\s\S]{0,120}^\s+EVALS_TIER:/m);
  });

  test('planner, executors, and report all run tier=gate on the shared runner', () => {
    expect(evalsYml).toMatch(/EVALS_TIER=gate bun --no-install run scripts\/test-paid-shards\.ts --tier gate --emit-plan/);
    expect(evalsYml).toMatch(/EVALS_TIER=gate bun run scripts\/test-paid-shards\.ts --tier gate --plan .* --slice /);
    expect(evalsYml).toMatch(/EVALS_TIER=gate bun --no-install run scripts\/test-paid-shards\.ts --tier gate --report /);
  });

  test('executor matrix and timeout come from the one budget planner', () => {
    expect(plannerSites(evalsYml), 'expected exactly one --emit-plan site in evals.yml').toHaveLength(1);
    const { site } = expectPlannedExecutor(evalsYml, 'eval-slices', '');
    expect(site).toEqual({ manifest: '/tmp/paid-plan/manifest.json', budgetSeconds: 540, jobs: 2 });
    // The validation-phase planner writes the same manifest with the same budget.
    expect(evalsYml).toContain('sliceBudgetMs: 540000, jobs: 2');
  });

  test('reconcile exit is captured via PIPESTATUS, never $? after a pipe', () => {
    // GitHub's default run-step shell is `bash -e {0}` with NO pipefail, so
    // `$?` after `... | tee` is tee's exit — always 0. That made the
    // fail-closed reconcile gate silently fail-open (ship review army,
    // 2026-08-31). Both lanes must read PIPESTATUS[0].
    for (const [name, source] of [['evals.yml', evalsYml], ['evals-periodic.yml', periodicYml], ['evals-marathon.yml', marathonYml]] as const) {
      const reconcileBlocks = [...source.matchAll(/--report[^\n]*\| tee[^\n]*\n([\s\S]{0,400}?)GITHUB_OUTPUT/g)];
      expect(reconcileBlocks.length, `${name}: expected a tee'd reconcile step`).toBeGreaterThanOrEqual(1);
      for (const block of reconcileBlocks) {
        expect(block[1], `${name} reconcile captures tee's exit, not the runner's`).toContain('PIPESTATUS[0]');
        expect(block[1]).not.toMatch(/exit=\$\?/);
      }
    }
  });

  test('the PR comment survived the matrix-report deletion (moved to slices-comment)', () => {
    // Keyed on the upsert marker so the migration keeps updating the SAME
    // comment; and the job holding it needs the issues permission (#1802).
    expect(evalsYml).toContain('## E2E Evals');
    expect(evalsYml).toMatch(/pull-requests: write/);
    expect(evalsYml).toMatch(/issues: write/);
  });

  test('the write-token job runs ZERO repo code (token/exec separation)', () => {
    // slices-report executes PR-authored code (bun install + the reconcile
    // runner), so it must hold contents:read ONLY; the write token lives in
    // slices-comment, which may only download artifacts and run jq/gh —
    // $GITHUB_ENV persistence is job-scoped, so this split IS the trust
    // boundary (codex adversarial, 2026-08-31; the matrix-era report job had
    // this property and the consolidation briefly regressed it).
    const commentJob = evalsYml.slice(evalsYml.indexOf('  slices-comment:'));
    expect(commentJob.length).toBeGreaterThan(100);
    expect(commentJob).not.toContain('actions/checkout');
    expect(commentJob).not.toContain('bun install');
    expect(commentJob).not.toMatch(/run: .*bun run/);
    expect(commentJob).not.toContain('uses: ./');
    // No checkout also means no git context: `gh pr comment` resolves the
    // repo FROM git and dies with "not a git repository" here (PR #2746's
    // first run). Every comment call must be explicit-repo REST (gh api).
    expect(commentJob).not.toContain('gh pr comment');
    // And the code-executing report job must NOT hold write scopes.
    const reportJob = evalsYml.slice(evalsYml.indexOf('  slices-report:'), evalsYml.indexOf('  slices-comment:'));
    expect(reportJob).not.toMatch(/pull-requests: write/);
    expect(reportJob).not.toMatch(/issues: write/);
  });
});

describe('evals-periodic.yml sliced-lane wiring', () => {
  const lanes = [
    { source: periodicYml, name: 'evals-periodic.yml', executor: 'eval-slices', prefix: 'periodic_', tier: 'periodic' },
    { source: periodicYml, name: 'evals-periodic.yml', executor: 'gate-census', prefix: 'gate_', tier: 'gate' },
    { source: evalsYml, name: 'evals.yml', executor: 'eval-slices', prefix: '', tier: 'gate' },
    { source: marathonYml, name: 'evals-marathon.yml', executor: 'eval-slices', prefix: '', tier: 'marathon' },
  ] as const;

  for (const lane of lanes) {
    test(`${lane.name}:${lane.executor} — the planned CI job cap covers every slice's supervised wall plus setup, and every slice starts at once`, () => {
      const { emit, execute, executor } = expectPlannedExecutor(lane.source, lane.executor, lane.prefix);
      const cliArgs = (run: string) => {
        const command = /\bbun(?: --no-install)? run scripts\/test-paid-shards\.ts /.exec(run);
        expect(command).not.toBeNull();
        return run.slice(command!.index + command![0].length)
          .replace(/\$\{\{\s*matrix\.slice\s*\}\}/g, '1').trim().split(/\s+/);
      };
      const workflow = Bun.YAML.parse(lane.source) as { env?: Record<string, string> };
      // The complete census (EVALS_ALL) is the largest plan any event can produce.
      const plannerEnv = { ...workflow.env, ...emit.env, EVALS_ALL: '1', EVALS_PROFILE: 'full' };
      const planned = parseCliOptions(cliArgs(emit.run!), plannerEnv);
      const active = parseCliOptions(cliArgs(execute.run!), { ...workflow.env, ...executor.env, ...execute.env, EVALS_PROFILE: 'full' });
      expect(planned.tier).toBe(lane.tier);
      expect(active.tier).toBe(lane.tier);
      expect(active.jobs).toBe(planned.jobs);
      const manifest = buildRunManifest({ tier: planned.tier, profile: 'full', sliceBudgetMs: planned.sliceBudgetMs!, jobs: planned.jobs,
        evalsAll: true, env: plannerEnv, rootDir: ROOT, skipJudges: planned.skipJudges });
      const walls = Array.from({ length: manifest.sliceCount }, (_, i) => sliceSupervisedWallMs(sliceExecutionOrder(
        manifest.entries.filter(entry => entry.status === 'planned' && entry.slice === i + 1)).map(entry => entry.file), planned.jobs));
      const requiredMinutes = Math.ceil(Math.max(0, ...walls) / 60_000) + CI_SETUP_ALLOWANCE_MINUTES;
      expect(CI_SETUP_ALLOWANCE_MINUTES).toBe(20);
      expect(manifest.plan!.ciTimeoutMinutes, `slice walls ${walls.join(', ')}ms`).toBe(requiredMinutes);
      // GitHub-hosted-style job ceiling: a plan past it must be split, not truncated.
      expect(manifest.plan!.ciTimeoutMinutes).toBeLessThanOrEqual(360);
      expect(manifest.sliceCount, `${lane.name}:${lane.executor} plans more slices than max-parallel starts at once`)
        .toBeLessThanOrEqual(executor.strategy!['max-parallel']);
    });
  }

  test('planner/executor/report tier=periodic agree and plan with the ~9-minute budget', () => {
    expect(periodicYml).toMatch(/EVALS_TIER=periodic bun --no-install run scripts\/test-paid-shards\.ts --tier periodic --emit-plan/);
    expect(periodicYml).toMatch(/EVALS_TIER=periodic bun run scripts\/test-paid-shards\.ts --tier periodic --plan .* --slice /);
    expect(periodicYml).toMatch(/EVALS_TIER=periodic bun --no-install run scripts\/test-paid-shards\.ts --tier periodic --report /);
    // Periodic work and the full gate census have distinct immutable plans.
    expect(plannerSites(periodicYml)).toEqual([
      { manifest: '/tmp/paid-plan/manifest.json', budgetSeconds: 540, jobs: 2 },
      { manifest: '/tmp/gate-census-plan/manifest.json', budgetSeconds: 540, jobs: 2 },
    ]);
  });
});

describe('evals-marathon.yml non-blocking lane', () => {
  const workflow = Bun.YAML.parse(marathonYml) as { on: Record<string, unknown>; env: Record<string, string>; jobs: Record<string, Job> };

  test('runs weekly and on dispatch, always fresh, with its own fail-closed report and tracking issue', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(workflow.env).toMatchObject({ EVALS_PROFILE: 'full', EVALS_FRESH: '1', EVALS_CACHE_PURPOSE: 'marathon' });
    expect(marathonYml).not.toContain('actions/cache');
    expect(marathonYml).toMatch(/EVALS_TIER=marathon bun --no-install run scripts\/test-paid-shards\.ts --tier marathon --emit-plan \/tmp\/marathon-plan\/manifest\.json --slice-budget 1 --jobs 1/);
    expect(marathonYml).toMatch(/EVALS_TIER=marathon bun run scripts\/test-paid-shards\.ts --tier marathon --plan .* --slice /);
    const report = workflow.jobs.report!;
    expect(report.needs).toEqual(['plan-slices', 'eval-slices']);
    const reconcile = report.steps.find(step => step.id === 'reconcile')!;
    expect(reconcile.run).toContain('EVALS_TIER=marathon bun --no-install run scripts/test-paid-shards.ts --tier marathon --report /tmp/marathon-report');
    const guards = report.steps.filter(step => /Upsert tracking|Fail the workflow/.test(step.name ?? ''));
    expect(guards).toHaveLength(2);
    for (const step of guards) {
      expect((step as { if?: string }).if).toContain("steps.reconcile.outputs.exit != '0'");
      expect((step as { if?: string }).if).toContain("needs.eval-slices.result != 'success'");
    }
    expect(marathonYml).toContain('Weekly marathon evals: red lane needs triage');
  });

  test('the blocking lanes never plan or execute the marathon tier', () => {
    for (const source of [evalsYml, periodicYml]) {
      expect(source).not.toContain('--tier marathon');
      expect(source).not.toContain('EVALS_TIER=marathon');
    }
  });
});

describe('shared setup composites (every paid lane)', () => {
  test('every lane registers skills through the shared composite', () => {
    for (const [name, source] of [['evals.yml', evalsYml], ['evals-periodic.yml', periodicYml], ['evals-marathon.yml', marathonYml]] as const) {
      expect(source, `${name} must use the register-gstack-skills composite`)
        .toContain('uses: ./.github/actions/register-gstack-skills');
      // No inline re-implementation creeping back beside the composite.
      expect(source, `${name} re-inlines the skill registry instead of using the composite`)
        .not.toContain('ln -snf "$REPO" "$SKILLS_DIR/gstack"');
    }
  });

  test('the register composite carries the fail-fast verification loop', () => {
    // The loop is the POINT of the composite: a dangling symlink or renamed
    // committed target fails in seconds with a named path, never as a wedged
    // PTY session at the shard wall. Pin its load-bearing markers.
    expect(registerAction).toContain('skill registry OK');
    expect(registerAction).toContain('skill-registry target missing');
    expect(registerAction).toContain('gstack root symlink dangles');
    expect(registerAction).toMatch(/grep -m1 "\^name: \$s\\\$"/);
  });

  test('seed/deps/temp composites exist and both lanes use them', () => {
    for (const action of ['seed-claude-config', 'restore-deps', 'fix-bun-temp']) {
      expect(fs.existsSync(path.join(ROOT, '.github', 'actions', action, 'action.yml')), `missing composite: ${action}`).toBe(true);
    }
    for (const [name, source] of [['evals.yml', evalsYml], ['evals-periodic.yml', periodicYml], ['evals-marathon.yml', marathonYml]] as const) {
      expect(source, `${name} must use seed-claude-config`).toContain('uses: ./.github/actions/seed-claude-config');
      expect(source, `${name} must use restore-deps`).toContain('uses: ./.github/actions/restore-deps');
      expect(source, `${name} must use fix-bun-temp`).toContain('uses: ./.github/actions/fix-bun-temp');
    }
  });
});
