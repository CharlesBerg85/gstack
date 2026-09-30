/**
 * runPlanSkillFloorCheck. Moved from claude-pty-runner.ts.
 * Import through test/helpers/claude-pty-runner.ts from tests; pty/ modules import siblings directly.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveEvalModel } from '../../../../lib/eval-model';
import { createPlanCountFixture } from '../../plan-count-fixture';
import { createPlanCountSnapshotWriter } from '../../plan-count-artifacts';
import { readPlanFloorTarget, type PlanFloorTargetDelivery } from '../../plan-floor-target';
import { judgePlanFloorReview, pickPlanFloorMode, pickPlanFloorProductType, type PlanFloorReview, type PlanFloorAssessment } from '../../plan-floor-review';
import { readPlanCountTranscript, type NativePlanQuestionCall, type PlanCountTranscript, type NativePublicToolEvent } from '../../plan-count-transcript';
import { readPendingQuestion, pendingQuestionRecorderStatus } from '../../plan-count-pending-question';
import { currentFilePermissionBinding, readPendingWriteInput, isCroppedEditPermissionVisible } from '../../plan-count-file-permission';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { capturePlanCountQuestion, createPlanCountPermissionGuard, matchesNativePlanQuestion, planCountPrerequisitePick, planCountQuestionInput } from '../auq';
import { resolveClaudeBinary } from '../binary';
import { designReviewSetupAUQ } from '../boundaries';
import { SANCTIONED_WRITE_SUBSTRINGS, isProseAUQVisible, planCountSubmissionInput } from '../classify';
import { launchClaudePty } from '../launch';
import type { ClaudePtySession } from '../launch';
import { isNumberedOptionListVisible, isPermissionDialogVisible, isPlanReadyVisible, isRejectedSlashCommand, stripPtyResidue } from '../screen';
import type { PtyDriver } from '../session';

// ────────────────────────────────────────────────────────────────────────────
// runPlanSkillFloorCheck — stop at the first substantive seeded question.
// Current owned input → complete question → evidence-backed assessment → outcome.
// Setup answers advance only the predeclared review interface. Findings are
// observed without answering them; permissions and generic waiting never count.
// The existing model-work deadline also bounds the replacement waiting judge.
// ────────────────────────────────────────────────────────────────────────────

export interface PlanSkillFloorObservation {
  /** True iff a review-phase AUQ render was observed. */
  auqObserved: boolean;
  /** Owned native acknowledgment of the exact seeded target command. */
  targetDelivery?: PlanFloorTargetDelivery;
  outcome:
    | 'auq_observed'
    | 'plan_ready'
    | 'silent_write'
    | 'exited'
    | 'timeout'
    | 'assessment_error';
  summary: string;
  /** Public current viewport for an accepted finding; terminal tail otherwise. */
  evidence: string;
  /** Wall time (ms) until the outcome was decided. */
  elapsedMs: number;
}

/**
 * Drive a plan-* skill and qualify its first current seeded finding question.
 * The actor answers only its declared optional-prerequisite, mode and product-type choices.
 */
/** DX's long empathy prompt needs its whole native pane, not an interior crop.
 * Retain the actual header and complete pinned renderer prefix; the shared
 * matcher still authenticates the pending question and native menu. */
