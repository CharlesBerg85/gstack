#!/usr/bin/env bun
/**
 * test-paid-shards — enumerate, shard, and run the paid (gate/periodic) tier.
 *
 * The single-process `test:gate` fan-out has never completed a run: one wedged
 * or spinning file takes the whole tier down, and an in-process `--timeout`
 * cannot save it because a spinning main thread never fires a timer. This
 * runner applies the free tier's proven fix — one Bun process per shard — plus
 * the two things the paid tier additionally needs:
 *
 *   - an EXTERNAL wall-clock timeout that kills the shard's process GROUP, and
 *   - an aggregate that distinguishes failed from timed-out from never-started,
 *     so 26% execution can never again look like a pass.
 *
 * Why not Bun 1.3.13's native `--shard` / isolated runs? Three gaps, each one
 * fatal for this tier:
 *   1. No detached-process-group SIGKILL. Paid tests spawn `claude` / `codex`
 *      PTY grandchildren; when a shard hangs, in-process isolation kills the
 *      Bun worker but the grandchildren survive and burn cores for hours.
 *   2. No never-started taxonomy. A run that aborts partway reports only what
 *      executed — the shards that never ran are invisible, which is exactly
 *      the 26%-execution-looks-like-a-pass bug.
 *   3. No per-shard env / eval dir. Each shard needs its own GSTACK_EVAL_DIR
 *      so eval baselines are per-test-file instead of last-flush-wins.
 *
 * Worst-case wall clock = ceil(shards / jobs) × shard timeout. Shard counts
 * drift as test files land, so treat any number written here as stale.
 * Do NOT hand-derive the eval:bg:* detach timeouts from a snapshot of
 * these counts — test/eval-detach-timeout-floor.test.ts recomputes the bound
 * from the live shard census every run and fails CI if package.json's numbers
 * dip below it (undersized detach timeouts recreate never-started truncation).
 *
 * Env contract: EVALS_JOBS = how many shard PROCESSES run at once (this
 * runner). EVALS_CONCURRENCY = bun's --max-concurrency WITHIN a shard (and the
 * legacy single-process scripts). They were previously conflated: exporting
 * the legacy value 15 gave you 15 concurrent Bun processes each spawning
 * claude — the 429 storm.
 *
 * Enumeration matches package.json's `test:gate` globs (via the shared
 * test/helpers/paid-test-set.ts) and honors EVALS_TIER against the E2E_TIERS
 * map in test/helpers/touchfiles.ts. Output classification reuses
 * scripts/test-strict-output.ts rather than reimplementing it.
 *
 * Parallelism now lives ACROSS shards (--jobs), not inside one Bun process, so
 * each shard runs its own file sequentially and can be killed independently.
 *
 * Usage:
 *   bun run scripts/test-paid-shards.ts --list                # shard plan only
 *   bun run scripts/test-paid-shards.ts --tier gate           # run gate tier
 *   bun run scripts/test-paid-shards.ts --timeout 600 --jobs 2
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBootstrapRetentionScope } from '../test/helpers/bootstrap-retention';
import {
  BunTestOutputClassifier,
  exactTestFileSelectors,
  forwardAndClassify,
  isTerminationRequested,
  normalizeRelativePath,
  runShardChild,
  strictTestExitCode,
  type ShardChildResult,
} from './test-strict-output';
import { PAID_TEST_GLOBS, isPaidTestFile } from '../test/helpers/paid-test-set';
import { CASE_CI_EXCLUDE, CASE_QUARANTINE, EVAL_POLICY, PERIODIC_CI_EXCLUDE } from '../test/helpers/periodic-exclude-data';
import { FILE_RETRY_BUDGETS, STRICT_RETRY_CASE_BUDGETS } from '../test/helpers/eval-budgets';
import {
  getProjectEvalDir, getClaudeCliVersion, isFinalizedEvalResultFile, evalEntryOutcome, failureClassOf, panelVerdict,
  sanitizeTrialError, formatTrialOutcomes, CONTRACT_VIOLATIONS_FILE, TRIAL_ENV, TRIAL_OUTCOME_SCHEMA, TRIAL_OUTCOMES_FILE,
  type EvalCaseKind, type PanelShape, type PanelVerdict, type TrialFailureClass, type TrialOutcome, type TrialOutcomeRecord,
} from '../test/helpers/eval-store';
import { E2E_KINDS } from '../test/helpers/touchfiles-data';
import { manualReviewProblem } from '../test/helpers/cookie-workflow-manual-review';
import { preflightAnthropicApi } from '../test/helpers/anthropic-preflight';
import { OVERLAY_MIN_FILE_WALL_MS } from '../test/helpers/overlay-case-policy';
import { PR_PROFILE_CASE_IDS, PR_PROFILE_FILES, packageChangeOnlyVersion, selectPrProfile, type PrProfileSelection } from './test-pr-profile';
import { e2eReuseLaneProblem, prepareE2EShardReuse } from './e2e-shard-reuse';

type E2EShardReuse = NonNullable<ReturnType<typeof prepareE2EShardReuse>>;
import {
  detectBaseBranch,
  getChangedFiles,
  selectTests,
  E2E_TOUCHFILES,
  E2E_TIERS,
  LLM_JUDGE_TOUCHFILES,
  GLOBAL_TOUCHFILES,
} from '../test/helpers/touchfiles';

export { PAID_TEST_GLOBS, isPaidTestFile };
export { PERIODIC_CI_EXCLUDE };

const ROOT = path.resolve(import.meta.dir, '..');

export type PaidTier = 'gate' | 'periodic' | 'marathon';
export const PAID_TIERS: readonly PaidTier[] = ['gate', 'periodic', 'marathon'];
export type PaidProfile = 'pr' | 'full';

export interface PaidCaseSelection {
  e2e: string[] | null;
  judges: string[] | null;
}

export const DEFAULT_TIER: PaidTier = 'gate';
export const DEFAULT_SHARD_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_MAX_FILES_PER_SHARD = 1;
// 8 jobs × 2 within-shard ≈ 10-13 real in-flight sessions (39 of 75
// skill-e2e files hold exactly ONE test, so within-shard concurrency is
// dead weight for most shards) — under the documented-safe ~15 the legacy
// 40-way runner established. The old 4×4 yielded only ~4-6 in-flight and a
// 13-wave local gate worst case (~6.5h); 8×2 halves it. Watch the WS1
// flake telemetry for sustained 429 storms across 2 PR cycles — that is
// the rollback trigger. Prerequisite (landed): per-shard TMPDIR/
// CHROMIUM_PROFILE isolation in runPaidShard.
export const DEFAULT_JOBS = 8;
export const DEFAULT_WITHIN_SHARD_CONCURRENCY = 2;

/** One overlay process preserves the original process-wide SDK semaphore. */
export const OVERLAY_MAX_ACTIVE_SHARDS = 1;

export function isOverlayTestFile(file: string): boolean {
  return /^skill-e2e-overlay-harness-.+\.test\.ts$/.test(path.basename(normalizeRelativePath(file)));
}

/**
 * Files whose cases run in separate processes, one shard per registered E2E
 * case (`<file>#<case id>`): the file's lane wall exceeds one runner's budget
 * while every case is short. Separate processes also give each case its own
 * SDK semaphore, so shared-libs(-paths) capture waves never queue inside a
 * sibling case's wall (the reason paths runs test.serial in one process).
 * Every case must be a registered, literal E2E id whose Bun test name is the
 * id or its CASE_TEST_NAMES label (test/paid-shards.test.ts scans the sources).
 */
export const CASE_SHARDED_FILES: readonly string[] = [
  'test/skill-e2e-design.test.ts',
  'test/skill-e2e-plan.test.ts',
  'test/skill-e2e-review-army.test.ts',
  'test/skill-e2e-shared-libs-paths.test.ts',
  'test/skill-e2e-shared-libs.test.ts',
  'test/skill-e2e-ship-docsync.test.ts',
];

/** Bun test names that differ from their E2E id. */
export const CASE_TEST_NAMES: Record<string, string> = {
  'plan-review-report': '/plan-eng-review writes GSTACK REVIEW REPORT to plan file',
  'auq-format-gate': "/plan-ceo-review's first AskUserQuestion is a compliant decision brief (7/7 + substance)",
};

const CASE_KEY_SEPARATOR = '#';
const TRIAL_SUFFIX = /~t([1-9][0-9]*)$/;

/** The test file behind a shard key (`<file>`, `<file>#<case id>` or `<file>#<case id>~t<N>`). */
export function shardFile(key: string): string {
  return normalizeRelativePath(key).split(CASE_KEY_SEPARATOR)[0]!;
}

/** The E2E case id of a case or trial shard key, else null. */
export function shardCaseId(key: string): string | null {
  const [, id] = normalizeRelativePath(key).split(CASE_KEY_SEPARATOR);
  return id === undefined ? null : id.replace(TRIAL_SUFFIX, '');
}

/** The 1-based trial index of an isolated trial shard key, else null. */
export function shardTrial(key: string): number | null {
  const [, id] = normalizeRelativePath(key).split(CASE_KEY_SEPARATOR);
  const match = id === undefined ? null : TRIAL_SUFFIX.exec(id);
  return match ? Number(match[1]) : null;
}

/** Shard key of one trial of an isolated case. */
export function trialShardKey(file: string, id: string, trial: number): string {
  return `${normalizeRelativePath(file)}${CASE_KEY_SEPARATOR}${id}~t${trial}`;
}

/** Trial policy of one case, fixed from the registries before the run. */
export interface CaseTrialPlan { kind: EvalCaseKind; panel: PanelShape; quarantined: boolean }

/**
 * `behavior` cases run EVAL_POLICY.panel; a quarantined case runs a full panel
 * whose k keeps its kind's meaning (k = n for rule); everything else runs one
 * trial. Only behavior and quarantined cases are isolated into trial shards.
 */
export function caseTrialPlan(id: string, kinds: Record<string, EvalCaseKind> = E2E_KINDS,
  quarantine: Record<string, unknown> = CASE_QUARANTINE): CaseTrialPlan {
  const kind = kinds[id] ?? 'rule';
  const quarantined = Object.hasOwn(quarantine, id);
  if (kind === 'behavior') return { kind, panel: { ...EVAL_POLICY.panel }, quarantined };
  if (quarantined) return { kind, panel: { n: EVAL_POLICY.panel.n, k: EVAL_POLICY.panel.n }, quarantined };
  return { kind, panel: { n: 1, k: 1 }, quarantined };
}

export function isIsolatedCase(plan: CaseTrialPlan): boolean {
  return plan.kind === 'behavior' || plan.quarantined;
}

function sameTrialPlan(a: CaseTrialPlan | undefined, b: CaseTrialPlan | undefined): boolean {
  return !!a && !!b && a.kind === b.kind && a.quarantined === b.quarantined && a.panel?.n === b.panel?.n && a.panel?.k === b.panel?.k;
}

