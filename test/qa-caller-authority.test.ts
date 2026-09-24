import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_HOST_CONFIGS } from '../hosts';
import { RESOLVERS } from '../scripts/resolvers';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';

const root = join(import.meta.dir, '..');
const callers = ['qa', 'qa-only', 'review', 'ship'];

function context(host: string, skillName: string): TemplateContext {
  return { host, skillName, tmplPath: '', paths: HOST_PATHS[host] };
}

function render(file: string, ctx: TemplateContext): string {
  let body = readFileSync(join(root, file), 'utf8');
  for (let pass = 0; pass < 10; pass++) {
    const next = body.replace(/\{\{([A-Z_]+)(?::([^}]+))?\}\}/g, (_match, name, args) => {
      if (!RESOLVERS[name]) throw new Error(`Unknown resolver ${name}`);
      return RESOLVERS[name](ctx, args?.split(':'));
    });
    if (next === body) return body;
    body = next;
  }
  throw new Error(`Unresolved template ${file}`);
}

function assertProbeLocalBlocker(body: string): void {
  expect(body).toContain('QA setup blocker');
  expect(body).toContain('affected probes as blocked');
  expect(body).toContain('continue other safe probes');
  expect(body).toContain('required QA');
  expect(body).toContain('independent functional/static checks');
  expect(body).not.toContain('stop that workflow');
  expect(body).not.toContain('stop all checks');
}

function assertSharedBrowserAuthority(body: string): void {
  const decision = body.slice(body.indexOf('## Browser access decision'), body.indexOf('## BROWSER SETUP'));
  expect(decision).toContain('invoking workflow, not this file');
  const reportOnly = decision.slice(decision.indexOf('**Report-only'), decision.indexOf('**Standalone /qa'));
  expect(reportOnly).toContain('/qa-only, /review and /ship');
  expect(reportOnly).toContain("do not run the fallback's setup/install or cookie-import workflow");
  expect(reportOnly).toContain('Never bootstrap or invoke another skill');
  expect(reportOnly).toContain('block only the affected browser probes');
  expect(reportOnly).toContain('continue independent functional/static checks');
  expect(reportOnly).not.toContain('run `cd');
  const standalone = decision.slice(decision.indexOf('**Standalone /qa'));
  expect(standalone).toContain('explicit approval');
  expect(standalone).toContain('STOP and wait');
  expect(standalone).toContain('Only after approval');
  expect(standalone).toContain('`cd <SKILL_DIR> && ./setup`');
  expect(standalone).toContain('/setup-browser-cookies');
  expect(standalone).toContain('declined, unavailable or unsuccessful');
  expect(standalone).toContain('blocked');
  expect(decision).toContain('Unknown caller');
  expect(decision).toContain('report-only');
  expect(body).not.toContain('If `NEEDS_SETUP`: tell the user');
  expect(body).not.toContain('An authenticated page needs /setup-browser-cookies');
}

