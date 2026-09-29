/**
 * Timeout policy for paid tests — five tiers instead of hand-tuned sprawl.
 *
 * Before this module the paid suite carried 46×300s, 46×120s, 44×360s,
 * 44×180s, 27×240s, 19×150s, 13×420s, 12×600s, 7×700s… hand-ratcheted
 * per test, several inflated to paper over the old 40-way in-shard
 * concurrency (session startup queued behind 39 siblings and ate the
 * budget before turn one — dead with the sharded runner's 1-file-per-shard
 * model). Pick the tier that matches the test's SHAPE; escape-hatch raw
 * literals stay legal with a justification comment (count-ratcheted by
 * test/eval-budgets-policy.test.ts).
 *
 * Every tier must fit inside the lane walls — pinned by the fit test in
 * test/eval-budgets-policy.test.ts against the sharded runner's
 * DEFAULT_SHARD_TIMEOUT_MS. Budget above the wall is fiction, not headroom.
 */

/** LLM-judge call over an existing capture (no agent session). */
export const JUDGE_MS = 120_000;

/** One bounded capture: SDK execution or the first displayed native question. */
export const CAPTURE_MS = 300_000;

/** Multi-capture or long multi-turn `claude -p` flows. */
export const CAPTURE_LONG_MS = 600_000;

/** Interactive real-PTY flow (spawn + skill + a few interactions). */
export const PTY_MS = 900_000;

/**
 * Chained/judged PTY observation — the ceiling tier. 1200s leaves the
 * 1800s shard wall real overhead; anything that genuinely needs more
 * should be split or use an explicitly registered workflow exception with
 * corresponding runner and CI walls; never inflate an ordinary tier.
 */
export const PTY_LONG_MS = 1_200_000;

export const ALL_TIERS = {
  JUDGE_MS,
  CAPTURE_MS,
  CAPTURE_LONG_MS,
  PTY_MS,
  PTY_LONG_MS,
} as const;

/** Supervision reserve added to every registered whole-file wall. */
export const SHARD_RESERVE_MS = 2 * 60_000;

/**
 * Retry policy (approved 2026-09-29): a timed-out attempt is a verdict. Bun's
 * --retry reruns a failed case after it may have spent its whole budget, so an
 * automatic retry is kept only where one more attempt is short: every case of
 * the file has a per-attempt budget of at most RETRY_MAX_CASE_MS, the CAPTURE
 * tier plus its recording grace. Those failures are fast flake classes (API
 * blips, tool hiccups) and a retry costs at most one more short attempt. Files
 * with any longer case run once. Per-case budgets never change with this rule.
 */
export const RETRY_MAX_CASE_MS = CAPTURE_MS + 15_000;

export function retriesWithinCaseCap(caseMs: number, configuredRetries: number): number {
  return caseMs <= RETRY_MAX_CASE_MS ? configuredRetries : 0;
}

/**
 * Unregistered paid files that keep one automatic retry: every case budget is
 * JUDGE or CAPTURE tier (test/paid-retry-supervision.test.ts scans each source).
 * Registered rows below derive retries from their declared caseMs; every other
 * paid file runs once.
 */
