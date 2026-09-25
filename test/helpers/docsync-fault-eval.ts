import { expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CAPTURE_MS } from './eval-budgets';
import { runSkillTest, type SkillTestResult } from './session-runner';
import { runId, logCost, recordE2E } from './e2e-helpers';
import type { EvalCollector } from './eval-store';
import { DOC_PATH, fixtureDocs, preserveDocsEvidence } from './docsync-fixture';
import { installDocsActor, type DocsActorState, type DocsFault } from './docsync-fault-actor';
import { observeDocsWrites, docsWriteFailures, docsNativeInterface, docsToolFailures, docsCompletedRead } from './docsync-observer';
import { extractDocsDispatch } from './docsync-contract';

export function docsActorVerdict(state: DocsActorState, report: string, published: boolean): string[] {
  const failures: string[] = [];
  const actions = state.events.map(e => e.action);
  const calls = state.events.filter(e => e.action === 'dispatch');
  const success = ['recovery', 'stale-before', 'stale-after'].includes(state.scenario);
  const count = state.scenario === 'missing-asset' ? 0 : success || state.scenario === 'late-result' ? 2 : 1;
  if (calls.length !== count) failures.push(`wrong executed dispatch count: ${calls.length}, expected ${count}`);
  if (new Set(calls.map(e => e.audit_id)).size !== calls.length) failures.push('audit identity reused');
  if (published !== success || actions.includes('publish') !== success) failures.push('wrong parent publication decision');
  if (state.events.some(e => e.action === 'rejected')) failures.push('parent attempted invalid actor interaction');
  if (!success && !/Documentation[\s\S]*blocked/i.test(report)) failures.push('blocked documentation not reported');
  if (!success && /Documentation(?: is|:) current/i.test(report)) failures.push('false current report');
  if (success && (!state.acceptedId || !report.includes(state.acceptedId))) failures.push('actual repaired audit not consumed');
  if (state.scenario === 'timeout-unsettled') {
    const stop = actions.indexOf('stop');
    if (stop < 0 || !state.events.slice(stop + 1).some(e => e.action === 'status' && e.detail === 'running')) failures.push('unsettled stop was not checked');
    if (state.tasks.every(t => t.settled)) failures.push('unsettled fault was not exercised');
  }
  if (state.scenario === 'late-result') {
    const stopped = state.events.findIndex(e => e.action === 'stop' && e.detail === 'settled');
    const repair = actions.indexOf('repair');
    const second = state.events.findIndex(e => e.action === 'dispatch' && e.audit_id === calls[1]?.audit_id);
    if (stopped < 0 || repair <= stopped || second <= repair || !actions.includes('late-callback')) failures.push('late result recovery sequence not exercised');
  }
  if (state.scenario === 'recovery') {
    const repair = actions.indexOf('repair');
    if (repair < 0 || repair >= state.events.findIndex(e => e.action === 'dispatch' && e.audit_id === calls[1]?.audit_id)) failures.push('retry had no concrete repair');
  }
  if (state.scenario.startsWith('stale-')) {
    const edit = actions.indexOf('scheduled-input-edit');
    const firstResult = actions.indexOf('completion');
    if (edit < 0 || firstResult < 0 || (state.scenario === 'stale-before' ? edit >= firstResult : edit <= firstResult)) failures.push('wrong stale input/result order');
    const second = state.events.findIndex(e => e.action === 'dispatch' && e.audit_id === calls[1]?.audit_id);
    if (second <= edit || actions.indexOf('publish') <= second) failures.push('stale audit was published or not refreshed');
  }
  return failures;
}

