/**
 * runPlanSkillCounting. Moved from claude-pty-runner.ts.
 * Import through test/helpers/claude-pty-runner.ts from tests; pty/ modules import siblings directly.
 */
import * as path from 'node:path';
import { createPlanCountFixture } from '../../plan-count-fixture';
import { createPlanCountSnapshotWriter } from '../../plan-count-artifacts';
import { readPlanCountTranscript, unresolvedPlanQuestionCalls, type NativePlanQuestionCall, type PlanCountTranscript, type NativePublicToolEvent } from '../../plan-count-transcript';
import { withPendingExit } from '../../plan-count-pending-exit';
import { readPendingQuestion } from '../../plan-count-pending-question';
import { currentFilePermissionBinding, readPendingWriteInput, type FilePermissionEpoch } from '../../plan-count-file-permission';
import { autoplanArtifactRecorderStatus, autoplanArtifactApprovalBoundary } from '../../autoplan-artifact-recorder';
import { stripVTControlCharacters } from 'node:util';
import { capturePlanCountQuestion, createPlanCountPermissionGuard, matchesNativePlanQuestion, nativePlanCallFingerprint, planCountPrerequisitePick, planCountQuestionInput, planCountQuestionPhase } from '../auq';
import type { AskUserQuestionFingerprint, Step0BoundaryPredicate } from '../auq';
import { SANCTIONED_WRITE_SUBSTRINGS, classifyPlanCountFrame, isProseAUQVisible, planCountSubmissionInput } from '../classify';
import { launchClaudePty, selectPtyNumberedOption } from '../launch';
import type { ClaudePtySession } from '../launch';
import { evaluateOwnedNativePlanTerminal, hasNativePlanCompletion, hasNativePlanTerminal, isQuestionlessNativePlanExit } from '../plan-native';
import type { NativePlanTerminalEvaluator } from '../plan-native';
import { isNumberedOptionListVisible, isPermissionDialogVisible, isRejectedSlashCommand } from '../screen';
import type { PtyDriver } from '../session';

// ────────────────────────────────────────────────────────────────────────────
// runPlanSkillCounting — drives a plan-* skill end-to-end through Step 0 then
// counts completed review-phase AskUserQuestion calls. The actual
// product asserted by the per-finding-count tests.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Result of a `runPlanSkillCounting` run. Includes both the count summary
 * (`step0Count`, `reviewCount`, `administrativeCount`) and the full fingerprint list for diagnostic
 * dumps when an assertion fails.
 */
export interface PlanSkillCountObservation {
  /** Durable full raw/visible PTY output plus JSON observation, when EVALS_RUN_ID or GSTACK_EVAL_DIR is set. */
  artifactDir?: string;
  artifactError?: string;
  outcome:
    | 'plan_ready'
    | 'completion_summary'
    | 'collection_complete'
    | 'ceiling_reached'
    | 'silent_write'
    | 'transcript_unavailable'
    | 'artifact_permission_failed'
    | 'no_review_questions'
    | 'exited'
    | 'timeout';
  summary: string;
  /** Visible terminal text at terminal time (last 3KB). */
  evidence: string;
  /** Wall time (ms) until the outcome was decided. */
  elapsedMs: number;
  /** All distinct AskUserQuestions observed, in observation order. */
  fingerprints: AskUserQuestionFingerprint[];
  /** Actual native calls, including unanswered/failed ones that add no coverage. */
  transcript: PlanCountTranscript;
  /** Setup questions; administrative calls are excluded. */
  step0Count: number;
  /** Review questions; administrative calls are excluded. */
  reviewCount: number;
  /** Answered administrative handoffs and artifact rendering, preserved separately. */
  administrativeCount: number;
}

