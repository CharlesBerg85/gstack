import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALL_HOST_CONFIGS } from '../hosts';
import { generateQAExploratory, generateQAMethodReads, generateQAReview, generateQAReviewPreflight } from '../scripts/resolvers/qa';
import { generatePlanVerificationExec } from '../scripts/resolvers/review';
import { HOST_PATHS } from '../scripts/resolvers/types';

function assertPreparation(text: string) {
  expect(text).toContain('Complete these Reads in order before writing charters or probing');
  expect(text).toContain('Do not repeat a Read already completed in this invocation');
  const stages = ['1. Read `sections/scope.md`', 'in full and select the surfaces',
    '2. Read the selected surface methods below in full', '**Functional surfaces:**',
    'Read `sections/system-functional.md` in full.', '**Browser surfaces only:**',
    'Read `sections/qa-patterns.md` in full.', '## 1. Charter and preflight',
    'Write a **charter**', 'Start once before baseline:', '1. First demonstrate success'];
  const positions = stages.map(stage => text.indexOf(stage));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  for (const section of ['scope', 'system-functional', 'qa-patterns']) {
    expect(text.split(`Read \`sections/${section}.md\``)).toHaveLength(2);
  }
}

function assertBoundsAndLayout(text: string) {
  for (const contract of [
    'Browser Quick: SECONDS=30', 'Browser Full/Regression: SECONDS=900',
    'Functional Full, Quick and Regression have no default total timer',
    "Set SECONDS to the mode's limit or a shorter caller duration",
    "With no mode limit, use the caller's duration or seconds remaining to its deadline",
    'Without a total time limit, do not use the guard',
    'Use documented or announced finite command timeouts instead',
    "EARLIER_UTC is the caller's absolute deadline, if set",
    'Use REPORT_DIR for clocks/checkpoints. For mixed standalone runs, create REPORT_DIR/browser and REPORT_DIR/functional instead; keep one final report at REPORT_DIR. Caller paths win.',
    'beside that surface\'s deadline file (or in its probe directory without a timer)',
  ]) expect(text).toContain(contract);
  expect(text.indexOf('Caller paths win.')).toBeLessThan(text.indexOf('Start once before baseline:'));
}

function assertPlanExecution(text: string) {
  const step = text.slice(text.indexOf('**3. Run the checks without repairing the product.**'), text.indexOf('**4. Check for changes before reporting.**')).replace(/\s+/g, ' ');
  for (const contract of [
    'First run smoke, replays and revalidation through the shared Probe loop and its guard',
    'Then run every required plan check, even if smoke expired',
    'Keep the same checkpoint sequence, but do not use the smoke guard or restart its clock',
    "Give each plan command a finite timeout capped by the caller's remaining deadline",
    'If that deadline expired, mark the check not-run',
    "Both groups retain the loop's successful baseline, acknowledged Writes and exact-replay gates",
  ]) expect(step).toContain(contract);
  expect(step.indexOf('First run smoke')).toBeLessThan(step.indexOf('Then run every required plan check'));
  expect(step.indexOf('Then run every required plan check')).toBeLessThan(step.indexOf('Keep the same checkpoint sequence'));
}

