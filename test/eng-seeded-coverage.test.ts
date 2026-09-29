import fb10Public from './fixtures/eng-fb10-count-public.json';
import { describe, expect, test } from 'bun:test';
import type { NativePlanQuestionCall, PlanCountTranscript } from './helpers/plan-count-transcript';
import { ENG_DECISION_SEEDS, buildEngSeedDecisionInput, isEngBatchingIssueAUQ } from './helpers/eng-seeded-coverage';
import { buildPlanReviewDecisionPrompt, validatePlanReviewDecisionResponse } from './helpers/plan-review-decisions';
import { nativePlanCallFingerprint } from './helpers/claude-pty-runner';
import { E2E_TOUCHFILES, matchGlob } from './helpers/touchfiles';

describe('Eng semantic native evidence boundary', () => {
  const start = Date.parse(fb10Public.windowStart), end = Date.parse(fb10Public.windowEnd);
  const native = (): PlanCountTranscript => ({ status: 'ready', calls: structuredClone(fb10Public.calls) as NativePlanQuestionCall[], assistantMessages: [] });
  const input = (t = native()) => buildEngSeedDecisionInput({ plan: fb10Public.plan, transcript: t,
    startedAt: start, finishedAt: end, deadlineAt: Date.now() + 60_000 });
  // This deliberately supplied response proves only local protocol checks.
  // No model has classified this capture, and no paid result is inferred.
  const response = (data = input()) => ({ questions: data.fingerprints.flatMap((fp, i) => fp.questions!.map((q, index) => ({
    toolUseId: fp.toolUseId!, questionIndex: index + 1, kind: 'finding',
    targetIds: ({ 0: ['sequential-idp'], 2: ['complexity'], 3: ['shared-cache'], 5: ['swallowed-errors'] } as Record<number, string[]>)[i] ?? [],
    independentDecisions: 1, evidence: [{ field: 'question', optionIndex: null, quote: q.question.split('\n')[0]! }],
    reason: 'Synthetic response for structural validation, not a semantic verdict.', optionActions: [],
  }))) });
  test('uses complete native fields and actual answers with all four independent targets', () => {
    const t = native(), data = input(t);
    expect(data.targets.map(target => target.id)).toEqual([...ENG_DECISION_SEEDS]);
    expect(data.floor).toBe(4);
    expect(data.ceiling).toBeUndefined();
    expect(data.fingerprints).toHaveLength(t.calls.length);
    data.fingerprints.forEach((fp, index) => {
      const call = t.calls[index]!;
      expect(fp.questions).toEqual(call.questions);
      expect(fp.nativeCall).toEqual(call);
      expect(fp.toolUseId).toBe(`${call.sessionId}:${call.toolUseId}`);
      expect(fp.selectedOptions).toEqual(call.questions.map(q => q.options.findIndex(o => o.label === call.answers![q.question]) + 1));
    });
    expect(data.fingerprints[2]!.selectedOptions).toEqual([1]); // The actor kept all five classes, not recommended B.
    expect(validatePlanReviewDecisionResponse(data, response(data)).coveredTargetIds).toEqual([...ENG_DECISION_SEEDS]);
    const prompt = buildPlanReviewDecisionPrompt(data);
    for (const fp of data.fingerprints) for (const q of fp.questions!) {
      expect(prompt).toContain(JSON.stringify(q.question));
      for (const o of q.options) expect(prompt).toContain(JSON.stringify(o.description));
    }
  });

  test('takes an immutable snapshot before asynchronous classification', () => {
    const t = native(), data = input(t), before = structuredClone(data);
    t.calls[2]!.questions[0]!.question += '\nAltered after binding';
    t.calls[2]!.answers = {};
    expect(data).toEqual(before);
  });

  for (const [name, change] of [
    ['foreign session', (t: PlanCountTranscript) => { t.calls[2]!.sessionId = 'foreign'; }],
    ['duplicate native identity', (t: PlanCountTranscript) => { t.calls.push(structuredClone(t.calls[2]!)); }],
    ['unanswered call', (t: PlanCountTranscript) => { t.calls[2]!.answered = false; }],
    ['failed call', (t: PlanCountTranscript) => { t.calls[2]!.failed = true; }],
    ['unanswered tab', (t: PlanCountTranscript) => { t.calls[2]!.unansweredQuestionIndices = [0]; }],
    ['unoffered actual answer', (t: PlanCountTranscript) => { const c = t.calls[2]!; c.answers![c.questions[0]!.question] = 'Use a different option'; }],
    ['duplicate offered labels', (t: PlanCountTranscript) => { const q = t.calls[2]!.questions[0]!; q.options[1]!.label = q.options[0]!.label; }],
    ['out-of-window answer', (t: PlanCountTranscript) => { t.calls[2]!.answeredAt = new Date(start - 1).toISOString(); }],
    ['foreign extra answer', (t: PlanCountTranscript) => { t.calls[2]!.answers!['Foreign question'] = 'A'; }],
  ] as const) test(`rejects ${name} before a judge can run`, () => {
    const t = native(); change(t); expect(() => input(t)).toThrow('complete owned');
  });

  for (const [name, change, error] of [
    ['missing row', (r: ReturnType<typeof response>) => { r.questions.pop(); }, 'missing native question rows'],
    ['duplicate row', (r: ReturnType<typeof response>) => { r.questions.push(structuredClone(r.questions[0]!)); }, 'duplicate native question'],
    ['foreign identity', (r: ReturnType<typeof response>) => { r.questions[2]!.toolUseId = 'foreign'; }, 'phantom'],
    ['wrong native quote', (r: ReturnType<typeof response>) => { r.questions[2]!.evidence[0]!.quote = r.questions[5]!.evidence[0]!.quote; }, 'exact native field'],
    ['missing seed', (r: ReturnType<typeof response>) => { r.questions[2]!.targetIds = []; }, 'missing target decisions'],
    ['bundled remedies', (r: ReturnType<typeof response>) => { r.questions[2]!.independentDecisions = 2; }, 'bundled independent decisions'],
    ['two seeds in one choice', (r: ReturnType<typeof response>) => { r.questions[2]!.targetIds.push('swallowed-errors'); r.questions[5]!.targetIds = []; }, 'bundled independent decisions'],
    ['uncertainty', (r: ReturnType<typeof response>) => { Object.assign(r.questions[2]!, { kind: 'uncertain', targetIds: [], independentDecisions: 0 }); }, 'uncertain classification'],
  ] as const) test(`rejects judge ${name}`, () => {
    const data = input(), raw = response(data); change(raw);
    expect(() => validatePlanReviewDecisionResponse(data, raw)).toThrow(error);
  });

  test('keeps the absolute deadline and does not grant a new judge window', () => {
    const deadlineAt = Date.now() - 1;
    const data = buildEngSeedDecisionInput({ plan: fb10Public.plan, transcript: native(), startedAt: start, finishedAt: end, deadlineAt });
    expect(data.deadlineAt).toBe(deadlineAt);
    expect(() => buildPlanReviewDecisionPrompt(data)).toThrow('absolute case deadline exhausted');
    expect(() => buildEngSeedDecisionInput({ plan: fb10Public.plan, transcript: native(), startedAt: start, finishedAt: end, deadlineAt: end - 1 })).toThrow('original deadline');
  });
});


