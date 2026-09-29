import { describe, expect, test } from 'bun:test';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createEngBatchingIssueCounter, isEngBatchingIssueAUQ } from './helpers/eng-seeded-coverage';
import { engSetupAUQ, hasCompletePlanReport, nativePlanCallFingerprint } from './helpers/claude-pty-runner';
import batchingCapture from './fixtures/eng-batching-unsourced-brief-36606688266.json';

function question(call: NativePlanQuestionCall, text: string) {
  const answer = call.answers![call.questions[0]!.question]!;
  call.questions[0]!.question = text; call.answers = { [text]: answer };
}

describe('Eng seeded coverage from completed native decisions', () => {
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

describe('batching replay of run 36606688266 (unsourced native briefs)', () => {
  // Run 36606688266 asked one native question per finding (D1-D9 bound to
  // ledger records R1-R9, D10 a TODO follow-up) but cited no PLAN.md line in the
  // native brief, so the old detector counted zero review decisions.
  const FLOOR = 3;
  const calls = batchingCapture.calls as unknown as NativePlanQuestionCall[];

  function count(plan: string, edit: (calls: NativePlanQuestionCall[]) => void = () => {}) {
    const copy = structuredClone(calls);
    edit(copy);
    const counter = createEngBatchingIssueCounter(() => plan, engSetupAUQ);
    const counted = copy.filter((call, index) => counter.isReviewAUQ(nativePlanCallFingerprint(call, 0, true), copy.slice(0, index)));
    return { counted: counted.length, issues: counter.trace.map(entry => entry.issue) };
  }

  test('the recorded failing verdict is the detector, not the review', () => {
    expect(batchingCapture.recordedOutcome).toEqual({ outcome: 'completion_summary', step0Count: 10, reviewCount: 0 });
    expect(calls.every(call => call.answered && call.questions.length === 1)).toBe(true);
  });

  test('each ledger-bound native decision counts once without a native source citation', () => {
    const { counted, issues } = count(batchingCapture.plan);
    expect(issues).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'].map(id => `record:${id}`));
    expect(counted).toBeGreaterThanOrEqual(FLOOR);
  });

  test('a re-asked decision cannot inflate the count', () => {
    const { counted } = count(batchingCapture.plan, all => {
      const again = structuredClone(all[0]!);
      again.toolUseId += '-again';
      all.splice(1, 0, again);
    });
    expect(counted).toBe(9);
  });

  const target = 'Review target (fixed): `PLAN.md`';
  for (const [name, plan] of [
    ['a foreign target', batchingCapture.plan.replace(target, 'Review target (fixed): `OTHER.md`')],
    ['a mixed target', batchingCapture.plan.replace(target, 'Review target (fixed): `OTHER.md` and `PLAN.md`')],
    ['two target declarations', batchingCapture.plan.replace(target, `${target}\nReview target (fixed): \`PLAN.md\``)],
    ['no target declaration', batchingCapture.plan.replace(target, 'Report scope: the fixture repo')],
    ['a report title for another plan', batchingCapture.plan.replace('# Engineering review: Add background job retry framework', '# Engineering review: Replace all customer data')],
    ['an archived report title', batchingCapture.plan.replace('# Engineering review:', '# Archived engineering review:')],
    ['a copied H1 naming another plan', batchingCapture.plan.replace('# Plan: Add background job retry framework', '# Plan: Replace all customer data')],
  ] as const) test(`the unsourced route rejects ${name}`, () => {
    expect(count(plan).counted).toBe(0);
  });

  test('the unsourced route rejects a native brief naming another plan or file', () => {
    const rename = (from: string, to: string) => (all: NativePlanQuestionCall[]) => {
      for (const call of all) call.questions[0]!.question = call.questions[0]!.question.replace(from, to);
    };
    expect(count(batchingCapture.plan, rename('plan "Add background job retry framework"', 'plan "Replace all customer data"')).counted).toBe(0);
    expect(count(batchingCapture.plan, rename('plan "Add background job retry framework"', 'plan "Add background job retry framework", OTHER.md')).counted).toBe(0);
    expect(count(batchingCapture.plan, rename('plan "Add background job retry framework"', 'the plan')).counted).toBe(0);
  });

  test('a saved record whose brief title differs from the native question does not bind it', () => {
    const plan = batchingCapture.plan.replace(/^Question D1:\n.*$/m, 'Question D1:\nD1 — Some other decision?');
    expect(count(plan).issues).not.toContain('record:R1');
  });

  test('the completed report is the early outcome point; a partial report is not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-batching-report-'));
    try {
      const report = path.join(dir, 'report.md');
      fs.writeFileSync(report, batchingCapture.plan);
      expect(hasCompletePlanReport(report, 0, Date.now() + 1_000)).toBe(true);
      fs.writeFileSync(report, batchingCapture.plan.slice(0, batchingCapture.plan.indexOf('## Completion summary')));
      expect(hasCompletePlanReport(report, 0, Date.now() + 1_000)).toBe(false);
      fs.writeFileSync(report, batchingCapture.plan.replace('## GSTACK REVIEW REPORT', '```\n## GSTACK REVIEW REPORT') + '\n```\n');
      expect(hasCompletePlanReport(report, 0, Date.now() + 1_000)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