describe('QA probe entry and checkpoint gates', () => {
  test('mode bounds and checkpoint nesting are explicit before dispatch', () => {
    for (const skillName of ['qa', 'qa-only']) {
      const text = generateQAExploratory({ host: 'claude', skillName, tmplPath: '', paths: HOST_PATHS.claude });
      for (const contract of [
        'Reuse resolved REPORT_DIR',
        'charters as Markdown in the report',
        "Set SECONDS to the mode's limit or a shorter caller duration",
        'Without a total time limit, do not use the guard',
        'Browser Quick: SECONDS=30',
        'Browser Full/Regression: SECONDS=900',
        'exactly four top-level fields: observationCommand, observed, hypothesis, nextCommand',
        'observed: its exact decoded child JSON (no wrapper/extra keys), or its full non-JSON text',
        'QA_DEADLINE receipts are not observations',
      ]) expect(text).toContain(contract);
      assertBoundsAndLayout(text);
      expect(text.indexOf('Browser Quick: SECONDS=30')).toBeLessThan(text.indexOf('bun G start D'));
    }
  });

  test('each shared loop loads its selected methods before choosing or executing probes', () => {
    for (const host of ALL_HOST_CONFIGS) {
      for (const skillName of ['qa', 'qa-only']) {
        const ctx = { host: host.name, skillName, tmplPath: '', paths: HOST_PATHS[host.name] };
        const text = generateQAExploratory(ctx);
        const methods = generateQAMethodReads(ctx);
        expect(text).toContain(methods);
        expect(text.indexOf(methods)).toBeLessThan(text.indexOf('1. First demonstrate success'));
        assertPreparation(text);
        const decision = text.indexOf('Decide whether another probe is needed');
        const write = text.indexOf('**Write before probing.**');
        expect(decision).toBeGreaterThan(-1);
        expect(decision).toBeLessThan(write);
        expect(text.slice(decision, write)).toContain('write the report, not a checkpoint');
        expect(text.slice(decision, write)).toContain('If expired or no safe next probe remains');
        expect(text.slice(decision, write)).not.toContain('If done or blocked');
        expect(text).toContain('Preserve every safe program-JSON key/value');
        expect(text).toContain('Preserve every safe program-JSON key/value and identity hash unchanged');
        expect(text).toContain('Put tool metadata in the report');
      }
    }
  });

  test('expiry branches precede baseline, checkpoint, probe and replay execution on every host', () => {
    for (const host of ALL_HOST_CONFIGS) for (const skillName of ['qa', 'qa-only', 'review', 'ship']) {
      const text = generateQAExploratory({ host: host.name, skillName, tmplPath: '', paths: HOST_PATHS[host.name] });
      const steps = text.slice(text.indexOf('1. First demonstrate success')).split(/\n(?=[2-5]\. )/);
      expect(steps).toHaveLength(5);
      expect(text).toContain('/gstack-qa-deadline');
      expect(text).toContain('bun G start D SECONDS [EARLIER_UTC]');
      expect(text).toContain('Every bounded probe: `bun G run D -- COMMAND ARGS`');
      expect(text).toContain('Never reset D/bypass G');
      expect(text).toContain('missing/invalid state stops probes');
      expect(steps[0]).toContain('demonstrate success: output AND durable effects');
      expect(steps[0]).toContain('Use the guard if bounded; wait for its result');
      expect(steps[1]).toContain('If bounded, run `bun G status D`');
      expect(steps[1].indexOf('If expired')).toBeLessThan(steps[1].indexOf('**Write before probing.**'));
      expect(steps[1]).toContain('STOP exploration; write the report, not a checkpoint');
      expect(steps[2]).toContain('Run that exact probe; G enforces the deadline when bounded');
      expect(steps[2]).toContain('G enforces the deadline');
      expect(steps[2]).toContain('On refusal, mark the note not-run in the report');
      expect(steps[3]).toContain('via steps 2–3');
      expect(steps[3]).toContain('then minimize via those gates');
      expect(steps[3]).toContain('Expiry leaves confirmation/minimization incomplete');
      expect(steps[4]).toContain('return to step 2 for each affected revalidation');
    }
  });

  test('parent QA makes method loading a stop gate even for plan verification', () => {
    for (const host of ALL_HOST_CONFIGS) {
      for (const skillName of ['review', 'ship']) {
        const ctx = { host: host.name, skillName, tmplPath: '', paths: HOST_PATHS[host.name] };
        const text = (skillName === 'review' ? generateQAReviewPreflight(ctx) : '') + generateQAReview(ctx);
        expect(text).toContain('> **STOP.** Load the installed exploratory section below and complete its ordered scope/method Reads');
        expect(text).toContain('{{QA_RESOURCE:exploratory}}');
        expect(text).not.toContain('{{QA_RESOURCE:scope}}');
        expect(text).not.toContain('Read `sections/system-functional.md`');
        const shared = generateQAExploratory({ ...ctx, skillName: 'qa' });
        assertPreparation(shared);
        expect(text).toContain('A plan command is a probe, not an exception to this gate');
        assertPlanExecution(text);
        const required = text.indexOf(skillName === 'review'
          ? '**2. Check readiness and list required checks.**' : '**2. List the checks');
        expect(required).toBeGreaterThan(-1);
        expect(text.indexOf('> **STOP.**')).toBeLessThan(required);
        if (skillName === 'review') {
          const isolation = text.indexOf('**1. Set the charter and isolation.**');
          const setup = text.indexOf('Read `sections/browser-setup.md` now');
          expect(isolation).toBeGreaterThan(text.indexOf('> **STOP.**'));
          expect(setup).toBeGreaterThan(required);
          expect(text.slice(isolation, required).replace(/\s+/g, ' ')).toContain('complete isolation/permission preflight');
          expect(text).toContain('Step 4 is read-only: defer charters, setup and probes to Step 4.7');
        } else {
          const setup = text.indexOf('For browser surfaces, Read `sections/browser-setup.md`');
          expect(setup).toBeGreaterThan(required);
          expect(setup).toBeLessThan(text.indexOf('**3. Run the checks'));
        }
      }
    }
  });

  test('preparation controls reject reordered scope, duplicate Reads and early charters', () => {
    const text = generateQAExploratory({ host: 'claude', skillName: 'qa', tmplPath: '', paths: HOST_PATHS.claude });
    assertPreparation(text);
    const method = 'Read `sections/system-functional.md` in full.';
    for (const changed of [
      method + '\n' + text.replace(method, ''),
      text.replace(method, method + '\n' + method),
      'Write a **charter**\n' + text,
      text.replace('Do not repeat a Read already completed in this invocation', 'Repeat all Reads'),
    ]) expect(() => assertPreparation(changed)).toThrow();
  });

  test('layout and bounds controls reject mixed caller overrides, split reports and unbounded commands', () => {
    const text = generateQAExploratory({ host: 'claude', skillName: 'qa', tmplPath: '', paths: HOST_PATHS.claude });
    assertBoundsAndLayout(text);
    for (const [before, after] of [
      ['mixed standalone runs', 'all mixed runs'],
      ['REPORT_DIR/browser and REPORT_DIR/functional', 'REPORT_DIR'],
      ['keep one final report at REPORT_DIR', 'write a final report per surface'],
      ['Caller paths win.', 'Surface paths win.'],
      ['finite command timeouts', 'unbounded command timeouts'],
      ["a shorter caller duration", 'the mode duration regardless of caller'],
    ]) expect(() => assertBoundsAndLayout(text.replace(before, after))).toThrow();
  });

  test('required plan checks cannot inherit the expired smoke guard or lose caller bounds and checkpoints', () => {
    for (const skillName of ['review', 'ship']) {
      const text = generateQAReview({ host: 'claude', skillName, tmplPath: '', paths: HOST_PATHS.claude });
      assertPlanExecution(text);
      for (const [before, after] of [
        ['Then run every required plan check, even if smoke expired', 'Skip plan checks when smoke expired'],
        ['do not use the smoke guard or restart its clock', 'restart and use the smoke guard'],
        ['Keep the same checkpoint sequence', 'Start a new checkpoint sequence'],
        ["capped by the caller's remaining deadline", 'with no caller cap'],
        ['If that deadline expired, mark the check not-run', 'If that deadline expired, mark the check passed'],
        ['acknowledged Writes and exact-replay gates', 'optional notes'],
      ]) expect(() => assertPlanExecution(text.replace(before, after))).toThrow();
      const smoke = 'First run smoke, replays and revalidation through the shared Probe loop and its guard.';
      expect(() => assertPlanExecution(text.replace(smoke, '').replace('**4. Check', smoke + '\n**4. Check'))).toThrow();
    }
  });

  test('core review collects runtime checks without executing them ahead of QA setup', () => {
    for (const [file, step] of [['review/SKILL.md.tmpl', 'Step 4.7'], ['ship/sections/review-army.md.tmpl', 'Step 9.2.1']]) {
      const text = fs.readFileSync(path.join(import.meta.dir, '..', file), 'utf8');
      const staticRule = step === 'Step 4.7' ? 'Step 4 is read-only; Step 4.7 owns setup, charters and probes' : `This pass is static; defer product probes to ${step}`;
      expect(text).toContain(staticRule);
      expect(text.indexOf(staticRule)).toBeLessThan(text.indexOf('{{QA_REVIEW}}'));
      if (step === 'Step 4.7') {
        const preflight = text.indexOf('{{QA_REVIEW_PREFLIGHT}}');
        expect(preflight).toBeGreaterThan(text.indexOf(staticRule));
        expect(preflight).toBeLessThan(text.indexOf('Apply both checklist passes in order'));
      }
    }
  });

  test('plan execution waits for the actual shared method reads, not just collection', () => {
    const text = generatePlanVerificationExec({ host: 'claude', skillName: 'ship', tmplPath: '', paths: HOST_PATHS.claude });
    expect(text).toContain('Do not invoke an entire QA skill or start probes here');
    expect(text).toContain('Before the first plan command, complete Step 9.2.1');
    expect(text).toContain('method Reads and the shared probe loop');
  });
});