/**
 * Drive a plan-* skill in plan mode and count distinct native review-phase
 * AskUserQuestions until a terminal signal fires. Each run disables the
 * extra outside review in its own gstack config: independent reviewers can
 * add valid findings unrelated to the seeded-N cadence band. These counts
 * do not assert outside-review dispatch or its approval-question cadence.
 *
 * Flow:
 *   1. Seed the complete fixture request in an isolated git repository's
 *      PLAN.md and initial CLAUDE.md context, with owned native-only config,
 *      then boot the PTY in that cwd
 *      (8s grace + auto-trust dialog). Skills remain registered in user scope.
 *   2. Send `slashCommand` alone. The fixture is already in context; sending
 *      it later can queue it behind the skill's first question while the
 *      review incorrectly starts against the operator's live branch.
 *   3. Poll loop:
 *      - Skip permission dialogs (auto-grant with `defaultPick`).
 *      - Read fixture-scoped native JSONL. Count each AskUserQuestion call
 *        once after its matching successful answer record, regardless of
 *        how many questions the call batches. Full native metadata feeds
 *        phase predicates; ANSI redraws and permissions cannot add counts.
 *      - On a new numbered-option list, keep the existing PTY answer driver.
 *        Decline only the recognized optional office-hours
 *        prerequisite by label so a different skill does not rewrite the
 *        seeded plan before this review begins.
 *      - After the native answer, evaluate `isLastStep0AUQ(fingerprint)`. If true,
 *        subsequent AUQs are review-phase unless the caller positively identifies native setup.
 *      - Hard ceiling: if `reviewCount >= reviewCountCeiling`, return
 *        `ceiling_reached`. This bounds runaway counts; tests should set
 *        the ceiling above their assertion CEILING.
 *      - Soft terminals: `COMPLETION_SUMMARY_RE` match → `completion_summary`;
 *        plan-ready confirmation → `plan_ready`; silent write outside
 *        sanctioned dirs → `silent_write`; process exited → `exited`;
 *        wall clock exceeded → `timeout`.
 *
 * Boundary detection (D14): event-based, fired against the answered AUQ's
 * fingerprint, not against later rendered content. This avoids the race
 * where Step-0-final and Section-1-first AUQs straddle a section header
 * regex match.
 *
 * UI fingerprints still dedupe redraws. Counted fingerprints use the
 * native session/tool call IDs, so shared answer labels never collapse
 * different calls and one multi-question call remains one finding.
 */