/** Bun name pattern that runs every case of a file except `ids` (their trial shards run them). */
export function excludedCasesNamePattern(ids: string[]): string {
  const escaped = ids.map(id => (CASE_TEST_NAMES[id] ?? id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `^(?!.*(?:^|\\s)(?:${escaped.join('|')})$)`;
}

/** Exact Bun name pattern for a set of case ids (labels where the test name differs). */
export function caseTestNamePattern(ids: string[]): string {
  const escaped = ids.map(id => (CASE_TEST_NAMES[id] ?? id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `(?:^|\\s)(?:${escaped.join('|')})$`;
}

/**
 * Replace each case-sharded file with one key per registered case of `tier`.
 * Throws when such a file's registration is not statically complete: an
 * unregistered case would otherwise silently never run.
 */
export function expandCaseShards(files: string[], tier: PaidTier, rootDir = ROOT,
  touchfiles: Record<string, string[]> = E2E_TOUCHFILES, tiers: Record<string, string> = E2E_TIERS): string[] {
  return files.flatMap(file => {
    const rel = normalizeRelativePath(file);
    if (!CASE_SHARDED_FILES.includes(rel)) return [file];
    const { registered, known } = fileCaseRegistration(rel, fs.readFileSync(path.join(rootDir, rel), 'utf8'), touchfiles, tiers);
    if (!known) throw new Error(`Case-sharded ${rel} needs a complete literal case registration`);
    return registered.filter(id => tiers[id] === tier).sort().map(id => `${rel}${CASE_KEY_SEPARATOR}${id}`);
  });
}

export interface TrialExpansion {
  keys: string[];
  /** Trial policy per trial shard key. */
  trials: Record<string, CaseTrialPlan>;
  /** File shard key -> isolated case ids its name pattern excludes. */
  excludeCases: Record<string, string[]>;
}

/**
 * Isolate every behavior or quarantined case of `tier` into its panel of trial
 * shards (`<file>#<id>~t1..tn`), each selected by EVALS_SELECTION_JSON=[id] and
 * its exact test name. The file shard keeps the remaining ids of the tier and
 * excludes the isolated ones by name; with none remaining it is dropped. A case
 * may be isolated only when its file's registration is statically known.
 */
export function expandTrialShards(keys: string[], tier: PaidTier, rootDir = ROOT, opts: {
  kinds?: Record<string, EvalCaseKind>; quarantine?: Record<string, unknown>;
  touchfiles?: Record<string, string[]>; tiers?: Record<string, string>;
} = {}): TrialExpansion {
  const touchfiles = opts.touchfiles ?? E2E_TOUCHFILES;
  const tiers = opts.tiers ?? E2E_TIERS;
  const planOf = (id: string) => caseTrialPlan(id, opts.kinds, opts.quarantine);
  const out: TrialExpansion = { keys: [], trials: {}, excludeCases: {} };
  const addPanel = (file: string, id: string) => {
    const plan = planOf(id);
    for (let trial = 1; trial <= plan.panel.n; trial++) {
      const key = trialShardKey(file, id, trial);
      out.keys.push(key);
      out.trials[key] = plan;
    }
  };
  for (const key of keys) {
    const file = shardFile(key);
    const caseId = shardCaseId(key);
    if (caseId !== null) {
      if (isIsolatedCase(planOf(caseId))) addPanel(file, caseId);
      else out.keys.push(key);
      continue;
    }
    const { registered, known } = fileCaseRegistration(file, fs.readFileSync(path.join(rootDir, file), 'utf8'), touchfiles, tiers);
    const inTier = registered.filter(id => tiers[id] === tier);
    const isolated = inTier.filter(id => isIsolatedCase(planOf(id)));
    if (isolated.length === 0) { out.keys.push(key); continue; }
    if (!known) {
      throw new Error(`${file}: behavior or quarantined case(s) ${isolated.join(', ')} need a statically known case registration`);
    }
    for (const id of isolated) addPanel(file, id);
    if (inTier.length > isolated.length) {
      out.keys.push(key);
      out.excludeCases[normalizeRelativePath(key)] = [...isolated].sort();
    }
  }
  return out;
}

/**
 * Split expanded shard keys into runnable keys and CI-unrunnable cases
 * (CASE_CI_EXCLUDE), each with its surfaced reason; never an empty shard.
 */
export function partitionCaseExclusions(keys: string[]): { runnable: string[]; excluded: Array<{ file: string; reason: string }> } {
  const excluded: Array<{ file: string; reason: string }> = [];
  const runnable = keys.filter(key => {
    const exclusion = CASE_CI_EXCLUDE[normalizeRelativePath(key)];
    if (exclusion) excluded.push({ file: key, reason: `excluded: ${exclusion.reason} [${exclusion.tracking}]` });
    return !exclusion;
  });
  return { runnable, excluded };
}

/** Compatibility helper for callers that only need the effective wall. */
export function resolvePaidShardTimeoutMs(files: string[], explicitTimeoutMs?: number): number {
  return resolvePaidShardBudget(files, explicitTimeoutMs).timeoutMs;
}

export function collectPaidTestFiles(rootDir = ROOT): string[] {
  const testDir = path.join(rootDir, 'test');
  if (!fs.existsSync(testDir)) return [];
  return fs.readdirSync(testDir)
    .map((name) => `test/${name}`)
    .filter(isPaidTestFile)
    .sort();
}

export interface TierClassification {
  included: boolean;
  reason: string;
}

/**
 * Decide whether a paid test file has anything to run in `tier`.
 *
 * Per-TEST tier filtering already happens at runtime: test/helpers/e2e-helpers.ts
 * intersects the selected tests with E2E_TIERS whenever EVALS_TIER is set, and
 * this runner passes EVALS_TIER down to every shard. So this file-level pass is
 * only an optimization — skipping a file merely saves one near-instant shard.
 *
 * Exclusion is the dangerous direction (a wrongly-skipped gate test is exactly
 * the invisible-non-execution bug this runner exists to kill), so the only
 * exclusion evidence accepted is an explicit whole-file tier guard: either the
 * raw `EVALS_TIER === '<other>'` predicate or the consolidated helper form
 * `describeE2ETier('<other>')` / `e2eTierEnabled('<other>')` from
 * test/helpers/e2e-gate.ts (same semantics, read from env at module load).
 * Inferring a file's tier from which E2E_TIERS names appear in its source
 * is guesswork that silently drops real work: short keys like 'retro' match
 * unrelated strings, and LLM-judge tests are keyed off LLM_JUDGE_TOUCHFILES and
 * carry no E2E_TIERS name at all. Everything without an explicit other-tier
 * guard runs and self-skips.
 */
export function classifyPaidTestFile(source: string, tier: PaidTier): TierClassification {
  const declares = (candidate: PaidTier) =>
    new RegExp(`EVALS_TIER\\s*===\\s*['"\`]${candidate}['"\`]`).test(source) ||
    new RegExp(`\\b(?:describeE2ETier|e2eTierEnabled)\\(\\s*['"\`]${candidate}['"\`]`).test(source);

  if (declares(tier)) return { included: true, reason: `declares tier '${tier}'` };
  const others = PAID_TIERS.filter(candidate => candidate !== tier && declares(candidate));
  if (others.length) return { included: false, reason: `declares tier ${others.map(other => `'${other}'`).join(' and ')} only` };
  return { included: true, reason: 'no whole-file tier guard — runtime E2E_TIERS filter decides' };
}

/**
 * The E2E ids a paid file registers: the touchfile registrations that list the
 * file. `known` is true only when those ids are complete: no computed
 * registration (testName, *IfSelected, describeIfSelected with a non-literal
 * argument) and every literal registration argument is among them. Quoted
 * strings elsewhere (comments, skill paths) never count.
 */
export function fileCaseRegistration(
  file: string, source: string,
  touchfiles: Record<string, string[]> = E2E_TOUCHFILES,
  tiers: Record<string, string> = E2E_TIERS,
): { registered: string[]; known: boolean } {
  const rel = normalizeRelativePath(file);
  const registered = Object.keys(touchfiles).filter(key => touchfiles[key]!.includes(rel));
  const computed = /testName\s*:\s*(?!string\b)(?:`[^`]*\$\{|[A-Za-z_$])/.test(source)
    || /\btest(?:Concurrent)?IfSelected\s*\(\s*(?:`[^`]*\$\{|[A-Za-z_$])/.test(source)
    || /\bdescribeIfSelected\s*\([^,]*,(?!\s*\[)/.test(source)
    || [...source.matchAll(/\bdescribeIfSelected\s*\([^,]*,\s*\[([^\]]*)\]/g)].some(m => m[1]!.split(',')
      .map(item => item.trim()).some(item => item && !/^(['"`])[^'"`$]*\1$/.test(item)));
  const literal = [
    ...[...source.matchAll(/testName\s*:\s*(['"`])([^'"`]+)\1/g)].map(m => m[2]!),
    ...[...source.matchAll(/\btest(?:Concurrent)?IfSelected\s*\(\s*(['"`])([^'"`]+)\1/g)].map(m => m[2]!),
    ...[...source.matchAll(/\bdescribeIfSelected\s*\([^,]*,\s*\[([^\]]*)\]/g)]
      .flatMap(m => [...m[1]!.matchAll(/(['"`])([^'"`]+)\1/g)].map(n => n[2]!)),
  ].filter(id => id in tiers);
  return { registered, known: registered.length > 0 && !computed && literal.every(id => registered.includes(id)) };
}

/**
 * A file is skipped for a tier lane only when its registered E2E ids are fully
 * known (fileCaseRegistration) and none of them has that tier. Any computed
 * registration, an id missing from the file's touchfile registration, or no id at
 * all keeps today's scheduling (the child's runtime filter decides).
 */
export function tierSkipReason(
  file: string, source: string, tier: PaidTier,
  touchfiles: Record<string, string[]> = E2E_TOUCHFILES,
  tiers: Record<string, string> = E2E_TIERS,
): string | null {
  const { registered, known } = fileCaseRegistration(file, source, touchfiles, tiers);
  if (!known || registered.some(id => tiers[id] === tier)) return null;
  return `skipped: no E2E_TIERS id has tier ${tier}`;
}

/**
 * The marathon lane selects positively: a file runs there only when it
 * declares the marathon tier or registers a marathon-tier case. Files without
 * marathon work never cost a marathon runner, and gate/periodic files never
 * gain a third execution.
 */
export function marathonSkipReason(
  file: string, source: string,
  touchfiles: Record<string, string[]> = E2E_TOUCHFILES,
  tiers: Record<string, string> = E2E_TIERS,
): string | null {
  if (classifyPaidTestFile(source, 'marathon').reason === "declares tier 'marathon'") return null;
  const { registered } = fileCaseRegistration(file, source, touchfiles, tiers);
  return registered.some(id => tiers[id] === 'marathon') ? null : 'skipped: declares no marathon tier and registers no marathon case';
}

export interface TierSelection {
  selected: string[];
  excluded: Array<{ file: string; reason: string }>;
}

export function selectPaidTestFiles(files: string[], tier: PaidTier, rootDir = ROOT, env: NodeJS.ProcessEnv = process.env): TierSelection {
  const selected: string[] = [];
  const excluded: Array<{ file: string; reason: string }> = [];
  const carveSkill = tier === 'periodic' ? env.GSTACK_CARVE_SKILL?.trim() : undefined;
  const carveWrapper = (file: string) => /^test\/carve-section-loading-(.+)\.test\.ts$/.exec(normalizeRelativePath(file))?.[1];
  if (carveSkill && files.some(file => carveWrapper(file)) && !files.some(file => carveWrapper(file) === carveSkill)) {
    throw new Error(`GSTACK_CARVE_SKILL=${carveSkill} has no generic section-loading wrapper`);
  }
  // Scheduled-lane exclusions (documented-red / manual-hardware files): a
  // known-red weekly shard is triage waste locally AND in CI, so the list
  // applies to every periodic and marathon run, with the reason surfaced per file.
  const ciExcluded = (file: string): { reason: string; tracking: string } | undefined =>
    tier !== 'gate' ? PERIODIC_CI_EXCLUDE[normalizeRelativePath(file)] : undefined;
  for (const file of files) {
    // One wrapper per process means a child-side return now creates an empty
    // shard. Apply the existing explicit cost scope before planning processes.
    const skill = carveWrapper(file);
    if (carveSkill && skill && skill !== carveSkill) {
      excluded.push({ file, reason: `GSTACK_CARVE_SKILL=${carveSkill} selects another section-loading case` });
      continue;
    }
    const exclusion = ciExcluded(file);
    if (exclusion) {
      excluded.push({ file, reason: `excluded: ${exclusion.reason} [${exclusion.tracking}]` });
      continue;
    }
    const source = fs.readFileSync(path.join(rootDir, file), 'utf8');
    const classification = classifyPaidTestFile(source, tier);
    const skip = !classification.included ? null
      : tier === 'marathon' ? marathonSkipReason(file, source) : tierSkipReason(file, source, tier);
    if (classification.included && !skip) selected.push(file);
    else excluded.push({ file, reason: skip ?? classification.reason });
  }
  return { selected, excluded };
}

// --- Parent-side diff selection (shard skipping) ---

/**
 * The test names the parent mapper recognizes: every E2E map key. LLM-judge
 * keys are deliberately excluded — skill-llm-eval.test.ts is not a
 * skill-e2e-* file, so it is always kept (child self-skip authoritative).
 */
export const PARENT_MAPPER_TEST_NAMES: string[] = [
  ...new Set([...Object.keys(E2E_TOUCHFILES), ...Object.keys(E2E_TIERS)]),
];

/**
 * Which of `names` appear in `source` as a quoted string ('x', "x", or `x`).
 * Same class of detection test/e2e-tier-alignment.test.ts uses: exact
 * quote-delimited match, raw source (comments count — a false hit can only
 * KEEP a shard, and the registration union below covers constructed names).
 */
export function knownTestNamesInSource(source: string, names: Iterable<string>): string[] {
  const hits: string[] = [];
  for (const name of names) {
    if (
      source.includes(`'${name}'`)
      || source.includes(`"${name}"`)
      || source.includes(`\`${name}\``)
    ) hits.push(name);
  }
  return hits;
}

export interface PaidDiffSelection {
  /** null = run everything (EVALS_ALL, or no changes vs base). */
  selectedNames: Set<string> | null;
  reason: string;
  totalTests: number;
}

/**
 * Compute diff selection in the PARENT, mirroring the module-scope selection
 * block in test/helpers/e2e-helpers.ts exactly: EVALS_ALL → run all;
 * base = EVALS_BASE || detectBaseBranch || 'main'; empty changed-file union →
 * run all. (e2e-helpers additionally gates on EVALS=1, which this runner sets
 * for every child unconditionally, so the parent mirror omits it.)
 *
 * getChangedFiles THROWS on git errors (fail-closed) — the children would hit
 * the same throw at module load, so the parent surfaces it before any shard
 * spawns.
 */
export function computePaidDiffSelection(
  env: NodeJS.ProcessEnv = process.env,
  rootDir = ROOT,
): PaidDiffSelection {
  const totalTests = Object.keys(E2E_TOUCHFILES).length;
  if (env.EVALS_ALL) {
    return { selectedNames: null, reason: 'run-all (EVALS_ALL=1)', totalTests };
  }
  const baseBranch = env.EVALS_BASE || detectBaseBranch(rootDir) || 'main';
  const changedFiles = getChangedFiles(baseBranch, rootDir);
  if (changedFiles.length === 0) {
    return { selectedNames: null, reason: `run-all (no changes vs ${baseBranch})`, totalTests };
  }
  const selection = selectTests(changedFiles, E2E_TOUCHFILES, GLOBAL_TOUCHFILES, {
    baseRef: baseBranch, cwd: rootDir,
  });
  return { selectedNames: new Set(selection.selected), reason: selection.reason, totalTests };
}

/**
 * Serialize the parent's diff selection for shard children (EVALS_SELECTION_JSON).
 *
 * Children's e2e-helpers module-load path adopts this instead of re-deriving
 * the selection per shard — which, when touchfiles-data.ts is in the diff,
 * spawned one bun subprocess PER CHILD to evaluate the old data file (the
 * map-diff path in test/helpers/test-selection.ts, 20s timeout each; 46-68
 * redundant children per full run). `selected: null` means run-all, mirroring
 * PaidDiffSelection.selectedNames. The child-side parser lives in
 * test/helpers/e2e-helpers.ts (parseEvalsSelectionJson); round-trip parity is
 * pinned by test/paid-selection-propagation.test.ts.
 */
export function serializePaidDiffSelection(selection: PaidDiffSelection): string {
  return JSON.stringify({
    version: 1,
    selected: selection.selectedNames === null ? null : [...selection.selectedNames].sort(),
    reason: selection.reason,
  });
}

/** Both selectors are computed once; execution consumes the exact persisted IDs. */
export function computePaidCaseSelection(options: {
  profile: PaidProfile;
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  changedFiles?: string[];
  /** Whether package.json differs from the base only in `version`; computed from git when omitted. */
  packageVersionOnly?: boolean;
}): { selection: PaidCaseSelection; reason: string; coverage?: PrProfileSelection } {
  const env = options.env ?? process.env;
  const rootDir = options.rootDir ?? ROOT;
  const baseRef = env.EVALS_BASE || detectBaseBranch(rootDir) || 'main';
  const files = options.changedFiles ?? (env.EVALS_ALL ? [] : getChangedFiles(baseRef, rootDir));
  const all = !!env.EVALS_ALL || files.length === 0;
  const effectiveFiles = files.filter(file => options.profile !== 'pr' || file !== 'package.json' ||
    !(options.packageVersionOnly ?? packageVersionOnlySinceBase(rootDir, baseRef)));
  const sourceAliases = options.profile === 'pr' ? existingPromptSourceAliases(effectiveFiles, rootDir) : {};
  const selectionFiles = [...new Set([...effectiveFiles, ...Object.values(sourceAliases)])];
  const select = (table: Record<string, string[]>) => all ? null
    : selectTests(selectionFiles, table, GLOBAL_TOUCHFILES, { baseRef, cwd: rootDir }).selected;
  const selection = { e2e: select(E2E_TOUCHFILES), judges: select(LLM_JUDGE_TOUCHFILES) };
  if (options.profile === 'full') return { selection, reason: all ? 'run-all' : 'diff' };
  const coverage = selectPrProfile({ selectedE2E: selection.e2e, selectedJudges: selection.judges, changedFiles: effectiveFiles, sourceAliases });
  if (coverage.needsFullValidation) {
    throw new Error(`PR profile requires full validation: ${coverage.missingCoverage.join(', ')}. Use --profile full and the relevant periodic cases.`);
  }
  return { selection: { e2e: coverage.e2e, judges: coverage.judges }, reason: coverage.reasons.join('; '), coverage };
}

export function existingPromptSourceAliases(files: readonly string[], rootDir = ROOT): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const template = `${file}.tmpl`;
    try { if (fs.statSync(path.join(rootDir, template)).isFile()) aliases[file] = template; }
    catch { /* Unknown/generated-only content must keep its own dependency identity. */ }
  }
  return aliases;
}

function packageVersionOnlySinceBase(rootDir: string, baseRef: string): boolean {
  try {
    const options = { cwd: rootDir, encoding: 'utf8' as const, timeout: 10_000, maxBuffer: 1024 * 1024 };
    const base = spawnSync('git', ['merge-base', baseRef, 'HEAD'], options);
    const sha = base.stdout?.trim() ?? '';
    if (base.status !== 0 || !/^[a-f0-9]{40,64}$/.test(sha)) return false;
    const old = spawnSync('git', ['show', `${sha}:package.json`], options);
    return old.status === 0 && packageChangeOnlyVersion(old.stdout, fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  } catch { return false; }
}

/** Only audited per-case files, plus the separately selected judge, enter the fast profile. */
/** The selected PR-profile case ids a shard key owns (a case key owns at most its own case). */
/** `exclude`: isolated case ids a file shard leaves to their trial shards. */
function prProfileShardIds(key: string, selection: PaidCaseSelection, exclude: readonly string[] = []): string[] {
  const caseId = shardCaseId(key);
  return (PR_PROFILE_FILES[shardFile(key)] ?? [])
    .filter(id => (caseId === null || id === caseId) && (selection.e2e === null || selection.e2e.includes(id)) && !exclude.includes(id));
}

export function prProfileFileSelected(file: string, selection: PaidCaseSelection, exclude: readonly string[] = []): boolean {
  if (file === 'test/skill-llm-eval.test.ts') return selection.judges === null || selection.judges.length > 0;
  return prProfileShardIds(file, selection, exclude).length > 0;
}

export function expectedPrCaseCount(file: string, selection: PaidCaseSelection, exclude: readonly string[] = []): number {
  if (file === 'test/skill-llm-eval.test.ts') return selection.judges?.length ?? Object.keys(LLM_JUDGE_TOUCHFILES).length;
  return prProfileShardIds(file, selection, exclude).length;
}

export function prProfileTestNamePattern(file: string, selection: PaidCaseSelection, exclude: readonly string[] = []): string {
  const ids = file === 'test/skill-llm-eval.test.ts'
    ? selection.judges ?? Object.keys(LLM_JUDGE_TOUCHFILES)
    : prProfileShardIds(file, selection, exclude);
  if (ids.length === 0) throw new Error(`No selected PR cases for ${file}`);
  return caseTestNamePattern(ids);
}

export function paidSelectionEnv(profile: PaidProfile, selection: PaidCaseSelection, reason: string): NodeJS.ProcessEnv {
  const encode = (selected: string[] | null) => JSON.stringify({ version: 1, selected, reason });
  return { EVALS_PROFILE: profile, EVALS_SELECTION_JSON: encode(selection.e2e), EVALS_JUDGE_SELECTION_JSON: encode(selection.judges) };
}

export interface ShardSkipDecision {
  file: string;
  kept: boolean;
  reason: string;
}

export interface DiffSkipOptions {
  rootDir?: string;
  /** Injectable for tests. Throwing reads fail OPEN (shard kept). */
  readSource?: (file: string) => string;
  /** Injectable name census (default: PARENT_MAPPER_TEST_NAMES). */
  allNames?: string[];
  /** Injectable registration map (default: E2E_TOUCHFILES). */
  e2eTouchfiles?: Record<string, string[]>;
  /** File shard -> isolated case ids its trial shards run instead. */
  excludeCases?: Record<string, string[]>;
}

/**
 * Decide whether a paid test file can be skipped under the current diff
 * selection. A file's MAPPED names are the union of:
 *   - E2E map keys quoted in its source, and
 *   - E2E map keys whose dep list registers the file (the tier-alignment
 *     mapping) — this covers files whose testNames are constructed rather
 *     than literal.
 *
 * FAIL-OPEN by construction: run-all selection, non-skill-e2e paid files
 * (llm-judge / codex-e2e / routing, keyed off other maps),
 * unreadable sources, and files with zero mapped names all KEEP their shard —
 * the child's self-skip stays authoritative. A parent bug may only run
 * extra work, never drop it.
 */
export function diffSkipDecisionForFile(
  file: string,
  selectedNames: Set<string> | null,
  options: DiffSkipOptions = {},
): ShardSkipDecision {
  if (selectedNames === null) return { file, kept: true, reason: 'run-all selection' };
  const caseId = shardCaseId(file);
  if (caseId !== null) {
    return selectedNames.has(caseId) ? { file, kept: true, reason: `selected: ${caseId}` } : { file, kept: false, reason: `case ${caseId} not selected` };
  }
  const rel = normalizeRelativePath(file);
  if (!/^test\/skill-e2e-.*\.test\.ts$/.test(rel)) {
    return { file, kept: true, reason: 'non-skill-e2e paid file — child self-skip authoritative' };
  }
  let source: string;
  try {
    const read = options.readSource
      ?? ((f: string) => fs.readFileSync(path.join(options.rootDir ?? ROOT, f), 'utf8'));
    source = read(file);
  } catch {
    return { file, kept: true, reason: 'source unreadable — fail-open' };
  }
  const allNames = options.allNames ?? PARENT_MAPPER_TEST_NAMES;
  const touchfiles = options.e2eTouchfiles ?? E2E_TOUCHFILES;
  const quoted = knownTestNamesInSource(source, allNames);
  const registered = Object.keys(touchfiles).filter((k) => touchfiles[k].includes(rel));
  const isolated = options.excludeCases?.[rel] ?? [];
  const mapped = [...new Set([...quoted, ...registered])].filter(name => !isolated.includes(name));
  if (mapped.length === 0) {
    return { file, kept: true, reason: 'no mappable test names — fail-open, child self-skip authoritative' };
  }
  const selectedHere = mapped.filter((n) => selectedNames.has(n));
  if (selectedHere.length > 0) {
    const shown = selectedHere.slice(0, 3).join(', ') + (selectedHere.length > 3 ? ', …' : '');
    return { file, kept: true, reason: `selected: ${shown}` };
  }
  return { file, kept: false, reason: `none of its ${mapped.length} mapped test(s) selected` };
}

/**
 * Partition planned shards into runnable vs skipped-by-diff. A shard is
 * skipped only when EVERY file in it is skippable.
 */
export function partitionShardsByDiffSelection(
  shards: string[][],
  selectedNames: Set<string> | null,
  options: DiffSkipOptions = {},
): { runnable: string[][]; skipped: Array<{ files: string[]; reason: string }> } {
  if (selectedNames === null) return { runnable: shards, skipped: [] };
  const runnable: string[][] = [];
  const skipped: Array<{ files: string[]; reason: string }> = [];
  for (const shard of shards) {
    const decisions = shard.map((file) => diffSkipDecisionForFile(file, selectedNames, options));
    if (decisions.every((d) => !d.kept)) {
      skipped.push({ files: shard, reason: [...new Set(decisions.map((d) => d.reason))].join('; ') });
    } else {
      runnable.push(shard);
    }
  }
  return { runnable, skipped };
}

export function planPaidShards(
  files: string[],
  options: { maxFilesPerShard?: number } = {},
): string[][] {
  const size = Math.max(1, options.maxFilesPerShard ?? DEFAULT_MAX_FILES_PER_SHARD);
  const unique = [...new Set(files.map(normalizeRelativePath))].sort();
  const shards: string[][] = [];
  let pending: string[] = [];
  for (const file of unique) {
    if (isOverlayTestFile(file) || shardCaseId(file) !== null || FILE_RETRY_BUDGETS.some(budget => budget.file === shardFile(file))) {
      if (pending.length) shards.push(pending);
      pending = [];
      shards.push([file]);
    } else {
      pending.push(file);
      if (pending.length === size) { shards.push(pending); pending = []; }
    }
  }
  if (pending.length) shards.push(pending);
  return shards;
}

export interface PaidShardBudget {
  timeoutMs: number;
  source: 'explicit' | 'registered' | 'default';
  policyId: string | null;
}

/** Explicit caller limits win; registered supervision preserves existing attempts. */
export function resolvePaidShardBudget(files: string[], overrideMs?: number): PaidShardBudget {
  const finding = FILE_RETRY_BUDGETS.find(budget => files.map(shardFile).includes(budget.file));
  if (finding && files.length !== 1) throw new Error('Registered retry budget requires its own shard');
  if (overrideMs !== undefined && (!Number.isSafeInteger(overrideMs) || overrideMs <= 0 || overrideMs > 2_147_483_647)) {
    throw new Error('Shard timeout must be a finite positive timer-safe integer');
  }
  const overlay = files.some(isOverlayTestFile);
  if (overlay && files.length !== 1) throw new Error('Overlay budget requires its own shard');
  if (overlay && overrideMs !== undefined && overrideMs < OVERLAY_MIN_FILE_WALL_MS) {
    throw new Error(`Overlay shard requires at least ${OVERLAY_MIN_FILE_WALL_MS}ms; explicit wall ${overrideMs}ms cannot preserve its work and finalization budget`);
  }
  // A registered file's case shard supervises its one case.
  const registeredMs = finding && shardCaseId(files[0]!) !== null
    ? finding.caseMs + finding.shardReserveMs : finding?.shardMs;
  return {
    timeoutMs: overrideMs ?? (registeredMs ?? (overlay ? OVERLAY_MIN_FILE_WALL_MS : DEFAULT_SHARD_TIMEOUT_MS)),
    source: overrideMs !== undefined ? 'explicit' : finding ? 'registered' : 'default',
    policyId: finding?.id ?? null,
  };
}

function sameBudget(actual: PaidShardBudget | undefined, expected: PaidShardBudget): boolean {
  return actual?.timeoutMs === expected.timeoutMs && actual.source === expected.source && actual.policyId === expected.policyId;
}

export function buildPaidShardArgs(
  files: string[],
  timeoutMs: number,
  maxConcurrency: number = DEFAULT_WITHIN_SHARD_CONCURRENCY,
  retries?: number,
): string[] {
  // Explicit --concurrent/--max-concurrency: the legacy path always set one;
  // omitting it here made within-shard parallelism differ silently between
  // the two runners (observed: 1.6x sumdur/wall sharded vs 8x legacy).
  // Paid evals never retry (retriesForFiles); `--retry 0` is explicit so a
  // bunfig default can never reintroduce one.
  return ['test', ...files, '--retry', String(retries ?? 0), '--concurrent', `--max-concurrency=${maxConcurrency}`, `--timeout=${timeoutMs}`];
}

/**
 * Stable per-shard eval-dir slug: test filename sans extension, sanitized.
 * Stable across runs so each shard baselines against its own prior run.
 */
export function shardSlug(files: string[]): string {
  return files
    .map((file) => path.basename(shardFile(file)).replace(/\.test\.(?:[cm]?[jt]s|tsx|jsx)$/, '')
      + (shardCaseId(file) === null ? '' : `--${shardCaseId(file)}`)
      + (shardTrial(file) === null ? '' : `.t${shardTrial(file)}`))
    .join('+')
    .replace(/[^a-zA-Z0-9._+-]/g, '-');
}

export type ShardStatus =
  | 'passed'
  | 'failed'
  | 'timed-out'
  | 'never-started'
  | 'skipped-by-diff'
  // exit 0 with ZERO executed tests on a run that promised everything
  // (EVALS_ALL): the hollow-file green the census backstop exists to catch.
  // Under selective runs, 0-executed passed shards stay 'passed' (in-file
  // diff/tier self-skips are legitimate there) and get a WARNING line only.
  | 'passed-empty';

export interface ShardOutcome {
  shard: number;
  files: string[];
  status: ShardStatus;
  exitCode: number | null;
  elapsedMs: number;
  groupPid: number | null;
  /** Tests bun reported executing ("Ran N tests ..."), null when unknown. */
  executedTests: number | null;
  /** Tests bun reported skipping (" N skip" count line), null when unknown.
   *  "Ran N tests" COUNTS skips, so executedTests alone cannot distinguish a
   *  shard that verified work from one whose every test self-skipped —
   *  codex/gemini files green-by-skip on every CI runner (no binary) and the
   *  weekly census read them as covered. */
  skippedTests: number | null;
  /** Effective supervised wall; absent only for unstarted or legacy outcomes. */
  budget?: PaidShardBudget;
  /** Present when a verified receipt replaced execution (PR lane only). */
  reused?: { inputKey: string; runId: string; revision: string; completedAt: number };
  /** The parent could not run the shard at all (a runner error, never a trial verdict). */
  runnerError?: string;
  /** Isolated trial shards only: the trial record this shard produced. */
  trial?: ShardTrialRecord;
}

/**
 * One isolated trial's record, derived from its shard status and the records
 * in its own eval dir. `outcome` null means the harness produced no trial
 * (never started, hollow, isolation broken, runner error): the panel is then
 * INCOMPLETE and the slice exits non-zero. A failed, timed-out or crashed
 * trial is a trial verdict; the slice still exits zero and the report decides.
 */
export interface ShardTrialRecord {
  case: string;
  trial: number;
  kind: EvalCaseKind;
  panel: PanelShape;
  quarantined: boolean;
  outcome: TrialOutcome | null;
  harness?: string;
  failure_class?: TrialFailureClass;
  exit_reason?: string;
  error?: string;
  timeout_at_turn?: number;
  cost_usd: number;
  duration_ms: number;
  model?: string;
}

/** Records and contract evidence an isolated shard left in its eval dir. */
export function readTrialEvidence(evalDir: string | undefined): { records: any[]; contract: string | null } {
  if (!evalDir || !fs.existsSync(evalDir)) return { records: [], contract: null };
  const names = fs.readdirSync(evalDir);
  const parse = (name: string) => { try { return JSON.parse(fs.readFileSync(path.join(evalDir, name), 'utf8')); } catch { return null; } };
  const finalized = names.filter(name => isFinalizedEvalResultFile(name) && !name.startsWith('e2e-reused-')).map(parse).filter(Boolean);
  const source = finalized.length ? finalized : names.filter(name => name.startsWith('_partial') && name.endsWith('.json')).map(parse).filter(Boolean);
  const records = source.flatMap((result: any) => Array.isArray(result?.tests) ? result.tests.filter((t: any) => t && typeof t === 'object') : []);
  let contract: string | null = records.find((t: any) => t.failure_class === 'contract')?.error ?? null;
  if (records.some((t: any) => t.failure_class === 'contract') && contract === null) contract = 'contract violation';
  try {
    const line = fs.readFileSync(path.join(evalDir, CONTRACT_VIOLATIONS_FILE), 'utf8').split('\n').find(l => l.trim());
    if (line) contract = String(JSON.parse(line).message ?? 'contract violation');
  } catch { /* no sidecar */ }
  return { records, contract };
}

/** Classify one isolated trial shard. Contract evidence always fails the trial. */
export function classifyTrialShard(
  outcome: Pick<ShardOutcome, 'status' | 'executedTests' | 'skippedTests' | 'elapsedMs' | 'runnerError'>,
  caseId: string, trial: number, plan: CaseTrialPlan,
  evidence: { records: any[]; contract: string | null },
): ShardTrialRecord {
  const failedRecord = evidence.records.find(record => record.passed === false) ?? evidence.records[0];
  const base: ShardTrialRecord = {
    case: caseId, trial, kind: plan.kind, panel: plan.panel, quarantined: plan.quarantined, outcome: null,
    cost_usd: Math.round(evidence.records.reduce((sum, record) => sum + (Number(record.cost_usd) || 0), 0) * 100) / 100,
    duration_ms: outcome.elapsedMs,
    ...(typeof failedRecord?.model === 'string' ? { model: failedRecord.model } : {}),
  };
  const failed = (failureClass: TrialFailureClass, error?: string): ShardTrialRecord => ({
    ...base, outcome: 'failed', failure_class: evidence.contract !== null ? 'contract' : failureClass,
    ...(failedRecord?.exit_reason ? { exit_reason: String(failedRecord.exit_reason) } : {}),
    ...(Number.isInteger(failedRecord?.timeout_at_turn) ? { timeout_at_turn: failedRecord.timeout_at_turn } : {}),
    ...(sanitizeTrialError(evidence.contract ?? failedRecord?.error ?? error) ? { error: sanitizeTrialError(evidence.contract ?? failedRecord?.error ?? error) } : {}),
  });
  if (outcome.runnerError !== undefined) return { ...base, harness: `runner error: ${sanitizeTrialError(outcome.runnerError) ?? 'unknown'}` };
  if (outcome.status === 'never-started') return { ...base, harness: 'never started' };
  if (outcome.status === 'passed-empty') return { ...base, harness: 'hollow: executed no case' };
  if (outcome.status === 'skipped-by-diff') return { ...base, harness: 'skipped by diff' };
  const known = outcome.executedTests !== null && outcome.skippedTests !== null;
  const ran = known ? outcome.executedTests! - outcome.skippedTests! : null;
  if (outcome.status === 'timed-out') {
    if (ran !== null && ran > 1) return { ...base, harness: `isolation broken: ${ran} cases ran` };
    return failed('timeout', 'shard wall reached');
  }
  if (ran === null) return outcome.status === 'failed' ? failed('infra', 'crashed without a test summary') : { ...base, harness: 'no test summary' };
  if (ran > 1) return { ...base, harness: `isolation broken: ${ran} cases ran` };
  if (ran === 0) {
    if (outcome.status === 'passed' && outcome.skippedTests! > 0 && evidence.contract === null) return { ...base, outcome: 'skipped' };
    if (outcome.status === 'failed') return failed('infra', 'the case never ran (load or setup failure)');
    return { ...base, harness: 'hollow: executed no case' };
  }
  if (outcome.status === 'passed') return evidence.contract !== null ? failed('contract') : { ...base, outcome: 'passed' };
  return failed(failedRecord ? failureClassOf(failedRecord) : 'assertion');
}

/**
 * True when a shard "passed" without verifying anything: every test bun ran
 * was a skip. Legitimate for external-service files on hosts without the
 * binary, but it must surface as a census warning, never read as coverage.
 */
export function isAllSkippedPass(outcome: Pick<ShardOutcome, 'status' | 'executedTests' | 'skippedTests'>): boolean {
  return outcome.status === 'passed'
    && outcome.executedTests !== null
    && outcome.executedTests > 0
    && outcome.skippedTests === outcome.executedTests;
}

export interface ShardCommand {
  command: string;
  args: string[];
}

/** Upper bound for one ordered FIFO group with the same admission limit.
 * At each launch the least-loaded worker has at most total prior work / jobs,
 * and at most floor(prior files / jobs) files of the largest prior wall.
 * Both bounds hold when earlier files finish below their ceilings. Overlay
 * groups must use their separate admission limit, as the runner does.
 */
export function paidShardWallUpperBoundMs(files: string[], jobs: number, overrideMs?: number): number {
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error('Worker count must be a positive integer');
  let priorWork = 0, priorLargest = 0, bound = 0;
  files.forEach((file, index) => {
    const wall = resolvePaidShardTimeoutMs([file], overrideMs);
    const start = Math.min(priorWork / jobs, Math.floor(index / jobs) * priorLargest);
    bound = Math.max(bound, start + wall);
    priorWork += wall;
    priorLargest = Math.max(priorLargest, wall);
  });
  return Math.ceil(bound);
}

export interface RunShardsOptions {
  timeoutMs?: number;
  registeredBudgets?: Record<string, PaidShardBudget>;
  jobs?: number;
  /** bun --max-concurrency inside each shard (EVALS_CONCURRENCY). */
  withinShardConcurrency?: number;
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  /** When set, each shard child gets GSTACK_EVAL_DIR=<evalDirBase>/shards/<slug>/. */
  evalDirBase?: string;
  /** Directory for the per-shard full-stream log files (default os.tmpdir()). Tests inject. */
  logDir?: string;
  /** Override the spawned command. Tests inject fake slow/spinning commands. */
  commandFor?: (files: string[]) => ShardCommand;
  log?: (line: string) => void;
  /** Fast-profile census: selected real cases per file, excluding Bun skips. */
  expectedCases?: Record<string, number>;
  casePatterns?: Record<string, string>;
  /** The selected case ids per shard key (reported for reused shards). */
  expectedCaseIds?: Record<string, string[]>;
  /** PR lane only: verified reuse for one shard's exact child environment and wall. */
  reuseFor?: (files: string[], env: NodeJS.ProcessEnv, budget: PaidShardBudget) => E2EShardReuse | null;
  /** Isolated trial shards: key -> the case's fixed trial plan. */
  trials?: Record<string, CaseTrialPlan>;
}

let shardLogSequence = 0;

/** Per-shard log path: slug + timestamp; pid + sequence defeat same-ms collisions. */
function nextShardLogPath(files: string[], logDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  shardLogSequence += 1;
  return path.join(logDir, `gstack-paid-shard-${shardSlug(files)}-${stamp}-${process.pid}-${shardLogSequence}.log`);
}

/** On-failure console excerpt budget: the last N bytes of the shard's log. */
export const FAILURE_TAIL_BYTES = 64 * 1024;

/** Read back only the tail of a shard log (never the whole 30-min stream). */
function readLogTail(logPath: string, maxBytes = FAILURE_TAIL_BYTES): string {
  try {
    const size = fs.statSync(logPath).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(logPath, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return ''; // a lost tail must never turn a real verdict into an exception
  }
}

export async function runPaidShard(
  files: string[],
  shardNumber: number,
  totalShards: number,
  options: RunShardsOptions = {},
): Promise<ShardOutcome> {
  if (files.length === 0) throw new Error('Cannot run an empty paid-test shard.');
  const rootDir = options.rootDir ?? ROOT;
  const planned = options.registeredBudgets?.[normalizeRelativePath(files[0]!)];
  const budget = resolvePaidShardBudget(files, options.timeoutMs ??
    (planned?.source === 'explicit' ? planned.timeoutMs : undefined));
  const timeoutMs = budget.timeoutMs;
  const streamLive = (options.jobs ?? DEFAULT_JOBS) === 1;
  const log = options.log ?? ((line: string) => console.log(line));
  const label = `[test:paid] shard ${shardNumber}/${totalShards}`;

  // A case shard runs exactly its one case; PR patterns narrow further.
  const caseId = files.length === 1 ? shardCaseId(files[0]!) : null;
  const casePattern = options.casePatterns?.[files[0]!] ?? (caseId !== null ? caseTestNamePattern([caseId]) : undefined);
  const expectedCases = options.expectedCases ?? (caseId !== null ? { [files[0]!]: 1 } : undefined);

  const env = { ...(options.env ?? process.env) };
  if (options.evalDirBase) {
    env.GSTACK_EVAL_DIR = path.join(options.evalDirBase, 'shards', shardSlug(files));
  }
  const trialPlan = files.length === 1 ? options.trials?.[normalizeRelativePath(files[0]!)] : undefined;
  const trialIndex = files.length === 1 ? shardTrial(files[0]!) : null;
  if (trialPlan && trialIndex !== null && caseId !== null) {
    // One case, one trial: the selection binds the child to exactly this id,
    // and eval-store stamps every record with the trial identity.
    Object.assign(env, {
      [TRIAL_ENV.caseId]: caseId, [TRIAL_ENV.kind]: trialPlan.kind, [TRIAL_ENV.trial]: String(trialIndex),
      [TRIAL_ENV.panelN]: String(trialPlan.panel.n), [TRIAL_ENV.panelK]: String(trialPlan.panel.k),
      [TRIAL_ENV.policyVersion]: String(EVAL_POLICY.version),
      EVALS_SELECTION_JSON: JSON.stringify({ version: 1, selected: [caseId], reason: `trial ${trialIndex}/${trialPlan.panel.n} of ${caseId}` }),
    });
  } else {
    for (const name of Object.values(TRIAL_ENV)) delete env[name];
  }
  const withTrial = (outcome: ShardOutcome): ShardOutcome => trialPlan && trialIndex !== null && caseId !== null
    ? { ...outcome, trial: classifyTrialShard(outcome, caseId, trialIndex, trialPlan, readTrialEvidence(env.GSTACK_EVAL_DIR)) }
    : outcome;
  // Resolve `claude --version` ONCE in the parent (cached across shards) and
  // hand it to every child: eval-store's fallback is a synchronous spawn on
  // the same thread that polls PTY sessions, so children must never pay it.
  if (!env.GSTACK_CLAUDE_CLI_VERSION) {
    env.GSTACK_CLAUDE_CLI_VERSION = getClaudeCliVersion();
  }
  // Verified first-attempt reuse (PR lane only; scripts/e2e-shard-reuse.ts):
  // identical consumed inputs to a fresh pass in this PR replace execution
  // with an explicitly reported reused result.
  // Bootstrap-retention qualification binds per-run state, so that shard stays fresh.
  const reuse = files.some(file => normalizeRelativePath(file) === 'test/skill-e2e-qa-workflow.test.ts')
    ? null : options.reuseFor?.(files, env, budget) ?? null;
  const reused = reuse?.lookup() ?? null;
  if (reused) {
    const reusedFrom = { input_key: reused.key, run_id: reused.source.runId, revision: reused.source.revision,
      completed_at: new Date(reused.source.completedAt).toISOString() };
    const caseIds = options.expectedCaseIds?.[files[0]!] ?? [];
    if (env.GSTACK_EVAL_DIR) {
      fs.mkdirSync(env.GSTACK_EVAL_DIR, { recursive: true });
      fs.writeFileSync(path.join(env.GSTACK_EVAL_DIR, `e2e-reused-${shardSlug(files)}.json`), `${JSON.stringify({
        schema_version: 1, tier: 'e2e', shard: shardSlug(files), total_tests: caseIds.length, executed_tests: 0,
        reused_tests: caseIds.length, passed: caseIds.length, failed: 0, total_cost_usd: 0, total_duration_ms: 0,
        tests: caseIds.map(name => ({ name, suite: shardSlug(files), tier: 'e2e', passed: true, duration_ms: 0, cost_usd: 0,
          execution: 'reused', reused_from: reusedFrom, attempt: 1 })),
      }, null, 2)}\n`);
    }
    log(`${label} REUSED ${files.join(' ')} — identical inputs passed in run ${reused.source.runId} at ${reusedFrom.completed_at}`);
    return withTrial({ shard: shardNumber, files, status: 'passed', exitCode: 0, elapsedMs: 0, groupPid: null,
      executedTests: caseIds.length, skippedTests: 0, budget,
      reused: { inputKey: reused.key, runId: reused.source.runId, revision: reused.source.revision, completedAt: reused.source.completedAt } });
  }
  const { command, args } = options.commandFor
    ? options.commandFor(files)
    : {
      command: process.execPath,
      args: [...buildPaidShardArgs(
        exactTestFileSelectors(files.map(shardFile), rootDir),
        timeoutMs,
        options.withinShardConcurrency ?? DEFAULT_WITHIN_SHARD_CONCURRENCY,
        retriesForFiles(files),
      ), ...(casePattern !== undefined ? ['--test-name-pattern', casePattern] : []),
      // Per-test outcomes for pass-rate history, keyed by Bun test name.
      ...(env.GSTACK_EVAL_DIR ? ['--reporter=junit', '--reporter-outfile', path.join(env.GSTACK_EVAL_DIR, 'junit.xml')] : [])],
    };
  if (env.GSTACK_EVAL_DIR) fs.mkdirSync(env.GSTACK_EVAL_DIR, { recursive: true });
  // Per-shard temp + Chromium-profile isolation — the free runner treats
  // this as mandatory (test-free-shards.ts: two concurrent shards on one
  // profile dir kill each other's browser; shared tmp cross-contaminates),
  // and the paid lane had NONE of it. Doubly load-bearing here: when a
  // shard hits its 30-min wall the group-SIGKILL means per-test afterAll
  // cleanup never runs — the rmSync backstop below is the only thing
  // stopping wedged runs from accumulating full git-repo workspaces in the
  // shared tmpdir forever. Prerequisite for raising EVALS_JOBS (more
  // concurrency on shared state amplifies exactly the opus-47 race class).
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-paid-shard-'));
  const childTmp = path.join(stateDir, 'tmp');
  fs.mkdirSync(childTmp);
  env.TMPDIR = childTmp;
  env.TEMP = childTmp;
  env.TMP = childTmp;
  env.CHROMIUM_PROFILE = path.join(stateDir, 'chromium-profile');
  const bootstrapFile = files.some(file => normalizeRelativePath(file) === 'test/skill-e2e-qa-workflow.test.ts');
  delete env.GSTACK_BOOTSTRAP_RETENTION;
  if (bootstrapFile && process.platform !== 'linux') log(`${label} bootstrap dependency retention unavailable on ${process.platform}; native behavior still runs without retained-dependency qualification`);
  const bootstrapRetention = bootstrapFile && process.platform === 'linux'
    ? createBootstrapRetentionScope(childTmp, path.join(env.GSTACK_EVAL_DIR || getProjectEvalDir(), 'bootstrap-retention'), env.EVALS_RUN_ID ||= `bootstrap-${Date.now()}-${process.pid}`)
    : undefined;
  if (bootstrapRetention) Object.assign(env, bootstrapRetention.env);
  let retentionFailed = false;

  const startedAt = Date.now();
  log(`${label} START ${files.join(' ')} (timeout ${Math.round(timeoutMs / 1000)}s, ${budget.source}${budget.policyId ? `: ${budget.policyId}` : ''})`);

  // Full-stream spool: EVERY child byte lands on disk (the free runner's
  // model), never in a whole-run Buffer[] — non-live shards used to hold
  // their entire 30-min stream-json stdout+stderr in RAM, × concurrent jobs.
  // Printed at START so a wedged shard is inspectable live, mid-run.
  const logPath = nextShardLogPath(files, options.logDir ?? os.tmpdir());
  const logStream = fs.createWriteStream(logPath);
  let logWriteFailed = false;
  logStream.on('error', (err) => {
    if (logWriteFailed) return;
    logWriteFailed = true;
    console.error(`${label} could not write the full log at ${logPath}: ${err.message}`);
  });
  log(`${label} full log: ${logPath}`);

  const classifier = new BunTestOutputClassifier();
  // Tee: the spool always gets the chunk; live mode (jobs=1) also forwards to
  // the console. forwardAndClassify feeds the classifier FIRST, so the strict
  // verdict path is unchanged by where the bytes land afterwards.
  const sink = (destination: NodeJS.WriteStream): NodeJS.WriteStream => ({
    write: (chunk: Buffer | string): boolean => {
      if (!logWriteFailed) logStream.write(chunk);
      if (streamLive) destination.write(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream);

  let exitCode: number | null = null;
  let timedOut = false;
  let groupPid: number | null = null;
  let incompleteCapture: ShardChildResult['incompleteCapture'];
  const shardDeadline = Date.now() + timeoutMs;
  try {
    // Shared spawn/detached/group-kill/wall-timer/reap lifecycle.
    const result = await runShardChild({
      command,
      args,
      cwd: rootDir,
      env,
      timeoutMs,
      deadlineMs: shardDeadline,
      hookStreams: (child) => {
        const streams: Array<Promise<void>> = [];
        if (child.stdout) streams.push(forwardAndClassify(child.stdout, sink(process.stdout), classifier, 'stdout'));
        if (child.stderr) streams.push(forwardAndClassify(child.stderr, sink(process.stderr), classifier, 'stderr'));
        return streams;
      },
    });
    exitCode = result.exitCode;
    timedOut = result.timedOut;
    groupPid = result.groupPid;
    incompleteCapture = result.incompleteCapture;
  } catch (error) {
    const result = (error as { shardResult?: ShardChildResult } | null)?.shardResult;
    if (result) {
      exitCode = result.exitCode;
      timedOut = result.timedOut;
      groupPid = result.groupPid;
      incompleteCapture = result.incompleteCapture;
    }
    throw error;
  } finally {
    if (incompleteCapture) log(`${label} incomplete child capture: ${JSON.stringify(incompleteCapture)}; retained log prefix: ${logPath}`);
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (complete: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        logStream.off('error', onError);
        logStream.off('close', onClose);
        if (!complete) {
          logWriteFailed = true;
          logStream.destroy();
          log(`${label} incomplete log capture; retained prefix: ${logPath}`);
        }
        resolve();
      };
      const onError = () => finish(false);
      const onClose = () => finish(logStream.writableFinished && !logWriteFailed);
      const expire = () => { timedOut = true; finish(false); };
      logStream.once('error', onError);
      logStream.once('close', onClose);
      if (Date.now() >= shardDeadline) { expire(); return; }
      if (logWriteFailed || logStream.destroyed) { finish(false); return; }
      timer = setTimeout(expire, shardDeadline - Date.now());
      try { logStream.end(() => finish(logStream.writableFinished && !logWriteFailed)); }
      catch { finish(false); }
    });
    let retentionRemovable = true;
    if (bootstrapRetention) {
      try {
        const retained = await bootstrapRetention.cleanup(shardDeadline);
        retentionFailed = !retained.complete;
        retentionRemovable = retained.removable;
        if (retentionFailed) log(`${label} bootstrap retention incomplete; qualification failed`);
      } catch {
        retentionFailed = true;
        retentionRemovable = false;
        log(`${label} bootstrap retention acknowledgment failed; preserving shard state`);
      }
    }
    try {
      // async rm: a SIGKILLed shard can leave a full git workspace + Chromium
      // profile here; a synchronous recursive delete on the parent's event
      // loop would stall every sibling shard's stream classification and
      // wall timers for seconds (review finding).
      if (retentionRemovable) await fs.promises.rm(stateDir, { recursive: true, force: true });
    } catch {
      // Best-effort: a locked file must not turn a real verdict into an
      // exception (same posture as the free runner's cleanup).
    }
  }

  const summary = classifier.end();

  // Pass expectedFiles so a shard whose bun child ran fewer files than planned
  // (or zero, all self-skipped) with exit 0 is NOT recorded 'passed' — the
  // invisible-non-execution class this runner exists to kill. bun prints
  // "Ran N tests across M files" with M = selected files even when every test
  // self-skips, so terminalFileCounts must include files.length. Enforced for
  // injected commandFor (tests) too, matching the free runner — fake passing
  // commands must print a synthetic `Ran N tests across M files. [Xms]` line,
  // so tests can pin the summary-missing => failure backstop.
  const expectedFiles = files.length;
  let status: ShardStatus = timedOut
    ? 'timed-out'
    : !retentionFailed && !logWriteFailed && !incompleteCapture && strictTestExitCode(exitCode ?? 1, summary, expectedFiles) === 0 ? 'passed' : 'failed';
  if (status === 'passed' && expectedCases) {
    const expected = files.reduce((count, file) => count + (expectedCases[file] ?? 0), 0);
    const actual = summary.terminalTestCounts.reduce((count, value) => count + value, 0) - summary.skippedTests;
    if (expected < 1 || actual !== expected) {
      status = 'failed';
      log(`${label} expected ${expected} selected cases, executed ${actual}; refusing incomplete case coverage`);
    }
  }
  const elapsedMs = Date.now() - startedAt;
  if (status === 'passed' && reuse) reuse.publish();

  // Failure debuggability without the RAM cost: read back only the log's
  // tail. Live mode already streamed everything, so no re-print there.
  if (status !== 'passed' && !streamLive) {
    const tail = readLogTail(logPath);
    if (tail.length > 0) {
      process.stdout.write(`${label} last ${Math.min(tail.length, FAILURE_TAIL_BYTES)} bytes of ${logPath}:\n`);
      process.stdout.write(tail.endsWith('\n') ? tail : `${tail}\n`);
    }
  }
  const logSuffix = status === 'passed' ? '' : ` — full log: ${logPath}`;
  log(`${label} ${status.toUpperCase()} in ${Math.round(elapsedMs / 1000)}s (exit ${exitCode ?? 'signal'})${logSuffix}`);

  const executedTests = summary.terminalTestCounts.length > 0
    ? summary.terminalTestCounts.reduce((a, b) => a + b, 0)
    : null;
  const skippedTests = summary.terminalTestCounts.length > 0 ? summary.skippedTests : null;
  return withTrial({ shard: shardNumber, files, status, exitCode, elapsedMs, groupPid, executedTests, skippedTests, budget });
}

export interface RunSummary {
  total: number;
  executed: number;
  passed: number;
  failed: number;
  timedOut: number;
  neverStarted: number;
  /** Shards the parent skipped via diff selection — successes, never conflated with never-started. */
  skippedByDiff: number;
  outcomes: ShardOutcome[];
}

export function summarize(outcomes: ShardOutcome[]): RunSummary {
  const count = (status: ShardStatus) => outcomes.filter((o) => o.status === status).length;
  return {
    total: outcomes.length,
    executed: outcomes.length - count('never-started') - count('skipped-by-diff'),
    passed: count('passed'),
    failed: count('failed') + count('passed-empty'),
    timedOut: count('timed-out'),
    neverStarted: count('never-started'),
    skippedByDiff: count('skipped-by-diff'),
    outcomes,
  };
}

/**
 * Hollow-shard guard. Under EVALS_ALL (the run promised EVERY test), a
 * passed shard whose bun summary reported 0 executed tests is not a pass —
 * it is the zero-execution class one layer down (file selected, every test
 * inside self-skipped, exit 0). Selective runs keep those shards 'passed'
 * (in-file diff/tier self-skips are legitimate) and only warn.
 */
export function applyHollowShardGuard(
  outcomes: ShardOutcome[],
  opts: { evalsAll: boolean; requireExecuted?: boolean; warn?: (line: string) => void },
): ShardOutcome[] {
  const warn = opts.warn ?? ((line: string) => console.error(line));
  return outcomes.map((outcome) => {
    if (opts.requireExecuted && outcome.status === 'passed' &&
        (outcome.executedTests === null || outcome.executedTests === 0 || isAllSkippedPass(outcome))) {
      return { ...outcome, status: 'passed-empty' };
    }
    if (outcome.status !== 'passed' || outcome.executedTests !== 0) return outcome;
    if (!opts.evalsAll) {
      warn(`[test:paid] WARNING: shard ${outcome.shard} passed with 0 executed tests (${outcome.files.join(' ')}) — legitimate under selection, hollow under EVALS_ALL`);
      return outcome;
    }
    return { ...outcome, status: 'passed-empty' };
  });
}

/**
 * Exit code for a finished run: skipped-by-diff shards are successes (the
 * parent proved none of their tests were selected); everything else must
 * have passed.
 */
export function summaryExitCode(summary: RunSummary): number {
  return summary.passed + summary.skippedByDiff === summary.total ? 0 : 1;
}

/** Run every shard in its own process. A timeout or failure never aborts the run. */
export async function runPaidShards(
  shards: string[][],
  options: RunShardsOptions = {},
): Promise<RunSummary> {
  const jobs = Math.max(1, options.jobs ?? DEFAULT_JOBS);
  const outcomes: ShardOutcome[] = shards.map((files, index) => ({
    shard: index + 1,
    files,
    status: 'never-started',
    exitCode: null,
    elapsedMs: 0,
    groupPid: null,
    executedTests: null,
    skippedTests: null,
  }));

  // Validate the whole batch before any child can spend or create artifacts.
  for (const files of shards) resolvePaidShardTimeoutMs(files, options.timeoutMs);
  const pending = shards.map((_, index) => index);
  let activeOverlayShards = 0;
  const waiters = new Set<() => void>();
  const wakeWorkers = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const worker = async (): Promise<void> => {
    while (true) {
      // Cancellation (SIGINT/SIGTERM) must stop the RUN: the signal
      // forwarders kill in-flight children, and this guard stops the pool
      // from launching replacement shards that would keep burning API spend.
      if (isTerminationRequested()) return;
      if (pending.length === 0) return;
      const position = pending.findIndex(index => !shards[index].some(isOverlayTestFile)
        || activeOverlayShards < OVERLAY_MAX_ACTIVE_SHARDS);
      if (position < 0) {
        await new Promise<void>(resolve => waiters.add(resolve));
        continue;
      }
      const [index] = pending.splice(position, 1);
      const overlay = shards[index].some(isOverlayTestFile);
      if (overlay) activeOverlayShards++;
      try {
        outcomes[index] = await runPaidShard(shards[index], index + 1, shards.length, { ...options, jobs });
      } catch (error) {
        const runnerError = error instanceof Error ? error.message : String(error);
        const failed: ShardOutcome = {
          shard: index + 1,
          files: shards[index],
          status: 'failed',
          exitCode: null,
          elapsedMs: 0,
          groupPid: null,
          executedTests: null,
          skippedTests: null,
          runnerError,
        };
        const key = shards[index].length === 1 ? normalizeRelativePath(shards[index][0]!) : '';
        const plan = options.trials?.[key];
        outcomes[index] = plan && shardCaseId(key) !== null && shardTrial(key) !== null
          ? { ...failed, trial: classifyTrialShard(failed, shardCaseId(key)!, shardTrial(key)!, plan, { records: [], contract: null }) }
          : failed;
        console.error(`[test:paid] shard ${index + 1} could not run: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (overlay) activeOverlayShards--;
        wakeWorkers();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(jobs, shards.length) }, worker));
  return summarize(outcomes);
}

export function formatSummary(summary: RunSummary): string[] {
  const lines = [
    '',
    `[test:paid] ${summary.executed}/${summary.total} shards executed — `
    + `${summary.passed} passed, ${summary.failed} failed, `
    + `${summary.timedOut} timed out, ${summary.neverStarted} never started, `
    + `${summary.skippedByDiff} skipped by diff`,
  ];
  for (const outcome of summary.outcomes) {
    // A pass whose every test skipped is labeled distinctly: it exited 0 but
    // verified NOTHING (codex/gemini files on hosts without the binary).
    // Status stays 'passed' — availability of an external service is not a
    // repo regression — but the census must never read it as coverage.
    const allSkipped = isAllSkippedPass(outcome) ? ` ⚠ all ${outcome.executedTests} tests SKIPPED — verified nothing` : '';
    lines.push(
      `  ${outcome.status.padEnd(15)} ${String(Math.round(outcome.elapsedMs / 1000)).padStart(5)}s  `
      + outcome.files.join(' ') + allSkipped,
    );
  }
  return lines;
}

// ─── Planner / executor / report (the CI re-platform surface) ──────────────
// One PLANNER computes selection and the slice plan ONCE; K executor jobs
// consume it; a REPORT reconciles results against the plan. This kills two
// classes at the root: per-slice selector divergence (one slice failing
// merge-base resolution and running a different partition than its siblings)
// and hollow lanes (a missing/failed slice that artifact-presence aggregation
// would read as green). CI wiring: evals.yml planner job → K-way matrix of
// `--plan manifest.json --slice i` → report job running `--report <dir>`.

export interface ManifestEntry {
  file: string;
  /** 1-based executor slice for planned entries; 0 for skipped/excluded. */
  slice: number;
  status: 'planned' | 'skipped-by-diff' | 'excluded';
  reason?: string;
  /** Required when a registered retry-budget file is planned. */
  budget?: PaidShardBudget;
  /** Budget-mode packing weight (recorded wall, or the whole budget when unknown). */
  estimatedMs?: number;
  /** Isolated trial shard (`<file>#<id>~t<N>`): the case's kind, fixed panel and quarantine at plan time. */
  trial?: CaseTrialPlan;
  /** File shard whose isolated cases run as trial shards: their ids, excluded by name here. */
  excludeCases?: string[];
}

/** Budget-mode plan: per-executor estimate and the CI job timeout it needs. */
export interface PaidSlicePlan {
  sliceBudgetMs: number;
  jobs: number;
  estimatedSliceMs: number[];
  ciTimeoutMinutes: number;
}

export interface PaidRunManifest {
  version: 1;
  tier: PaidTier;
  evalsAll: boolean;
  sliceCount: number;
  selectionReason: string;
  /** Legacy v1 manifests omit these; new plans bind case-level execution. */
  profile?: PaidProfile;
  selection?: PaidCaseSelection;
  prCoverage?: PrProfileSelection;
  plan?: PaidSlicePlan;
  entries: ManifestEntry[];
}

/**
 * Paid evals never retry (approved 2026-09-29): a failed verdict is final for
 * its run, and trials are fixed by kind before the run (EVAL_POLICY). The
 * function stays the single statement of that policy for the Bun arguments
 * and the reuse identity.
 */
export function retriesForFiles(_files: string[]): number {
  return 0;
}

export const PAID_TEST_DURATIONS_FILE = 'scripts/paid-test-durations.json';

/**
 * Recorded per-file paid-shard wall times (ms) per tier from real CI slice
 * reports (a file's gate and periodic cases differ), refreshed with
 * `--report <dir> --write-durations`. A packing hint only: a missing or
 * corrupt seed keeps the supervision-budget allocation.
 */
export function loadPaidTestDurations(rootDir = ROOT, tier: PaidTier = 'gate'): Record<string, number> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(rootDir, PAID_TEST_DURATIONS_FILE), 'utf8')) as { version?: unknown; tiers?: Record<string, Record<string, unknown>> };
    if (parsed.version !== 2) return {};
    return Object.fromEntries(Object.entries(parsed.tiers?.[tier] ?? {})
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0));
  } catch {
    return {};
  }
}

/** Rewrite one tier of the committed seed, keeping the other tiers. */
export function writePaidTestDurations(tier: PaidTier, durations: Record<string, number>, rootDir = ROOT): void {
  const target = path.join(rootDir, PAID_TEST_DURATIONS_FILE);
  const tiers = Object.fromEntries(PAID_TIERS.map(name => [name, loadPaidTestDurations(rootDir, name)])
    .filter(([name, recorded]) => name === tier || Object.keys(recorded as object).length > 0));
  tiers[tier] = durations;
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 2, recordedAt: new Date().toISOString(), tiers }, null, 2)}\n`);
  fs.renameSync(temporary, target);
}

/** Seed key of a shard: trials of one case share their case key (`<file>#<id>`). */
function durationKey(key: string): string {
  const rel = normalizeRelativePath(key);
  return shardTrial(rel) === null ? rel : `${shardFile(rel)}${CASE_KEY_SEPARATOR}${shardCaseId(rel)}`;
}

/** Recorded wall of a shard key; an unrecorded trial falls back to its whole file's wall. */
export function recordedShardMs(recorded: Record<string, number>, key: string): number | undefined {
  const rel = normalizeRelativePath(key);
  return recorded[durationKey(rel)] ?? (shardTrial(rel) === null ? undefined : recorded[shardFile(rel)]);
}

/**
 * Merge a report's executed single-file outcomes into the seed; all-skipped
 * shards carry no cost signal. Trials of one case record their longest wall
 * under the case key.
 */
export function mergePaidTestDurations(seed: Record<string, number>, results: SliceResult[]): Record<string, number> {
  const merged = { ...seed };
  const fresh = new Map<string, number>();
  for (const result of results) {
    for (const outcome of result.outcomes) {
      if (outcome.files.length !== 1 || outcome.elapsedMs < 1_000 || isAllSkippedPass(outcome) || outcome.reused) continue;
      const key = durationKey(outcome.files[0]!);
      fresh.set(key, Math.max(fresh.get(key) ?? 0, outcome.elapsedMs));
    }
  }
  for (const [key, ms] of fresh) merged[key] = ms;
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Panel identity of a trial shard key (`<file>#<id>`), else null. */
export function trialPanelKey(key: string): string | null {
  return shardTrial(key) === null ? null : durationKey(key);
}

/** True when `key` is a trial whose panel already has a trial in `planned`. */
function sharesPanel(planned: readonly string[], key: string): boolean {
  const panel = trialPanelKey(key);
  return panel !== null && planned.some(other => other !== key && trialPanelKey(other) === panel);
}

/** Setup, image pull and artifact upload allowance on top of a slice's supervised wall. */
export const CI_SETUP_ALLOWANCE_MINUTES = 20;

/** Estimated wall of one executor running `files` in order on `jobs` FIFO workers. */
export function estimatedSliceMs(files: string[], weight: (file: string) => number, jobs: number): number {
  const workers = Array<number>(Math.max(1, jobs)).fill(0);
  for (const file of files) {
    const next = workers.indexOf(Math.min(...workers));
    workers[next] += weight(file);
  }
  return Math.max(...workers);
}

/** Executor order within a slice: longest recorded work first, then by path. */
export function sliceExecutionOrder<T extends { file: string; estimatedMs?: number }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => (b.estimatedMs ?? 0) - (a.estimatedMs ?? 0) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** Supervised worst case of one slice in execution order, overlays at their own admission limit. */
export function sliceSupervisedWallMs(files: string[], jobs: number, overrideMs?: number): number {
  return paidShardWallUpperBoundMs(files.filter(file => !isOverlayTestFile(file)), jobs, overrideMs)
    + paidShardWallUpperBoundMs(files.filter(isOverlayTestFile), Math.min(jobs, OVERLAY_MAX_ACTIVE_SHARDS), overrideMs);
}

/**
 * Budget packing: one runner per file or per tightly packed group. Files go
 * longest-recorded-first into the fullest slice whose estimated wall stays
 * within the budget (best fit), else into a new slice. A file with no recorded
 * wall weighs the whole budget, so unknown cost gets a runner of its own. A
 * file longer than the budget runs alone. Overlay wrappers keep one shared
 * final slice (one wrapper at a time). The CI timeout covers every slice's
 * supervised worst case plus the setup allowance.
 */
export function packBySliceBudget(files: string[], budgetMs: number, jobs: number,
  recorded: Record<string, number>, timeoutMs?: number): {
  slices: string[][]; estimates: Record<string, number>; estimatedSliceMs: number[]; ciTimeoutMinutes: number;
} {
  const estimates = Object.fromEntries(files.map(file => [file, recordedShardMs(recorded, file) ?? budgetMs]));
  const weight = (file: string) => estimates[file]!;
  const slices: string[][] = [];
  for (const file of sliceExecutionOrder(files.filter(file => !isOverlayTestFile(file)).map(file => ({ file, estimatedMs: weight(file) }))).map(entry => entry.file)) {
    let best = -1, bestMs = -1;
    slices.forEach((planned, index) => {
      // Trials of one case never share a runner: independent machines, and
      // the panel's wall stays one trial long.
      if (sharesPanel(planned, file)) return;
      const ms = estimatedSliceMs([...planned, file], weight, jobs);
      if (ms <= budgetMs && ms > bestMs) { best = index; bestMs = ms; }
    });
    if (best < 0) slices.push([file]);
    else slices[best]!.push(file);
  }
  const overlays = files.filter(isOverlayTestFile).sort();
  if (overlays.length) slices.push(sliceExecutionOrder(overlays.map(file => ({ file, estimatedMs: weight(file) }))).map(entry => entry.file));
  if (!slices.length) slices.push([]);
  const estimatedSliceMsList = slices.map(planned => planned.some(isOverlayTestFile)
    ? estimatedSliceMs(planned, weight, Math.min(jobs, OVERLAY_MAX_ACTIVE_SHARDS)) : estimatedSliceMs(planned, weight, jobs));
  const worst = Math.max(0, ...slices.map(planned => sliceSupervisedWallMs(planned, jobs, timeoutMs)));
  return { slices, estimates, estimatedSliceMs: estimatedSliceMsList,
    ciTimeoutMinutes: Math.ceil(worst / 60_000) + CI_SETUP_ALLOWANCE_MINUTES };
}

/** Worker counts whose worst-case slice wall duration packing may never worsen. */
export const SUPERVISED_WORKER_COUNTS = [1, 2, 3, 4] as const;

/**
 * Allocate the RUNNABLE shard plan across K slices — deterministic. Registered
 * long files are spread by supervision budget and the rest round-robin; that
 * baseline fixes each slice's worst-case wall. With a duration seed, files are
 * then re-packed longest-recorded-first onto the lightest slice, accepting a
 * placement only if no slice's worst-case wall exceeds the baseline's maximum
 * for any supervised worker count. If any file cannot be placed, the baseline
 * stands.
 */
export function buildRunManifest(opts: {
  tier: PaidTier;
  profile?: PaidProfile;
  /** Fixed slice count; exclusive with sliceBudgetMs. */
  sliceCount?: number;
  /** Budget mode: pack recorded work so each executor's estimated wall stays
   * within this budget; the slice count follows from the plan. */
  sliceBudgetMs?: number;
  /** Shard workers per executor (EVALS_JOBS) that budget mode plans for. */
  jobs?: number;
  evalsAll: boolean;
  timeoutMs?: number;
  discovered?: string[];
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  changedFiles?: string[];
  /** Recorded per-file durations; defaults to the committed seed under rootDir. */
  durations?: Record<string, number>;
  /** Weekly gate census only: LLM judges already run in the periodic census and PR gate lanes. */
  skipJudges?: boolean;
  /** Injectable registries (default: E2E_KINDS and CASE_QUARANTINE). */
  kinds?: Record<string, EvalCaseKind>;
  quarantine?: Record<string, unknown>;
}): PaidRunManifest {
  const budgetMode = opts.sliceBudgetMs !== undefined;
  if (budgetMode === (opts.sliceCount !== undefined)) throw new Error('Plan with exactly one of --slices or --slice-budget');
  if (budgetMode && (!Number.isSafeInteger(opts.sliceBudgetMs) || opts.sliceBudgetMs! <= 0 || !Number.isSafeInteger(opts.jobs) || opts.jobs! <= 0)) {
    throw new Error('--slice-budget needs a positive budget and an explicit positive --jobs');
  }
  if (!budgetMode && (!Number.isInteger(opts.sliceCount) || opts.sliceCount! <= 0)) {
    throw new Error(`--slices needs a positive integer. Received: ${opts.sliceCount}`);
  }
  const rootDir = opts.rootDir ?? ROOT;
  const env = opts.env ?? process.env;
  const profile = opts.profile ?? validatedProfile(env.EVALS_PROFILE, 'EVALS_PROFILE');
  if (profile === 'pr' && opts.tier !== 'gate') throw new Error('PR profile requires gate tier; use --profile full for periodic coverage');
  const discovered = opts.discovered ?? collectPaidTestFiles(rootDir);
  const tierSelection = selectPaidTestFiles(discovered, opts.tier, rootDir, env);
  const judge = (file: string) => /^test\/skill-llm-eval[^/]*\.test\.ts$/.test(normalizeRelativePath(file));
  const selected = opts.skipJudges ? tierSelection.selected.filter(file => !judge(file)) : tierSelection.selected;
  const kinds = opts.kinds ?? E2E_KINDS;
  const quarantine = opts.quarantine ?? CASE_QUARANTINE;
  const notLive = [...Object.keys(kinds).filter(id => kinds[id] === 'behavior'), ...Object.keys(quarantine)].filter(id => !Object.hasOwn(E2E_TIERS, id));
  if (notLive.length) throw new Error(`Only live E2E cases can be behavior or quarantined (judges sample their panel inside the case): ${notLive.join(', ')}`);
  const caseKeys = partitionCaseExclusions(expandCaseShards(selected, opts.tier, rootDir));
  const excluded = [...tierSelection.excluded, ...(opts.skipJudges ? tierSelection.selected.filter(judge)
    .map(file => ({ file, reason: 'skipped: LLM judges run in the periodic census and PR gate lanes' })) : []), ...caseKeys.excluded];
  const expansion = expandTrialShards(caseKeys.runnable, opts.tier, rootDir, { kinds, quarantine });
  const excludeOf = (key: string) => expansion.excludeCases[normalizeRelativePath(key)] ?? [];
  const shards = planPaidShards(expansion.keys, { maxFilesPerShard: 1 });
  const cases = computePaidCaseSelection({ profile, env, rootDir, changedFiles: opts.changedFiles });
  const fast = cases.coverage?.mode === 'pr';
  const profileShards = fast ? shards.filter(files => prProfileFileSelected(files[0], cases.selection, excludeOf(files[0]!))) : shards;
  const { runnable, skipped } = partitionShardsByDiffSelection(profileShards,
    cases.selection.e2e === null ? null : new Set(cases.selection.e2e), { rootDir, excludeCases: expansion.excludeCases });
  if (fast) for (const files of shards) {
    if (!prProfileFileSelected(files[0], cases.selection, excludeOf(files[0]!))) skipped.push({ files, reason: 'Outside the fast PR profile; retained in broad gate/periodic coverage' });
  }
  const extras = (key: string): Pick<ManifestEntry, 'trial' | 'excludeCases'> => {
    const trial = expansion.trials[normalizeRelativePath(key)];
    const exclude = expansion.excludeCases[normalizeRelativePath(key)];
    return { ...(trial ? { trial } : {}), ...(exclude ? { excludeCases: exclude } : {}) };
  };

  const entries: ManifestEntry[] = [];
  if (budgetMode) {
    const plan = packBySliceBudget(runnable.map(files => files[0]!), opts.sliceBudgetMs!, opts.jobs!,
      opts.durations ?? loadPaidTestDurations(rootDir, opts.tier), opts.timeoutMs);
    plan.slices.forEach((files, index) => files.forEach(file => entries.push({ file, slice: index + 1, status: 'planned',
      estimatedMs: plan.estimates[file]!, ...extras(file),
      ...(FILE_RETRY_BUDGETS.some(budget => budget.file === shardFile(file)) ? { budget: resolvePaidShardBudget([file], opts.timeoutMs) } : {}) })));
    for (const s of skipped) entries.push({ file: s.files[0], slice: 0, status: 'skipped-by-diff', reason: s.reason, ...extras(s.files[0]!) });
    for (const e of excluded) entries.push({ file: e.file, slice: 0, status: 'excluded', reason: e.reason });
    entries.sort((a, b) => (a.file < b.file ? -1 : 1));
    return parseRunManifest(JSON.stringify({
      version: 1, tier: opts.tier, evalsAll: opts.evalsAll, sliceCount: plan.slices.length,
      selectionReason: cases.reason, profile, selection: cases.selection,
      ...(cases.coverage ? { prCoverage: cases.coverage } : {}),
      plan: { sliceBudgetMs: opts.sliceBudgetMs!, jobs: opts.jobs!, estimatedSliceMs: plan.estimatedSliceMs, ciTimeoutMinutes: plan.ciTimeoutMinutes },
      entries,
    } satisfies PaidRunManifest));
  }
  const sliceCount = opts.sliceCount!;
  const overlaySlice = sliceCount;
  const reserveOverlaySlice = overlaySlice > 1 && runnable.some(files => files.some(isOverlayTestFile));
  const ordinarySlices = overlaySlice - Number(reserveOverlaySlice);
  // Spread registered long files by supervised load. Keep one ordinary-only
  // lane when possible, so every lane does not inherit a long-workflow tail.
  // The reserved overlay slice retains its ownership.
  const ordinary = runnable.filter(files => !files.some(isOverlayTestFile));
  const registered = ordinary.filter(files => FILE_RETRY_BUDGETS.some(budget => budget.file === shardFile(files[0]!)));
  const allocations = new Map<string, number>();
  if (registered.length && ordinarySlices > 1) {
    const loads = Array<number>(ordinarySlices).fill(0);
    const longLanes = ordinarySlices - Number(registered.length < ordinary.length);
    const registeredFiles = new Set(registered.map(files => files[0]));
    const byWall = (a: string[], b: string[]) =>
      resolvePaidShardTimeoutMs(b, opts.timeoutMs) - resolvePaidShardTimeoutMs(a, opts.timeoutMs) ||
      (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    for (const files of [...registered].sort(byWall).concat(
      ordinary.filter(files => !registeredFiles.has(files[0])))) {
      const lanes = registeredFiles.has(files[0]) ? longLanes : ordinarySlices;
      const laneKeys = (index: number) => [...allocations].filter(([, lane]) => lane === index + 1).map(([key]) => key);
      let lane = -1;
      for (let index = 0; index < lanes; index++) {
        if (sharesPanel(laneKeys(index), files[0]!)) continue;
        if (lane < 0 || loads[index] < loads[lane]) lane = index;
      }
      if (lane < 0) lane = loads.slice(0, lanes).indexOf(Math.min(...loads.slice(0, lanes)));
      allocations.set(files[0], lane + 1);
      loads[lane] += resolvePaidShardTimeoutMs(files, opts.timeoutMs);
    }
  }
  let ordinaryIndex = 0;
  for (const files of ordinary) {
    if (allocations.has(files[0])) continue;
    // Round-robin, skipping a lane that already holds a trial of the same panel.
    let lane = ordinaryIndex % ordinarySlices;
    for (let step = 0; step < ordinarySlices; step++) {
      const candidate = (ordinaryIndex + step) % ordinarySlices;
      if (!sharesPanel([...allocations].filter(([, l]) => l === candidate + 1).map(([key]) => key), files[0]!)) { lane = candidate; break; }
    }
    ordinaryIndex++;
    allocations.set(files[0], lane + 1);
  }
  const packed = packByRecordedDuration();
  function packByRecordedDuration(): Map<string, number> | null {
    const recorded = opts.durations ?? loadPaidTestDurations(rootDir, opts.tier);
    if (ordinarySlices < 2 || ordinary.length === 0 || Object.keys(recorded).length === 0) return null;
    const bound = (files: string[], jobs: number) => paidShardWallUpperBoundMs([...files].sort(), jobs, opts.timeoutMs);
    const lanes = Array.from({ length: ordinarySlices }, (_, lane) =>
      ordinary.filter(files => allocations.get(files[0]) === lane + 1).map(files => files[0]));
    const caps = SUPERVISED_WORKER_COUNTS.map(jobs => Math.max(...lanes.map(files => bound(files, jobs))));
    const fits = (files: string[]) => SUPERVISED_WORKER_COUNTS.every((jobs, k) => bound(files, jobs) <= caps[k]);
    const known = ordinary.map(files => recordedShardMs(recorded, files[0]!))
      .filter((ms): ms is number => ms !== undefined).sort((a, b) => a - b);
    const fallback = known.length ? known[Math.min(known.length - 1, Math.floor(known.length * 0.75))] : 1;
    const weight = (file: string) => recordedShardMs(recorded, file) ?? fallback;
    const load = (files: string[]) => files.reduce((sum, file) => sum + weight(file), 0);
    const registeredFiles = new Set(registered.map(files => files[0]));
    // Local search from the supervised baseline: move or swap a file out of
    // the heaviest slice whenever that lowers its recorded load without
    // making the other slice the new maximum or breaching any worst-case cap.
    // Registered files only trade places with registered files, so the long
    // lanes keep their ownership.
    for (let step = 0; step < 10 * ordinary.length; step++) {
      const loads = lanes.map(load);
      const heavy = loads.indexOf(Math.max(...loads));
      let best: { gain: number; apply: () => void } | null = null;
      for (let other = 0; other < lanes.length; other++) {
        if (other === heavy) continue;
        for (const a of lanes[heavy]) {
          const moves: Array<string | null> = registeredFiles.has(a) ? lanes[other].filter(b => registeredFiles.has(b)) : [null, ...lanes[other].filter(b => !registeredFiles.has(b))];
          for (const b of moves) {
            const delta = weight(a) - (b === null ? 0 : weight(b));
            if (delta <= 0 || loads[other] + delta >= loads[heavy]) continue;
            const gain = Math.min(delta, loads[heavy] - loads[other] - delta);
            if (best && gain <= best.gain) continue;
            const heavyAfter = lanes[heavy].filter(file => file !== a).concat(b === null ? [] : [b]);
            const otherAfter = lanes[other].filter(file => file !== b).concat([a]);
            if (!fits(heavyAfter) || !fits(otherAfter)) continue;
            if (sharesPanel(otherAfter, a) || (b !== null && sharesPanel(heavyAfter, b))) continue;
            const [h, o] = [heavy, other];
            best = { gain, apply: () => { lanes[h] = heavyAfter; lanes[o] = otherAfter; } };
          }
        }
      }
      if (!best) break;
      best.apply();
    }
    return new Map(lanes.flatMap((files, lane) => files.map(file => [file, lane + 1] as const)));
  }
  runnable.forEach((files) => {
    const slice = files.some(isOverlayTestFile) ? overlaySlice : (packed ?? allocations).get(files[0])!;
    entries.push({ file: files[0], slice, status: 'planned', ...extras(files[0]!),
      ...(FILE_RETRY_BUDGETS.some(budget => budget.file === shardFile(files[0]!))
        ? { budget: resolvePaidShardBudget(files, opts.timeoutMs) } : {}) });
  });
  for (const s of skipped) entries.push({ file: s.files[0], slice: 0, status: 'skipped-by-diff', reason: s.reason, ...extras(s.files[0]!) });
  for (const e of excluded) entries.push({ file: e.file, slice: 0, status: 'excluded', reason: e.reason });
  entries.sort((a, b) => (a.file < b.file ? -1 : 1));

  const manifest: PaidRunManifest = {
    version: 1,
    tier: opts.tier,
    evalsAll: opts.evalsAll,
    sliceCount,
    selectionReason: cases.reason,
    profile,
    selection: cases.selection,
    ...(cases.coverage ? { prCoverage: cases.coverage } : {}),
    entries,
  };
  return parseRunManifest(JSON.stringify(manifest));
}

/**
 * Narrow a built manifest to a curated case subset (validation phases): the
 * selection binds every child, and a case shard outside it can execute
 * nothing, so it becomes skipped instead of an empty planned shard.
 */
export function restrictManifestSelection(manifest: PaidRunManifest, selection: PaidCaseSelection, reason: string): PaidRunManifest {
  const entries = manifest.entries.map(entry => {
    const caseId = shardCaseId(entry.file);
    if (entry.status !== 'planned' || caseId === null || selection.e2e === null || selection.e2e.includes(caseId)) return entry;
    const { estimatedMs: _estimate, budget: _budget, ...rest } = entry;
    return { ...rest, slice: 0, status: 'skipped-by-diff' as const, reason };
  });
  return parseRunManifest(JSON.stringify({ ...manifest, selection, entries }));
}

export function parseRunManifest(raw: string): PaidRunManifest {
  const parsed = JSON.parse(raw) as PaidRunManifest;
  if (parsed.version !== 1) throw new Error(`unsupported manifest version: ${(parsed as { version?: unknown }).version}`);
  if (!PAID_TIERS.includes(parsed.tier)) throw new Error(`manifest tier invalid: ${parsed.tier}`);
  if (parsed.profile !== undefined && parsed.profile !== 'pr' && parsed.profile !== 'full') throw new Error('manifest profile invalid');
  if (parsed.selection !== undefined) {
    for (const [key, inventory] of [['e2e', E2E_TOUCHFILES], ['judges', LLM_JUDGE_TOUCHFILES]] as const) {
      const ids = parsed.selection?.[key];
      if (ids !== null && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !Object.hasOwn(inventory, id)) || new Set(ids).size !== ids.length)) {
        throw new Error(`manifest ${key} selection invalid`);
      }
    }
  }
  if (parsed.profile === 'pr') {
    const coverage = parsed.prCoverage;
    if (parsed.tier !== 'gate' || !parsed.selection || !coverage ||
        !['pr', 'full-fallback'].includes(coverage.mode) || !Array.isArray(coverage.deferred) ||
        !Array.isArray(coverage.unknownFiles) || !Array.isArray(coverage.missingCoverage) ||
        !Array.isArray(coverage.deferredPromptFiles) || coverage.deferredPromptFiles.some(file => typeof file !== 'string') ||
        !Array.isArray(coverage.e2e) || !Array.isArray(coverage.judges) ||
        coverage.unknownFiles.some(file => typeof file !== 'string') ||
        coverage.needsFullValidation !== false || coverage.missingCoverage.length !== 0 ||
        JSON.stringify(parsed.selection.e2e) !== JSON.stringify(coverage.e2e) ||
        JSON.stringify(parsed.selection.judges) !== JSON.stringify(coverage.judges)) {
      throw new Error('manifest PR coverage/selection invalid or requires full validation');
    }
    if (coverage.mode === 'pr' && coverage.e2e.some(id => !(PR_PROFILE_CASE_IDS as readonly string[]).includes(id))) {
      throw new Error('manifest PR selection contains a broad-only case');
    }
    if (coverage.deferred.some(item => !Object.hasOwn(E2E_TOUCHFILES, item.id) || E2E_TIERS[item.id] !== item.tier || typeof item.reason !== 'string')) {
      throw new Error('manifest deferred case is outside the broad census');
    }
  }
  if (!Number.isInteger(parsed.sliceCount) || parsed.sliceCount <= 0) throw new Error('manifest sliceCount invalid');
  if (!Array.isArray(parsed.entries)) throw new Error('manifest entries missing');
  for (const entry of parsed.entries) {
    if (typeof entry.file !== 'string' || !Number.isInteger(entry.slice)) throw new Error('manifest entry malformed');
    if (!['planned', 'skipped-by-diff', 'excluded'].includes(entry.status)) throw new Error(`manifest entry status invalid: ${entry.status}`);
    if (entry.status === 'planned' && (entry.slice < 1 || entry.slice > parsed.sliceCount)) {
      throw new Error(`planned entry ${entry.file} has out-of-range slice ${entry.slice}`);
    }
    if (entry.estimatedMs !== undefined && (entry.status !== 'planned' || !Number.isSafeInteger(entry.estimatedMs) || entry.estimatedMs < 0)) {
      throw new Error(`manifest entry ${entry.file} has an invalid estimate`);
    }
    if (entry.status === 'planned' && parsed.prCoverage?.mode === 'pr' && !prProfileFileSelected(entry.file, parsed.selection!, entry.excludeCases ?? [])) {
      throw new Error(`manifest file is outside its PR case selection: ${entry.file}`);
    }
  }
  for (const entry of parsed.entries) {
    const caseId = shardCaseId(entry.file);
    const trial = shardTrial(entry.file);
    if (trial !== null) {
      const plan = entry.trial;
      const expected = plan && ['rule', 'behavior', 'judge'].includes(plan.kind) && typeof plan.quarantined === 'boolean'
        ? caseTrialPlan(caseId!, { [caseId!]: plan.kind }, plan.quarantined ? { [caseId!]: true } : {}) : undefined;
      if (!Object.hasOwn(E2E_TOUCHFILES, caseId!) || !E2E_TOUCHFILES[caseId!]!.includes(shardFile(entry.file))
        || !plan || !expected || !isIsolatedCase(expected) || !sameTrialPlan(plan, expected) || trial > plan.panel.n) {
        throw new Error(`Trial shard must name a registered isolated case of its file with its fixed policy panel: ${entry.file}`);
      }
    } else if (entry.trial !== undefined) {
      throw new Error(`Only trial shards carry a trial plan: ${entry.file}`);
    } else if (caseId === null ? entry.status === 'planned' && CASE_SHARDED_FILES.includes(shardFile(entry.file))
      : !CASE_SHARDED_FILES.includes(shardFile(entry.file)) || !(caseId in E2E_TOUCHFILES)) {
      throw new Error(`Case-sharded files plan one registered case per shard: ${entry.file}`);
    }
    if (entry.excludeCases !== undefined && (caseId !== null || !Array.isArray(entry.excludeCases) || entry.excludeCases.length === 0
      || entry.excludeCases.some(id => !parsed.entries.some(other => shardTrial(other.file) !== null
        && shardFile(other.file) === shardFile(entry.file) && shardCaseId(other.file) === id)))) {
      throw new Error(`A file shard may exclude only cases that run as its trial shards: ${entry.file}`);
    }
    if (caseId !== null && entry.status === 'planned' && parsed.selection?.e2e && !parsed.selection.e2e.includes(caseId)) {
      throw new Error(`Planned case shard is outside the manifest selection: ${entry.file}`);
    }
  }
  // Panels are whole: exactly n trial entries per isolated case with one plan
  // and one status, and planned trials on distinct slices when the ordinary
  // slices allow it.
  const panels = new Map<string, ManifestEntry[]>();
  for (const entry of parsed.entries) {
    const panel = trialPanelKey(entry.file);
    if (panel !== null) panels.set(panel, [...(panels.get(panel) ?? []), entry]);
  }
  const reservedOverlay = parsed.sliceCount > 1 && parsed.entries.some(entry => entry.status === 'planned' && isOverlayTestFile(entry.file));
  const ordinarySliceCount = parsed.sliceCount - Number(reservedOverlay);
  for (const [panel, trials] of panels) {
    const n = trials[0]!.trial!.panel.n;
    const indices = trials.map(entry => shardTrial(entry.file)!).sort((a, b) => a - b);
    if (indices.length !== n || indices.some((index, i) => index !== i + 1)
      || trials.some(entry => !sameTrialPlan(entry.trial, trials[0]!.trial) || entry.status !== trials[0]!.status)
      || parsed.entries.some(entry => normalizeRelativePath(entry.file) === panel)) {
      throw new Error(`Isolated case ${panel} must plan exactly its ${n} trials together`);
    }
    const slices = trials.filter(entry => entry.status === 'planned').map(entry => entry.slice);
    if (ordinarySliceCount >= n && new Set(slices).size !== slices.length) {
      throw new Error(`Trials of ${panel} share a slice; each trial needs its own runner`);
    }
  }
  if (parsed.prCoverage?.mode === 'pr') {
    const planned = parsed.entries.filter(entry => entry.status === 'planned').map(entry => normalizeRelativePath(entry.file));
    const required: string[][] = Object.entries(PR_PROFILE_FILES).flatMap(([file, ids]) => {
      const selected = ids.filter(id => parsed.selection!.e2e!.includes(id));
      if (!selected.length) return [];
      const owners = new Set(selected.flatMap(id => {
        const trials = parsed.entries.filter(entry => shardTrial(entry.file) !== null && shardFile(entry.file) === file && shardCaseId(entry.file) === id);
        if (trials.length) return trials.map(entry => normalizeRelativePath(entry.file));
        return [CASE_SHARDED_FILES.includes(file) ? `${file}#${id}` : file];
      }));
      return [[...owners]];
    });
    if (parsed.selection!.judges!.length) required.push(['test/skill-llm-eval.test.ts']);
    for (const owners of required) {
      if (owners.some(owner => planned.filter(key => key === owner).length !== 1)
        || planned.filter(key => shardFile(key) === shardFile(owners[0]!)).length !== owners.length) {
        throw new Error(`PR selected cases require exactly one planned owning file: ${owners.join(', ')}`);
      }
    }
  }
  if (parsed.plan !== undefined) {
    const plan = parsed.plan;
    const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
    if (!plan || typeof plan !== 'object' || !count(plan.sliceBudgetMs) || !count(plan.jobs) || !count(plan.ciTimeoutMinutes)
      || !Array.isArray(plan.estimatedSliceMs) || plan.estimatedSliceMs.length !== parsed.sliceCount
      || !plan.estimatedSliceMs.every(ms => Number.isSafeInteger(ms) && ms >= 0)
      || parsed.entries.some(entry => entry.status === 'planned' && entry.estimatedMs === undefined)) {
      throw new Error('manifest slice plan malformed');
    }
  }
  const keys = parsed.entries.map(entry => normalizeRelativePath(entry.file));
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate manifest entry');
  // Unique result slugs: shard artifacts merge by path, so a shared slug would
  // let one trial's records overwrite another's.
  const slugs = new Map<string, string>();
  for (const entry of parsed.entries) {
    const slug = shardSlug([entry.file]);
    if (slugs.has(slug)) throw new Error(`Shards ${slugs.get(slug)} and ${entry.file} share the result slug ${slug}`);
    slugs.set(slug, entry.file);
  }
  const overlaySlice = parsed.sliceCount;
  const plannedOverlays = parsed.entries.filter(entry => entry.status === 'planned' && isOverlayTestFile(entry.file));
  if (plannedOverlays.some(entry => entry.slice !== overlaySlice)) {
    throw new Error('Overlay manifest entries must share the final ordinary slice to preserve one-process API admission');
  }
  if (plannedOverlays.length && overlaySlice > 1 && parsed.entries.some(entry =>
      entry.status === 'planned' && !isOverlayTestFile(entry.file) && entry.slice === overlaySlice)) {
    throw new Error('The final ordinary manifest slice is reserved for overlay files');
  }
  for (const budget of FILE_RETRY_BUDGETS) {
    const entries = parsed.entries.filter(entry => shardFile(entry.file) === budget.file);
    const fileKeys = entries.filter(entry => shardCaseId(entry.file) === null).length;
    const caseKeys = entries.filter(entry => shardCaseId(entry.file) !== null && shardTrial(entry.file) === null).length;
    if (fileKeys > 1 || (fileKeys === 1 && caseKeys > 0)) throw new Error(`Duplicate registered manifest entry: ${budget.file}`);
    for (const entry of entries.filter(entry => entry.status === 'planned')) {
      if (!entry.budget) throw new Error(`Registered manifest needs an explicit budget record: ${budget.file}`);
      const expected = resolvePaidShardBudget([entry.file], entry.budget.source === 'explicit' ? entry.budget.timeoutMs : undefined);
      if (!sameBudget(entry.budget, expected)) throw new Error(`Registered manifest budget differs from declared policy: ${budget.file}`);
    }
  }
  return parsed;
}

export interface SliceResult {
  version: 1;
  tier: PaidTier;
  profile?: PaidProfile;
  selection?: PaidCaseSelection;
  sliceIndex: number;
  sliceCount: number;
  timeoutOverrideMs?: number;
  /** CI run attempt (github.run_attempt) that produced this slice; absent means 1. */
  attempt?: number;
  /** Epoch ms bounds of the slice's shard execution (lane wall time). */
  startedAt?: number;
  finishedAt?: number;
  outcomes: Array<Pick<ShardOutcome, 'files' | 'status' | 'exitCode' | 'elapsedMs' | 'executedTests' | 'skippedTests' | 'budget' | 'reused' | 'runnerError' | 'trial'>>;
}

/**
 * Slice exit = execution completeness, never the semantic verdict. A rule
 * shard that did not pass fails the slice (unchanged fail-closed rule); an
 * isolated trial shard fails it only when the harness produced no trial
 * record. Failed, timed-out or crashed trials are verdict input for the
 * report's panelVerdict(), so a 2/3 PASS panel never reds its runner.
 */
export function sliceExitCode(outcomes: ReadonlyArray<Pick<ShardOutcome, 'status' | 'trial'>>): number {
  return outcomes.every(outcome => outcome.trial !== undefined
    ? outcome.trial.outcome !== null
    : outcome.status === 'passed' || outcome.status === 'skipped-by-diff') ? 0 : 1;
}

/** A hollow-guarded trial shard has no trial record: the guard's verdict is a harness problem. */
export function guardTrialRecords<T extends Pick<ShardOutcome, 'status' | 'trial'>>(outcomes: T[]): T[] {
  return outcomes.map(outcome => outcome.trial && outcome.status === 'passed-empty' && outcome.trial.outcome !== null
    ? { ...outcome, trial: { ...outcome.trial, outcome: null, harness: 'hollow: executed no case' } } : outcome);
}

/**
 * Reconcile slice results against the manifest — the fail-closed aggregation.
 * Problems (any → non-zero): a slice index missing entirely (a cancelled or
 * crashed executor whose artifact never landed), a planned entry no slice
 * reported, an entry reported by the wrong/duplicate slice, or any reported
 * outcome that is not a pass.
 */
export function verifySliceResults(
  manifest: PaidRunManifest,
  results: SliceResult[],
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  try { parseRunManifest(JSON.stringify(manifest)); }
  catch (error) { problems.push(`Invalid run manifest: ${error instanceof Error ? error.message : String(error)}`); }
  const byIndex = new Map<number, SliceResult>();
  for (const result of results) {
    if (result.version !== 1) { problems.push(`slice result with unsupported version: ${String(result.version)}`); continue; }
    if (result.tier !== manifest.tier) problems.push(`slice ${result.sliceIndex} ran tier ${result.tier}, manifest says ${manifest.tier}`);
    if (manifest.profile === 'pr' && (result.profile !== 'pr' || JSON.stringify(result.selection) !== JSON.stringify(manifest.selection))) {
      problems.push(`slice ${result.sliceIndex} did not bind the manifest PR case selection`);
    }
    if (byIndex.has(result.sliceIndex)) problems.push(`duplicate result for slice ${result.sliceIndex}`);
    byIndex.set(result.sliceIndex, result);
  }
  for (let index = 1; index <= manifest.sliceCount; index += 1) {
    if (!byIndex.has(index)) problems.push(`slice ${index}/${manifest.sliceCount} reported NO result — cancelled/crashed executor, not a pass`);
  }

  const reported = new Map<string, { slice: number; status: ShardStatus; trial?: ShardTrialRecord }>();
  const planned = new Map(manifest.entries.map(entry => [normalizeRelativePath(entry.file), entry]));
  for (const result of results) {
    for (const outcome of result.outcomes) {
      if (outcome.files.some(file => FILE_RETRY_BUDGETS.some(budget => budget.file === shardFile(file)) || shardCaseId(file) !== null) && outcome.files.length !== 1) {
        problems.push('Registered result must report its own shard');
      }
      const file = normalizeRelativePath(outcome.files[0] ?? '');
      const trialPlan = planned.get(file)?.trial;
      if (manifest.prCoverage?.mode === 'pr') {
        const expected = expectedPrCaseCount(file, manifest.selection!, planned.get(file)?.excludeCases);
        const executed = outcome.executedTests === null || outcome.skippedTests === null
          ? -1 : outcome.executedTests - outcome.skippedTests;
        // A trial's exit status is its verdict (panelVerdict decides); its
        // completeness is the trial record checked below.
        if ((!trialPlan && outcome.exitCode !== 0) || expected < 1 || (!trialPlan && executed !== expected)) {
          problems.push(`PR profile expected ${expected} executed cases in ${file}, received ${executed}`);
        }
      }
      if (trialPlan) {
        const t = outcome.trial;
        if (!t || t.case !== shardCaseId(file) || t.trial !== shardTrial(file) || !sameTrialPlan(t, trialPlan)
          || !(t.outcome === null || ['passed', 'failed', 'skipped'].includes(t.outcome))
          || (t.outcome === 'failed') !== (t.failure_class !== undefined)) {
          problems.push(`${file}: trial record missing or does not match its planned trial`);
        }
      } else if (outcome.trial !== undefined) {
        problems.push(`${file}: an unplanned trial record`);
      }
      if (shardCaseId(file) !== null && outcome.status === 'passed'
        && (outcome.executedTests === null || outcome.skippedTests === null || outcome.executedTests - outcome.skippedTests !== 1)) {
        problems.push(`Case shard must execute exactly its one case: ${file}`);
      }
      if (outcome.reused !== undefined) {
        const r = outcome.reused;
        if (manifest.prCoverage?.mode !== 'pr') problems.push(`${file}: only the fast PR profile may reuse results; this lane executes fresh`);
        if (outcome.status !== 'passed' || outcome.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(r?.inputKey ?? '')
          || !/^[\w./-]{1,160}$/.test(r?.runId ?? '') || !/^[a-f0-9]{40}$/.test(r?.revision ?? '') || !Number.isSafeInteger(r?.completedAt) || r.completedAt <= 0) {
          problems.push(`${file}: malformed reused result`);
        }
      }
      if (reported.has(file)) problems.push(`${file} reported by two slices`);
      reported.set(file, { slice: result.sliceIndex, status: outcome.status, ...(outcome.trial ? { trial: outcome.trial } : {}) });
      const registered = FILE_RETRY_BUDGETS.find(budget => budget.file === shardFile(file));
      const finding = STRICT_RETRY_CASE_BUDGETS.find(budget => budget.file === file);
      if (finding) {
        // Full-census runs must account for every registered case. A manifest
        // explicitly marked selective may report its executed subset.
        if (outcome.exitCode !== 0 || !Number.isInteger(outcome.executedTests) ||
            outcome.executedTests! < 1 || outcome.executedTests! > finding.cases ||
            (manifest.evalsAll !== false && outcome.executedTests !== finding.cases) || outcome.skippedTests !== 0) {
          problems.push(`Finding workflow must execute real unskipped cases with exit zero: ${file}`);
        }
      }
      if (registered) {
        try {
          const planned = manifest.entries.find(entry => normalizeRelativePath(entry.file) === file)?.budget;
          const expected = resolvePaidShardBudget([file], result.timeoutOverrideMs ??
            (planned?.source === 'explicit' ? planned.timeoutMs : undefined));
          if (!sameBudget(outcome.budget, expected)) problems.push(`Registered effective result budget differs from its planned/explicit allocation: ${file}`);
        } catch { problems.push(`Invalid registered effective result budget: ${file}`); }
      }
    }
  }
  for (const entry of manifest.entries) {
    if (entry.status !== 'planned') continue;
    const got = reported.get(normalizeRelativePath(entry.file));
    if (!got) {
      if (byIndex.has(entry.slice)) problems.push(`planned ${entry.file} (slice ${entry.slice}) was never reported`);
      continue; // the missing-slice problem above already covers it
    }
    if (got.slice !== entry.slice) problems.push(`${entry.file} planned for slice ${entry.slice} but reported by slice ${got.slice}`);
    // Isolated trial shards: harness health only; the panel verdict gates.
    if (entry.trial) {
      if (got.trial?.outcome === null) problems.push(`${entry.file}: no trial record (${got.trial.harness ?? 'unknown'})`);
    } else if (got.status !== 'passed') problems.push(`${entry.file}: ${got.status}`);
  }
  return { ok: problems.length === 0, problems };
}

/** Budget-mode plan lines: every slice with its estimate, files and retries. */
export function formatSlicePlan(manifest: PaidRunManifest): string[] {
  const plan = manifest.plan;
  if (!plan) return [];
  const minutes = (ms: number) => (ms / 60_000).toFixed(1);
  const lines = [`[test:paid] slice plan: ${manifest.sliceCount} slice(s) x ${plan.jobs} worker(s), budget ${minutes(plan.sliceBudgetMs)}m per slice, `
    + `longest estimate ${minutes(Math.max(0, ...plan.estimatedSliceMs))}m, CI job timeout ${plan.ciTimeoutMinutes}m`];
  for (let slice = 1; slice <= manifest.sliceCount; slice++) {
    const mine = sliceExecutionOrder(manifest.entries.filter(entry => entry.status === 'planned' && entry.slice === slice));
    const over = plan.estimatedSliceMs[slice - 1]! > plan.sliceBudgetMs ? '  [over budget: longer than one runner allows]' : '';
    lines.push(`  slice ${slice}: ~${minutes(plan.estimatedSliceMs[slice - 1]!)}m${over}`);
    for (const entry of mine) lines.push(`    ${entry.file} ~${minutes(entry.estimatedMs ?? 0)}m retries=${retriesForFiles([entry.file])}`);
  }
  return lines;
}

/**
 * Capacity preflight (E-A10): what the plan asks of the runner pool and the
 * API. Sessions are planned shard processes; at most jobs of them run per
 * slice at once. Waves > 1 mean slices queue behind the matrix cap and the
 * lane wall grows by whole slices.
 */
export function formatCapacityPreflight(manifest: PaidRunManifest, maxParallel?: number): string[] {
  const planned = manifest.entries.filter(entry => entry.status === 'planned');
  const trials = planned.filter(entry => entry.trial);
  const jobs = manifest.plan?.jobs ?? DEFAULT_JOBS;
  const longest = [...trials].sort((a, b) => (b.estimatedMs ?? 0) - (a.estimatedMs ?? 0))[0];
  const waves = maxParallel ? Math.ceil(manifest.sliceCount / maxParallel) : null;
  return [
    `[test:paid] capacity: ${manifest.sliceCount} slice(s), ${planned.length} planned shard(s) (${planned.length - trials.length} rule/judge, ${trials.length} trial shard(s) in ${new Set(trials.map(entry => trialPanelKey(entry.file))).size} panel(s)); `
      + `peak ${Math.min(manifest.sliceCount, maxParallel ?? manifest.sliceCount) * jobs} concurrent shard process(es)`
      + (waves !== null ? `; wave(s) at max-parallel ${maxParallel}: ${waves}` : ''),
    ...(longest ? [`[test:paid] capacity: longest indivisible trial ~${((longest.estimatedMs ?? 0) / 60_000).toFixed(1)}m (${longest.file})`] : []),
    ...(waves !== null && waves > 1 ? [`[test:paid] capacity: ⚠ ${manifest.sliceCount} slices exceed max-parallel ${maxParallel}; later slices queue for a second wave`] : []),
  ];
}

export function formatProfileCoverage(manifest: PaidRunManifest): string[] {
  const coverage = manifest.prCoverage;
  return [
    `[test:paid] coverage: profile=${manifest.profile ?? 'full'} mode=${coverage?.mode ?? 'full'}; selected E2E=${manifest.selection?.e2e?.length ?? 'all'}, judges=${manifest.selection?.judges?.length ?? 'all'}`,
    ...(coverage ? [`[test:paid] deferred: ${coverage.deferred.length} broad behaviors, ${coverage.deferredPromptFiles.length} changed prompts without quick live coverage; these are not PR passes`] : []),
  ];
}

/** Every collector record counts: paid evals never retry, so a later record never replaces an earlier one. */
export function collectorOutcomeCounts(results: Array<{ tests?: Array<{
  name: string; suite?: string; passed: boolean; execution?: string; manual_review?: unknown;
}> }>): { executed: number; reused: number; passed: number; failed: number; manual_accepted: number; attempts: number } {
  const counts = { executed: 0, reused: 0, passed: 0, failed: 0, manual_accepted: 0, attempts: 0 };
  for (const result of results) {
    for (const entry of result.tests ?? []) {
      if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || typeof entry.passed !== 'boolean') continue;
      counts.attempts++;
      counts[entry.execution === 'reused' ? 'reused' : 'executed']++;
      const outcome = evalEntryOutcome(entry);
      counts[outcome === 'manual-review' ? 'manual_accepted' : outcome]++;
    }
  }
  return counts;
}


// ─── Report: verdicts, history records and the human readout ───────────────

/** One Bun JUnit testcase (`--reporter=junit`). */
export interface JUnitCase { name: string; classname: string; outcome: TrialOutcome; timeMs: number; failureType?: string; message?: string }

const xmlUnescape = (text: string) => text.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (_, name: string, dec?: string, hex?: string) =>
  dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16))
    : ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' } as Record<string, string>)[name.toLowerCase()]!);

function xmlAttributes(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(match => [match[1]!, xmlUnescape(match[2]!)]));
}

/** Per-test outcomes from a Bun JUnit report; unparseable input yields []. */
export function parseJUnitCases(xml: string): JUnitCase[] {
  const cases: JUnitCase[] = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = xmlAttributes(match[1]!);
    const body = match[3] ?? '';
    const failure = /<(failure|error)\b([^>]*?)(?:\/>|>)/.exec(body);
    const failureAttrs = failure ? xmlAttributes(failure[2]!) : {};
    cases.push({
      name: attrs.name ?? '', classname: attrs.classname ?? '',
      outcome: failure ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed',
      timeMs: Math.round(Number(attrs.time ?? 0) * 1000) || 0,
      ...(failure ? { failureType: failureAttrs.type ?? failure[1]!, message: failureAttrs.message } : {}),
    });
  }
  return cases;
}

/** Registry id of a Bun test name: the id itself or its CASE_TEST_NAMES label, else null (unattributed). */
export function caseIdForTestName(name: string): string | null {
  if (Object.hasOwn(E2E_TIERS, name) || Object.hasOwn(LLM_JUDGE_TOUCHFILES, name)) return name;
  return Object.keys(CASE_TEST_NAMES).find(id => CASE_TEST_NAMES[id] === name) ?? null;
}

interface ReportArtifact { root: string; result: SliceResult }

/** Every slice result under the report dir: flat (merged) or one directory per attempt-scoped artifact. */
export function loadSliceArtifacts(reportDir: string): ReportArtifact[] {
  const found: ReportArtifact[] = [];
  for (const name of fs.readdirSync(reportDir, { recursive: true }) as string[]) {
    const rel = normalizeRelativePath(name);
    if (!/^slice-\d+\.json$/.test(path.basename(rel)) || rel.split('/').includes('shards') || rel.split('/').includes('receipts')) continue;
    found.push({ root: path.join(reportDir, path.dirname(rel)), result: JSON.parse(fs.readFileSync(path.join(reportDir, rel), 'utf8')) as SliceResult });
  }
  return found.sort((a, b) => (a.result.attempt ?? 1) - (b.result.attempt ?? 1) || a.result.sliceIndex - b.result.sliceIndex);
}

export interface PanelReport extends PanelVerdict {
  file: string;
  /** Slice per trial index (trial n -> slice), for the rerun/artifact pointer. */
  slices: Record<number, number>;
}

/** Panel verdicts of one run attempt: exactly the planned trials, each from its reported record. */
export function panelReports(manifest: PaidRunManifest, results: SliceResult[], attempt: number): PanelReport[] {
  const reported = new Map<string, { slice: number; outcome: SliceResult['outcomes'][number] }>();
  for (const result of results.filter(r => (r.attempt ?? 1) === attempt)) {
    for (const outcome of result.outcomes) reported.set(normalizeRelativePath(outcome.files[0] ?? ''), { slice: result.sliceIndex, outcome });
  }
  const panels = new Map<string, ManifestEntry[]>();
  for (const entry of manifest.entries.filter(e => e.status === 'planned' && e.trial)) {
    const key = trialPanelKey(entry.file)!;
    panels.set(key, [...(panels.get(key) ?? []), entry]);
  }
  return [...panels.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, entries]) => {
    const plan = entries[0]!.trial!;
    const slices: Record<number, number> = {};
    const trials = entries.flatMap(entry => {
      const got = reported.get(normalizeRelativePath(entry.file));
      const t = got?.outcome.trial;
      if (!got || !t || t.outcome === null) return [];
      slices[t.trial] = got.slice;
      return [{ trial: t.trial, outcome: t.outcome, attempt, ...(t.failure_class ? { failure_class: t.failure_class } : {}),
        ...(t.exit_reason ? { exit_reason: t.exit_reason } : {}), ...(t.error ? { error: t.error } : {}),
        ...(got.outcome.reused ? { execution: 'reused' as const } : {}),
        ...(t.timeout_at_turn !== undefined ? { timeout_at_turn: t.timeout_at_turn } : {}) }];
    });
    const verdict = panelVerdict({ case: shardCaseId(key)!, kind: plan.kind, panel: plan.panel, trials, quarantined: plan.quarantined });
    return { ...verdict, file: shardFile(key), slices };
  });
}

/** Why one failed trial failed, in one line: a case timeout names its turn. */
function trialCause(trial: PanelVerdict['trials'][number] & { timeout_at_turn?: number }): string {
  const cls = trial.failure_class ?? 'assertion';
  const head = cls === 'timeout' || trial.exit_reason === 'timeout'
    ? `timeout${trial.timeout_at_turn !== undefined ? ` at turn ${trial.timeout_at_turn}` : ''}`
    : cls;
  return `t${trial.trial}: ${head}${trial.exit_reason && trial.exit_reason !== 'timeout' ? ` (${trial.exit_reason})` : ''}${trial.error ? ` — ${trial.error}` : ''}`;
}

export function rerunCommand(tier: PaidTier, id: string, trials: number): string {
  return `bun run scripts/test-paid-shards.ts --tier ${tier} --case ${id}${trials > 1 ? ` --trials ${trials}` : ''}`;
}

/** One line per non-PASS or split panel verdict. */
export function formatPanelLine(panel: PanelReport, tier: PaidTier): string {
  const mark = panel.status === 'PASS' ? '⚠' : panel.failsLane ? '✗' : '◌';
  const label = panel.status === 'PASS' ? `PASS ${panel.passed}/${panel.panel.n}` : `${panel.status} ${panel.passed}/${panel.panel.n}`;
  const causes = panel.trials.filter(t => t.outcome !== 'passed').map(t => trialCause(t as any));
  const where = Object.entries(panel.slices).map(([trial, slice]) => `t${trial}@slice ${slice}`).join(', ');
  return `${mark} ${panel.case}  ${panel.kind}${panel.quarantined ? ' (quarantined)' : ''}  ${label} (${panel.marks})`
    + `${causes.length ? `  ${causes.join('; ')}` : ''}${panel.status === 'INCOMPLETE' ? `  [${panel.reason}]` : ''}`
    + `${where ? `  [${where}, attempt ${panel.attempt}]` : ''}  rerun: ${rerunCommand(tier, panel.case, panel.panel.n)}`;
}

export interface ReportHeadline {
  lane: string;
  verdict: 'GREEN' | 'RED';
  attempt: number;
  counts: {
    rule: { passed: number; total: number };
    behavior: { passed: number; total: number; split: number };
    judge: { passed: number; total: number };
    quarantined: { total: number; failingLane: number };
    skipped: number;
    infra: number;
    incomplete: number;
    unattributed: number;
  };
  actionRequired: number;
  wallMs: number | null;
  costUsd: number;
  redispatchEligible: boolean;
}

export function formatHeadline(h: ReportHeadline): string[] {
  const c = h.counts;
  const minutes = h.wallMs === null ? 'unknown' : `${Math.floor(h.wallMs / 60_000)}m${String(Math.round((h.wallMs % 60_000) / 1000)).padStart(2, '0')}s`;
  return [
    `[test:paid] VERDICT ${h.verdict} — lane ${h.lane}, attempt ${h.attempt}`,
    `  rule ${c.rule.passed}/${c.rule.total} · behavior ${c.behavior.passed}/${c.behavior.total}${c.behavior.split ? ` (${c.behavior.split} split)` : ''}`
      + ` · judge ${c.judge.passed}/${c.judge.total} · quarantined ${c.quarantined.total} (${c.quarantined.failingLane} failing the lane)`,
    `  SKIPPED ${c.skipped} · INFRA ${c.infra} · INCOMPLETE ${c.incomplete} · unattributed ${c.unattributed} · ACTION REQUIRED ${h.actionRequired}`,
    `  wall ${minutes} · cost $${h.costUsd.toFixed(2)}${h.redispatchEligible ? ' · every red is machine-classified INFRA/INCOMPLETE: eligible for ONE re-dispatch as a new run (EVAL_POLICY.infraRedispatch); report both runs' : ''}`,
  ];
}

/** Problems a runner loss or an API/CLI failure before grading produces; nothing else qualifies for re-dispatch. */
const INFRA_PROBLEMS = [
  /^slice \d+\/\d+ reported NO result/,
  /^planned .* was never reported$/,
  /: never-started$/,
  /: no trial record \((?:never started|runner error: .*|no test summary)\)$/,
  /^PANEL \S+ INCOMPLETE /,
  /^PANEL \S+ FAIL \(INFRA\)/,
];
export function infraOnly(problems: readonly string[]): boolean {
  return problems.length > 0 && problems.every(problem => INFRA_PROBLEMS.some(re => re.test(problem)));
}

/**
 * Report mode: reconcile slice artifacts against the manifest (fail-closed),
 * compute every panel verdict with panelVerdict(), write collector-outcomes
 * v2, trial-outcomes.jsonl and report-summary.md, and exit non-zero when the
 * lane is red. Only the earliest run attempt decides the lane; later attempts
 * are reported beside it and never replace it.
 */
export function runPaidReport(reportDir: string, options: { writeDurations?: boolean; env?: NodeJS.ProcessEnv; rootDir?: string } = {}): number {
  const env = options.env ?? process.env;
  const rootDir = options.rootDir ?? ROOT;
  const summaryPath = path.join(reportDir, 'collector-outcomes.json');
  const summaryMdPath = path.join(reportDir, 'report-summary.md');
  const trialOutcomesPath = path.join(reportDir, TRIAL_OUTCOMES_FILE);
  for (const file of [summaryPath, summaryMdPath, trialOutcomesPath]) fs.rmSync(file, { force: true });
  const manifest = parseRunManifest(fs.readFileSync(path.join(reportDir, 'manifest.json'), 'utf-8'));
  const artifacts = loadSliceArtifacts(reportDir);
  const attempts = [...new Set(artifacts.map(a => a.result.attempt ?? 1))].sort((a, b) => a - b);
  const primary = attempts[0] ?? 1;
  const results = artifacts.filter(a => (a.result.attempt ?? 1) === primary).map(a => a.result);
  const verdict = verifySliceResults(manifest, results);
  const planned = manifest.entries.filter((e) => e.status === 'planned').length;
  const lane = `${manifest.tier}/${manifest.profile ?? 'full'}${manifest.evalsAll ? ' census' : ''}`;
  console.log(`[test:paid] report: ${results.length}/${manifest.sliceCount} slices, ${planned} planned shards, tier=${manifest.tier}, attempt ${primary}${attempts.length > 1 ? ` (later attempts ${attempts.slice(1).join(', ')} reported, never replacing it)` : ''}`);
  for (const line of formatProfileCoverage(manifest)) console.log(line);
  for (const result of [...results].sort((a, b) => a.sliceIndex - b.sliceIndex)) {
    for (const outcome of result.outcomes) {
      const shown = outcome.reused ? `reused (run ${outcome.reused.runId})` : outcome.trial
        ? `trial ${outcome.trial.outcome ?? 'NO RECORD'}` : outcome.status;
      console.log(`  slice ${result.sliceIndex}  ${shown.padEnd(15)} ${String(Math.round(outcome.elapsedMs / 1000)).padStart(5)}s  ${outcome.files.join(' ')}`);
    }
  }
  if (options.writeDurations) {
    const durations = mergePaidTestDurations(loadPaidTestDurations(rootDir, manifest.tier), results);
    writePaidTestDurations(manifest.tier, durations, rootDir);
    console.log(`[test:paid] wrote ${Object.keys(durations).length} ${manifest.tier} durations to ${PAID_TEST_DURATIONS_FILE}`);
  }

  // Which artifact root (attempt) and which shard (isolated or not) each file belongs to.
  const roots = artifacts.map(a => ({ root: path.resolve(a.root), attempt: a.result.attempt ?? 1 }))
    .sort((a, b) => b.root.length - a.root.length);
  const attemptOf = (abs: string) => roots.find(r => abs === r.root || abs.startsWith(r.root + path.sep))?.attempt ?? primary;
  const entryBySlug = new Map(manifest.entries.map(entry => [shardSlug([entry.file]), entry]));
  const shardOf = (rel: string) => {
    const parts = normalizeRelativePath(rel).split('/');
    const at = parts.lastIndexOf('shards');
    return at >= 0 && parts[at + 1] ? entryBySlug.get(parts[at + 1]!) ?? null : null;
  };

  const flaky: Array<{ name: string; attempts: number; file: string }> = [];
  const collectors: Parameters<typeof collectorOutcomeCounts>[0] = [];
  const files: Array<{ file: string; tier: string; shard: string | number; cost: number;
    flaky: number; total: number; executed: number; reused: number; passed: number;
    failed: number; manual_accepted: number; attempts: number }> = [];
  const manualProblems: string[] = [];
  const manualClaims = new Map<string, string>();
  const recordsByShard = new Map<string, any[]>();
  let costUsd = 0;
  for (const name of fs.readdirSync(reportDir, { recursive: true }) as string[]) {
    const rel = normalizeRelativePath(name);
    if (!isFinalizedEvalResultFile(rel) || rel.split('/').includes('receipts') || rel === 'collector-outcomes.json') continue;
    if (attemptOf(path.resolve(reportDir, rel)) !== primary) continue;
    const shard = shardOf(rel);
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(reportDir, rel), 'utf-8'));
      if (!Array.isArray(parsed.tests)) {
        if (Object.hasOwn(parsed, 'tests') || parsed.total_tests !== undefined || parsed.manual_review !== undefined) {
          manualProblems.push(`${rel}: malformed collector tests[]`);
        }
        continue;
      }
      costUsd += Number(parsed.total_cost_usd) || 0;
      if (shard) recordsByShard.set(shard.file, [...(recordsByShard.get(shard.file) ?? []), ...parsed.tests]);
      // Trial records are verdict input for panelVerdict(), never collector gates.
      if (shard?.trial) continue;
      const seen = new Map<string, number>();
      for (const [index, entry] of parsed.tests.entries()) {
        if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !entry.name
          || typeof entry.passed !== 'boolean') {
          manualProblems.push(`${rel}: attempt ${index + 1}: malformed collector entry (name/passed required)`);
          continue;
        }
        const key = `${entry.suite ?? ''}\0${entry.name}`;
        const occurrence = (seen.get(key) ?? 0) + 1;
        seen.set(key, occurrence);
        if (Object.hasOwn(entry, 'manual_review') && occurrence !== 1) {
          manualProblems.push(`${rel}: attempt ${index + 1}: manual review is only valid on the first case attempt`);
        }
        if (Object.hasOwn(entry, 'manual_review')) {
          const previous = manualClaims.get(key);
          if (previous && previous !== rel) manualProblems.push(`${rel}: duplicate manual-review claim for ${entry.name} (also in ${previous})`);
          else manualClaims.set(key, rel);
        }
        const problem = manualReviewProblem(entry, rootDir);
        if (problem) manualProblems.push(`${rel}: attempt ${index + 1}: ${problem}`);
      }
      collectors.push(parsed);
      const counts = collectorOutcomeCounts([parsed]);
      files.push({ file: rel, tier: parsed.tier ?? 'unknown', shard: parsed.shard ?? '-',
        cost: parsed.total_cost_usd ?? 0, flaky: parsed.flaky_retries?.length ?? 0,
        total: counts.passed + counts.failed + counts.manual_accepted, ...counts });
      for (const f of parsed.flaky_retries ?? []) flaky.push({ ...f, file: rel });
    } catch (error) {
      manualProblems.push(`${rel}: malformed collector JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const evidence = collectorOutcomeCounts(collectors);
  console.log(`[test:paid] collector final outcomes: ${evidence.executed} executed, ${evidence.reused} reused; ${evidence.passed} passed, ${evidence.failed} failed, ${evidence.manual_accepted} manual accepted (unscored; no score-cache credit) (${evidence.attempts} attempt records from ${collectors.length} collectors; every record counts)`);
  if (flaky.length > 0) {
    console.log(`[test:paid] report: ⚠ ${flaky.length} cases with multiple attempts this run: (paid evals never retry; each record counts)`);
    for (const f of flaky) console.log(`  ⚠ ${f.name} (x${f.attempts}) — ${f.file}`);
  }
  const allSkipped = results.flatMap((r) => r.outcomes.filter(isAllSkippedPass));
  if (allSkipped.length > 0) {
    console.log(`[test:paid] report: ⚠ ${allSkipped.length} shard(s) passed with EVERY test skipped — they verified nothing:`);
    for (const outcome of allSkipped) {
      console.log(`  ⚠ ${outcome.files.join(' ')} (${outcome.executedTests} skipped — external service missing or tier mismatch)`);
    }
  }
  if (manualProblems.length) verdict.problems.push(...manualProblems);
  if (evidence.failed > 0) verdict.problems.push(`${evidence.failed} unapproved final collector failure(s)`);
  if (files.reduce((sum, file) => sum + file.total, 0) !== evidence.passed + evidence.failed + evidence.manual_accepted
    || files.reduce((sum, file) => sum + file.executed + file.reused, 0) !== evidence.executed + evidence.reused) {
    verdict.problems.push('Collector summary totals are inconsistent');
  }

  // Panel verdicts: one function, computed here only.
  const panels = panelReports(manifest, results, primary);
  for (const panel of panels.filter(p => p.failsLane)) {
    verdict.problems.push(`PANEL ${panel.case} ${panel.status}${panel.redClass === 'INFRA' ? ' (INFRA)' : ''} ${panel.passed}/${panel.panel.n} (${panel.marks}): ${panel.reason}`);
  }
  const laterPanels = attempts.slice(1).flatMap(attempt => panelReports(manifest, artifacts.map(a => a.result), attempt)
    .filter(panel => panel.trials.length > 0));

  // Quarantine policy checks on census runs: the per-tier cap and entry expiry.
  if (manifest.evalsAll) {
    const tierIds = Object.keys(E2E_TIERS).filter(id => E2E_TIERS[id] === manifest.tier);
    const quarantined = Object.keys(CASE_QUARANTINE).filter(id => E2E_TIERS[id] === manifest.tier);
    if (quarantined.length > EVAL_POLICY.quarantine.capFraction * tierIds.length) {
      verdict.problems.push(`QUARANTINE over cap: ${quarantined.length} of ${tierIds.length} ${manifest.tier} cases (cap ${Math.round(EVAL_POLICY.quarantine.capFraction * 100)}%)`);
    }
    const expiryMs = EVAL_POLICY.quarantine.expiryWeeklyRuns * 7 * 24 * 60 * 60 * 1000;
    for (const id of quarantined) {
      const entered = Date.parse(CASE_QUARANTINE[id]!.enteredAt);
      if (!Number.isFinite(entered) || Date.now() - entered > expiryMs) {
        verdict.problems.push(`QUARANTINE expired: ${id} (entered ${CASE_QUARANTINE[id]!.enteredAt}; entries expire after ${EVAL_POLICY.quarantine.expiryWeeklyRuns} weekly runs)`);
      }
    }
  }

  // History: one trial-outcomes line per isolated trial and per JUnit rule/judge case.
  const runId = env.GITHUB_RUN_ID;
  const sha = env.GITHUB_SHA;
  const history: TrialOutcomeRecord[] = [];
  const common = (attempt: number) => ({ schema: TRIAL_OUTCOME_SCHEMA, tier: manifest.tier, attempt, policy_version: EVAL_POLICY.version,
    ...(runId ? { run_id: runId } : {}), ...(sha ? { sha } : {}), lane, recorded_at: new Date().toISOString() });
  for (const { result } of artifacts) {
    const attempt = result.attempt ?? 1;
    for (const outcome of result.outcomes) {
      const t = outcome.trial;
      if (!t || t.outcome === null) continue;
      history.push({ ...common(attempt), case: t.case, file: shardFile(outcome.files[0]!), kind: t.kind, trial: t.trial, panel: t.panel,
        outcome: t.outcome, ...(t.outcome === 'failed' ? { failure_class: t.failure_class ?? 'assertion' } : {}),
        ...(t.exit_reason ? { exit_reason: t.exit_reason } : {}), ...(t.error ? { error: t.error } : {}),
        duration_ms: t.duration_ms, cost_usd: t.cost_usd, ...(t.model ? { model: t.model } : {}),
        ...(outcome.reused ? { input_identity: outcome.reused.inputKey } : {}),
        quarantined: t.quarantined, execution: outcome.reused ? 'reused' : 'executed', source: 'shard' } as TrialOutcomeRecord);
    }
  }
  const ruleCases: Array<{ id: string; kind: EvalCaseKind; outcome: TrialOutcome; line?: string }> = [];
  const junitFailedShards = new Set<string>();
  let unattributed = 0;
  const cliVersion = env.GSTACK_CLAUDE_CLI_VERSION;
  for (const { root, result } of artifacts.filter(a => (a.result.attempt ?? 1) === primary)) {
    for (const outcome of result.outcomes) {
      const key = normalizeRelativePath(outcome.files[0] ?? '');
      if (outcome.trial || outcome.files.length !== 1) continue;
      let xml = '';
      try { xml = fs.readFileSync(path.join(root, 'shards', shardSlug([key]), 'junit.xml'), 'utf8'); } catch { continue; }
      const records = recordsByShard.get(key) ?? [];
      for (const tc of parseJUnitCases(xml)) {
        const id = caseIdForTestName(tc.name);
        if (id === null) { unattributed++; continue; }
        const kind = (E2E_KINDS[id] ?? 'rule') as EvalCaseKind;
        const mine = records.filter((r: any) => r?.name === id || r?.case_id === id);
        const failedRecord = mine.find((r: any) => r.passed === false);
        const failureClass: TrialFailureClass | undefined = tc.outcome !== 'failed' ? undefined
          : tc.failureType === 'TimeoutError' ? 'timeout' : failedRecord ? failureClassOf(failedRecord) : 'assertion';
        const error = sanitizeTrialError(failedRecord?.error ?? tc.message);
        if (tc.outcome === 'failed') junitFailedShards.add(key);
        ruleCases.push({ id, kind, outcome: tc.outcome,
          ...(tc.outcome === 'failed' ? { line: `✗ ${id}  ${kind}  FAIL  ${failureClass}${failedRecord?.exit_reason === 'timeout' && failedRecord?.timeout_at_turn !== undefined ? ` at turn ${failedRecord.timeout_at_turn}` : ''}${error ? ` — ${error}` : ''}  [slice ${result.sliceIndex}, attempt ${primary}]  rerun: ${rerunCommand(manifest.tier, id, 1)}` } : {}) });
        history.push({ ...common(primary), case: id, file: shardFile(key), kind, trial: 1, panel: { n: 1, k: 1 }, outcome: tc.outcome,
          ...(failureClass ? { failure_class: failureClass } : {}), ...(failedRecord?.exit_reason ? { exit_reason: String(failedRecord.exit_reason) } : {}),
          ...(error && tc.outcome === 'failed' ? { error } : {}), duration_ms: tc.timeMs,
          cost_usd: Math.round(mine.reduce((sum: number, r: any) => sum + (Number(r.cost_usd) || 0), 0) * 100) / 100,
          ...(typeof mine[0]?.model === 'string' ? { model: mine[0].model } : {}), ...(cliVersion ? { cli_version: cliVersion } : {}),
          quarantined: false, execution: outcome.reused ? 'reused' : 'executed', source: 'junit' } as TrialOutcomeRecord);
      }
    }
  }
  fs.writeFileSync(trialOutcomesPath, formatTrialOutcomes(history));

  // Headline and failure block (A4): one formatter for the log, the PR comment and the weekly issue.
  const ruleShardFailures = manifest.entries.filter(entry => entry.status === 'planned' && !entry.trial).flatMap(entry => {
    const got = results.flatMap(r => r.outcomes.map(o => ({ o, slice: r.sliceIndex }))).find(({ o }) => normalizeRelativePath(o.files[0] ?? '') === normalizeRelativePath(entry.file));
    if (got && got.o.status === 'passed') return [];
    if (got && junitFailedShards.has(normalizeRelativePath(entry.file))) return [];
    const id = shardCaseId(entry.file);
    return [`✗ ${entry.file}  rule shard ${got ? got.o.status : 'NOT REPORTED'}${got?.o.runnerError ? ` — ${sanitizeTrialError(got.o.runnerError)}` : ''}  [slice ${entry.slice}, attempt ${primary}]${id ? `  rerun: ${rerunCommand(manifest.tier, id, 1)}` : ''}`];
  });
  const behaviorPanels = panels.filter(p => !p.quarantined && p.kind === 'behavior');
  const lanePanels = panels.filter(p => !p.quarantined);
  const count = (kind: EvalCaseKind) => ({
    passed: ruleCases.filter(c => c.kind === kind && c.outcome === 'passed').length
      + lanePanels.filter(p => p.kind === kind && p.status === 'PASS').length,
    total: ruleCases.filter(c => c.kind === kind).length + lanePanels.filter(p => p.kind === kind).length,
  });
  const primaryTrials = results.flatMap(r => r.outcomes.map(o => o.trial)).filter((t): t is ShardTrialRecord => !!t);
  const wall = results.filter(r => Number.isSafeInteger(r.startedAt) && Number.isSafeInteger(r.finishedAt));
  const failureLines = [
    ...ruleShardFailures,
    ...ruleCases.filter(c => c.line).map(c => c.line!),
    ...panels.filter(p => p.status !== 'PASS' || p.split).map(p => formatPanelLine(p, manifest.tier)),
  ];
  const red = verdict.problems.length > 0;
  const headline: ReportHeadline = {
    lane, verdict: red ? 'RED' : 'GREEN', attempt: primary,
    counts: {
      rule: count('rule'),
      behavior: { ...count('behavior'), split: behaviorPanels.filter(p => p.split).length },
      judge: count('judge'),
      quarantined: { total: panels.filter(p => p.quarantined).length, failingLane: panels.filter(p => p.quarantined && p.failsLane).length },
      skipped: allSkipped.length + panels.filter(p => p.status === 'SKIPPED').length + ruleCases.filter(c => c.outcome === 'skipped').length,
      infra: primaryTrials.filter(t => t.failure_class === 'infra').length
        + results.flatMap(r => r.outcomes).filter(o => !o.trial && o.runnerError !== undefined).length,
      incomplete: panels.filter(p => p.status === 'INCOMPLETE').length,
      unattributed,
    },
    actionRequired: verdict.problems.length,
    wallMs: wall.length ? Math.max(...wall.map(r => r.finishedAt!)) - Math.min(...wall.map(r => r.startedAt!)) : null,
    costUsd: Math.round(costUsd * 100) / 100,
    redispatchEligible: red && infraOnly(verdict.problems),
  };
  const headlineLines = formatHeadline(headline);
  for (const line of headlineLines) console.log(line);
  if (failureLines.length) {
    console.log('[test:paid] failures and split verdicts:');
    for (const line of failureLines) console.log(`  ${line}`);
  }
  for (const panel of laterPanels) console.log(`  attempt ${panel.attempt} (re-run; reported, never replacing attempt ${primary}): ${formatPanelLine(panel, manifest.tier)}`);
  const fence = (lines: string[]) => ['```', ...lines.map(line => line.replace(/```/g, "'''")), '```'];
  fs.writeFileSync(summaryMdPath, [
    ...fence(headlineLines),
    ...(failureLines.length ? ['', '**Failures and split verdicts**', '', ...fence(failureLines)] : []),
    ...(verdict.problems.length ? ['', `**ACTION REQUIRED (${verdict.problems.length})**`, '', ...fence(verdict.problems.map(p => sanitizeTrialError(p) ?? p))] : []),
  ].join('\n') + '\n');
  if (!manualProblems.length) fs.writeFileSync(summaryPath, JSON.stringify({ version: 2, files, totals: {
    ...evidence, total: evidence.passed + evidence.failed + evidence.manual_accepted,
    flaky: files.reduce((sum, file) => sum + file.flaky, 0),
  }, verdict: headline, headline: headlineLines,
  panels: panels.map(p => ({ case: p.case, kind: p.kind, status: p.status, passed: p.passed, n: p.panel.n, k: p.panel.k,
    marks: p.marks, split: p.split, quarantined: p.quarantined, failsLane: p.failsLane, redClass: p.redClass, reason: p.reason,
    trials: p.trials.map(t => ({ trial: t.trial, outcome: t.outcome, ...(t.failure_class ? { failure_class: t.failure_class } : {}),
      ...(t.exit_reason ? { exit_reason: t.exit_reason } : {}), ...(t.error ? { error: t.error } : {}) })) })),
  failures: failureLines.map(line => sanitizeTrialError(line) ?? line) }, null, 2) + '\n');
  if (verdict.problems.length) {
    console.error(`[test:paid] report: ${verdict.problems.length} problem(s):`);
    for (const problem of verdict.problems) console.error(`  ✗ ${problem}`);
    if (headline.redispatchEligible) console.error('[test:paid] report: INFRA-ONLY RED — one re-dispatch as a new run is allowed; report both runs');
    return 1;
  }
  console.log(evidence.manual_accepted
    ? `[test:paid] report: every planned shard accounted; ${evidence.manual_accepted} manual acceptance(s), no automated-score credit`
    : '[test:paid] report: every planned shard accounted and passed');
  return 0;
}

type CliOptions = {
  tier: PaidTier;
  profile: PaidProfile;
  profileExplicit: boolean;
  listOnly: boolean;
  skipJudges: boolean;
  timeoutMs: number;
  timeoutExplicit: boolean;
  jobs: number;
  withinShardConcurrency: number;
  maxFilesPerShard: number;
  /** Planner mode: write the run manifest here and exit. */
  emitPlanPath: string | null;
  /** Slice count for --emit-plan. */
  slices: number;
  /** Budget mode for --emit-plan / --list: per-executor estimated wall. */
  sliceBudgetMs: number | null;
  jobsExplicit: boolean;
  /** Executor mode: consume this manifest... */
  planPath: string | null;
  /** ...running only this 1-based slice. */
  sliceIndex: number | null;
  /** Report mode: reconcile manifest.json + slice-*.json under this dir. */
  reportDir: string | null;
  /** Report mode: merge executed shard wall times into the duration seed. */
  writeDurations: boolean;
  /** Planner: the workflow matrix cap, for the capacity preflight's wave count. */
  maxParallel: number | null;
};

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} needs a positive integer. Received: ${value}`);
  return parsed;
}

function validatedTier(value: string | undefined, source: string): PaidTier {
  if (value === undefined || value === '') return DEFAULT_TIER;
  // A typo'd EVALS_TIER (e.g. 'e2e', the tier string eval-store uses) would
  // otherwise cast through unchecked, match nothing in the runtime E2E_TIERS
  // filter, self-skip every test, and exit 0 with all shards 'passed' — the
  // exact 0%-execution-looks-like-a-pass class this runner exists to kill.
  if (!PAID_TIERS.includes(value as PaidTier)) {
    throw new Error(`${source} must be gate, periodic or marathon. Received: ${value}`);
  }
  return value as PaidTier;
}

function validatedProfile(value: string | undefined, source: string): PaidProfile {
  if (value === undefined || value === '') return 'full';
  if (value !== 'pr' && value !== 'full') throw new Error(`${source} must be pr or full. Received: ${value}`);
  return value;
}

export function parseCliOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const options: CliOptions = {
    tier: validatedTier(env.EVALS_TIER, 'EVALS_TIER'),
    profile: validatedProfile(env.EVALS_PROFILE, 'EVALS_PROFILE'),
    profileExplicit: !!env.EVALS_PROFILE,
    listOnly: false,
    skipJudges: false,
    timeoutExplicit: !!env.EVALS_SHARD_TIMEOUT_MS,
    timeoutMs: env.EVALS_SHARD_TIMEOUT_MS
      ? parsePositiveInt(env.EVALS_SHARD_TIMEOUT_MS, 'EVALS_SHARD_TIMEOUT_MS')
      : DEFAULT_SHARD_TIMEOUT_MS,
    // EVALS_JOBS = shard process count. EVALS_CONCURRENCY deliberately does
    // NOT set jobs anymore — it's bun's within-shard --max-concurrency (its
    // legacy meaning). Conflating them turned "EVALS_CONCURRENCY=15" into 15
    // parallel Bun processes each spawning claude.
    jobs: env.EVALS_JOBS ? parsePositiveInt(env.EVALS_JOBS, 'EVALS_JOBS') : DEFAULT_JOBS,
    withinShardConcurrency: env.EVALS_CONCURRENCY
      ? parsePositiveInt(env.EVALS_CONCURRENCY, 'EVALS_CONCURRENCY')
      : DEFAULT_WITHIN_SHARD_CONCURRENCY,
    maxFilesPerShard: DEFAULT_MAX_FILES_PER_SHARD,
    emitPlanPath: null,
    slices: 1,
    sliceBudgetMs: null,
    jobsExplicit: !!env.EVALS_JOBS,
    planPath: null,
    sliceIndex: null,
    reportDir: null,
    writeDurations: false,
    maxParallel: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--list') { options.listOnly = true; continue; }
    if (arg === '--tier') {
      options.tier = validatedTier(argv[index += 1] ?? '-', '--tier');
      continue;
    }
    if (arg === '--profile') {
      const value = argv[index += 1];
      if (!value) throw new Error('--profile needs pr or full');
      options.profile = validatedProfile(value, '--profile'); options.profileExplicit = true; continue;
    }
    if (arg === '--timeout') { options.timeoutMs = parsePositiveInt(argv[index += 1], '--timeout') * 1000; options.timeoutExplicit = true; continue; }
    if (arg === '--jobs') { options.jobs = parsePositiveInt(argv[index += 1], '--jobs'); options.jobsExplicit = true; continue; }
    if (arg === '--slice-budget') { options.sliceBudgetMs = parsePositiveInt(argv[index += 1], '--slice-budget') * 1000; continue; }
    if (arg === '--files-per-shard') { options.maxFilesPerShard = parsePositiveInt(argv[index += 1], '--files-per-shard'); continue; }
    if (arg === '--emit-plan') {
      const value = argv[index += 1];
      if (!value) throw new Error('--emit-plan needs a file path');
      options.emitPlanPath = value; continue;
    }
    if (arg === '--skip-judges') { options.skipJudges = true; continue; }
    if (arg === '--slices') { options.slices = parsePositiveInt(argv[index += 1], '--slices'); continue; }
    if (arg === '--plan') {
      const value = argv[index += 1];
      if (!value) throw new Error('--plan needs a manifest path');
      options.planPath = value; continue;
    }
    if (arg === '--slice') { options.sliceIndex = parsePositiveInt(argv[index += 1], '--slice'); continue; }
    if (arg === '--report') {
      const value = argv[index += 1];
      if (!value) throw new Error('--report needs a directory');
      options.reportDir = value; continue;
    }
    if (arg === '--write-durations') { options.writeDurations = true; continue; }
    if (arg === '--max-parallel') { options.maxParallel = parsePositiveInt(argv[index += 1], '--max-parallel'); continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.writeDurations && !options.reportDir) throw new Error('--write-durations requires --report');
  if (options.sliceBudgetMs !== null && argv.includes('--slices')) throw new Error('Plan with exactly one of --slices or --slice-budget');
  if (options.sliceBudgetMs !== null && !options.jobsExplicit) throw new Error('--slice-budget needs explicit --jobs (or EVALS_JOBS): the plan packs and supervises for that worker count');
  if (options.skipJudges && (!options.emitPlanPath || options.tier !== 'gate')) throw new Error('--skip-judges applies only to an emitted gate census plan');
  if (options.profile === 'pr' && options.tier !== 'gate') throw new Error('PR profile requires gate tier');
  if (options.profile === 'pr' && options.maxFilesPerShard !== 1) throw new Error('PR profile requires one file per shard to preserve case accounting');
  return options;
}

async function main(): Promise<number> {
  const options = parseCliOptions(process.argv.slice(2));
  const timeoutOverride = options.timeoutExplicit ? options.timeoutMs : undefined;

  // ── Planner mode: compute selection + the slice plan ONCE, write it, exit.
  if (options.emitPlanPath) {
    const manifest = buildRunManifest({
      tier: options.tier,
      profile: options.profile,
      ...(options.sliceBudgetMs !== null ? { sliceBudgetMs: options.sliceBudgetMs, jobs: options.jobs } : { sliceCount: options.slices }),
      timeoutMs: options.timeoutExplicit ? options.timeoutMs : undefined,
      evalsAll: process.env.EVALS_ALL === '1',
      skipJudges: options.skipJudges,
    });
    fs.mkdirSync(path.dirname(path.resolve(options.emitPlanPath)), { recursive: true });
    fs.writeFileSync(options.emitPlanPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const planned = manifest.entries.filter((e) => e.status === 'planned').length;
    const skipped = manifest.entries.filter((e) => e.status === 'skipped-by-diff').length;
    const excludedCount = manifest.entries.filter((e) => e.status === 'excluded').length;
    console.log(
      `[test:paid] plan: tier=${manifest.tier} profile=${manifest.profile ?? 'full'} evalsAll=${manifest.evalsAll} — `
      + `${planned} planned across ${manifest.sliceCount} slice(s), ${skipped} skipped by diff, `
      + `${excludedCount} excluded (${manifest.selectionReason})`,
    );
    for (const line of formatSlicePlan(manifest)) console.log(line);
    for (const line of formatCapacityPreflight(manifest, options.maxParallel ?? undefined)) console.log(line);
    return 0;
  }

  // ── Report mode: reconcile slice artifacts against the manifest. Fail-closed:
  // a slice whose artifact never landed is a FAILURE, not an absence.
  if (options.reportDir) return runPaidReport(options.reportDir, { writeDurations: options.writeDurations });

  const discovered = collectPaidTestFiles();
  if (discovered.length === 0) throw new Error('No paid test files were discovered.');

  // ── Executor mode: consume the planner's manifest; never self-select.
  if (options.planPath || options.sliceIndex !== null) {
    if (!options.planPath || options.sliceIndex === null) {
      throw new Error('--plan and --slice must be used together');
    }
    const manifest = parseRunManifest(fs.readFileSync(options.planPath, 'utf-8'));
    if (manifest.tier !== options.tier) {
      throw new Error(`manifest tier ${manifest.tier} != requested tier ${options.tier} — refusing a cross-tier run`);
    }
    const profile = manifest.profile ?? 'full';
    if (options.profileExplicit && options.profile !== profile) throw new Error(`manifest profile ${profile} != requested profile ${options.profile}`);
    if (options.sliceIndex > manifest.sliceCount) {
      throw new Error(`--slice ${options.sliceIndex} exceeds manifest sliceCount ${manifest.sliceCount}`);
    }
    if (manifest.plan && options.jobs !== manifest.plan.jobs) {
      throw new Error(`manifest was packed for ${manifest.plan.jobs} worker(s) per slice; EVALS_JOBS=${options.jobs} would break its supervision bound`);
    }
    const mine = sliceExecutionOrder(manifest.entries.filter((e) => e.status === 'planned' && e.slice === options.sliceIndex));
    const shards = mine.map((e) => [e.file]);
    for (const files of shards) resolvePaidShardTimeoutMs(files, timeoutOverride);
    console.log(`[test:paid] slice ${options.sliceIndex}/${manifest.sliceCount}: ${shards.length} shard(s), tier=${manifest.tier}, evalsAll=${manifest.evalsAll}`);

    if (options.listOnly) {
      for (const [index, files] of shards.entries()) {
        const budget = resolvePaidShardBudget(files, timeoutOverride);
        console.log(`  shard ${index + 1}/${shards.length}: ${files.join(' ')} wall=${budget.timeoutMs}ms source=${budget.source} policy=${budget.policyId ?? 'none'} retries=${retriesForFiles(files)}`);
      }
      return 0;
    }

    const evalDirBase = process.env.GSTACK_EVAL_DIR || getProjectEvalDir();
    const trials = Object.fromEntries(mine.filter(entry => entry.trial).map(entry => [normalizeRelativePath(entry.file), entry.trial!]));
    const exclusionPatterns = Object.fromEntries(mine.filter(entry => entry.excludeCases).map(entry => [entry.file,
      manifest.prCoverage?.mode === 'pr' ? prProfileTestNamePattern(entry.file, manifest.selection!, entry.excludeCases)
        : excludedCasesNamePattern(entry.excludeCases!)]));
    const startedAt = Date.now();
    let summary: RunSummary;
    if (shards.length === 0) {
      summary = summarize([]);
    } else {
      preflightAnthropicApi(process.env);
      summary = await runPaidShards(shards, {
        trials,
        casePatterns: exclusionPatterns,
        timeoutMs: options.timeoutExplicit ? options.timeoutMs : undefined,
        jobs: options.jobs,
        withinShardConcurrency: options.withinShardConcurrency,
        registeredBudgets: Object.fromEntries(mine.filter(entry => entry.budget).map(entry => [normalizeRelativePath(entry.file), entry.budget!])),
        ...(manifest.prCoverage?.mode === 'pr' ? {
          expectedCases: Object.fromEntries(mine.map(entry => [entry.file, expectedPrCaseCount(entry.file, manifest.selection!, entry.excludeCases)])),
          casePatterns: Object.fromEntries(mine.map(entry => [entry.file, prProfileTestNamePattern(entry.file, manifest.selection!, entry.excludeCases)])),
          expectedCaseIds: Object.fromEntries(mine.map(entry => [entry.file, prProfileShardIds(entry.file, manifest.selection!, entry.excludeCases)])),
          reuseFor: e2eReuseLaneProblem(process.env, manifest.prCoverage.mode) !== null ? undefined : (files, env, budget) => {
            const key = files[0]!;
            const file = shardFile(key);
            if (files.length !== 1 || !/^test\/skill-e2e-/.test(file)) return null;
            const { registered, known } = fileCaseRegistration(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
            const exclude = mine.find(entry => entry.file === key)?.excludeCases;
            return prepareE2EShardReuse({ root: ROOT, key, file, caseIds: prProfileShardIds(key, manifest.selection!, exclude),
              registeredIds: registered, registrationKnown: known,
              casePattern: prProfileTestNamePattern(key, manifest.selection!, exclude), expectedCases: expectedPrCaseCount(key, manifest.selection!, exclude),
              retries: retriesForFiles(files), timeoutMs: budget.timeoutMs, withinShardConcurrency: options.withinShardConcurrency,
              tier: manifest.tier, profile, env });
          },
        } : {}),
        env: {
          ...process.env,
          // Manifest filenames already encode carve selection. Ambient scope
          // must not suppress a planned wrapper when this slice executes.
          GSTACK_CARVE_SKILL: '',
          EVALS: '1',
          EVALS_TIER: options.tier,
          EVALS_ALL: manifest.evalsAll ? '1' : '',
          EVALS_PREFLIGHT_OK: '1',
          // The manifest IS the selection: children must not re-derive a
          // possibly-different one from their own git view.
          ...paidSelectionEnv(profile, manifest.selection ?? { e2e: null, judges: null }, `manifest slice ${options.sliceIndex}: ${manifest.selectionReason}`),
        },
        evalDirBase,
      });
    }
    const guarded = guardTrialRecords(applyHollowShardGuard(summary.outcomes, { evalsAll: manifest.evalsAll, requireExecuted: manifest.prCoverage?.mode === 'pr' }));
    summary = summarize(guarded);
    const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
    const sliceResult: SliceResult = {
      version: 1,
      tier: manifest.tier,
      profile,
      ...(manifest.selection ? { selection: manifest.selection } : {}),
      sliceIndex: options.sliceIndex,
      sliceCount: manifest.sliceCount,
      ...(options.timeoutExplicit ? { timeoutOverrideMs: options.timeoutMs } : {}),
      attempt: Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1,
      startedAt,
      finishedAt: Date.now(),
      outcomes: guarded.map(({ files, status, exitCode, elapsedMs, executedTests, skippedTests, budget, reused, runnerError, trial }) =>
        ({ files, status, exitCode, elapsedMs, executedTests, skippedTests, ...(budget ? { budget } : {}), ...(reused ? { reused } : {}),
          ...(runnerError !== undefined ? { runnerError } : {}), ...(trial ? { trial } : {}) })),
    };
    fs.mkdirSync(evalDirBase, { recursive: true });
    const sliceResultPath = path.join(evalDirBase, `slice-${options.sliceIndex}.json`);
    fs.writeFileSync(sliceResultPath, `${JSON.stringify(sliceResult, null, 2)}\n`);
    console.log(`[test:paid] slice result: ${sliceResultPath}`);
    for (const line of formatSummary(summary)) console.log(line);
    for (const outcome of guarded.filter(outcome => outcome.trial)) {
      const t = outcome.trial!;
      console.log(`  trial ${t.case} t${t.trial}/${t.panel.n}: ${t.outcome ?? `NO RECORD (${t.harness})`}${t.failure_class ? ` [${t.failure_class}]` : ''}`);
    }
    return sliceExitCode(guarded);
  }

  if (options.listOnly && options.sliceBudgetMs !== null) {
    const manifest = buildRunManifest({ tier: options.tier, profile: options.profile, sliceBudgetMs: options.sliceBudgetMs,
      jobs: options.jobs, evalsAll: process.env.EVALS_ALL === '1', timeoutMs: timeoutOverride });
    console.log(`[test:paid] slice plan preview: tier=${manifest.tier} profile=${manifest.profile ?? 'full'} (${manifest.selectionReason})`);
    for (const line of formatSlicePlan(manifest)) console.log(line);
    return 0;
  }

  const tierSelection = selectPaidTestFiles(discovered, options.tier);
  const caseKeys = partitionCaseExclusions(expandCaseShards(tierSelection.selected, options.tier));
  const selected = tierSelection.selected;
  const excluded = [...tierSelection.excluded, ...caseKeys.excluded];
  const shards = planPaidShards(caseKeys.runnable, { maxFilesPerShard: options.maxFilesPerShard });

  // Parent-side diff selection (D9): skip whole shards whose mapped tests are
  // all unselected. Fail-open everywhere — the child's self-skip stays
  // authoritative for anything the mapper can't attribute.
  const cases = computePaidCaseSelection({ profile: options.profile });
  const fast = cases.coverage?.mode === 'pr';
  const profileShards = fast ? shards.filter(files => files.some(file => prProfileFileSelected(file, cases.selection))) : shards;
  const { runnable, skipped } = partitionShardsByDiffSelection(profileShards,
    cases.selection.e2e === null ? null : new Set(cases.selection.e2e));
  if (fast) for (const files of shards) {
    if (!files.some(file => prProfileFileSelected(file, cases.selection))) skipped.push({ files, reason: 'Outside the fast PR profile; retained in broad coverage' });
  }
  const selectedCount = cases.selection.e2e?.length ?? Object.keys(E2E_TOUCHFILES).length;
  console.log(
    `[test:paid] selection: profile=${options.profile} selected ${selectedCount} of ${Object.keys(E2E_TOUCHFILES).length} tests -> `
    + `running ${runnable.length} of ${shards.length} shards, reason: ${cases.reason}`,
  );
  console.log(
    `[test:paid] tier=${options.tier}: ${selected.length}/${discovered.length} files, `
    + `${shards.length} shards, jobs=${options.jobs}, ${options.timeoutExplicit ? 'explicit' : 'ordinary default'} wall=${Math.round(options.timeoutMs / 1000)}s; per-shard policies below`,
  );

  if (options.listOnly) {
    const skipReasons = new Map(skipped.map((s) => [s.files.join(' '), s.reason]));
    for (let index = 0; index < shards.length; index += 1) {
      const key = shards[index].join(' ');
      const note = skipReasons.has(key) ? `  [would skip: ${skipReasons.get(key)}]` : '';
      const budget = resolvePaidShardBudget(shards[index], options.timeoutExplicit ? options.timeoutMs : undefined);
      console.log(`  shard ${index + 1}/${shards.length}: ${key} wall=${budget.timeoutMs}ms source=${budget.source} policy=${budget.policyId ?? 'none'} retries=${retriesForFiles(shards[index])}${note}`);
    }
    if (excluded.length > 0) {
      console.log(`\nExcluded (${excluded.length}):`);
      for (const { file, reason } of excluded) console.log(`  - ${file}  [${reason}]`);
    }
    return 0;
  }

  // One preflight ping in the parent; children skip theirs via the env flag.
  // Before this, every shard's e2e-helpers module load re-pinged the API —
  // ~30 paid claude -p calls (30s timeout each) per full run for one bit of
  // information. A dead API now fails here, before any shard spawns.
  // Nothing runnable → nothing to ping.
  for (const files of runnable) resolvePaidShardTimeoutMs(files, timeoutOverride);
  if (runnable.length > 0) preflightAnthropicApi(process.env);

  const runSummary = await runPaidShards(runnable, {
    // Tier reaches the children only via EVALS_TIER below; the runtime
    // E2E_TIERS filter inside each child is the real selection mechanism.
    timeoutMs: options.timeoutExplicit ? options.timeoutMs : undefined,
    jobs: options.jobs,
    withinShardConcurrency: options.withinShardConcurrency,
    ...(fast ? {
      expectedCases: Object.fromEntries(runnable.flat().map(file => [file, expectedPrCaseCount(file, cases.selection)])),
      casePatterns: Object.fromEntries(runnable.flat().map(file => [file, prProfileTestNamePattern(file, cases.selection)])),
    } : {}),
    env: {
      ...process.env,
      EVALS: '1',
      EVALS_TIER: options.tier,
      EVALS_PREFLIGHT_OK: '1',
      // The parent's selection, computed once above — children's e2e-helpers
      // module load adopts it instead of re-deriving per shard (which spawned
      // a bun subprocess per child on the touchfiles-data map-diff path).
      // Children fall back to local derivation on any parse failure.
      ...paidSelectionEnv(options.profile, cases.selection, cases.reason),
    },
    evalDirBase: process.env.GSTACK_EVAL_DIR || getProjectEvalDir(),
  });
  const skippedOutcomes: ShardOutcome[] = skipped.map((s, index) => ({
    shard: runnable.length + index + 1,
    files: s.files,
    status: 'skipped-by-diff',
    exitCode: null,
    elapsedMs: 0,
    groupPid: null,
    executedTests: null,
    skippedTests: null,
  }));
  const guardedOutcomes = applyHollowShardGuard(runSummary.outcomes, {
    evalsAll: process.env.EVALS_ALL === '1',
    requireExecuted: fast,
  });
  const summary = summarize([...guardedOutcomes, ...skippedOutcomes]);
  for (const line of formatSummary(summary)) console.log(line);
  return summaryExitCode(summary);
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`[test:paid] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
