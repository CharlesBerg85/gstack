/**
 * runPlanSkillObservation. Moved from claude-pty-runner.ts.
 * Import through test/helpers/claude-pty-runner.ts from tests; pty/ modules import siblings directly.
 */
import * as path from 'node:path';
import { createPlanCountSnapshotWriter } from '../../plan-count-artifacts';
import { nativeSeededPlanSelection } from '../../plan-scope-selection';
import { bindAutoDecisionState } from '../../auto-decision-state';
import { findNativeAutoDecision, type NativeAutoDecision } from '../../native-auto-decide';
import { readPlanCountTranscript, type PlanCountTranscript, type NativePublicToolEvent } from '../../plan-count-transcript';
import { submitPlanSeed, PlanSeedTimeout } from '../../plan-seed-submission';
import { randomUUID } from 'node:crypto';
import { classifyVisible, isProseAUQVisible, isScopeGateAutoSelectVisible, isScopeGateQuestionVisible } from '../classify';
import { judgePtyState, logPtySnapshot } from '../judge';
import type { PtyStateVerdict } from '../judge';
import { launchClaudePty } from '../launch';
import { extractPlanFilePath, isNumberedOptionListVisible, isPermissionDialogVisible, isPlanReadyVisible, isRejectedSlashCommand } from '../screen';
import type { PtyDriver } from '../session';

// ---------------------------------------------------------------------------
// High-level skill-mode test contract
// ---------------------------------------------------------------------------

export interface PlanSkillObservation {
  /** Exact owned public-native annotation when terminal redraws lose it. */
  nativeAutoDecide?: NativeAutoDecision;
  /** Persisted public diagnostics for this attempt, when eval recording is enabled. */
  artifactDir?: string;
  artifactError?: string;
  /**
   * What happened first. One of:
   *  - 'asked'        — skill emitted a numbered-option prompt (its Step 0
   *                     AskUserQuestion or the routing-injection prompt)
   *  - 'auto_decided' — visible TTY shows "Auto-decided ... → ..." (the
   *                     AUTO_DECIDE preamble template fired). Distinguishes
   *                     "the regression we're tracking" (auto-mode silently
   *                     auto-deciding questions the user wanted to see) from
   *                     "skill legitimately reached plan_ready". Detected
   *                     before plan_ready/silent_write so the auto-decide
   *                     evidence wins when both are present.
   *  - 'plan_ready'   — claude wrote a plan and emitted its native
   *                     "Ready to execute" confirmation
   *  - 'silent_write' — a Write/Edit landed BEFORE any prompt, to a path
   *                     outside the sanctioned plan/project directories
   *  - 'wrote_findings_before_asking' — strictPlanWrites only (seeded runs):
   *                     the plan file was rewritten with findings before any
   *                     AskUserQuestion render (the May-2026 transcript bug)
   *  - 'exited'       — claude process died before any of the above
   *  - 'timeout'      — none of the above within budget
   */
  outcome:
    | 'asked'
    | 'auto_decided'
    | 'plan_ready'
    | 'silent_write'
    | 'wrote_findings_before_asking'
    | 'exited'
    | 'timeout';
  /** Human-readable summary. */
  summary: string;
  /** Visible terminal text since the slash command was sent (last 2KB). */
  evidence: string;
  /** Wall time (ms) until the outcome was decided. */
  elapsedMs: number;
  /**
   * Path to the plan file the skill wrote (if outcome is 'plan_ready').
   * Extracted from the visible TTY via {@link extractPlanFilePath}. Lets the
   * v1.22 AskUserQuestion-blocked regression tests verify the plan file
   * contains a `## Decisions to confirm` section under --disallowedTools —
   * a model that silently skips Step 0 reaches plan_ready WITHOUT writing
   * the section, and that's the regression we want to catch.
   */
  planFile?: string;
  /**
   * High-water-mark flag: did the polling loop ever observe a
   * prose-rendered AskUserQuestion (lettered or numbered options visible)
   * during the run? Set true the first poll iteration that
   * isProseAUQVisible returns true on the recent buffer; remains true
   * for the rest of the observation.
   *
   * The 2KB `evidence` window often misses the prose-AUQ moment because
   * by the time outcome=plan_ready fires, the ExitPlanMode "Ready to
   * execute" UI has pushed the options out of the tail. Tests that need
   * to assert "the user saw the question at SOME point" should check
   * this flag rather than re-running isProseAUQVisible on the truncated
   * evidence.
   */
  proseAUQEverObserved?: boolean;
  /**
   * High-water-mark flag: did the LLM judge ever return state='waiting'
   * during the run? Same shape as proseAUQEverObserved but driven by the
   * Haiku judge fallback rather than the regex detector.
   */
  waitingEverObserved?: boolean;
  /**
   * High-water-mark flag: did the scope-gate QUESTION ("What should I
   * review?" plus option-body text) ever render during the run? Same
   * lossy-2KB-evidence rationale as proseAUQEverObserved. The plan-mode
   * smokes assert this stays false (gate bypassed via auto-select B); the
   * no-op regression asserts it fires outside plan mode.
   */
  scopeGateQuestionObserved?: boolean;
  /**
   * High-water-mark flag: did the plan-mode auto-select announcement
   * ("Scope gate: plan mode — auto-selected B …") ever render? The
   * plan-mode smokes assert true; the no-op regression asserts false.
   */
  scopeGateAutoSelectObserved?: boolean;
  /**
   * High-water map for opts.trackTokens: token → did it EVER appear in the
   * cumulative visible buffer? Consumption asserts (e.g. "the pasted target's
   * distinctive token shows up in the review output") must not depend on the
   * lossy 2KB evidence tail — plan-file fallbacks are unreachable outside
   * plan mode (extractPlanFilePath only matches plan-mode save renders).
   */
  tokensObserved?: Record<string, boolean>;
}