export function planFloorDXPane(visible: string, call: NativePlanQuestionCall): string | null {
  if (call.answered || call.failed || call.questions.length !== 1) return null;
  const text = stripPtyResidue(visible).replace(/\r+\n?/g, '\n')
    .replace(/((?:^|\n)Enter\s+to\s+select\s*·\s*↑\/↓\s+to\s+navigate\s*·\s*)ctrl\+g\s+to\s+edit\s+in[ \t]+[^\s·\x00-\x1f\x7f][^·\x00-\x1f\x7f]*?\s*·\s*(Esc\s+to\s+cancel\s*)$/, '$1$2');
  const headers = [...text.matchAll(/(?:^|\n)[\t ]*[☐□][^\n]*\n/g)];
  const header = headers.at(-1);
  if (!header) return null;
  const preceding = text.slice(0, header.index).trimEnd();
  if (preceding && !/(?:^|\n)[ \t]*[─━]{10,}[ \t]*$/.test(preceding)) return null;
  let fence: string | undefined;
  for (const line of preceding.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!marker) continue;
    if (!fence) fence = marker[1];
    else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
  }
  if (fence) return null;
  const pane = text.slice(header.index).trimStart();
  const cursor = /(?:^|\n)❯\s*1\./.exec(pane);
  if (!cursor) return null;
  const body = pane.slice(pane.indexOf('\n') + 1, cursor.index)
    .replace(/^[ \t]*[│┃] ?|[│┃][ \t]*$/gm, '').trim();
  const compact = (value: string) => value.replace(/\s+/g, '');
  const q = call.questions[0]!;
  const displayed = q.question.length > 2000 ? q.question.slice(0, 2000) + '…' : q.question;
  if (compact(body) !== compact(displayed) || !matchesNativePlanQuestion(pane, call)) return null;
  return pane;
}

export interface PlanFloorDXReply {
  call: NativePlanQuestionCall;
  pane: string;
  reply: string;
  stage: 'focus' | 'paste' | 'submit' | 'done';
}

/** The native custom field focuses first, then accepts literal bracketed paste.
 * Each step binds the same unanswered call and unchanged complete pane. */
export function planFloorDXReplyInput(visible: string, call: NativePlanQuestionCall,
  state: PlanFloorDXReply): { input: string; stage: PlanFloorDXReply['stage'] } | null {
  if (state.stage === 'done' || call.answered || call.failed || call.questions.length !== 1 ||
      call.questions[0]!.multiSelect || call.sessionId !== state.call.sessionId || call.toolUseId !== state.call.toolUseId ||
      !isDeepStrictEqual(call.questions, state.call.questions) || !state.reply.trim() || state.reply.length > 1400 ||
      /[\x00-\x1f\x7f]/.test(state.reply)) return null;
  const compact = (value: string) => value.replace(/\s+/g, '');
  const index = call.questions[0]!.options.length + 1;
  if (state.stage === 'focus') {
    const pane = planFloorDXPane(visible, call);
    if (!pane || compact(pane) !== compact(state.pane) ||
        !new RegExp(`(?:^|\\n)  ${index}\\. Type something\\.[ \\t]*(?:\\n|$)`).test(pane)) return null;
    return { input: String(index), stage: 'paste' };
  }
  const lines = stripPtyResidue(visible).replace(/\r+\n?/g, '\n').split('\n');
  const start = lines.findIndex(line => new RegExp(`^❯ ${index}\\. `).test(line));
  if (start < 0 || lines.filter(line => /^❯ [1-9]\. /.test(line)).length !== 1) return null;
  let end = start + 1;
  while (end < lines.length && /^ {5}\S|^ {5,}\S/.test(lines[end]!)) end++;
  const field = [lines[start]!.replace(new RegExp(`^❯ ${index}\\. `), ''),
    ...lines.slice(start + 1, end).map(line => line.trim())].join(' ').trim();
  if (field !== (state.stage === 'paste' ? 'Type something.' : state.reply)) return null;
  lines.splice(start, end - start, `  ${index}. Type something.`);
  const first = lines.findIndex(line => /^  1\. /.test(line));
  if (first < 0) return null;
  lines[first] = lines[first]!.replace(/^  1\./, '❯ 1.');
  const pane = planFloorDXPane(lines.map(line => line.replace(
    /^(Enter to select · ↑\/↓ to navigate · (?:n to add notes · )?)ctrl\+g to edit in [^\x00-\x1f\x7f·]+ · (Esc to cancel)$/,
    '$1$2')).join('\n'), call);
  if (!pane || compact(pane) !== compact(state.pane)) return null;
  return state.stage === 'paste'
    ? { input: '\x1b[200~' + state.reply + '\x1b[201~', stage: 'submit' }
    : { input: '\r', stage: 'done' };
}

