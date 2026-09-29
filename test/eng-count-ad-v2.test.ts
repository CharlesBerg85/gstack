import { describe, expect, test } from 'bun:test';
import captured from './fixtures/eng-count-ad-v2.json';
import { engFirstReviewAUQ, engSetupAUQ, engStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, matchGlob } from './helpers/touchfiles';
const firstCalls = captured.cases.first.calls as NativePlanQuestionCall[];
const retryCalls = captured.cases.retry.calls as NativePlanQuestionCall[];
const issue = () => structuredClone(retryCalls[3]!);
const fp = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, true);
const isFirst = (call: NativePlanQuestionCall) => engFirstReviewAUQ(fp(call));
function setupPacket(): NativePlanQuestionCall {
  const c = issue();
  c.questions = [
    { header: 'Design doc', question: 'No design doc found for this branch. /office-hours produces sharper review input. Run it first?',
      multiSelect: false, options: [{ label: 'Skip — proceed with standard review (recommended)' }, { label: 'Run /office-hours now' }] },
    { header: 'Learnings', question: 'Search learnings from your other projects on this machine?',
      multiSelect: false, options: [{ label: 'Enable cross-project learnings (recommended)' }, { label: 'Keep learnings project-scoped only' }] },
  ];
  c.answers = Object.fromEntries(c.questions.map(q => [q.question, q.options[0]!.label]));
  return c;
}
function changeQuestion(call: NativePlanQuestionCall, change: (s: string) => string) {
  const q = call.questions[0]!, answer = call.answers?.[q.question];
  q.question = change(q.question); call.answers = answer ? { [q.question]: answer } : {}; return call;
}
function census(calls: NativePlanQuestionCall[]) {
  let reviewStarted = false;
  const counts = { setup: 0, review: 0, administrative: 0 };
  const phases = calls.map(call => {
    const phase = planCountQuestionPhase(fp(call), reviewStarted, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ);
    reviewStarted = phase.reviewStarted;
    counts[phase.administrative ? 'administrative' : phase.preReview ? 'setup' : 'review']++;
    return phase;
  });
  return { counts, phases };
}