export async function runShipDocsFault(testName: string, scenario: DocsFault, collector: EvalCollector) {
  if (!process.env.EVALS_RUN_ID) throw Error('Native docs fault acceptance requires EVALS_RUN_ID');
  const deadline = Date.now() + CAPTURE_MS;
  const fixture = fixtureDocs('current');
  const actorFile = path.join(import.meta.dir, 'docsync-fault-actor.ts');
  const stateFile = installDocsActor(fixture, scenario);
  const report = path.join(fixture.home, 'ship-report.md');
  const phase = path.join(fixture.home, 'phase.md');
  const skeleton = fs.readFileSync(path.join(fixture.skills, 'ship/SKILL.md'), 'utf8');
  const start = skeleton.indexOf('## Step 14.5: Documentation audit (every ship)');
  const end = skeleton.indexOf('## Step 15: Commit');
  if (start < 0 || end <= start) throw Error('native parent documentation phase markers moved');
  fs.writeFileSync(phase, skeleton.slice(start, end));
  const observer = await observeDocsWrites(fixture);
  let result: SkillTestResult | undefined;
  let passed = false;
  try {
    result = await runSkillTest({
      prompt: `Load gstack /ship. Steps 0–14 are complete; execute the actual next phase from ${phase} and stop before Step 15. Base main; existing open PR, already-pushed docs-only branch. Skill assets are installed at ${fixture.skills}. Place candidate/prompt/report artifacts directly under ${fixture.home}. No prior audit is reusable. Write the final ship report to ${report}; no user risk exception or risky edit is approved.

This native-parent fault fixture supplies a deterministic child transport instead of Agent/Task. This is a host tool adapter, not a replacement workflow: pass the actual section's child prompt unchanged except literal placeholders and the fixture interface. Do not invoke real Agent/Task for these fault cases. Available commands (arguments are literal key=value strings; quote file paths as needed):
bun ${actorFile} dispatch ${stateFile} audit_id=ID candidate=ABSOLUTE_JSON_PATH prompt=ABSOLUTE_PROMPT_PATH run_in_background=false
bun ${actorFile} status ${stateFile} task_id=ID
bun ${actorFile} stop ${stateFile} task_id=ID
bun ${actorFile} repair ${stateFile}
bun ${actorFile} publish ${stateFile} audit_id=ID report=${report}
dispatch may return the actual final text, a launch error or a task id. status/stop expose this adapter's authoritative child state. Its clock is virtual: each status query advances to the next policy deadline, so use status instead of real sleeps. The model work budget is unchanged. repair is available only for a fixture marking/transport fault, once and only after settlement; this isolated launcher repair is authorized when needed, not approval for document risks. Perform the available bounded repair or fresh-snapshot audit when the loaded workflow requires it. An independent fixture actor may change selected source between audit phases. Do not read or edit ${stateFile}; it is private transport state. Only when the actual loaded workflow permits publication, call publish; it is a local receipt, not GitHub. A stop request is not a new audit or a publication permission.

${docsNativeInterface(fixture, [actorFile])}`,
      workingDirectory: fixture.repo, maxTurns: 24,
      tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      timeout: Math.max(1, deadline - Date.now() - 15_000), env: fixture.env, testName, runId,
    });
    logCost(testName, result);
    expect(result.exitReason).toBe('success');
    expect(docsCompletedRead(result, phase, fixture)).toBe(true);
    const documentation = path.join(fixture.skills, 'ship/sections/documentation.md');
    expect(docsCompletedRead(result, documentation, fixture)).toBe(true);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as DocsActorState;
    const summary = fs.readFileSync(report, 'utf8');
    expect(docsActorVerdict(state, summary, fs.existsSync(path.join(fixture.home, 'publication.json')))).toEqual([]);
    expect(docsToolFailures(result, fixture, [actorFile])).toEqual([]);
    for (const task of state.tasks) {
      const source = extractDocsDispatch(fs.readFileSync(documentation, 'utf8'));
      const literalPieces = source.split(/<branch>|<base>|<candidate-path>|<audit-id>|<mode>/);
      let cursor = 0;
      const actual = task.prompt.replaceAll(fixture.home, '${HOME}').replace(/\s+/g, ' ');
      for (const piece of literalPieces) {
        const literal = piece.replace(/\s+/g, ' ');
        const found = actual.indexOf(literal, cursor);
        expect(found).toBeGreaterThanOrEqual(cursor);
        cursor = found + literal.length;
      }
    }
    const events = result.toolCalls.filter(call => call.tool === 'Bash' && String(call.input?.command).includes(actorFile));
    for (const action of ['dispatch', 'status', 'stop', 'repair', 'publish']) {
      expect(events.filter(call => String(call.input?.command).replaceAll("'", '').replaceAll('"', '').includes(` ${action} `)).length)
        .toBe(state.events.filter(e => e.action === action).length);
    }
    if (scenario !== 'missing-asset') expect(events.some(call => call.output.includes('SESSION_KIND:') || call.output.includes('task_id') || call.output.includes('Child launch failed'))).toBe(true);
    passed = true;
  } finally {
    const observation = observer.stop();
    const failures = docsWriteFailures(observation, scenario.startsWith('stale-') ? ['app.ts', DOC_PATH] : [],
      result ? { result, fixture, scripts: [actorFile] } : undefined);
    if (failures.length) passed = false;
    preserveDocsEvidence(fixture, result ?? { output: 'capture did not return', toolCalls: [] }, runId, testName, {
      observation, actor: JSON.parse(fs.readFileSync(stateFile, 'utf8')), passed,
    });
    if (result) recordE2E(collector, testName, 'Native ship docs fault adapter', result, { passed });
    fixture.clean();
    expect(failures).toEqual([]);
  }
}