export const SHORT_CASE_RETRY_FILES: readonly string[] = [
  'test/codex-e2e-sol-scope.test.ts',
  'test/llm-judge-recommendation.test.ts',
  'test/skill-e2e-ask-user-question-format-compliance.test.ts',
  'test/skill-e2e-benchmark-providers.test.ts',
  'test/skill-e2e-bws.test.ts',
  'test/skill-e2e-context-skills.test.ts',
  'test/skill-e2e-coverage-audit.test.ts',
  'test/skill-e2e-diagram.test.ts',
  'test/skill-e2e-first-task-scaffold.test.ts',
  'test/skill-e2e-gbrain-roundtrip-local.test.ts',
  'test/skill-e2e-hermetic-canary.test.ts',
  'test/skill-e2e-investigate-owned-completion.test.ts',
  'test/skill-e2e-investigate-owned-termination.test.ts',
  'test/skill-e2e-learnings.test.ts',
  'test/skill-e2e-plan-tune.test.ts',
  'test/skill-e2e-qa-functional-fix.test.ts',
  'test/skill-e2e-qa-functional.test.ts',
  'test/skill-e2e-review-army.test.ts',
  'test/skill-e2e-review.test.ts',
  'test/skill-e2e-session-intelligence.test.ts',
  'test/skill-e2e-setup-gbrain-bad-token.test.ts',
  'test/skill-e2e-setup-gbrain-path4-local-pglite.test.ts',
  'test/skill-e2e-setup-gbrain-remote.test.ts',
  'test/skill-e2e-ship-hook-consent.test.ts',
  'test/skill-e2e-ship-hook-refresh.test.ts',
  'test/skill-e2e-ship-skip.test.ts',
  'test/skill-e2e-sync-gbrain-readiness.test.ts',
  'test/skill-e2e-third-party-actions.test.ts',
  'test/skill-e2e-triage.test.ts',
  'test/skill-routing-e2e.test.ts',
];

/** Whole-file supervision covers every attempt the retry policy allows.
 * These fixtures allow 25 minutes per case, so they run once.
 * Reserve the sequential upper bound even when Bun runs sibling cases together.
 */
export const FINDING_RETRY_BUDGETS = [
  { file: 'test/skill-e2e-plan-ceo-split-overflow.test.ts', cases: 1 },
  { file: 'test/skill-e2e-plan-eng-multi-finding-batching.test.ts', cases: 1 },
].map(({ file, cases }) => {
  const retries = retriesWithinCaseCap(1_500_000, 1);
  return {
    file, cases,
    id: `${file.slice('test/skill-e2e-'.length, -'.test.ts'.length)}-existing-retry-v1`,
    testMs: 1_500_000,
    caseMs: 1_500_000,
    retries,
    shardReserveMs: SHARD_RESERVE_MS,
    shardMs: cases * 1_500_000 * (retries + 1) + SHARD_RESERVE_MS,
  };
});

/** Three existing captures in one 16-minute case, so the file runs once. */
export const AUQ_CONSISTENCY_RETRY_BUDGET = {
  file: 'test/skill-e2e-auq-consistency.test.ts',
  id: 'auq-consistency-existing-retry-v1',
  cases: 1,
  testMs: 3 * CAPTURE_MS + 60_000,
  caseMs: 3 * CAPTURE_MS + 60_000,
  retries: retriesWithinCaseCap(3 * CAPTURE_MS + 60_000, 1),
  shardReserveMs: SHARD_RESERVE_MS,
  shardMs: (3 * CAPTURE_MS + 60_000) * (retriesWithinCaseCap(3 * CAPTURE_MS + 60_000, 1) + 1) + SHARD_RESERVE_MS,
} as const;

/** These fixtures have a fixed case count in every supported tier. */
export const STRICT_RETRY_CASE_BUDGETS = [...FINDING_RETRY_BUDGETS, AUQ_CONSISTENCY_RETRY_BUDGET];

/** Whole-file walls cover all existing cases and every allowed attempt, even if
 * Bun runs them sequentially. Mixed-tier files reserve their larger complete
 * tier, never a currently selected subset. caseMs is the longest single case
 * budget, which decides the retry (RETRY_MAX_CASE_MS). These rows add no
 * case-count or model-work policy. The 10-second terms preserve the existing
 * Codex/recording finalization grace.
 */