function question(call: NativePlanQuestionCall, text: string) {
  const answer = call.answers![call.questions[0]!.question]!;
  call.questions[0]!.question = text; call.answers = { [text]: answer };
}

describe('Eng seeded coverage from completed native decisions', () => {
  test('local evidence dependencies select both Eng consumers', () => {
    for (const file of ['test/helpers/eng-seeded-coverage.ts', 'test/eng-seeded-coverage.test.ts']) {
      expect(Object.entries(E2E_TOUCHFILES).filter(([, patterns]) => patterns.some(p => matchGlob(file, p))).map(([key]) => key))
        .toEqual(['plan-eng-finding-count', 'plan-eng-multi-finding-batching']);
    }
  });
});


describe('batching caller counts completed issue decisions across setup boundaries', () => {
  const issue = (number: number, header = 'Architecture'): NativePlanQuestionCall => {
    const question = `D${number + 2} — Issue ${number}: Choose the component contract\nELI10: The current contract leaves behavior unspecified.`;
    return { sessionId: 'owned-session', toolUseId: `toolu_issue_${number}`, answered: true, failed: false,
      answeredAt: '2026-01-01T00:00:00.000Z', unansweredQuestionIndices: [],
      questions: [{ header, question, multiSelect: false, options: [
        { label: `${number}A: Define the contract`, description: 'Specify the behavior.' },
        { label: `${number}B: Retain the current contract`, description: 'Keep the documented risk.' },
      ] }], answers: { [question]: `${number}A: Define the contract` } };
  };
  const check = (call: NativePlanQuestionCall, prior: readonly NativePlanQuestionCall[] = []) =>
    isEngBatchingIssueAUQ(nativePlanCallFingerprint(call, 0, true), prior);

  test('six completed calls count six; unrelated wording and either offered choice do not change identity', () => {
    const history: NativePlanQuestionCall[] = [];
    for (const [i, header] of ['Architecture', 'Architecture', 'Architecture', 'Code quality', 'Tests', 'Performance'].entries()) {
      const call = issue(i + 1, header);
      if (i % 2) call.answers![call.questions[0]!.question] = call.questions[0]!.options[1]!.label;
      expect(check(call, history)).toBe(true); history.push(call);
    }
    expect(history).toHaveLength(6);
    expect(check(history[0]!, history)).toBe(false);
    const repeated = structuredClone(history[0]!); repeated.toolUseId = 'toolu_repeated';
    expect(check(repeated, history)).toBe(false);
    const scope = issue(1, 'Scope');
    expect(check(repeated, [scope])).toBe(true);
    const batch = issue(1), second = issue(2);
    batch.questions.push(...second.questions); Object.assign(batch.answers!, second.answers);
    expect(check(repeated, [batch])).toBe(true);
  });

  test('one batched native call cannot satisfy a three-call floor', () => {
    const batch = issue(1);
    for (const number of [2, 3, 4]) {
      const next = issue(number); batch.questions.push(...next.questions); Object.assign(batch.answers!, next.answers);
    }
    const count = [batch].filter(call => check(call)).length;
    expect(count).toBeLessThanOrEqual(1); expect(count).toBeLessThan(3);
  });

  test('incomplete, foreign, inconsistent or non-issue packets cannot inflate the counter', () => {
    const variants: Array<(call: NativePlanQuestionCall) => void> = [
      c => { c.answered = false; }, c => { c.failed = true; }, c => { c.unansweredQuestionIndices = [0]; },
      c => { delete c.answeredAt; }, c => { c.answers = {}; }, c => { c.questions[0]!.multiSelect = true; },
      c => { c.answers![c.questions[0]!.question] = 'Not offered'; },
      c => { c.questions[0]!.options[1]!.label = '2B: Foreign issue'; },
      c => { c.questions[0]!.options[1]!.label = '1A: Duplicate option ID'; },
      c => { c.questions[0]!.header = 'Scope'; }, c => { c.questions[0]!.header = 'Next steps'; },
      c => { c.questions[0]!.header = 'TODO'; }, c => { c.questions[0]!.header = 'Design'; },
      c => { question(c, c.questions[0]!.question.replace('Issue 1:', 'TODO 1:')); },
      c => { question(c, '> ' + c.questions[0]!.question); },
      c => { question(c, 'Historical note:\n' + c.questions[0]!.question); },
      c => { question(c, c.questions[0]!.question + '\nThis decision is "withdrawn".'); },
      c => { question(c, c.questions[0]!.question + '\nIssue 1 is no longer current.'); },
      c => { question(c, c.questions[0]!.question + '\nThis decision is `no longer current`.'); },
    ];
    for (const change of variants) { const call = issue(1); change(call); expect(check(call)).toBe(false); }
    const fp = nativePlanCallFingerprint(issue(1), 0, true); fp.signature = 'foreign:identity';
    expect(isEngBatchingIssueAUQ(fp)).toBe(false);
    expect(check(issue(2), [{ ...issue(1), sessionId: 'foreign-session' }])).toBe(false);
    const call = issue(1); question(call, call.questions[0]!.question + '\n> This decision is withdrawn.');
    expect(check(call)).toBe(true);
    const quoted = issue(1); question(quoted, quoted.questions[0]!.question + '\n`This decision is withdrawn.`');
    expect(check(quoted)).toBe(true);
  });
});