describe('Eng AD v2 completed native count evidence', () => {
  test('a completed prerequisite and learnings packet closes setup without counting it as a finding', () => {
    for (const reverse of [false, true]) {
      const c = setupPacket(); if (reverse) c.questions.reverse();
      for (const answer of c.questions.find(q => q.header === 'Learnings')!.options) {
        const learning = c.questions.find(q => q.header === 'Learnings')!;
        c.answers![learning.question] = answer.label;
        const phase = planCountQuestionPhase(fp(c), false, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ);
        expect(phase).toEqual({ preReview: true, reviewStarted: true });
        expect(planCountQuestionPhase(fp(issue()), phase.reviewStarted,
          engStep0Boundary, engFirstReviewAUQ, engSetupAUQ).preReview).toBe(false);
      }
    }
  });

  test('partial, ambiguous, foreign and prerequisite-running packets cannot close setup', () => {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [1]; },
      (c: NativePlanQuestionCall) => { delete c.answers![c.questions[1]!.question]; },
      (c: NativePlanQuestionCall) => { c.answers![c.questions[1]!.question] = 'unoffered'; },
      (c: NativePlanQuestionCall) => { c.answers![c.questions[0]!.question] = c.questions[0]!.options[1]!.label; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
      (c: NativePlanQuestionCall) => { c.questions[1]!.options.push({ ...c.questions[1]!.options[0]! }); },
      (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(issue().questions[0]!)); },
      (c: NativePlanQuestionCall) => { c.answeredAt = 'invalid'; },
    ]) {
      const c = setupPacket(); mutate(c); expect(engStep0Boundary(fp(c))).toBe(false);
    }
    expect(engStep0Boundary({ ...fp(setupPacket()), signature: 'foreign:call' })).toBe(false);
    expect(engStep0Boundary({ ...fp(setupPacket()), options: [] })).toBe(false);
    const c = setupPacket();
    c.questions[1]!.header = 'Issue 1';
    expect(engStep0Boundary(fp(c))).toBe(false);
  });

  test('retry ordinary Issue identity starts review without qids, retaining its later TODO', () => {
    const { counts, phases } = census(retryCalls);
    expect(counts).toEqual({ setup: 3, review: 6, administrative: 0 });
    expect(phases.slice(3).every(p => !p.preReview && !p.administrative)).toBe(true);
    for (const call of retryCalls.slice(3, 8)) expect(isFirst(call)).toBe(true);
    expect(retryCalls[8]!.questions[0]!.question).toContain('TODO 1');
    expect(captured.cases.retry.actual.reviewCount).toBe(0);
  });

  test('ordinary issue presentation can vary while completed identity and section number remain bound', () => {
    for (const title of ['Issue 1', 'Finding 1.2 (D17)', 'D42 — Issue 1']) {
      const call = changeQuestion(issue(), s => s.replace('Issue 1 (D4)', title).replace('AuthCache', 'SessionCache'));
      call.questions[0]!.header = title.includes('1.2') ? 'Architecture 1.2' : 'Architecture 1';
      call.questions[0]!.options.reverse();
      for (const option of call.questions[0]!.options) {
        call.answers = { [call.questions[0]!.question]: option.label };
        expect(isFirst(call)).toBe(true);
      }
    }
  });

  test('setup, quoted or mismatched section identities do not start review', () => {
    for (const header of ['Scope', 'Approach', 'Next steps', 'Arch 2', 'Example Arch 1', 'TODO 1']) {
      const call = issue(); call.questions[0]!.header = header; expect(isFirst(call)).toBe(false);
    }
    for (const change of [
      (s: string) => '> ' + s,
      (s: string) => 'Example: ' + s,
      (s: string) => '```text\n' + s + '\n```',
      (s: string) => s.replace('Issue 1 (D4)', 'Issue 2 (D4)'),
      (s: string) => s + ' <gstack-qid:plan-eng-setup>',
    ]) expect(isFirst(changeQuestion(issue(), change))).toBe(false);
    for (const call of [...firstCalls.slice(0, 4), ...retryCalls.slice(0, 3)]) expect(isFirst(call)).toBe(false);
  });

  test('an Issue heading alone cannot turn a confirmation or report action into a finding', () => {
    for (const body of [
      'No defect remains in the cache. Proceed with the next section?',
      'The cache already serializes writes. Confirm this is accurate?',
      'Should I save the reviewed plan now?',
      'Add a section to the reviewed plan?',
      'Serialize the reviewed plan as JSON for the handoff?',
      'Add the completed tests to this report?',
    ]) {
      const c = changeQuestion(issue(), () => 'Issue 1 (D4) — ' + body);
      c.questions[0]!.options = [
        { label: 'Yes', description: 'Confirm this statement; no new implementation work.' },
        { label: 'No', description: 'Do not confirm; no new implementation work.' },
      ];
      c.answers = { [c.questions[0]!.question]: 'Yes' };
      expect(isFirst(c)).toBe(false);
    }
    const c = issue();
    c.questions[0]!.options = [{ label: 'Yes', description: 'Confirm; no new work.' }, { label: 'No', description: 'Decline; no new work.' }];
    c.answers = { [c.questions[0]!.question]: 'Yes' };
    expect(isFirst(c)).toBe(false);
  });

  test('new first-finding path requires exact completed native identity and answer', () => {
    for (const factory of [issue]) {
      const classify = isFirst;
      for (const mutate of [
        (c: NativePlanQuestionCall) => { c.answered = false; },
        (c: NativePlanQuestionCall) => { c.failed = true; },
        (c: NativePlanQuestionCall) => { delete c.failed; },
        (c: NativePlanQuestionCall) => { c.sessionId = ''; },
        (c: NativePlanQuestionCall) => { c.toolUseId = ''; },
        (c: NativePlanQuestionCall) => { delete c.answeredAt; },
        (c: NativePlanQuestionCall) => { c.answeredAt = 'invalid'; },
        (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
        (c: NativePlanQuestionCall) => { delete c.unansweredQuestionIndices; },
        (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
        (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
        (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label = c.questions[0]!.options[0]!.label; },
        (c: NativePlanQuestionCall) => { c.answers = {}; },
        (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'Unoffered' }; },
        (c: NativePlanQuestionCall) => { c.answers!.foreign = 'Foreign'; },
      ]) { const c = factory(); mutate(c); expect(classify(c)).toBe(false); }
      const classifyFp = engFirstReviewAUQ;
      expect(classifyFp({ ...fp(factory()), signature: 'foreign:call' })).toBe(false);
      expect(classifyFp({ ...fp(factory()), nativeCall: undefined })).toBe(false);
      expect(classifyFp({ ...fp(factory()), nativeQuestionIndex: 1 })).toBe(false);
      expect(classifyFp({ ...fp(factory()), options: [] })).toBe(false);
      const wrong = fp(factory()); wrong.options[0]!.index = 2; expect(classifyFp(wrong)).toBe(false);
    }
  });

  test('new evidence selects precisely its affected existing paid workflows', () => {
    const selected = (path: string) => Object.entries(E2E_TOUCHFILES).filter(([, patterns]) => patterns.some(p => matchGlob(path, p))).map(([name]) => name).sort();
    for (const path of ['test/eng-count-ad-v2.test.ts', 'test/fixtures/eng-count-ad-v2.json']) {
      expect(selected(path)).toEqual(['plan-eng-finding-count', 'plan-eng-multi-finding-batching']);
    }
  });
});
