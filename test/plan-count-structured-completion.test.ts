/** Free structured-completion regressions from run 36385945043 plus real-PTY wiring; no model calls. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import captured from './fixtures/design-completion-36385945043.json';
import { hasNativePlanCompletion, hasNativePlanTerminal, classifyPlanCountFrame, structuredPlanCompletion,
  planReviewLogBaseline, type PlanReviewLogBinding } from './helpers/claude-pty-runner';
import type { PlanCountTranscript } from './helpers/plan-count-transcript';

const COMMIT = 'c'.repeat(40);
const second = (ms: number) => Math.floor(ms / 1000) * 1000;
// RECONSTRUCTED: the run saved no plan file. The report follows the Design
// review's report contract with the verdict the dashboard implies.
const REPORT = ['# Settings Page UI redesign (reconstructed)', '', 'Reviewed plan body.', '', '## GSTACK REVIEW REPORT', '',
  '| Review | Trigger | Why | Runs | Status | Findings |', '|--------|---------|-----|------|--------|----------|',
  '| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | 5 decisions, 0 unresolved |', '',
  '**VERDICT:** DESIGN CLEARED — eng review required', '', 'NO UNRESOLVED DECISIONS', ''].join('\n');

function envelope(attempt: number) {
  const a = captured.attempts[attempt]!;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-completion-'));
  const plan = path.join(dir, 'gstack-test-plan-design.md');
  const logs = path.join(dir, 'gstack-home', 'projects', 'gstack-plan-count-fixture');
  fs.mkdirSync(logs, { recursive: true });
  const transcript = structuredClone(a.transcript) as PlanCountTranscript;
  for (const m of transcript.assistantMessages) m.text = m.text.replaceAll(a.originalPlanPath, plan);
  const final = transcript.assistantMessages.at(-1)!;
  final.stopReason = 'end_turn'; // RECONSTRUCTED: the capture predates stopReason; the screen shows the turn done and idle.
  const finishedAt = Date.parse(final.timestamp);
  const lastAnswer = Math.max(...transcript.calls.map(c => Date.parse(c.answeredAt!)));
  const startedAt = Date.parse(a.observed.capturedAt) - a.observed.elapsedMs;
  const writeReport = (at = finishedAt - 60_000, text = REPORT) => {
    fs.writeFileSync(plan, text); fs.utimesSync(plan, at / 1000, at / 1000);
  };
  // RECONSTRUCTED review-log row: the review's own Review Log fields, stamped with the fixture commit.
  const row = (fields: Record<string, unknown> = {}) => JSON.stringify({ skill: 'plan-design-review',
    timestamp: new Date(second(finishedAt - 30_000)).toISOString().replace('.000Z', 'Z'), status: 'clean',
    initial_score: 6, overall_score: 9, unresolved: 0, decisions_made: 5, commit: 'ccccccc', commit_full: COMMIT, ...fields });
  const log = path.join(logs, 'main-reviews.jsonl');
  const binding = (): PlanReviewLogBinding => ({ directory: logs, skill: 'plan-design-review', commitFull: COMMIT,
    baseline: {}, attemptStartedAt: startedAt });
  writeReport();
  fs.writeFileSync(log, row() + '\n');
  const check = (overrides: { screen?: string; binding?: PlanReviewLogBinding; now?: number } = {}) =>
    structuredPlanCompletion(transcript, plan, startedAt, overrides.screen ?? a.finalScreen, overrides.binding ?? binding(),
      new Set(), overrides.now ?? finishedAt + 60_000);
  return { a, dir, plan, logs, log, transcript, final, finishedAt, lastAnswer, startedAt, writeReport, row, binding, check,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('existing predicates rejected both captured Design endings (recorded before the structured route)', () => {
  for (const attempt of [0, 1]) {
    const e = envelope(attempt);
    try {
      expect(classifyPlanCountFrame(e.a.finalScreen)).toBeNull();
      expect(hasNativePlanCompletion(e.transcript, e.plan, e.startedAt)).toBe(false);
      expect(hasNativePlanTerminal(e.transcript, e.plan, e.startedAt, 'completion_summary')).toBe(false);
      expect(e.a.observed.outcome).toBe('timeout');
    } finally { e.cleanup(); }
  }
});

test('both captured Design endings complete on structured evidence', () => {
  for (const attempt of [0, 1]) {
    const e = envelope(attempt);
    try { expect(e.check(), `attempt ${attempt + 1}`).toEqual({ ok: true }); } finally { e.cleanup(); }
  }
});

const rejects = (reason: RegExp, change: (e: ReturnType<typeof envelope>) => Parameters<ReturnType<typeof envelope>['check']>[0] | void) => () => {
  const e = envelope(1);
  try {
    const result = e.check(change(e) ?? {});
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(reason);
  } finally { e.cleanup(); }
};

test('negative control: idle mid-review (last question unanswered)', rejects(/pending or unresolved/, e => {
  const call = e.transcript.calls.at(-1)!; call.answered = false; call.answers = {}; delete call.answeredAt;
}));
test('negative control: stale review-log row from a previous attempt', rejects(/no review-log row appended during this attempt/, e =>
  ({ binding: { ...e.binding(), baseline: planReviewLogBaseline(e.logs) } })));
test('negative control: row written before the current report', rejects(/no completed plan-design-review review-log row/, e =>
  fs.writeFileSync(e.log, e.row({ timestamp: new Date(second(e.finishedAt - 90_000)).toISOString() }) + '\n')));
test('negative control: report older than the last answer (stale plan)', rejects(/no complete caller-owned report/, e =>
  e.writeReport(e.lastAnswer - 5_000)));
test('negative control: pending question below the report', rejects(/question or permission prompt is visible/, e =>
  ({ screen: e.a.finalScreen + '\n\n Which option?\n❯ 1. Add routing rules\n  2. Skip\n\nEnter to select · ↑/↓ to navigate · Esc to cancel' })));
for (const status of ['failed', 'skipped', 'unavailable'])
  test(`negative control: fresh ${status} row`, rejects(/no completed plan-design-review review-log row/, e =>
    fs.writeFileSync(e.log, e.row({ status }) + '\n')));
test('negative control: row reporting completed=false', rejects(/no completed plan-design-review/, e =>
  fs.writeFileSync(e.log, e.row({ completed: false }) + '\n')));
test('negative control: concurrent foreign attempt (another fixture commit)', rejects(/for this fixture commit/, e =>
  fs.writeFileSync(e.log, e.row({ commit_full: 'd'.repeat(40) }) + '\n')));
test('negative control: row for another skill', rejects(/no completed plan-design-review/, e =>
  fs.writeFileSync(e.log, e.row({ skill: 'plan-eng-review' }) + '\n')));
test('negative control: sibling-slug row', rejects(/no review-log row appended/, e => {
  const sibling = path.join(path.dirname(e.logs), 'gstack-plan-count-sibling');
  fs.mkdirSync(sibling); fs.renameSync(e.log, path.join(sibling, 'main-reviews.jsonl'));
}));
test('negative control: future timestamp', rejects(/no completed plan-design-review/, e => {
  fs.writeFileSync(e.log, e.row({ timestamp: new Date(e.finishedAt + 3_600_000).toISOString() }) + '\n');
  return { now: e.finishedAt + 60_000 };
}));
test('negative control: invalid timestamp', rejects(/no completed plan-design-review/, e =>
  fs.writeFileSync(e.log, e.row({ timestamp: 'yesterday' }) + '\n')));
test('negative control: report changed after the final native message', rejects(/changed after the final native message/, e =>
  e.writeReport(e.finishedAt + 10_000)));
for (const stopReason of ['tool_use', undefined])
  test(`negative control: final message stop_reason ${stopReason ?? 'missing'}`, rejects(/not end_turn/, e => {
    if (stopReason) e.final.stopReason = stopReason; else delete e.final.stopReason;
  }));
test('negative control: final message asks for input', rejects(/asks for input/, e => { e.final.text += '\n\nWhich option do you want?'; }));
test('negative control: a Design report that is not cleared', rejects(/Design binding/, e =>
  e.writeReport(undefined, REPORT.replace('DESIGN CLEARED — eng review required', 'NOT CLEARED — design issues open'))));
test('negative control: no review-log binding', () => {
  const e = envelope(1);
  try {
    expect(structuredPlanCompletion(e.transcript, e.plan, e.startedAt, e.a.finalScreen, undefined, new Set(), e.finishedAt + 60_000))
      .toMatchObject({ ok: false, reason: 'no fixture-owned review log binding' });
  } finally { e.cleanup(); }
});

test('same-second row, report and last answer are accepted', () => {
  const e = envelope(1);
  try {
    const call = e.transcript.calls.at(-1)!;
    const base = second(e.finishedAt - 120_000);
    call.answeredAt = new Date(base + 700).toISOString();
    e.writeReport(base + 800);
    fs.writeFileSync(e.log, e.row({ timestamp: new Date(base).toISOString().replace('.000Z', 'Z') }) + '\n');
    expect(e.check()).toEqual({ ok: true });
  } finally { e.cleanup(); }
});

// Real PTY + real bin/gstack-review-log: the counting loop's existing summary
// branch accepts structured evidence, and a timeout names the rejected ending.
async function runFake(opts: { logRow: boolean; timeoutMs: number }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-completion-pty-'));
  const fake = path.join(dir, 'fake-claude'), worker = path.join(dir, 'worker.ts');
  const output = path.join(dir, 'gstack-test-plan-design.md'), result = path.join(dir, 'result.json');
  const runner = pathToFileURL(path.join(import.meta.dir, 'helpers/claude-pty-runner.ts')).href;
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
const sessionId = 'structured-completion-fixture';
const project = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', sessionId);
fs.mkdirSync(project, { recursive: true });
const file = path.join(project, sessionId + '.jsonl');
const native = (role, content, extra = {}, message = {}) => fs.appendFileSync(file, JSON.stringify({
  cwd: process.cwd(), sessionId, isSidechain: false,
  timestamp: new Date().toISOString(), message: { role, content, ...message }, ...extra,
}) + '\n');
let sent = false;
process.stdin.setRawMode?.(true);
process.stdin.on('data', async () => {
  if (sent) return; sent = true;
  const q = { header: 'Issue 1', question: 'D1 — Issue 1: How should Save be distinguished?', options: [{ label: '1A) Filled Save' }, { label: '1B) Keep equal buttons' }] };
  native('assistant', [{ type: 'tool_use', id: 'finding', name: 'AskUserQuestion', input: { questions: [q] } }]);
  native('user', [{ type: 'tool_result', tool_use_id: 'finding', content: 'Answered.' }], {
    timestamp: new Date(Date.now() - 100).toISOString(), toolUseResult: { answers: { [q.question]: q.options[0].label } },
  });
  await Bun.sleep(20);
  fs.writeFileSync(process.env.PROBE_PLAN, process.env.PROBE_REPORT);
  if (process.env.PROBE_LOG_ROW === '1') {
    const logged = spawnSync(process.env.PROBE_REVIEW_LOG, [JSON.stringify({ skill: 'plan-design-review',
      timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), status: 'clean', initial_score: 6, overall_score: 9,
      unresolved: 0, decisions_made: 1, commit: 'fixture' })], { encoding: 'utf8', timeout: 20000 });
    if (logged.status !== 0) fs.writeFileSync(process.env.PROBE_PLAN + '.log-error', logged.stderr || String(logged.error));
  }
  await Bun.sleep(1100);
  const text = '**STATUS: DONE**\n\nWhat happened:\n- One finding, one decision. Reviewed plan written to ' + process.env.PROBE_PLAN;
  native('assistant', [{ type: 'text', text }], {}, { stop_reason: 'end_turn' });
  process.stdout.write('STATUS: DONE\nWhat happened: one finding, one decision.\nBaked for 1m 2s · done 7:05 AM\n❯ ');
});
process.stdin.resume();
process.stdout.write('PTY_READY\x1b[2J\x1b[H');
`);
  fs.chmodSync(fake, 0o755);
  fs.writeFileSync(worker, `import { runPlanSkillCounting } from ${JSON.stringify(runner)};\n` +
    `const result = await runPlanSkillCounting({skillName:'plan-design-review',slashCommand:'/plan-design-review',` +
    `followUpPrompt:'# Structured completion fixture',expectedPlanPath:${JSON.stringify(output)},isLastStep0AUQ:()=>false,` +
    `isFirstReviewAUQ:()=>true,reviewCountCeiling:8,timeoutMs:${opts.timeoutMs},startupReadyMarker:'PTY_READY',` +
    `env:{PROBE_PLAN:${JSON.stringify(output)},PROBE_REPORT:${JSON.stringify(REPORT)},PROBE_LOG_ROW:'${opts.logRow ? 1 : 0}',` +
    `PROBE_REVIEW_LOG:${JSON.stringify(path.resolve(import.meta.dir, '..', 'bin', 'gstack-review-log'))}}});\n` +
    `await Bun.write(${JSON.stringify(result)},JSON.stringify(result));\n`);
  const child = Bun.spawn([process.execPath, worker], {
    env: { ...process.env, EVALS_HERMETIC: '1', EVALS_RUN_ID: '', BROWSE_TERMINAL_BINARY: fake },
    stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs + 30_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stdout + stderr).toBe(0);
    expect(fs.existsSync(output + '.log-error') ? fs.readFileSync(output + '.log-error', 'utf8') : '').toBe('');
    return JSON.parse(fs.readFileSync(result, 'utf8'));
  } finally { clearTimeout(timer); child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
}

test.skipIf(process.platform === 'win32')('real PTY: a real review-log row completes an unrecognized summary wording', async () => {
  const observation = await runFake({ logRow: true, timeoutMs: 40_000 });
  expect(observation.outcome).toBe('completion_summary');
  expect(observation.summary).toContain('native completion_summary and final report verified');
  expect(observation.reviewCount).toBe(1);
}, 80_000);

test.skipIf(process.platform === 'win32')('real PTY: without the row the attempt times out naming idle time and the rejected ending', async () => {
  const observation = await runFake({ logRow: false, timeoutMs: 20_000 });
  expect(observation.outcome).toBe('timeout');
  expect(observation.summary).toMatch(/; idleFor=\d+ms lastTerminalCandidate=native_summary: no review-log row appended during this attempt in /);
}, 60_000);
