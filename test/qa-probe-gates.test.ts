import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALL_HOST_CONFIGS } from '../hosts';
import { generateQAExploratory, generateQAMethodReads, generateQAReview, generateQAReviewPreflight } from '../scripts/resolvers/qa';
import { generatePlanVerificationExec } from '../scripts/resolvers/review';
import { HOST_PATHS } from '../scripts/resolvers/types';

describe('QA probe entry and checkpoint gates', () => {
  test('each shared loop loads its selected methods before choosing or executing probes', () => {
    for (const host of ALL_HOST_CONFIGS) {
      for (const skillName of ['qa', 'qa-only']) {
        const ctx = { host: host.name, skillName, tmplPath: '', paths: HOST_PATHS[host.name] };
        const text = generateQAExploratory(ctx);
        const methods = generateQAMethodReads(ctx);
        expect(text).toContain(methods);
        expect(text.indexOf(methods)).toBeLessThan(text.indexOf('1. First demonstrate'));
        expect(text).toContain('Reuse only completed method Reads from this invocation');
        const decision = text.indexOf('Decide whether another probe is needed');
        const write = text.indexOf('**Write before probing.**');
        expect(decision).toBeGreaterThan(-1);
        expect(decision).toBeLessThan(write);
        expect(text.slice(decision, write)).toContain('do not write a checkpoint');
        expect(text.slice(decision, write)).toContain('With no safe next probe');
        expect(text.slice(decision, write)).not.toContain('If done or blocked');
        expect(text).toContain('program JSON only');
        expect(text).toContain('Do not add, rename, summarize or remove fields');
        expect(text).toContain('tool wrapper metadata belongs in the report');
      }
    }
  });

  test('parent QA makes method loading a stop gate even for plan verification', () => {
    for (const host of ALL_HOST_CONFIGS) {
      for (const skillName of ['review', 'ship']) {
        const ctx = { host: host.name, skillName, tmplPath: '', paths: HOST_PATHS[host.name] };
        const text = (skillName === 'review' ? generateQAReviewPreflight(ctx) : '') + generateQAReview(ctx);
        expect(text).toContain('> **STOP.** Read `sections/exploratory.md` in that QA installation');
        expect(text).toContain('A plan command is a probe, not an exception to this gate');
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
        }
      }
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
