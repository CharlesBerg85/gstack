/** Free replay of run 36385945043's Design count attempts through the structural boundary; no model calls. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import captured from './fixtures/design-completion-36385945043.json';
import { designStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import { isDesignCompletionHandoff, isDesignCountReviewStart, isDesignCountStructuralSetup, isDesignTodoProposal } from './helpers/design-count-review';
import { isDesignArtifactGeneration } from './helpers/design-artifact-question';

const replay = (calls: NativePlanQuestionCall[]) => {
  let started = false;
  return calls.map(call => {
    const fp = nativePlanCallFingerprint(structuredClone(call), 0, !started);
    const phase = planCountQuestionPhase(fp, started, designStep0Boundary, isDesignCountReviewStart,
      isDesignCountStructuralSetup, isDesignCompletionHandoff, isDesignArtifactGeneration, isDesignTodoProposal);
    started = phase.reviewStarted;
    return { header: call.questions[0]!.header, kind: phase.administrative ?? (phase.preReview ? 'setup' : 'review') };
  });
};
const calls = (i: number) => captured.attempts[i]!.transcript.calls as NativePlanQuestionCall[];

test('the paid Design caller uses the structural boundary replayed here', () => {
  const caller = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-plan-design-finding-count.test.ts'), 'utf8');
  for (const wiring of ['isFirstReviewAUQ: isDesignCountReviewStart,', 'isSetupAUQ: isDesignCountStructuralSetup,',
    'isArtifactGenerationAUQ: isDesignArtifactGeneration,', 'isTodoProposalAUQ: isDesignTodoProposal,'])
    expect(caller).toContain(wiring);
});

test('captured attempts record the old miscount: Issue 1 pre-review, and a TODO proposal counted as a finding', () => {
  expect(captured.attempts.map(a => a.observed.reviewCount)).toEqual([4, 5]);
  expect(captured.attempts[0]!.observed.preReview.find(row => row.header === 'Issue 1')!.preReview).toBe(true);
  expect(captured.attempts[1]!.observed.preReview.find(row => row.header === 'Primary CTA')!.preReview).toBe(true);
  expect(captured.attempts[1]!.observed.preReview.find(row => row.header === 'Font TODO')!.preReview).toBe(false);
});

test('attempt 1: setup, then Issues 1-5 each count as one finding', () => {
  expect(replay(calls(0))).toEqual([
    { header: 'Routing', kind: 'setup' }, { header: 'Focus', kind: 'setup' }, { header: 'Learnings', kind: 'setup' },
    { header: 'Issue 1', kind: 'review' }, { header: 'Issue 2', kind: 'review' }, { header: 'Issue 3', kind: 'review' },
    { header: 'Issue 4', kind: 'review' }, { header: 'Issue 5', kind: 'review' },
  ]);
});

test('attempt 2: setup, Issues 1-5 count, and the TODO proposal is an extra decision, not a finding', () => {
  const rows = replay(calls(1));
  expect(rows).toEqual([
    { header: 'Routing', kind: 'setup' }, { header: 'Learnings', kind: 'setup' },
    { header: 'Primary CTA', kind: 'review' }, { header: 'Save pending', kind: 'review' }, { header: 'Type roles', kind: 'review' },
    { header: 'Spacing', kind: 'review' }, { header: 'Error color', kind: 'review' }, { header: 'Font TODO', kind: 'todo-proposal' },
  ]);
  expect(rows.filter(row => row.kind === 'review')).toHaveLength(5);
  const issues = calls(1).filter((_, i) => rows[i]!.kind === 'review').map(call => /Issue ([1-5])/.exec(call.questions[0]!.question)![1]);
  expect(issues).toEqual(['1', '2', '3', '4', '5']);
});

test('setup stays setup after review starts and a TODO proposal never starts review', () => {
  const [routing, , first] = calls(1), todo = calls(1).at(-1)!;
  expect(replay([todo, first!])).toEqual([{ header: 'Font TODO', kind: 'todo-proposal' }, { header: 'Primary CTA', kind: 'review' }]);
  expect(replay([first!, routing!])).toEqual([{ header: 'Primary CTA', kind: 'review' }, { header: 'Routing', kind: 'setup' }]);
});

test('an unanswered, failed or foreign call cannot start review', () => {
  const first = calls(1)[2]!;
  const unanswered = { ...structuredClone(first), answered: false, answers: {} };
  const failed = { ...structuredClone(first), answered: false, failed: true };
  for (const call of [unanswered, failed]) expect(isDesignCountReviewStart(nativePlanCallFingerprint(call, 0, true))).toBe(false);
  expect(isDesignCountReviewStart({ ...nativePlanCallFingerprint(structuredClone(first), 0, true), signature: 'foreign:call' })).toBe(false);
});

test('only the contracted Add to TODOS.md / Skip / Build it now menu is a TODO proposal', () => {
  const todo = calls(1).at(-1)!;
  expect(isDesignTodoProposal(nativePlanCallFingerprint(structuredClone(todo), 0, false))).toBe(true);
  for (const labels of [['6A) Add to plan as a task', '6B) Skip', '6C) Build it now'], ['6A) Add to TODOS.md', '6B) Skip'],
    ['6A) Add to TODOS.md', '6B) Build it now', '6C) Skip'], ['6A) Add to TODOS.md', '6B) Skip', '6C) Build it now', '6D) Other']]) {
    const call = structuredClone(todo), q = call.questions[0]!;
    q.options = labels.map(label => ({ label, description: 'x' }));
    call.answers = { [q.question]: labels[0]! };
    const phase = planCountQuestionPhase(nativePlanCallFingerprint(call, 0, false), true, designStep0Boundary, isDesignCountReviewStart,
      isDesignCountStructuralSetup, isDesignCompletionHandoff, isDesignArtifactGeneration, isDesignTodoProposal);
    expect(phase.administrative, labels.join(' / ')).toBeUndefined();
  }
});
