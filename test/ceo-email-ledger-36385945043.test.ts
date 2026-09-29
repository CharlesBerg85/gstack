/** Free replay of run 36385945043's two CEO email-seed throws (FAN-1, ERR-1); no model calls. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import captured from './fixtures/ceo-email-ledger-36385945043.json';
import { ceoPaymentFinding, createCeoPaymentFindingCounter } from './helpers/ceo-payment-findings';
import { ceoFirstReviewAUQ, nativePlanCallFingerprint } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

// The seed is regenerated from the paid test's unchanged source for each captured plan path.
const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-plan-ceo-finding-count.test.ts'), 'utf8');
const seedSource = source.slice(source.indexOf('const planCeo5Findings'), source.indexOf('\nconst planCeo2PairedFindings'));
const seedOf = new Function(new Bun.Transpiler({ loader: 'ts' }).transformSync(seedSource) + '\nreturn planCeo5Findings;')() as (plan: string) => string;
const [fan, err] = captured.attempts;
const LEDGER = '## Decision ledger\n\n| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |\n|---|---|---|---|---|---|\n';
// RECONSTRUCTED saved plans: ledger rows (and FAN-1's saved grid) from the rendered Edit/Write diffs.
const ledgerPlan = (row: string) => `# Payment Processing Integration (reconstructed)\n\n${LEDGER}${row}\n`;
const fp = (call: unknown) => nativePlanCallFingerprint(structuredClone(call) as NativePlanQuestionCall, 0, false);
const withQuestion = (call: NativePlanQuestionCall, change: (q: NativePlanQuestionCall['questions'][number]) => void) => {
  const copy = structuredClone(call), q = copy.questions[0]!, answer = copy.answers![q.question]!;
  change(q); copy.answers = { [q.question]: answer };
  return copy;
};
function fanPayloadPlan(row = fan!.reconstructedLedgerRow!) {
  const q = fan!.call.questions[0]!;
  return ledgerPlan(row) + ['', '## currentDecision (FAN-1)', 'Commitment comparison:', '', '```text', ...fan!.reconstructedGrid!, '```', '',
    `Question: ${q.question}`, '', `Header: ${q.header}`,
    ...q.options.flatMap((o, i) => [`${'ABC'[i]}) ${o.label}`, o.description!]), ''].join('\n');
}

test('fixture provenance names the run, shards, attempts and reconstructed parts', () => {
  expect(captured.provenance.run).toContain('36385945043');
  expect(captured.provenance.qualification).toContain('RECONSTRUCTED');
  for (const attempt of captured.attempts) {
    expect(attempt.observedError).toContain('Unsupported current CEO decision');
    expect(attempt.observedError).toEndWith(`${attempt.call.sessionId}:${attempt.call.toolUseId}`);
    expect(attempt.attemptDir).toContain('skill-e2e-plan-ceo-finding-count/pty-count/');
  }
});

test('replay: the email explanation-defect predicate is the first seed-classifier predicate to fail for both questions', () => {
  const traceFan: string[] = [], traceErr: string[] = [];
  expect(ceoPaymentFinding(fp(fan!.call), seedOf(fan!.seedPlanPath), ledgerPlan(fan!.reconstructedLedgerRow!), traceFan)).toBeNull();
  expect(traceFan).toContain('email@FAN-1: seedPlan=yes rowSubject=yes rowDefect=yes questionSubject=yes explanationDefect=no operativeOption=yes proposal=yes');
  expect(ceoPaymentFinding(fp(err!.call), seedOf(err!.seedPlanPath), ledgerPlan(err!.reconstructedLedgerRow!), traceErr)).toBeNull();
  // ERR-1's rendered row proposes nothing itself and no currentDecision (ERR-1) payload was rendered.
  expect(traceErr).toContain('email@ERR-1: seedPlan=yes rowSubject=yes rowDefect=yes questionSubject=yes explanationDefect=no operativeOption=yes proposal=no');
});

test('the fail-closed throw names the header, the question start and the matched obligation predicates', () => {
  const counter = createCeoPaymentFindingCounter(seedOf(fan!.seedPlanPath), () => ledgerPlan(fan!.reconstructedLedgerRow!), ceoFirstReviewAUQ);
  let message = '';
  try { counter.isReviewAUQ(fp(fan!.call)); } catch (error) { message = String(error); }
  expect(message).toContain(`Unsupported current CEO decision; cannot exclude it from the 4–7 count: ${fan!.call.sessionId}:${fan!.call.toolUseId}`);
  expect(message).toContain('\nheader: FAN-1 mail leg\n');
  expect(message).toContain(`\nquestion: ${fan!.call.questions[0]!.question.slice(0, 200)}\n`);
  expect(message).toContain('obligation predicates: ');
  expect(message).toContain('email@FAN-1: seedPlan=yes rowSubject=yes rowDefect=yes questionSubject=yes explanationDefect=no');
});

test('RECONSTRUCTED: with its saved currentDecision payload FAN-1 counts as a recorded decision, not a seed finding', () => {
  // The rendered diffs show this payload saved before the question. Replaying it
  // does not reproduce the throw, so the real saved plan must have differed.
  const plan = fanPayloadPlan();
  const counter = createCeoPaymentFindingCounter(seedOf(fan!.seedPlanPath), () => plan, ceoFirstReviewAUQ);
  expect(counter.isReviewAUQ(fp(fan!.call))).toBe(true);
  expect(counter.trace).toMatchObject([{ kind: 'recorded-decision', ledgerId: 'FAN-1', phase: 'currentDecision (FAN-1)' }]);
});

test('negative control: an unrelated question earns no floor credit', () => {
  const unrelated = withQuestion(fan!.call as NativePlanQuestionCall, q => {
    q.question = q.question.replace('D2 — FAN-1: What should the handler do when the inline receipt send raises after the user update?',
      'D2 — UX-1: Which brand colour should the receipt email use?');
    q.header = 'UX-1 colour';
  });
  expect(ceoPaymentFinding(fp(unrelated), seedOf(fan!.seedPlanPath), fanPayloadPlan())).toBeNull();
  const counter = createCeoPaymentFindingCounter(seedOf(fan!.seedPlanPath), () => fanPayloadPlan(), ceoFirstReviewAUQ);
  expect(() => counter.isReviewAUQ(fp(unrelated))).toThrow(/Unsupported current CEO decision[\s\S]*header: UX-1 colour/);
});

test('negative control: an email question whose ledger row says the failure is already rescued is not the seed finding', () => {
  const rescued = fan!.reconstructedLedgerRow!.replace('| Mail exception escapes handler; webhook 500; Stripe retries committed payment |',
    '| Mail failures are already rescued in the handler after commit; webhook returns 200 |');
  expect(rescued).not.toBe(fan!.reconstructedLedgerRow);
  const trace: string[] = [];
  expect(ceoPaymentFinding(fp(fan!.call), seedOf(fan!.seedPlanPath), ledgerPlan(rescued), trace)).toBeNull();
  expect(trace.find(line => line.startsWith('email@FAN-1'))).toContain('rowDefect=no');
});

test('negative control: a ledger ID whose row belongs to another seed is not the email finding', () => {
  const dispatcherRow = '| FAN-1 (owner: Section 1) | PLAN.md 106-108: new handler bypasses the dispatcher | New class bypasses `WebhookDispatcher` | A) register through WebhookDispatcher; B) keep bypass | unresolved | pending |';
  const trace: string[] = [];
  expect(ceoPaymentFinding(fp(fan!.call), seedOf(fan!.seedPlanPath), ledgerPlan(dispatcherRow), trace)).toBeNull();
  expect(trace.some(line => line.startsWith('email@FAN-1') && / rowSubject=no /.test(line) || line.startsWith('dispatcher@FAN-1') && / questionSubject=no /.test(line))).toBe(true);
  const counter = createCeoPaymentFindingCounter(seedOf(fan!.seedPlanPath), () => ledgerPlan(dispatcherRow), ceoFirstReviewAUQ);
  expect(() => counter.isReviewAUQ(fp(fan!.call))).toThrow(/Unsupported current CEO decision/);
});