/**
 * The contract for "skill X invoked in plan mode behaves correctly."
 *
 * PASS: outcome is 'asked' or 'plan_ready'.
 *   - 'asked' = the skill is gating decisions on the user, as expected.
 *   - 'plan_ready' = the skill ran end-to-end, wrote a plan file, and
 *     surfaced claude's native confirmation. Some skills (like
 *     plan-design-review on a no-UI branch) legitimately reach plan_ready
 *     without firing AskUserQuestion because they short-circuit.
 *
 * FAIL: 'silent_write' or 'exited' or 'timeout'.
 *
 * This replaces the SDK-based runPlanModeSkillTest which never worked
 * because plan mode renders its native confirmation as TTY UI, not via
 * the AskUserQuestion tool — so canUseTool never fired and the assertion
 * counted zero questions.
 */
export async function runPlanSkillObservation(opts: {
  /** Skill name, e.g. 'plan-ceo-review'. */
  skillName: string;
  /** Whether to launch in plan mode. Default true. The no-op regression
   *  test sets this false to verify skills work outside plan mode. */
  inPlanMode?: boolean;
  /** Working directory. Default process.cwd(). */
  cwd?: string;
  /** Total budget for skill to reach a terminal outcome. Default 180000. */
  timeoutMs?: number;
  /** Keep observing a judge-only waiting verdict when the caller requires
   * a rendered prose choice list. Deterministic terminal outcomes retain
   * precedence; this does not grant prose credit to a judge verdict. */
  requireProseEvidence?: boolean;
  /** Optional witness in this attempt's explicit child state. */
  autoDecisionState?: { stateRoot: string; projectSlug: string };
  /** Extra CLI args appended after --permission-mode. Used by the v1.22+
   *  AskUserQuestion-blocked regression tests to pass
   *  `['--disallowedTools', 'AskUserQuestion']` (the flag set Conductor
   *  uses to remove native AskUserQuestion in favor of its MCP variant).
   *  Plumbs straight through to launchClaudePty. */
  extraArgs?: string[];
  /**
   * Extra env merged into the spawned `claude` process. `launchClaudePty`
   * already supports this; exposing it here lets per-skill tests isolate
   * from local config that would mask the regression they're trying to
   * catch (e.g., `QUESTION_TUNING=true` causing AUTO_DECIDE to skip the
   * rendered AskUserQuestion list).
   */
  env?: Record<string, string>;
  /**
   * Seed an initial plan that the spawned `claude` process operates on.
   * STOP-gate regression tests need a plan with guaranteed-finding-triggering
   * complexity (8+ files, custom-vs-builtin smell) so the skill MUST emit
   * AskUserQuestion or fall back to a Decisions section. Without this,
   * plan-mode creates a fresh empty plan and the skill has nothing to find
   * issues with.
   *
   * Implementation: claude has no `--plan-file` flag (verified via
   * `claude --help`). We pre-pump a user message containing the draft
   * plan, wait for it to register, then invoke the skill. The skill's
   * Step 0 reads the prior conversation context so it sees the draft.
   */
  initialPlanContent?: string;
  /** Override the spawned model. Defaults via launchClaudePty's chain
   *  (opts.model ?? EVALS_MODEL ?? resolveEvalModel('capture')). */
  model?: string;
  /** Literal tokens to track as high-water marks over the CUMULATIVE visible
   *  buffer (case-sensitive). Results land in obs.tokensObserved. Use for
   *  consumption asserts that must survive the 2KB evidence tail. */
  trackTokens?: string[];
  /** Launch seam and clock; tests pass the fake driver. Default: real launcher and clocks. */
  driver?: PtyDriver;
}): Promise<PlanSkillObservation> {
  const driver = opts.driver ?? { launch: launchClaudePty, now: () => Date.now(),
    monotonic: () => performance.now(), sleep: (ms: number) => Bun.sleep(ms) };
  const startedAt = driver.now();
  const budgetMs = opts.timeoutMs ?? 180_000;
  const deadlineAt = startedAt + budgetMs;
  const screenDeadlineAt = driver.monotonic() + budgetMs;
  // Explicitly identify only a new seeded plan-mode session. Caller-owned
  // resume/session arguments retain their existing behavior.
  const scopeSessionId = opts.initialPlanContent && opts.inPlanMode !== false &&
    !opts.extraArgs?.some(arg => /^(?:--session-id|--resume|--continue|-r|-c)(?:=|$)/.test(arg))
    ? randomUUID() : undefined;
  const readAutoDecisionState = opts.autoDecisionState
    ? bindAutoDecisionState(opts.autoDecisionState, opts.env, opts.skillName) : undefined;
  const saveSnapshot = createPlanCountSnapshotWriter();
  const session = await driver.launch({
    permissionMode: opts.inPlanMode === false ? null : 'plan',
    cwd: opts.cwd,
    timeoutMs: (opts.timeoutMs ?? 180_000) + 30_000,
    extraArgs: [...(opts.extraArgs ?? []), ...(scopeSessionId ? ['--session-id', scopeSessionId] : [])],
    env: {
      ...(opts.inPlanMode !== false && !opts.extraArgs?.some(arg => /^--permission-mode(?:=|$)/.test(arg))
        ? { GSTACK_PLAN_MODE: 'active' } : {}),
      ...opts.env,
    },
    model: opts.model,
    seedSkills: true,
    observeScreen: !!opts.initialPlanContent,
    screenDeadlineAt,
  });

  let observationFailed = false;
  try {
    const preflightTimeout = async (summary: string): Promise<PlanSkillObservation> => {
      let viewport: string | undefined, viewportError: string | undefined;
      try { viewport = (await session.currentScreenFrame())?.text; } catch (error) { viewportError = String(error); }
      const artifacts = saveSnapshot({ skillName: opts.skillName, cwd: path.resolve(opts.cwd ?? process.cwd()),
        claudeConfigDir: session.hermeticConfigDir, raw: session.rawOutput(), visible: session.visibleText(), viewport,
        observation: { state: 'plan_skill_preflight_timeout', summary, scopeSessionId, startedAt, deadlineAt, viewportError } });
      return {
        outcome: 'timeout', summary, evidence: session.visibleText().slice(-2000),
        elapsedMs: driver.now() - startedAt,
        proseAUQEverObserved: false, waitingEverObserved: false,
        scopeGateQuestionObserved: false, scopeGateAutoSelectObserved: false,
        ...(opts.trackTokens?.length ? { tokensObserved: Object.fromEntries(opts.trackTokens.map(t => [t, false])) } : {}),
        ...artifacts,
      };
    };
    // Entry deadline → boot → owned paste/receipt/ack → slash → observation.
    // Setup consumes the existing case budget; cleanup has its separate grace.
    if (!opts.initialPlanContent) await driver.sleep(Math.min(8000, Math.max(0, deadlineAt - driver.now())));
    if (opts.initialPlanContent) {
      const seed = `Keep this draft plan as context. Briefly acknowledge receipt, then wait for my next message containing a slash command. Do not start the review or call tools yet.\n\n${opts.initialPlanContent}`;
      try {
        await submitPlanSeed({...session, currentScreen: session.currentScreenFrame}, seed, {
          cwd: opts.cwd ?? process.cwd(), launchedAt: startedAt, deadlineAt,
          isQuestionOrPermission: text => isProseAUQVisible(text) || isNumberedOptionListVisible(text) || isPermissionDialogVisible(text),
        });
      } catch (error) {
        if (!(error instanceof PlanSeedTimeout)) throw error;
        return await preflightTimeout(`Plan seed submission failed: ${error.message}`);
      }
    }
    if (driver.now() >= deadlineAt) return await preflightTimeout('Boot or seed preflight exhausted the existing case budget');
    const commandStartedAt = driver.now();
    const since = session.mark();
    session.send(`/${opts.skillName}\r`);

    const start = driver.now();
    let lastJudgeAt = 0;
    let lastJudgeVerdict: PtyStateVerdict | null = null;
    // High-water marks: did we EVER see a prose-AUQ surface or a judge
    // 'waiting' verdict during the run? Models may surface options
    // briefly, then resume thinking when no user response comes (test
    // env has no responder). At timeout we trust historical signals
    // even if the current state is 'working'.
    let proseAUQEverObserved = false;
    let waitingEverObserved = false;
    let scopeGateQuestionObserved = false;
    let scopeGateAutoSelectObserved = false;
    let scopeTranscript: PlanCountTranscript = { status: 'missing', calls: [], assistantMessages: [] };
    let scopeTools: NativePublicToolEvent[] = [];
    let nativeAutoDecide: NativeAutoDecision | null = null;
    let nativePolledAt: number | null = null;
    const tokensObserved: Record<string, boolean> = {};
    for (const t of opts.trackTokens ?? []) tokensObserved[t] = false;
    // Single source for the high-water flags at EVERY return site. Hand-
    // spreading them per-site already drifted once (the judge-waiting return
    // omitted the prose/waiting flags); a site that forgets a must-stay-false
    // flag makes `obs.flag ?? false` negative assertions pass vacuously.
    const highWaterFlags = () => {
      const flags = { proseAUQEverObserved, waitingEverObserved,
        scopeGateQuestionObserved, scopeGateAutoSelectObserved,
        ...(nativeAutoDecide ? { nativeAutoDecide } : {}),
        ...(opts.trackTokens?.length ? { tokensObserved } : {}) };
      // Preserve the measured terminal flags and public evidence before the
      // hermetic session is removed, including when a later assertion fails.
      const artifacts = saveSnapshot({ skillName: opts.skillName,
        cwd: path.resolve(opts.cwd ?? process.cwd()), claudeConfigDir: session.hermeticConfigDir,
        raw: session.rawOutput(), visible: session.visibleSince(since),
        observation: { state: 'plan_skill_observation_terminal', ...flags,
          commandStartedAt, scopeSessionId, native: scopeTranscript, publicTools: scopeTools,
          nativePolledAt, nativeScope: 'Latest owned native poll, refreshed while observing; not an exhaustive terminal journal.' } });
      return { ...flags, ...artifacts };
    };
    const JUDGE_AFTER_MS = 60_000;
    const JUDGE_INTERVAL_MS = 30_000;
    while (driver.now() < deadlineAt) {
      await driver.sleep(Math.min(2000, Math.max(0, deadlineAt - driver.now())));
      const visible = session.visibleSince(since);

      if (session.exited()) {
        return {
          outcome: 'exited',
          summary: `claude exited (code=${session.exitCode()}) before reaching a terminal outcome`,
          evidence: visible.slice(-2000),
          elapsedMs: driver.now() - startedAt,
          ...highWaterFlags(),
        };
      }
      if (isRejectedSlashCommand(visible, `/${opts.skillName}`)) {
        return {
          outcome: 'exited',
          summary: `claude rejected /${opts.skillName} as unknown command (skill not registered in this cwd)`,
          evidence: visible.slice(-2000),
          elapsedMs: driver.now() - startedAt,
          ...highWaterFlags(),
        };
      }

      const classified = classifyVisible(visible, {
        strictPlanWrites: !!opts.initialPlanContent,
        currentScreen: opts.initialPlanContent ? await session.currentScreen() : undefined,
      });
      const pendingSeededCompletion = !!opts.initialPlanContent &&
        isPlanReadyVisible(visible) && classified === null;

      // Cheap surface-tracking: did the model ever surface a prose AUQ in
      // this tick's recent buffer? Track once-true (high water).
      if (!proseAUQEverObserved && !pendingSeededCompletion && isProseAUQVisible(visible)) {
        proseAUQEverObserved = true;
        logPtySnapshot(visible, {
          testName: opts.skillName,
          elapsedMs: driver.now() - start,
          tag: 'prose-auq-surfaced',
        });
      }
      // Scope-gate render tracking (same high-water shape). Full-run
      // detection matters because the 2KB evidence tail usually scrolls
      // past the gate render before the outcome fires.
      if (!scopeGateQuestionObserved && isScopeGateQuestionVisible(visible)) {
        scopeGateQuestionObserved = true;
      }
      if (!scopeGateAutoSelectObserved && isScopeGateAutoSelectVisible(visible)) {
        scopeGateAutoSelectObserved = true;
      }
      // Keep reading after scope selection: an AUTO_DECIDE annotation may
      // arrive later, and a prior poll cannot establish its current ownership.
      if (scopeSessionId && opts.initialPlanContent && session.hermeticConfigDir) {
        scopeTools = [];
        scopeTranscript = readPlanCountTranscript(session.hermeticConfigDir,
          path.resolve(opts.cwd ?? process.cwd()), event => scopeTools.push(event));
        nativePolledAt = driver.now();
        if (!scopeGateAutoSelectObserved) scopeGateAutoSelectObserved = nativeSeededPlanSelection(scopeTranscript, scopeTools, {
          seed: opts.initialPlanContent, skillName: opts.skillName, sessionId: scopeSessionId, commandStartedAt,
        });
      }
      for (const t of opts.trackTokens ?? []) {
        if (!tokensObserved[t] && visible.includes(t)) tokensObserved[t] = true;
      }

      if (classified) {
        const obs: PlanSkillObservation = {
          ...classified,
          evidence: visible.slice(-2000),
          elapsedMs: driver.now() - startedAt,
          ...highWaterFlags(),
        };
        // Capture the plan file path on any outcome where one may have been
        // written. Gating only on 'plan_ready' missed two cases: (1) the
        // 'asked' outcome where the model wrote a plan partway through then
        // paused on a question, and (2) 'wrote_findings_before_asking' where
        // the bug is precisely that the plan was written. The
        // assertReviewReportAtBottom checks downstream gate on planFile
        // existing, not on the outcome.
        const planFile = extractPlanFilePath(visible);
        if (planFile) obs.planFile = planFile;
        return obs;
      }

      // Terminal classification retains precedence (including actual questions
      // and writes). Only an unclassified frame may use owned native auto-decision evidence.
      if (scopeSessionId) {
        nativeAutoDecide = findNativeAutoDecision(scopeTranscript, scopeTools, {
          skillName: opts.skillName, sessionId: scopeSessionId, commandStartedAt, now: driver.now(), proseQuestionObserved: proseAUQEverObserved,
          stateEvidence: readAutoDecisionState?.(),
        });
        if (nativeAutoDecide) return {
          outcome: 'auto_decided',
          summary: 'owned native session completed the saved-preference auto-decision',
          evidence: visible.slice(-2000), elapsedMs: driver.now() - startedAt,
          ...highWaterFlags(),
        };
      }

      // LLM judge fallback: if regex detectors didn't classify and we've
      // burned >60s with periodic ticks, ask Haiku "is the model waiting,
      // working, or hung?" Treat 'waiting' as 'asked' (model surfaced a
      // question via prose the regex couldn't reassemble). Snapshot the
      // visible buffer at each judge call when GSTACK_PTY_LOG=1.
      const elapsed = driver.now() - start;
      if (elapsed > JUDGE_AFTER_MS && driver.now() - lastJudgeAt > JUDGE_INTERVAL_MS) {
        lastJudgeAt = driver.now();
        logPtySnapshot(visible, { testName: opts.skillName, elapsedMs: elapsed, tag: 'judge-tick' });
        lastJudgeVerdict = judgePtyState(visible, { testName: opts.skillName });
        if (lastJudgeVerdict.state === 'waiting' && !pendingSeededCompletion) {
          waitingEverObserved = true;
          if (opts.requireProseEvidence && !proseAUQEverObserved) continue;
          return {
            outcome: 'asked',
            summary: `LLM judge: ${lastJudgeVerdict.reasoning} (state=waiting after ${Math.round(elapsed / 1000)}s)`,
            evidence: visible.slice(-2000),
            elapsedMs: driver.now() - startedAt,
            ...highWaterFlags(),
          };
        }
      }
    }

    // Timeout fallback: if we observed a prose-AUQ surface OR a judge
    // 'waiting' verdict at any point during the run, treat as 'asked'.
    // This catches the model-surfaced-then-resumed-thinking case where
    // by the time the timeout fires, the buffer has moved past the
    // options into spinner state but the question DID surface earlier.
    const finalVisible = session.visibleSince(since);
    if (proseAUQEverObserved || waitingEverObserved && !opts.requireProseEvidence) {
      return {
        outcome: 'asked',
        summary:
          `prose-AUQ surface observed during run (proseAUQEverObserved=${proseAUQEverObserved}, waitingEverObserved=${waitingEverObserved}); model surfaced the question and the test budget elapsed without a follow-up classification` +
          (lastJudgeVerdict
            ? ` (last LLM judge: ${lastJudgeVerdict.state} — ${lastJudgeVerdict.reasoning})`
            : ''),
        evidence: finalVisible.slice(-2000),
        elapsedMs: driver.now() - startedAt,
        ...highWaterFlags(),
      };
    }
    return {
      outcome: 'timeout',
      summary:
        `no terminal outcome within ${budgetMs}ms` +
        (lastJudgeVerdict
          ? ` (last LLM judge: state=${lastJudgeVerdict.state} — ${lastJudgeVerdict.reasoning})`
          : ''),
      evidence: finalVisible.slice(-2000),
      elapsedMs: driver.now() - startedAt,
      ...highWaterFlags(),
    };
  } catch (error) {
    observationFailed = true;
    try {
      const publicTools: NativePublicToolEvent[] = [];
      const transcript = session.hermeticConfigDir ? readPlanCountTranscript(session.hermeticConfigDir,
        path.resolve(opts.cwd ?? process.cwd()), event => publicTools.push(event)) : undefined;
      const saved = saveSnapshot({ skillName: opts.skillName, cwd: path.resolve(opts.cwd ?? process.cwd()),
        claudeConfigDir: session.hermeticConfigDir, raw: session.rawOutput(), visible: session.visibleText(),
        observation: { state: 'threw', error: String(error), transcript, publicTools } });
      if (saved.artifactError) console.error(`PTY artifact write failed: ${saved.artifactError}`);
    } catch (captureError) { console.error(`PTY failure capture failed: ${String(captureError)}`); }
    throw error;
  } finally {
    try { await session.close(); }
    catch (error) { if (!observationFailed) throw error; }
  }
}