export async function runPlanSkillFloorCheck(opts: {
  /** Skill name, e.g. 'plan-eng-review'. Used for diagnostic strings only. */
  skillName: string;
  /** Slash command; the owned PLAN.md target is supplied in the same submission. */
  slashCommand: string;
  /** Complete request seeded in an isolated project before the command starts. */
  followUpPrompt: string;
  /** Explicit working-plan request relocated into the owned fixture before launch. */
  requestedPlanPath?: string;
  /** Predeclared DX fixture classification; never inferred from a recommendation. */
  productType?: 'sdk-documentation';
  /** Literal persona/journey correction declared before DX setup; approves no offered remedy. */
  devexSetupContext?: string;
  /** Installation cwd retained for caller compatibility; review uses an owned seeded project. */
  cwd?: string;
  /** Total budget. Default 600000 (10 min). Tests exit early on AUQ. */
  timeoutMs?: number;
  /** Extra env merged into the spawned `claude` process. */
  env?: Record<string, string>;
  /** Override the spawned model. Defaults via launchClaudePty's chain. */
  model?: string;
  /** Launch seam and clock; tests pass the fake driver. Default: real launcher and clocks. */
  driver?: PtyDriver;
}): Promise<PlanSkillFloorObservation> {
  const driver = opts.driver ?? { launch: launchClaudePty, now: () => Date.now(),
    monotonic: () => performance.now(), sleep: (ms: number) => Bun.sleep(ms) };
  const startedAt = driver.now();
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const dxContext = opts.devexSetupContext;
  if (dxContext !== undefined && (opts.skillName !== 'plan-devex-review' || opts.productType !== 'sdk-documentation' ||
      !dxContext.trim() || dxContext.length > 1400 || /[\x00-\x1f\x7f]/.test(dxContext)))
    throw Error('DX setup context requires the declared SDK-documentation actor and a bounded literal single line');

  const request = [
    'Proceed directly to the requested review; skip the optional /office-hours prerequisite.',
    'This actor has already declined routing setup, cross-project recall and outside reviewers.',
    'Preserve the supplied product scope. For review-mode questions choose HOLD SCOPE (CEO), DX POLISH (DX), or the full BIG CHANGE review (Eng). Design: review all seven dimensions.',
    ...(opts.productType === 'sdk-documentation' ? [
      'Product type is confirmed: SDK quickstart documentation, with the complete journey to the first SDK call as context. If asked to classify, choose SDK + Docs when offered, otherwise Documentation. This confirms the review lens; it does not expand the plan.',
      'Target persona is confirmed: a hands-on developer integrating this SDK for the first time, trying to make one successful call. Product type and persona setup are already answered; proceed to reviewing the supplied plan.',
    ] : []),
    ...(dxContext ? ['For setup confirmations, this actor can supply only the following persona/journey correction through the native custom answer. It does not approve a proposed narrative, remedy, or scope change: ' + dxContext] : []),
    opts.followUpPrompt,
  ].join('\n\n');
  const fixture = createPlanCountFixture(request, { requestedPlanPath: opts.requestedPlanPath,
    nativeReviewOnly: true, preconfiguredReviewActor: true });
  const sessionId = randomUUID();
  let session: ClaudePtySession;
  try {
    session = await driver.launch({
      permissionMode: 'plan',
      cwd: fixture.cwd,
      timeoutMs: timeoutMs + 60_000,
      env: { ...opts.env, ...fixture.env },
      model: opts.model,
      seedSkills: true,
      observeScreen: true,
      observeSetupQuestions: true,
      ...(dxContext ? { rows: 80 } : {}),
      observeFilePermissions: fixture.workingPlanPath ? [fixture.workingPlanPath] : undefined,
      extraArgs: ['--session-id', sessionId],
    });
  } catch (error) {
    fixture.cleanup();
    throw error;
  }

  const ownedFilePermissions = (session.pendingFilePermissionFiles ?? []).map(binding =>
    ({ ...binding, guard: createPlanCountPermissionGuard() }));
  const planningDirectory = session.hermeticConfigDir ? path.join(session.hermeticConfigDir, 'plans') : undefined;
  let transcript: PlanCountTranscript = { status: 'missing', calls: [], assistantMessages: [] };
  let viewport = '';
  let publicTools: NativePublicToolEvent[] = [];
  let pendingQuestion: NativePlanQuestionCall | undefined;
  let floorReview: PlanFloorReview | undefined;
  let floorAssessment: PlanFloorAssessment | undefined;
  const setupChoices = new Map<string, Set<number>>();
  const submittedSetup = new Set<string>();
  const assessed = new Map<string, PlanFloorAssessment>();
  const dxReplies = new Map<string, PlanFloorDXReply>();
  let captureBeforeClose: ((error?: unknown) => void) | undefined;
  let floorFailed = false;
  let floorError: unknown;
  try {
    await driver.sleep(8000); // boot grace + auto-trust handler window
    const since = session.mark();
    const commandStartedAt = driver.now();
    session.send(`${opts.slashCommand} PLAN.md\r`);
    const deliveryOptions = { seed: fixture.seed, sessionId,
      slashCommand: opts.slashCommand, startedAt: commandStartedAt };
    let targetDelivery = readPlanFloorTarget(session.hermeticConfigDir, fixture.cwd,
      { ...deliveryOptions, now: driver.now() });
    const saveSnapshot = createPlanCountSnapshotWriter();
    let nativeCandidates: NativePlanQuestionCall[] = [];
    let validatedPendingQuestion: ReturnType<typeof readPendingQuestion>;
    let sampledAt: number | undefined;
    let lastCheckpointAt = 0, lastCheckpointState = '';
    let artifactError: string | undefined;
    let finished = false;
    const capture = (observation: object) => {
      const recorderStatus = pendingQuestionRecorderStatus(session.pendingQuestionFile, fixture.cwd, session.hermeticConfigDir);
      const artifacts = saveSnapshot({ skillName: opts.skillName, cwd: fixture.cwd,
        claudeConfigDir: session.hermeticConfigDir, raw: session.rawOutput(),
        visible: session.visibleSince(since), viewport,
        observation: { ...observation, transcript, publicTools, pendingQuestion, floorReview, floorAssessment, targetDelivery, commandStartedAt,
          pendingWriteInputs: ownedFilePermissions.flatMap(binding => {
            const input = readPendingWriteInput(binding.file, binding.expected, fixture.cwd, session.hermeticConfigDir, startedAt);
            return input ? [input] : [];
          }),
          questionDiagnostics: { sampledAt, parentSessionId: sessionId, recorderStatus, recorderStatusAt: driver.now(), nativeCandidates, validatedPendingQuestion },
          ...(dxContext ? { setupContextReplies: [...dxReplies.values()] } : {}), artifactError } });
      if (artifacts.artifactError) {
        artifactError ??= artifacts.artifactError;
        console.error(`PTY artifact write failed: ${artifacts.artifactError}`);
      }
      return { ...artifacts, ...(artifactError ? { artifactError } : {}) };
    };
    const checkpoint = () => {
      const state = JSON.stringify([pendingQuestionRecorderStatus(session.pendingQuestionFile, fixture.cwd, session.hermeticConfigDir),
        targetDelivery.status, nativeCandidates, validatedPendingQuestion, pendingQuestion, [...dxReplies.values()]]);
      if (state === lastCheckpointState && driver.now() - lastCheckpointAt < 15_000) return;
      lastCheckpointState = state; lastCheckpointAt = driver.now();
      capture({ state: 'in_progress', elapsedMs: driver.now() - startedAt });
    };
    captureBeforeClose = (error) => {
      if (floorFailed && session.hermeticConfigDir) {
        publicTools = [];
        transcript = readPlanCountTranscript(session.hermeticConfigDir, fixture.cwd, event => publicTools.push(event));
      }
      if (!finished) capture({ state: floorFailed ? 'threw' : 'in_progress', error: floorFailed ? String(error) : undefined,
        captureReason: 'before_cleanup', elapsedMs: driver.now() - startedAt });
    };
    const finish = (observation: PlanSkillFloorObservation): PlanSkillFloorObservation => {
      const artifacts = capture(observation);
      finished = true;
      return { ...observation, targetDelivery, ...artifacts };
    };

    const start = driver.now();
    const deadlineAt = start + timeoutMs;
    const screenDeadlineAt = driver.monotonic() + timeoutMs;
    while (driver.now() - start < timeoutMs) {
      await driver.sleep(2000);
      const visible = session.visibleSince(since);

      if (session.exited()) {
        return finish({
          auqObserved: false,
          outcome: 'exited',
          summary: `claude exited (code=${session.exitCode()}) before a qualifying finding`,
          evidence: visible.slice(-3000),
          elapsedMs: driver.now() - startedAt,
        });
      }
      if (isRejectedSlashCommand(visible, opts.slashCommand)) {
        return finish({
          auqObserved: false,
          outcome: 'exited',
          summary: `claude rejected ${opts.slashCommand} as unknown command`,
          evidence: visible.slice(-3000),
          elapsedMs: driver.now() - startedAt,
        });
      }

      if (targetDelivery.status !== 'ready') {
        targetDelivery = readPlanFloorTarget(session.hermeticConfigDir, fixture.cwd,
          { ...deliveryOptions, now: driver.now() });
        if (targetDelivery.status !== 'ready') {
          viewport = await session.currentScreen(screenDeadlineAt);
          checkpoint();
          continue;
        }
      }

      // Current native identity precedes permission handling and finding assessment.
      floorReview = undefined; floorAssessment = undefined;
      viewport = await session.currentScreen(screenDeadlineAt);
      publicTools = [];
      transcript = session.hermeticConfigDir
        ? readPlanCountTranscript(session.hermeticConfigDir, fixture.cwd, event => publicTools.push(event))
        : { status: 'missing', calls: [], assistantMessages: [] };
      const hook = readPendingQuestion(session.pendingQuestionFile, fixture.cwd,
        session.hermeticConfigDir, commandStartedAt, transcript);
      const currentCalls = transcript.status === 'ready' ? transcript.calls.filter(call =>
        call.sessionId === sessionId && !call.answered && !call.failed && publicTools.filter(event =>
          event.sessionId === sessionId && event.kind === 'use' && event.name === 'AskUserQuestion' &&
          event.toolUseId === call.toolUseId && Date.parse(event.timestamp) >= commandStartedAt &&
          Date.parse(event.timestamp) <= driver.now() && isDeepStrictEqual(event.input?.questions, call.questions)).length === 1) : [];
      nativeCandidates = currentCalls.slice();
      validatedPendingQuestion = hook;
      sampledAt = driver.now();
      if (hook?.sessionId === sessionId && !transcript.calls.some(call => call.toolUseId === hook.toolUseId)) currentCalls.push(hook);
      const activeReply = currentCalls.length === 1 && dxReplies.get(`${currentCalls[0]!.sessionId}:${currentCalls[0]!.toolUseId}`);
      if (activeReply) {
        pendingQuestion = undefined;
        const next = planFloorDXReplyInput(viewport, currentCalls[0]!, activeReply);
        if (next) { session.send(next.input); activeReply.stage = next.stage; }
        checkpoint();
        continue;
      }
      const matching = currentCalls.filter(call => dxContext
        ? planFloorDXPane(viewport, call) !== null : matchesNativePlanQuestion(viewport, call, planningDirectory));
      pendingQuestion = matching.length === 1 ? matching[0] : undefined;
      checkpoint();
      const nativeQuestionVisible = Boolean(pendingQuestion);
      const permissionIsActiveRender = !nativeQuestionVisible &&
        (isPermissionDialogVisible(viewport) || isCroppedEditPermissionVisible(viewport));
      if (permissionIsActiveRender) {
        // An authorized file write enables the review, but never supplies its
        // finding question. Exclude the permission's old render after approval.
        const owned = currentFilePermissionBinding(ownedFilePermissions, fixture.cwd,
          session.hermeticConfigDir, startedAt, transcript, viewport);
        let ordinaryOwnedTarget = false;
        if (fixture.workingPlanPath) try {
          const parent = fs.realpathSync(path.dirname(fixture.workingPlanPath));
          let target: fs.Stats | undefined;
          try { target = fs.lstatSync(fixture.workingPlanPath); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          ordinaryOwnedTarget = parent === fs.realpathSync(fixture.cwd) && (!target || target.isFile());
        } catch { /* No authority for a linked, foreign, or unreadable target. */ }
        if (owned && ordinaryOwnedTarget && owned.binding.guard(viewport, session.visibleText(), owned.epoch) === 'grant')
          session.send('1\r');
      }
      if (permissionIsActiveRender) continue;

      const questionViewport = dxContext && pendingQuestion ? planFloorDXPane(viewport, pendingQuestion)! : viewport;
      const fp = pendingQuestion && capturePlanCountQuestion(questionViewport, new Set(), driver.now() - start, true, pendingQuestion, planningDirectory);
      if (fp && pendingQuestion) {
        const index = fp.nativeQuestionIndex ?? 0;
        const question = pendingQuestion.questions[index]!;
        const key = `${pendingQuestion.sessionId}:${pendingQuestion.toolUseId}`;
        const chosen = setupChoices.get(key) ?? new Set<number>();
        const allDesign = opts.skillName === 'plan-design-review' && designReviewSetupAUQ(fp)
          ? question.options.flatMap((option, i) => /^(?:Review )?All 7 (?:design )?(?:dimensions|passes)(?:\s*\(recommended\))?$/i.test(option.label.trim()) ? [i + 1] : []) : [];
        const pick = pickPlanFloorMode(opts.skillName, question) ?? planCountPrerequisitePick(fp, fp)
          ?? (opts.skillName === 'plan-devex-review' ? pickPlanFloorProductType(question, opts.productType) : null)
          ?? (allDesign.length === 1 ? allDesign[0]! : null);
        if (pick !== null) {
          if (!chosen.has(index)) {
            session.send(planCountQuestionInput(viewport, fp, pick));
            chosen.add(index); setupChoices.set(key, chosen);
          }
          continue;
        }
        floorReview = { seed: fixture.seed, candidate: { transport: 'native', identity: `${key}:question:${index}`,
          question: structuredClone(question) } };
      } else {
        // Public fallback must be a complete current question, not scrollback,
        // a generic idle prompt, permission, tool result or quoted example.
        floorReview = undefined;
        const message = transcript.assistantMessages.filter(m => m.sessionId === sessionId &&
          Date.parse(m.timestamp) >= commandStartedAt && Date.parse(m.timestamp) <= driver.now()).at(-1);
        const compact = (text: string) => text.replace(/\s+/g, '');
        if (!currentCalls.length && message && isProseAUQVisible(viewport) && isProseAUQVisible(message.text) &&
            !/^\s*(?:>|`{3,}|~{3,})/m.test(message.text) && compact(viewport).includes(compact(message.text)))
          floorReview = { seed: fixture.seed, candidate: { transport: 'prose',
            identity: `${message.sessionId}:${message.timestamp}`, text: message.text } };
        const submit = planCountSubmissionInput(viewport);
        const packet = currentCalls.find(call => setupChoices.get(`${call.sessionId}:${call.toolUseId}`)?.size === call.questions.length);
        if (submit && packet) {
          const key = `${packet.sessionId}:${packet.toolUseId}`;
          if (!submittedSetup.has(key)) { session.send(submit); submittedSetup.add(key); }
          continue;
        }
      }
      if (floorReview) {
        const key = JSON.stringify(floorReview);
        floorAssessment = assessed.get(key);
        if (!floorAssessment) {
          try {
            floorAssessment = judgePlanFloorReview(floorReview, {
              binary: resolveClaudeBinary() ?? 'claude', model: resolveEvalModel('warmup'), deadlineAt });
          } catch (error) {
            return finish({ auqObserved: false, outcome: 'assessment_error',
              summary: `Finding assessment failed: ${error instanceof Error ? error.message : String(error)}`,
              evidence: viewport, elapsedMs: driver.now() - startedAt });
          }
          assessed.set(key, floorAssessment);
        }
        if (dxContext && floorAssessment.kind === 'setup' && pendingQuestion?.questions.length === 1 &&
            !pendingQuestion.questions[0]!.multiSelect && floorReview.candidate.transport === 'native') {
          const key = `${pendingQuestion.sessionId}:${pendingQuestion.toolUseId}`;
          dxReplies.set(key, { call: structuredClone(pendingQuestion), pane: questionViewport, reply: dxContext, stage: 'focus' });
        }
        if (floorAssessment.kind === 'finding') return finish({
          auqObserved: true, outcome: 'auq_observed',
          summary: `Current ${floorReview.candidate.transport} question addresses the owned seeded finding: ${floorAssessment.reason}`,
          evidence: viewport, elapsedMs: driver.now() - startedAt,
        });
      }

      // Silent write outside sanctioned dirs is the transcript-bug shape.
      const writeRe = /⏺\s*(?:Write|Edit)\(([^)]+)\)/g;
      let m: RegExpExecArray | null;
      while ((m = writeRe.exec(visible)) !== null) {
        const target = m[1] ?? '';
        const sanctioned = SANCTIONED_WRITE_SUBSTRINGS.some((s) => target.includes(s));
        if (!sanctioned && !isNumberedOptionListVisible(visible)) {
          return finish({
            auqObserved: false,
            outcome: 'silent_write',
            summary: `Write/Edit to ${target} fired before any AskUserQuestion`,
            evidence: visible.slice(-3000),
            elapsedMs: driver.now() - startedAt,
          });
        }
      }

      // Reached terminal without AUQ → transcript-bug regression.
      // Note: COMPLETION_SUMMARY_RE is intentionally NOT checked here — it
      // matches "GSTACK REVIEW REPORT" anywhere in the buffer, including
      // when the agent does recon by reading existing plan files (which
      // contain that string as a generated section). The plan_ready check
      // (claude's actual "Ready to execute" confirmation) is the reliable
      // terminal signal for "agent finished without asking."
      if (isPlanReadyVisible(visible)) {
        return finish({
          auqObserved: false,
          outcome: 'plan_ready',
          summary: 'agent reached plan_ready without a qualifying finding question',
          evidence: visible.slice(-3000),
          elapsedMs: driver.now() - startedAt,
        });
      }
    }

    return finish({
      auqObserved: false,
      outcome: 'timeout',
      summary: targetDelivery.status === 'ready'
        ? `no qualifying finding question within ${timeoutMs}ms`
        : `seeded target delivery unavailable within ${timeoutMs}ms: ${targetDelivery.reason ?? targetDelivery.status}`,
      evidence: session.visibleSince(since).slice(-3000),
      elapsedMs: driver.now() - startedAt,
    });
  } catch (error) {
    floorFailed = true;
    floorError = error;
    throw error;
  } finally {
    try { captureBeforeClose?.(floorError); }
    catch (error) { if (!floorFailed) { floorFailed = true; throw error; } }
    finally {
      try { await session.close(); }
      catch (error) { if (!floorFailed) throw error; }
      finally { fixture.cleanup(); }
    }
  }
}