export async function runPlanSkillCounting(opts: {
  /** Skill name, e.g. 'plan-ceo-review'. Used for diagnostic strings only. */
  skillName: string;
  /** Slash command to send alone, e.g. '/plan-ceo-review'. No trailing args. */
  slashCommand: string;
  /** Fixture request seeded in initial project context before the slash command. */
  followUpPrompt: string;
  /** Observe this caller-owned disposable plan for permission identity only.
   * Does not impose the expectedPlanPath terminal-report contract. */
  permissionPlanPath?: string;
  /** Declared actor support for the required QA artifact; no other state path gains approval. */
  approveEngTestPlanEdits?: boolean;
  /** Per-skill predicate: which answered AUQ is the last Step-0 question. */
  isLastStep0AUQ: Step0BoundaryPredicate;
  /** Optional positive identity for a first finding when no final setup AUQ was emitted. */
  isFirstReviewAUQ?: Step0BoundaryPredicate;
  /** Optional native setup classifier; late/reordered setup must not become a finding. */
  isSetupAUQ?: Step0BoundaryPredicate;
  /** Optional native completed-review handoff identity, excluded from both count bands. */
  isCompletionHandoffAUQ?: Step0BoundaryPredicate;
  /** Opt-in one-shot semantic assessment at a real native Exit. Existing callers
   * retain their synchronous navigation and terminal policy. */
  evaluateTerminal?: NativePlanTerminalEvaluator;
  /** Accepted artifact rendering is not a finding; its answer still requires a fresh report. */
  isArtifactGenerationAUQ?: Step0BoundaryPredicate;
  /** Optional issue classifier across phases; receives full native call metadata. */
  isReviewAUQ?: (fp: AskUserQuestionFingerprint, priorCalls?: readonly NativePlanQuestionCall[]) => boolean;
  /** Stop a collection-only fixture once its acknowledged inputs are complete.
   * This is not review completion or a passing verdict; the caller still validates them. */
  isCollectionComplete?: (transcript: PlanCountTranscript, fingerprints: readonly AskUserQuestionFingerprint[]) => boolean;
  /** Narrow caller-specific selection; null retains the normal answer policy.
   * The first argument retains full pending metadata for existing callers.
   * Native-bound selection uses activeCapture, whose metadata is present only
   * when capturePlanCountQuestion matched the currently visible native question. */
  pickAUQ?: (fp: AskUserQuestionFingerprint, activeCapture: AskUserQuestionFingerprint,
    context: Readonly<{ cwd: string; deadlineAt: number }>) => number | null;
  /** Opt-in declared actor: wait for a complete current native tab, then require
   * its picker answer. Unbound redraws never consume seen state or default to 1. */
  requireNativePicker?: boolean;
  /** Observe owned pending AUQs for callers that need identity before answering. */
  observeSetupQuestions?: boolean;
  /** Bind the declared Design board actor and renderer to one fixture-owned daemon state. */
  bindDesignBoardState?: boolean;
  /** Require native completion plus this caller-owned final report before accepting a soft terminal. */
  expectedPlanPath?: string;
  /** Additional versioned files available in the isolated fixture before the skill starts. */
  fixtureFiles?: Record<string, string>;
  /** Fixture actor already declined routing setup and cross-project learnings. */
  preconfiguredReviewActor?: boolean;
  /** Hard cap on review-phase count; helper returns when reached. Should be
   *  set ABOVE the test's assertion ceiling so the test sees the cap as a
   *  failure rather than a silent stop. */
  reviewCountCeiling: number;
  /** Numbered option to press by default. Defaults to 1 (recommended). */
  defaultPick?: number;
  /**
   * Optional override for the FIRST AUQ observed. Receives the fingerprint;
   * returns the option index to press. Subsequent review AUQs use defaultPick;
   * only the recognized optional office-hours prerequisite is declined by label.
   *
   * Skill-specific routing helper: /plan-ceo-review's first AUQ asks "what
   * scope?" with options like "branch diff" / "describe inline" / "skip
   * interview". Pressing the default 1 routes to "branch diff" (the wrong
   * review target for a seeded fixture). firstAUQPick lets the test pick
   * "Skip interview" or "describe inline" so the agent reviews the
   * fixture plan content, not the git diff.
   */
  firstAUQPick?: (fp: AskUserQuestionFingerprint) => number;
  /** Total budget including startup and cleanup. Must exceed the 5s cleanup reserve. Default 1_500_000. */
  timeoutMs?: number;
  startupReadyMarker?: string;
  /** Extra env merged into the spawned `claude` process. */
  env?: Record<string, string>;
  /** Override the spawned model. Defaults via launchClaudePty's chain. */
  model?: string;
  /** Launch seam and clock; tests pass the fake driver. Default: real launcher and clocks. */
  driver?: PtyDriver;
}): Promise<PlanSkillCountObservation> {
  const driver = opts.driver ?? { launch: launchClaudePty, now: () => Date.now(),
    monotonic: () => performance.now(), sleep: (ms: number) => Bun.sleep(ms) };
  if (opts.requireNativePicker && !opts.pickAUQ)
    throw Error('Native picker binding requires a declared picker');
  if (opts.bindDesignBoardState && (opts.skillName !== 'plan-design-review' || !opts.pickAUQ))
    throw Error('Design board state binding requires the Design caller and its declared picker');
  if (opts.approveEngTestPlanEdits && (opts.skillName !== 'plan-eng-review' || !opts.expectedPlanPath))
    throw Error('Eng test-plan approval requires the Eng caller and its explicit report');
  if (opts.isCollectionComplete && opts.expectedPlanPath)
    throw Error('Collection-only completion cannot replace the final report contract');
  const budgetStarted = driver.monotonic();
  const startedAt = driver.now();
  const defaultPick = opts.defaultPick ?? 1;
  const timeoutMs = opts.timeoutMs ?? 1_500_000;
  if (opts.startupReadyMarker !== undefined && !opts.startupReadyMarker.length) {
    throw new RangeError('Plan counting startup-ready marker must not be empty');
  }
  // The caller may use this same limit as its Bun timeout. Leave room for
  // close()'s 2s graceful + 1s forced exit waits and artifact/fixture cleanup.
  // A second work window after boot lets Bun retry while this body is alive.
  const cleanupReserveMs = 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= cleanupReserveMs) {
    throw new RangeError('Plan counting timeout must exceed the 5000ms cleanup reserve');
  }
  const workDeadline = budgetStarted + timeoutMs - cleanupReserveMs;
  const remainingWork = () => Math.max(0, workDeadline - driver.monotonic());
  async function waitForWork(ms: number): Promise<boolean> {
    const remaining = remainingWork();
    if (remaining <= 0) return false;
    const clipped = ms >= remaining;
    await driver.sleep(Math.min(ms, remaining));
    // A clipped wait cannot finish the requested interval. Timers may wake
    // just before the fractional deadline; that is no license to advance.
    return !clipped && remainingWork() > 0;
  }

  const fixture = createPlanCountFixture(opts.followUpPrompt, { nativeReviewOnly: true,
    files: opts.fixtureFiles, preconfiguredReviewActor: opts.preconfiguredReviewActor });
  const pickerContext = Object.freeze({cwd: fixture.cwd, deadlineAt: startedAt + timeoutMs - cleanupReserveMs});
  const permissionPaths = [
    ...(opts.expectedPlanPath ? [opts.expectedPlanPath, path.join(fixture.cwd, 'PLAN.md')] : []),
    ...(opts.permissionPlanPath ? [opts.permissionPlanPath] : []),
  ];
  let session: ClaudePtySession;
  try {
    session = await driver.launch({
      permissionMode: 'plan',
      cwd: fixture.cwd,
      // Stop new output at the work cutoff so screen drain cannot consume
      // the reserve while the CLI continues streaming.
      timeoutMs: Math.max(1, remainingWork()),
      screenDeadlineAt: workDeadline,
      env: { ...opts.env, ...fixture.env,
        // The renderer may cd into its artifact directory before starting the daemon.
        ...(opts.bindDesignBoardState ? { DESIGN_DAEMON_STATE_FILE: path.join(fixture.cwd, '.gstack', 'design.json') } : {}),
      },
      model: opts.model,
      seedSkills: true,
      observeScreen: true,
      observePlanReady: true,
      observeSetupQuestions: opts.observeSetupQuestions,
      observeFilePermissions: permissionPaths.length ? [...new Set(permissionPaths)] : undefined,
      ...(opts.approveEngTestPlanEdits ? { observeAutoplanArtifacts: true, approveAutoplanArtifactEdits: true, engTestPlanArtifactOnly: true } : {}),
    });
  } catch (error) {
    fixture.cleanup();
    throw error;
  }

  const fingerprints: AskUserQuestionFingerprint[] = [];
  const planningDirectory = session.hermeticConfigDir ? path.join(session.hermeticConfigDir, 'plans') : undefined;
  const seen = new Set<string>();
  const countedCalls = new Set<string>();
  const filePermission = createPlanCountPermissionGuard();
  // Each owned path keeps its own grant history when the workflow switches
  // between the active plan and the separate caller-owned final report.
  const ownedFilePermissions = (session.pendingFilePermissionFiles ?? []).map(binding =>
    ({ ...binding, guard: createPlanCountPermissionGuard() }));
  let lastMatchedNativeQuestion: NativePlanQuestionCall | undefined;
  let transcript: PlanCountTranscript = { status: 'missing', calls: [], assistantMessages: [] };
  let boundaryFired = false;
  let step0Count = 0;
  let reviewCount = 0;
  let administrativeCount = 0;
  let isFirstAUQ = true;
  const saveSnapshot = createPlanCountSnapshotWriter();
  let lastCheckpointAt = driver.now();
  let viewport = '';

  const capture = (observation: object) => {
    const publicTools: NativePublicToolEvent[] = [];
    if (session.hermeticConfigDir) readPlanCountTranscript(session.hermeticConfigDir, fixture.cwd,
      event => publicTools.push(event));
    return saveSnapshot({
      skillName: opts.skillName, observation: { ...observation,
        publicTools,
        pendingWriteInputs: ownedFilePermissions.flatMap(binding => {
          const input = readPendingWriteInput(binding.file, binding.expected, fixture.cwd, session.hermeticConfigDir, startedAt);
          return input ? [input] : [];
        }) }, raw: session.rawOutput(), visible: session.visibleText(), viewport,
      cwd: fixture.cwd, claudeConfigDir: session.hermeticConfigDir,
    });
  };

  function snapshot(
    outcome: PlanSkillCountObservation['outcome'],
    summary: string,
    visible: string,
  ): PlanSkillCountObservation {
    const clean = (text: string) => stripVTControlCharacters(text)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    const failed = outcome === 'exited' || outcome === 'timeout';
    const observation: PlanSkillCountObservation = {
      outcome,
      summary,
      evidence: failed
        ? `exitCode=${session.exitCode()}\n--- post-command evidence (last 3KB) ---\n${clean(visible).slice(-3000)}` +
          `\n--- full-session evidence, including startup (last 6KB) ---\n${clean(session.visibleText()).slice(-6000)}`
        : visible.slice(-3000),
      elapsedMs: driver.now() - startedAt,
      fingerprints,
      transcript,
      step0Count,
      reviewCount,
      administrativeCount,
    };
    const artifacts = capture(observation);
    Object.assign(observation, artifacts);
    if (artifacts.artifactDir) observation.evidence += `\nFull PTY artifacts: ${artifacts.artifactDir}`;
    if (artifacts.artifactError) observation.evidence += `\nPTY artifact write failed: ${artifacts.artifactError}`;
    return observation;
  }

  let observedOutput = session.mark();
  let lastObservationAt = -Infinity;
  let countingFailed = false;
  try {
    let startupReady: boolean;
    if (opts.startupReadyMarker !== undefined) {
      await session.waitFor(opts.startupReadyMarker, { timeoutMs: Math.min(8000, remainingWork()) });
      startupReady = remainingWork() > 0;
    } else {
      startupReady = await waitForWork(8000);
    }
    if (startupReady) {
      observedOutput = session.mark();
      if (opts.approveEngTestPlanEdits) {
        if (!session.startAutoplanArtifactEditApproval) throw Error('Owned Eng test-plan approval hook unavailable');
        session.startAutoplanArtifactEditApproval(driver.now());
      }
      session.send(`${opts.slashCommand}\r`);
    }

    while (remainingWork() > 0) {
      await session.waitForOutput(observedOutput, Math.min(2000, remainingWork()));
      if (remainingWork() <= 0) break;
      const coalesceMs = session.rawOutput().length > observedOutput
        ? 250 : 250 - (driver.monotonic() - lastObservationAt);
      if (coalesceMs > 0 && !await waitForWork(coalesceMs)) break;
      observedOutput = session.mark();
      lastObservationAt = driver.monotonic();
      const visible = viewport = await session.currentScreen();
      if (remainingWork() <= 0) break;
      transcript = session.hermeticConfigDir
        ? readPlanCountTranscript(session.hermeticConfigDir, fixture.cwd)
        : { status: 'error', calls: [], assistantMessages: [], error: 'Claude count session has no isolated transcript directory' };
      transcript = withPendingExit(transcript, session.pendingPlanReadyFile, fixture.cwd,
        session.hermeticConfigDir, startedAt, visible);
      if (opts.approveEngTestPlanEdits) {
        const status = autoplanArtifactRecorderStatus(session.pendingAutoplanArtifactFile, fixture.cwd,
          session.hermeticConfigDir, session.autoplanArtifactStateRoot);
        const boundary = autoplanArtifactApprovalBoundary(status);
        if (boundary === 'failed') return snapshot('artifact_permission_failed',
          `Owned Eng QA test-plan approval failed: ${JSON.stringify(status)}`, visible);
        // Native approval owns this Edit. Never answer its repaint or count a
        // metadata-only pending request; resume only after its actual result.
        if (boundary === 'pending') {
          if (driver.now() - lastCheckpointAt >= 30_000) {
            lastCheckpointAt = driver.now();
            const saved = capture({ state: 'artifact_pending', elapsedMs: driver.now() - startedAt,
              fingerprints, step0Count, reviewCount, administrativeCount, transcript, artifactStatus: status });
            if (saved.artifactError) console.error(`PTY artifact write failed: ${saved.artifactError}`);
          }
          continue;
        }
      }
      if (transcript.status === 'error') {
        return snapshot('transcript_unavailable', transcript.error!, visible);
      }
      for (const [callIndex, call] of transcript.calls.entries()) {
        const signature = `${call.sessionId}:${call.toolUseId}`;
        if (!call.answered || countedCalls.has(signature)) continue;
        const fp = nativePlanCallFingerprint(call, driver.now() - startedAt, !boundaryFired);
        const phase = planCountQuestionPhase(fp, boundaryFired, opts.isLastStep0AUQ, opts.isFirstReviewAUQ, opts.isSetupAUQ, opts.isCompletionHandoffAUQ, opts.isArtifactGenerationAUQ);
        if (phase.administrative) {
          fp.preReview = false;
          fp.administrative = phase.administrative;
          administrativeCount += 1;
        } else {
          fp.preReview = opts.isReviewAUQ ? !opts.isReviewAUQ(fp, transcript.calls.slice(0, callIndex)) : phase.preReview;
          if (fp.preReview) step0Count += 1;
          else reviewCount += 1;
        }
        fp.promptSnippet = fp.promptSnippet.replace(/\s+/g, ' ').slice(0, 240);
        fingerprints.push(fp);
        countedCalls.add(signature);
        boundaryFired = phase.reviewStarted;
      }
      if (reviewCount >= opts.reviewCountCeiling) {
        if (unresolvedPlanQuestionCalls(transcript.calls).length) {
          return snapshot('transcript_unavailable', 'Question count reached its ceiling with unresolved failed native calls', visible);
        }
        return snapshot('ceiling_reached', `review-phase AUQ count reached ceiling (${opts.reviewCountCeiling})`, visible);
      }
      // An outer test timeout/cancellation may prevent a terminal snapshot.
      // Keep bounded-cadence evidence without adding a timer to clean up.
      if (driver.now() - lastCheckpointAt >= 30_000) {
        lastCheckpointAt = driver.now();
        const saved = capture({ state: 'in_progress', elapsedMs: driver.now() - startedAt,
          fingerprints, step0Count, reviewCount, administrativeCount, transcript });
        if (saved.artifactError) console.error(`PTY artifact write failed: ${saved.artifactError}`);
      }

      // Process exited?
      if (session.exited()) {
        return snapshot(
          'exited',
          `claude exited (code=${session.exitCode()}) during counting (step0=${step0Count}, review=${reviewCount})`,
          visible,
        );
      }

      if (isRejectedSlashCommand(visible, opts.slashCommand)) {
        return snapshot(
          'exited',
          `claude rejected ${opts.slashCommand} as unknown command (skill not registered in this cwd)`,
          visible,
        );
      }

      // A native AUQ can render before its JSONL tool-use record is flushed.
      // The opt-in hook supplies pending identity only; answered counts above
      // still come exclusively from the published native transcript.
      const pending = transcript.calls.find(c => !c.answered && !c.failed)
        ?? readPendingQuestion(session.pendingQuestionFile, fixture.cwd,
          session.hermeticConfigDir, startedAt, transcript);
      // Native ACKs → complete collection → caller validation. A process failure
      // above or a pending native question still prevents this early collection stop.
      if (opts.isCollectionComplete && !pending && transcript.status === 'ready' &&
          transcript.calls.length > 0 && transcript.calls.every(call => call.answered && !call.failed) &&
          !unresolvedPlanQuestionCalls(transcript.calls).length && remainingWork() > 0 &&
          opts.isCollectionComplete(transcript, fingerprints) && remainingWork() > 0) {
        return snapshot('collection_complete', 'Caller-defined native collection is complete; final validation remains required', visible);
      }
      const newlyMatched = pending && matchesNativePlanQuestion(visible, pending, planningDirectory);
      if (newlyMatched) lastMatchedNativeQuestion = pending;
      const renderedFrame = classifyPlanCountFrame(visible);
      const administrative = new Set(fingerprints.filter(fp => fp.administrative === 'completion-handoff').map(fp => fp.signature));
      if (opts.evaluateTerminal && opts.expectedPlanPath && renderedFrame === 'plan_ready' && !newlyMatched) {
        const reviewed = await evaluateOwnedNativePlanTerminal(transcript, opts.expectedPlanPath, startedAt,
          startedAt + timeoutMs - cleanupReserveMs, opts.evaluateTerminal);
        if (reviewed) {
          // Once semantics are validated, lexical phase labels have no veto.
          // The earlier progress snapshots remain unchanged diagnostic evidence.
          administrative.clear();
          for (const identity of reviewed.administrative) administrative.add(identity);
          for (const fp of fingerprints) {
            fp.preReview = !reviewed.substantive.has(fp.signature) && !administrative.has(fp.signature);
            if (administrative.has(fp.signature)) fp.administrative = 'completion-handoff';
            else delete fp.administrative;
          }
          reviewCount = reviewed.substantive.size;
          administrativeCount = administrative.size;
          step0Count = fingerprints.length - reviewCount - administrativeCount;
        }
      }

      // A long completed summary may scroll its heading off the viewport.
      // With no active input UI, retain the existing native/report validator;
      // neither display text nor a missing heading supplies completion evidence.
      const nativeCompletion = opts.expectedPlanPath && hasNativePlanCompletion(transcript, opts.expectedPlanPath, startedAt);
      const nativeSummary = !nativeCompletion && renderedFrame === null && opts.expectedPlanPath &&
        !isNumberedOptionListVisible(visible) && !isPermissionDialogVisible(visible) && !isProseAUQVisible(visible) &&
        hasNativePlanTerminal(transcript, opts.expectedPlanPath, startedAt, 'completion_summary', administrative);
      const terminalFrame = nativeSummary ? 'completion_summary' : renderedFrame;
      const isTerminalHint = terminalFrame === 'completion_summary' || terminalFrame === 'plan_ready';
      const verifiedTerminal = nativeSummary || (opts.expectedPlanPath && isTerminalHint &&
        hasNativePlanTerminal(transcript, opts.expectedPlanPath, startedAt, terminalFrame, administrative));
      if (reviewCount === 0 && fingerprints.some(fp => fp.administrative === 'artifact-generation') &&
          (nativeCompletion || verifiedTerminal)) {
        return snapshot('no_review_questions', 'Completed artifact generation supplied no review finding decisions', visible);
      }
      // A streamed heading cannot dismiss the last bound native question.
      // Only an accepted terminal may supersede its answered redraw; otherwise
      // permission wording inside that question could queue a stray answer.
      const acceptedTerminal = isTerminalHint && (!opts.expectedPlanPath || verifiedTerminal);
      const nativeQuestionVisible = newlyMatched || (!acceptedTerminal &&
        lastMatchedNativeQuestion && matchesNativePlanQuestion(visible, lastMatchedNativeQuestion, planningDirectory));
      const terminalHint = nativeQuestionVisible ? null : terminalFrame;
      let frame = terminalHint;
      // Clear unverified hints before routing active permissions and Submit.
      if (opts.expectedPlanPath && isTerminalHint && !verifiedTerminal) frame = null;
      // A real approval gate is never an AUQ or a file permission. Wait for
      // its report/native evidence before input routing; verified gates still
      // pass the existing silent-write check below. A positively matched
      // native question above takes precedence over gate text.
      const nonReviewCalls = new Set(fingerprints.filter(fp => fp.preReview || fp.administrative)
        .map(fp => fp.signature));
      if (opts.expectedPlanPath && terminalHint === 'plan_ready' && reviewCount === 0 &&
          isQuestionlessNativePlanExit(transcript, opts.expectedPlanPath, startedAt, visible, nonReviewCalls)) {
        return snapshot('no_review_questions',
          'Native plan approval reached with zero review-phase AskUserQuestion calls; review coverage is missing', visible);
      }
      if (opts.expectedPlanPath && terminalHint === 'plan_ready' && !verifiedTerminal) continue;
      let permissionGuard = filePermission;
      let permissionEpoch: FilePermissionEpoch | null | undefined;
      const currentBinding = currentFilePermissionBinding(ownedFilePermissions, fixture.cwd,
        session.hermeticConfigDir, startedAt, transcript, visible);
      if (currentBinding) { permissionGuard = currentBinding.binding.guard; permissionEpoch = currentBinding.epoch; }
      else permissionEpoch = currentBinding;
      const permission = nativeQuestionVisible || terminalHint === 'plan_ready'
        ? null : permissionGuard(visible, session.visibleText(), permissionEpoch);
      if (frame === 'permission' || (permission === 'grant' && frame === null)) {
        if (remainingWork() <= 0) break;
        if (permission !== 'handled') session.send(`${defaultPick}\r`);
        await waitForWork(1500);
        continue;
      }

      const submissionInput = frame === null ? planCountSubmissionInput(visible) : null;
      if (submissionInput !== null) {
        if (remainingWork() <= 0) break;
        session.send(submissionInput);
        await waitForWork(1500);
        continue;
      }

      // Silent write detection — only fires if no numbered prompt is on
      // screen (otherwise the write is gated by a permission/AUQ).
      const writeRe = /⏺\s*(?:Write|Edit)\(([^)]+)\)/g;
      let m: RegExpExecArray | null;
      while ((m = writeRe.exec(visible)) !== null) {
        const target = m[1] ?? '';
        const sanctioned = SANCTIONED_WRITE_SUBSTRINGS.some((s) =>
          target.includes(s),
        );
        if (!sanctioned && !isNumberedOptionListVisible(visible)) {
          return snapshot(
            'silent_write',
            `Write/Edit to ${target} fired before any AskUserQuestion`,
            visible,
          );
        }
      }

      if (opts.expectedPlanPath && verifiedTerminal && (frame === 'completion_summary' || frame === 'plan_ready')) {
        return snapshot(frame, `native ${frame} and final report verified (step0=${step0Count}, review=${reviewCount})`, visible);
      }

      // Legacy callers without a report contract retain their terminal policy.
      if (frame === 'completion_summary') {
        if (transcript.status !== 'ready' || transcript.calls.some(c => !c.answered && !c.failed) ||
            unresolvedPlanQuestionCalls(transcript.calls).length) {
          return snapshot('transcript_unavailable', 'Completion has no complete native question transcript', visible);
        }
        return snapshot(
          'completion_summary',
          `skill emitted completion summary / verdict / status line (step0=${step0Count}, review=${reviewCount})`,
          visible,
        );
      }
      if (frame === 'plan_ready') {
        if (transcript.status !== 'ready' || transcript.calls.some(c => !c.answered && !c.failed) ||
            unresolvedPlanQuestionCalls(transcript.calls).length) {
          return snapshot('transcript_unavailable', 'Plan-ready gate has no complete native question transcript', visible);
        }
        return snapshot(
          'plan_ready',
          `skill emitted plan-mode "Ready to execute" confirmation (step0=${step0Count}, review=${reviewCount})`,
          visible,
        );
      }

      if (opts.expectedPlanPath && !transcript.planReadyRequests?.length && !isNumberedOptionListVisible(visible) &&
          hasNativePlanCompletion(transcript, opts.expectedPlanPath, startedAt)) {
        return snapshot('completion_summary',
          `native review completion and final report verified (step0=${step0Count}, review=${reviewCount})`, visible);
      }

      // A dismissed or repainted permission is never a native question.
      if (permission === 'handled') continue;

      // Dedupe the complete question, not just its answer labels: separate
      // findings often reuse the same Add to plan / Defer / Skip menu.
      if (opts.requireNativePicker && !newlyMatched) continue;
      const capturedSeen = opts.requireNativePicker ? new Set(seen) : seen;
      const fp = capturePlanCountQuestion(visible, capturedSeen, driver.now() - startedAt, !boundaryFired, pending, planningDirectory);
      if (!fp) continue;
      const boundNativeTab = pending && fp.nativeCall === pending && fp.nativeQuestionIndex !== undefined;
      if (opts.requireNativePicker && !boundNativeTab) continue;
      // Press to advance — first AUQ may use the override pick.
      const routing = pending?.questions.length === 1
        ? nativePlanCallFingerprint(pending, fp.observedAtMs, fp.preReview) : fp;
      const prerequisitePick = planCountPrerequisitePick(routing, fp);
      // Native tool records may flush only after the answer. Let a guarded
      // caller recognize that visible menu. A known packet needs a positively
      // matched active tab before a caller can change that tab's choice.
      // The captured fingerprint alone proves whether native metadata matched
      // this active UI; an unrelated pending record is not a routing identity.
      let callerPick: number | null = null;
      if ((!opts.requireNativePicker || prerequisitePick === null) &&
          (!pending || pending.questions.length === 1 || boundNativeTab)) {
        callerPick = opts.pickAUQ?.(routing, fp, pickerContext) ?? null;
      }
      if (opts.requireNativePicker && prerequisitePick === null && callerPick === null)
        throw Error('Declared native picker returned no authorized choice');
      const pickIdx = prerequisitePick ?? callerPick ??
        (isFirstAUQ && opts.firstAUQPick ? opts.firstAUQPick(routing) : defaultPick);
      if (opts.requireNativePicker) for (const signature of capturedSeen) seen.add(signature);
      isFirstAUQ = false;
      const questionInput = planCountQuestionInput(visible, fp, pickIdx);
      if (remainingWork() <= 0) break;
      if (questionInput.includes('\r')) {
        // The helper separates digit and Enter by 500ms. Do not let that
        // delayed confirmation send input after this counting window closes.
        await selectPtyNumberedOption({ send: input => {
          if (remainingWork() > 0) session.send(input);
        } }, pickIdx);
      } else session.send(questionInput);

      // Give the agent a beat to advance to the next state.
      await waitForWork(2000);
    }

    return snapshot(
      'timeout',
      `no terminal outcome within ${timeoutMs}ms total budget (including startup and ${cleanupReserveMs}ms cleanup reserve; step0=${step0Count}, review=${reviewCount})`,
      viewport,
    );
  } catch (error) {
    countingFailed = true;
    // Caller/actor errors used to leave only the preceding 30s checkpoint.
    // Retain the actual throw frame and public native state before close()
    // removes the hook and fixture, without replacing the original failure.
    try {
      // Keep the exact frame/transcript that the throwing caller observed;
      // awaiting a redraw here would erase that ordering evidence.
      const saved = capture({ state: 'threw', error: error instanceof Error ? error.message : String(error),
        elapsedMs: driver.now() - startedAt, fingerprints, step0Count, reviewCount, administrativeCount, transcript,
        pendingQuestion: readPendingQuestion(session.pendingQuestionFile, fixture.cwd,
          session.hermeticConfigDir, startedAt, transcript) });
      if (saved.artifactDir) console.error(`Full PTY artifacts: ${saved.artifactDir}`);
      if (saved.artifactError) console.error(`PTY artifact write failed: ${saved.artifactError}`);
    } catch (captureError) { console.error(`PTY failure capture failed: ${String(captureError)}`); }
    throw error;
  } finally {
    try {
      await session.close();
    } catch (error) {
      if (!countingFailed) {
        capture({ state: 'cleanup_failed', error: String(error), transcript, fingerprints });
        throw error;
      }
    } finally {
      fixture.cleanup();
    }
  }
}