describe('QA caller authority in pure host renders', () => {
  for (const host of ALL_HOST_CONFIGS) {
    test(`${host.name}: prior learnings name QA findings without changing review callers`, () => {
      for (const skill of ['qa', 'qa-only']) {
        const body = RESOLVERS.LEARNINGS_SEARCH(context(host.name, skill));
        expect(body).toContain('When a QA finding');
        expect(body).not.toContain('When a review finding');
        expect(body).toContain('Prior learning applied');
      }
      for (const skill of ['review', 'ship']) {
        expect(RESOLVERS.LEARNINGS_SEARCH(context(host.name, skill))).toContain('When a review finding');
      }
    });

    test(`${host.name}: missing lazy sections stop affected probes, not independent checks`, () => {
      for (const skill of ['qa', 'qa-only']) {
        const ctx = context(host.name, skill);
        for (const id of ['browser-setup', 'exploratory']) {
          const sharedSetup = skill === 'qa-only' && id === 'browser-setup';
          const pointer = sharedSetup ? RESOLVERS.QA_RESOURCE(ctx, [id]) : RESOLVERS.SECTION(ctx, [id]);
          assertProbeLocalBlocker(pointer);
          expect(pointer).toContain(`\`sections/${id}.md\``);
          expect(pointer).toContain('SKILL.md directory');
          expect(pointer).toContain(sharedSetup ? 'No product-directory or cross-host substitutes' : 'never the product working directory');
          expect(pointer).not.toContain('## BROWSER SETUP');
          expect(pointer).not.toContain('aside repl');
        }
      }
    });

    test(`${host.name}: each installed caller resource uses the same blocker rule`, () => {
      for (const caller of callers) {
        const resource = RESOLVERS.QA_RESOURCE(context(host.name, caller), ['browser-setup']);
        assertProbeLocalBlocker(resource);
        if (caller === 'review' || caller === 'ship') {
          expect(resource).toContain(`../${host.name === 'claude' ? 'qa' : 'gstack-qa'}/sections/browser-setup.md`);
          expect(resource).toContain(`installed /${caller} SKILL.md`);
        } else {
          expect(resource).toContain('installed');
          expect(resource).toContain('sections/browser-setup.md');
        }
      }
    });

    test(`${host.name}: shared QA setup chooses runtime caller authority before readiness`, () => {
      const ctx = context(host.name, 'qa');
      const body = render('qa/sections/browser-setup.md.tmpl', ctx);
      assertSharedBrowserAuthority(body);
      expect(body.indexOf('## Browser access decision')).toBeLessThan(body.indexOf('## BROWSER SETUP'));
      expect(body.indexOf('## BROWSER SETUP')).toBeLessThan(body.indexOf('## Browser fallback'));
      expect(body).toContain('Functional-only');
      expect(body).toContain('do not probe Aside');
      expect(body).toContain("scope section's ownership rules apply even to LOCAL browser targets");
      expect(body).toContain('never substitute unit tests or curl for the browser step');
      expect(body).toContain('Never type passwords, one-time codes, or payment details');
      expect(body).toContain('Never read, screenshot, navigate, or close any other tab');
      expect((body.match(/cd <SKILL_DIR> && \.\/setup/g) ?? [])).toHaveLength(1);
    });

    test(`${host.name}: QA fallback delegates setup and authentication without new authority`, () => {
      for (const caller of callers) {
        const fallback = RESOLVERS.BROWSE_FALLBACK(context(host.name, caller));
        expect(fallback).toContain('Browser access decision');
        expect(fallback).not.toContain('OK to proceed?');
        expect(fallback).not.toContain('run `cd <SKILL_DIR>');
        expect(fallback).not.toContain('An authenticated page needs /setup-browser-cookies');
        expect(fallback).toContain('$B snapshot -i');
        expect(fallback).toContain('DIFF_START');
        expect(fallback).toContain('CONSOLE_ERRORS=');
      }
    });

    test(`${host.name}: browser methodology routes auth through the decision instead of importing`, () => {
      const body = render('qa/sections/qa-patterns.md.tmpl', context(host.name, 'qa'));
      const auth = body.slice(body.indexOf('### Phase 2:'), body.indexOf('### Phase 3:'));
      expect(auth).toContain('Browser access decision');
      expect(auth).not.toContain('Fallback: /setup-browser-cookies or');
      expect(auth).toContain('Never handle credentials');
      expect(body).toContain('Run only for selected browser surfaces');
      expect(body).toContain('Confirm each issue by retrying once');
    });

    test(`${host.name}: functional-only and report-only paths preserve independent checks and gates`, () => {
      const scope = RESOLVERS.QA_SCOPE(context(host.name, 'qa'));
      expect(scope).toContain('Functional-only runs must not read browser setup, methodology, verification or bootstrap');
      expect(scope).not.toContain('command -v aside');
      expect(scope).not.toContain('curl -sI');
      for (const caller of callers) {
        const ctx = context(host.name, caller);
        const body = RESOLVERS.QA_EXPLORATORY(ctx);
        assertProbeLocalBlocker(body);
        expect(body).toContain("Complete the caller's required surface reads first");
        const reads = RESOLVERS.QA_METHOD_READS(context(host.name, caller));
        expect(reads).toContain('**Functional surfaces:**');
        expect(reads).toContain('sections/system-functional.md');
        expect(reads).toContain('**Browser surfaces only:**');
        expect(reads).toContain('sections/qa-patterns.md');
        expect(body).toContain('Never bootstrap for functional/report-only QA');
        expect(body).toContain('The caller owns questions, edits, commits and continuation');
        expect(body).toContain('Setup errors, timeouts, refusal or missing observations never pass');
        if (caller !== 'qa-only') {
          expect(body).toContain('make /review incomplete');
          expect(body).toContain('user acceptance of that named risk');
          expect(body).toContain('noninteractive runs return blocked');
          expect(body).toContain('test_stub and require ASK approval');
        }
      }
      const review = RESOLVERS.QA_REVIEW(context(host.name, 'review'));
      const ship = RESOLVERS.QA_REVIEW(context(host.name, 'ship'));
      expect(review).toContain('a later ship waiver cannot complete these probes');
      expect(ship).toContain('explicit named-risk acceptance');
      expect(ship).toContain('Missing coverage never passes');
    });

    test(`${host.name}: non-QA fallback retains its existing setup and human sign-in flow`, () => {
      const fallback = RESOLVERS.BROWSE_FALLBACK(context(host.name, 'browse'));
      expect(fallback).toContain('OK to proceed?');
      expect(fallback).toContain('STOP for the answer, then run `cd <SKILL_DIR> && ./setup`');
      expect(fallback).toContain('An authenticated page needs /setup-browser-cookies');
      expect(fallback).toContain('$B handoff');
      expect(fallback).toContain('$B resume');
      expect(fallback).not.toContain('Browser access decision');
    });

    test(`${host.name}: orchestration declares required probes before execution`, () => {
      for (const caller of ['review', 'ship']) {
        const body = RESOLVERS.QA_REVIEW(context(host.name, caller));
        const exploration = body.indexOf('Read `sections/exploratory.md` in that QA installation');
        expect(exploration).toBeGreaterThan(-1);
        expect(exploration).toBeLessThan(body.indexOf('list before execution'));
        expect(body).toContain('Required smoke within the 5-minute/12-probe bound');
        expect(body).toContain('Explicit plan checks');
        expect(body).toContain('required beyond the bound');
        expect(body).toContain('Other ideas: disclose as untested coverage, not required probes');
        expect(body).toContain('Required probes stay required if blocked or unfinished');
      }
      const ship = RESOLVERS.QA_REVIEW(context(host.name, 'ship'));
      expect(ship).toContain('return them to Step 9.4');
      expect(ship).toContain('the parent asks');
    });

    test(`${host.name}: caller QA selects surfaces directly and links checkpoints in one final section`, () => {
      for (const caller of ['review', 'ship']) {
        const body = RESOLVERS.QA_REVIEW(context(host.name, caller));
        const scope = body.indexOf('{{QA_RESOURCE:scope}}');
        const exploration = body.indexOf('Read `sections/exploratory.md` in that QA installation');
        const methods = body.indexOf('**Functional surfaces:**');
        const probes = body.indexOf('list before execution');
        expect(scope).toBeGreaterThan(-1);
        expect(exploration).toBeGreaterThan(-1);
        expect(scope).toBeLessThan(exploration);
        expect(exploration).toBeLessThan(methods);
        expect(methods).toBeLessThan(probes);
        expect(body).toContain('one final QA section');
        expect(body).toContain('checkpoint files are supporting evidence');
        expect(body).toContain('Link each `exploration-NNN.json` there');
        expect(body).toContain('templates/functional-report-template.md');
        expect(body).not.toContain('not a second report');
      }
    });

    test(`${host.name}: orchestration logs reviewer attempts before parent-owned edits`, () => {
      const body = RESOLVERS.ADVERSARIAL_STEP(context(host.name, 'review'));
      expect(body).toContain("queued for the parent's Fix-First handling at Step 5; do not edit during Step 4.8");
      expect(body).toContain('do not start an inner repair loop');
      expect(body).toContain('Track tokens by source/phase/attempt, never in REVIEW_START');
      expect(body).toContain('log each source/phase/attempt separately, before the');
      expect(body).toContain('parent applies queued fixes');
      expect(body).toContain('Each token is consumed once');
      expect(body).not.toContain('address the findings. Re-run the same shared structured invocation');
      expect(body).toContain('The native pass is required for Step 5.8 completion');
    });

    test(`${host.name}: orchestration skips only history matching without user skips`, () => {
      for (const caller of ['review', 'ship']) {
        const body = RESOLVERS.CROSS_REVIEW_DEDUP(context(host.name, caller));
        expect(body).toContain('skip history matching silently; still classify current findings');
        expect(body.indexOf('If no prior reviews exist')).toBeLessThan(body.indexOf('For each JSONL entry'));
        expect(body).toContain('If N > 0, print once:');
        expect(body).toContain('Otherwise skip the summary');
        expect(body).toContain('Only suppress `skipped` findings — never `fixed` or `auto-fixed`');
        expect(body).not.toContain('skip this step silently');
      }
    });

    test(`${host.name}: orchestration consumes the existing generation allowance at both coverage gates`, () => {
      const body = RESOLVERS.TEST_COVERAGE_GATE_SHIP(context(host.name, 'ship'));
      expect(body).toContain("Use Step 7's remaining generation allowance");
      expect(body.match(/If A and allowance remains:/g)).toHaveLength(2);
      expect(body).toContain('At the cap, offer only B/C or stop');
      expect(body).toContain('At the cap, offer only B or stop');
      expect(body).toContain('At the cap, omit A and recommend stopping');
      expect(body).toContain('Minimum = 60%, Target = 80%');
      expect(body).not.toContain('Maximum 2 passes total');
    });
  }

  test('report-only recommendations cannot dispatch a repair skill during discovery', () => {
    const skill = readFileSync(join(root, 'qa-only/SKILL.md.tmpl'), 'utf8');
    expect(skill).toContain('Never invoke /qa or another skill from this report-only run');
    expect(skill).toContain('separate, user-authorized');
    expect(skill).toContain('No test framework detected');
    expect(skill).toContain('Never commit, stash or bootstrap');
  });

  test('standalone QA scopes its general test rule around the approved browser bootstrap', () => {
    const skill = readFileSync(join(root, 'qa/SKILL.md.tmpl'), 'utf8');
    const rule = skill.split('\n').find(line => line.startsWith('13. '));
    expect(rule).toContain('Outside an explicitly approved browser bootstrap');
    expect(rule).toContain('Only create tests through authorized codification in Phase 8a.5');
    expect(rule).toContain('Never modify CI configuration or weaken existing tests');
    const bootstrap = readFileSync(join(root, 'qa/sections/test-bootstrap.md.tmpl'), 'utf8');
    expect(bootstrap).toContain('Browser /qa only, never functional/report-only');
    expect(bootstrap).toContain('AskUserQuestion and WAIT');
    expect(bootstrap).toContain('install only the actual choice');
    expect(bootstrap).toContain('Never silently delete a valid red regression');
    expect(bootstrap).toContain('create/extend `.github/workflows/test.yml`');
  });

  test('negative controls reject workflow-wide stopping and ungated installation', () => {
    const ctx = context('claude', 'qa');
    const pointer = RESOLVERS.SECTION(ctx, ['browser-setup']);
    expect(() => assertProbeLocalBlocker(pointer + '\nstop that workflow')).toThrow();
    expect(() => assertProbeLocalBlocker(pointer.replace('continue other safe probes', 'stop all checks'))).toThrow();
    const setup = render('qa/sections/browser-setup.md.tmpl', ctx);
    expect(() => assertSharedBrowserAuthority(setup.replace('Only after approval', 'Immediately'))).toThrow();
    expect(() => assertSharedBrowserAuthority(setup.replace('Never bootstrap or invoke another skill', 'Invoke another skill'))).toThrow();
    expect(() => assertSharedBrowserAuthority(setup + '\nIf `NEEDS_SETUP`: tell the user')).toThrow();
    expect(() => assertSharedBrowserAuthority(setup + '\nAn authenticated page needs /setup-browser-cookies')).toThrow();
  });
});