export const FILE_RETRY_BUDGETS = [
  ...STRICT_RETRY_CASE_BUDGETS,
  ...[
    { file: 'test/skill-e2e-qa-callers.test.ts', attemptMs: 5 * (CAPTURE_MS + 15_000), caseMs: CAPTURE_MS + 15_000, configuredRetries: 1 },
    { file: 'test/skill-e2e-shared-libs-paths.test.ts', attemptMs: 3 * CAPTURE_LONG_MS, caseMs: CAPTURE_LONG_MS, configuredRetries: 1 },
    { file: 'test/skill-e2e-ship-docsync.test.ts', attemptMs: 5 * CAPTURE_LONG_MS + 8 * CAPTURE_MS, caseMs: CAPTURE_LONG_MS, configuredRetries: 1 },
    // Seventeen workflow judges include their 10s recording grace; the other
    // seven judges retain 120s. Supervise all 24 and the existing one retry.
    { file: 'test/skill-llm-eval.test.ts', attemptMs: 17 * (JUDGE_MS + 10_000) + 7 * JUDGE_MS, caseMs: JUDGE_MS + 10_000, configuredRetries: 1 },
    { file: 'test/skill-e2e-auq-matrix.test.ts', attemptMs: 6 * CAPTURE_MS, caseMs: CAPTURE_MS, configuredRetries: 1 },
    { file: 'test/skill-e2e-plan-format.test.ts', attemptMs: 4 * (CAPTURE_MS + 10_000), caseMs: CAPTURE_MS + 10_000, configuredRetries: 1 },
    { file: 'test/skill-e2e-auto-decide-preserved.test.ts', attemptMs: PTY_MS, caseMs: PTY_MS, configuredRetries: 1 },
    { file: 'test/skill-e2e-plan-ceo-finding-floor.test.ts', attemptMs: PTY_MS, caseMs: PTY_MS, configuredRetries: 1 },
    { file: 'test/skill-e2e-plan-eng-finding-floor.test.ts', attemptMs: PTY_MS, caseMs: PTY_MS, configuredRetries: 1 },
    { file: 'test/skill-e2e-plan-design-finding-floor.test.ts', attemptMs: PTY_MS, caseMs: PTY_MS, configuredRetries: 1 },
    { file: 'test/skill-e2e-plan-devex-finding-floor.test.ts', attemptMs: PTY_MS, caseMs: PTY_MS, configuredRetries: 1 },
    { file: 'test/skill-e2e-plan-mode-no-op.test.ts', attemptMs: 5 * CAPTURE_LONG_MS, caseMs: CAPTURE_LONG_MS, configuredRetries: 2 },
    { file: 'test/skill-e2e-plan-ceo-mode-routing.test.ts', attemptMs: 2 * CAPTURE_LONG_MS, caseMs: CAPTURE_LONG_MS, configuredRetries: 1 },
    { file: 'test/skill-e2e-plan-eng-plan-mode.test.ts', attemptMs: 2 * CAPTURE_LONG_MS, caseMs: CAPTURE_LONG_MS, configuredRetries: 1 },
    { file: 'test/skill-e2e-plan-prosons.test.ts', attemptMs: 4 * (CAPTURE_MS + 10_000), caseMs: CAPTURE_MS + 10_000, configuredRetries: 1 },
    // Gate: six 300s cases + one 610s case; periodic: two 900s + three 600s.
    { file: 'test/skill-e2e-plan.test.ts', attemptMs: Math.max(6 * CAPTURE_MS + CAPTURE_LONG_MS + 10_000, 2 * PTY_MS + 3 * CAPTURE_LONG_MS), caseMs: PTY_MS, configuredRetries: 1 },
  ].map(({ file, attemptMs, caseMs, configuredRetries }) => {
    const retries = retriesWithinCaseCap(caseMs, configuredRetries);
    return {
      file, attemptMs, caseMs, retries,
      id: `${file.slice('test/'.length, -'.test.ts'.length)}-existing-retry-v1`,
      shardReserveMs: SHARD_RESERVE_MS,
      shardMs: attemptMs * (retries + 1) + SHARD_RESERVE_MS,
    };
  }),
];

/** No paid test may exceed the ordinary tiers; arbitrary per-file escapes fail. */
export function assertPaidTestBudget(file: string, ms: number): void {
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > PTY_LONG_MS * 1.25) {
    throw new Error(`Unregistered paid test budget: ${file}: ${ms}`);
  }
}
