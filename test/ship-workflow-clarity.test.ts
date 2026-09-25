import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ALL_HOST_CONFIGS } from '../hosts';
import { generateAdversarialStep } from '../scripts/resolvers/review';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { readWorkflowExcerpt } from './helpers/workflow-excerpt';

const readShip = () => readWorkflowExcerpt('ship/SKILL.md', '# Ship:', '## Important Rules');

test('ship uses the PR template headings instead of a competing combined QA report', () => {
  const ship = readShip();
  expect(ship).toContain('Include `## Exploratory QA` in the PR body');
  expect(ship).toContain('Put plan-check outcomes in `## Verification Results`');
  expect(ship).toContain("Read QA's `templates/functional-report-template.md` for this one final QA section");
  expect(ship).toContain('Its checkpoint files are supporting evidence');
  expect(ship).toContain('Link each `exploration-NNN.json` there; write no second report');
  expect(ship).not.toContain('## Exploratory QA and Verification Results');
});

test('late adversarial fixes use the same bounded review cycle before release steps', () => {
  const ship = readShip();
  const review = ship.slice(ship.indexOf('## Step 9:'), ship.indexOf('## Step 10:'));
  const adversarial = compact(ship.slice(ship.indexOf('## Step 11:'), ship.indexOf('## Step 12:')));
  expect(review).toContain('queued Steps 10–11 findings');
  expect(review).toContain('3 fixing-cycle limit');
  expect(review.replace(/\s+/g, ' ')).toContain('keeping the **3 fixing-cycle limit** across returns from Steps 10, 11 and 16');
  expect(adversarial).toContain('queued for the next Step 9 pass; do not edit during Step 11');
  expect(adversarial).toContain('return to Step 9 before capturing its fresh start token');
  expect(adversarial).toContain('Required native review incomplete: STOP before Step 12');
  expect(adversarial).toContain('Optional outside failures retain their own incomplete records');
  expect(adversarial).toContain('Repeat Steps 9–11 on the new tree');
  expect(adversarial).toContain('Continue only after a zero-edit review cycle');
  const greptile = ship.slice(ship.indexOf('## Step 10:'), ship.indexOf('## Step 11:'));
  expect(greptile).toContain('queue the approved fix for Step 9, without editing here');
  expect(greptile).toMatch(/finish the saved replies without asking again about\s+completed fixes/);
});

test('late source changes repeat affected gates without resetting either allowance', () => {
  const ship = readShip();
  const gate = ship.slice(ship.indexOf('## Step 16:'), ship.indexOf('## Step 17:'));
  const text = gate.replace(/\s+/g, ' ');
  expect(text).toContain('Behavior, tests or build-input changes take the behavioral-change route above');
  expect(text).toContain("keep the invocation's counts and same-scope approvals throughout");
  expect(text).toContain('Use Step 14.5\'s remaining attempt/recovery');
  const workflow = ship.replace(/\s+/g, ' ');
  expect(workflow).toContain('Increment before each launch or inline takeover');
  expect(workflow).toContain('Increment before each launch or inline takeover, including failed launches');
  expect(workflow).toContain('A stale snapshot is neither a new attempt nor a current audit');
  expect(workflow).toContain('never a third attempt, even after Step 16 changes');
});

const readTemplate = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const compact = (text: string) => text.replace(/\s+/g, ' ');
const reviewTemplate = readTemplate('ship/sections/review-army.md.tmpl');
const coverageTemplate = readTemplate('ship/sections/test-coverage.md.tmpl');
const entryTemplate = readTemplate('ship/SKILL.md.tmpl');
const docsTemplate = readTemplate('ship/sections/documentation.md.tmpl');
const prTemplate = readTemplate('ship/sections/pr-body.md.tmpl');

test('ship r12 template: the invocation note locates release, attempts and receipts', () => {
  const entry = compact(entryTemplate);
  expect(entry).toContain('outside the product tree and retain its absolute path');
  for (const state of [
    'Record versions, `BUMP_LEVEL` and used attempts',
    'Record versions, `BUMP_LEVEL`',
    'Save each approval with its finding, files and authorized action',
    'each review\'s handle, original start token, terminal state, output and queued fixes',
    'each check\'s command/label, result/counts, timestamp, log and consumed inputs',
    'the docs candidate/id, accepted hashes or named blocked exception',
  ]) {
    expect(entry).toContain(state);
  }
  expect(entry).toContain('handle, original start token, terminal state, output and queued fixes');
  expect(entry).toContain("reuse the recorded `BUMP_LEVEL` or save the chosen level");
  expect(entry).toContain('Before queue selection, reuse the recorded `BUMP_LEVEL` or save the chosen level');
});

test('ship r12 template: reuse compares recorded observations and actual inputs without resampling judges', () => {
  const gate = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('## Step 17:')));
  expect(gate).toContain('original command, result/counts, timestamp and log');
  expect(gate).toContain('Compare hashes or complete bytes');
  expect(gate).toContain('consumed files, fixtures, dependencies and execution parameters');
  expect(gate).toContain('complete expanded request, rubric, parameters and builder/runtime dependencies');
  expect(gate).toContain('instead of resampling an identical passing judge');
  expect(gate).toContain('Mandatory reviews still run');
  expect(gate).toContain('Check each test lane\'s receipt as well');
});

test('ship r12 template: undeclared builds differ from unavailable declared prerequisites', () => {
  const gate = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('## Step 17:')));
  expect(gate).toContain('If none exists, record not applicable and the inspected sources');
  expect(gate).toContain('A missing prerequisite or failed build stops shipping');
  expect(gate).toContain('Confirm terminal completion or termination before another writer runs');
  expect(gate).toContain('Timeout or cancellation acknowledgment alone means STOP until confirmed');
  expect(gate).toContain('If nothing changed, continue to stage 3');
  expect(gate).toContain('If only authored docs or release metadata changed');
  expect(gate).toContain('Behavior, tests or build-input changes take the behavioral-change route above');
});

test('ship r12 template: docs collection separates stopped work from acceptable coverage', () => {
  const docs = compact(docsTemplate);
  expect(docs).toContain('Terminal completion or confirmed termination is sufficient');
  expect(docs).toContain('Require every field/type, exact audit id, schema, status invariant and actual spawned marker');
  expect(docs).toContain('enforcing prompt/audit-scope permissions and protected-file exclusions');
  expect(docs).toContain('Compare saved base and input hashes with current content');
  expect(docs).toContain('an exited child with missing output has stopped, but its audit is blocked');
  expect(docs).toContain('HEAD and index must be unchanged, existing dirty/untracked user content preserved, and changed paths exactly `files_updated`');
  expect(docs).toContain('Otherwise save post-child hashes, status and `documentation_section` for Step 16');
  expect(docs).toContain('A failed check or `blocked` result goes to recovery, even with valid JSON');
  expect(docsTemplate).toContain('**Subagent prompt:**');
  expect(docsTemplate).toContain('**Parent processing:**');
});

test('ship r12 template: review finalization precedes one prioritized return table', () => {
  const persist = reviewTemplate.indexOf('6. Persist the review result');
  const route = reviewTemplate.indexOf('### Choose the next step');
  expect(persist).toBeGreaterThanOrEqual(0);
  expect(route).toBeGreaterThan(persist);
  const exits = compact(reviewTemplate.slice(route));
  const missing = exits.indexOf('if dispatched output is missing, STOP before Step 10');
  const cap = exits.indexOf('After a third fixing cycle, STOP');
  const fixing = exits.indexOf('Below that cap, any fixing pass');
  const zeroFix = exits.indexOf('Only a zero-fix pass can continue to Step 10');
  for (const position of [missing, cap, fixing, zeroFix]) expect(position).toBeGreaterThanOrEqual(0);
  expect(missing).toBeLessThan(cap);
  expect(cap).toBeLessThan(fixing);
  expect(fixing).toBeLessThan(zeroFix);
  expect(compact(reviewTemplate)).toContain('Finish and log this pass before choosing the next step');
  expect(compact(reviewTemplate)).toContain('Complete items 5–6 exactly once with the original REVIEW_START');
});

test('ship r6 template: one progress note defines surviving state and per-pass content tokens', () => {
  const entry = compact(entryTemplate);
  expect(entry).toContain('one private **invocation record**');
  expect(entry).toContain('Update this record on every return');
  expect(entry).toContain('tracked and non-ignored untracked files, not just a commit');
  expect(entry).toContain('The helper\'s `wtree` fingerprint identifies a Git tree snapshot');
  expect(entry).toContain('Capture each token before reading');
  expect(entry).toContain('finish that pass with the same token; never exchange them');
  expect(entry).toContain('Reuse an approval only for the same finding, files and action');
});

test('ship r6 template: plan obligations precede learnings and scope drift even without a plan', () => {
  const route = compact(entryTemplate.slice(entryTemplate.indexOf('{{SECTION:test-coverage}}'), entryTemplate.indexOf('{{SECTION:review-army}}')));
  expect(route).toContain('Step 8 audit/gates → Step 8.1 collect verification → Prior Learnings → Step 8.2 Scope Drift → Step 9');
  expect(route).toContain('No plan skips only plan-specific work, not Prior Learnings or Scope Drift');
  expect(route.indexOf('follow this order')).toBeLessThan(route.indexOf('{{SECTION:plan-completion}}'));
});

test('ship r6 template: an approved rebump logs the written version rather than its initial state', () => {
  const bump = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 12:'), entryTemplate.indexOf('{{SECTION:changelog}}')));
  expect(bump).toContain('Record the release decision after a version was actually written');
  expect(bump).toContain('including an approved ALREADY_BUMPED rebump');
  expect(bump).toContain('Skip unchanged versions and manifest-only repairs');
  expect(bump).not.toContain('skip if ALREADY_BUMPED');
  expect(bump).toContain('Only approval changes the existing version');
  expect(bump).toContain('Best-effort, non-interactive, non-blocking');
});

test('ship r6 template: late-change routing runs prerequisites before final evidence without a circular gate', () => {
  const gate = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('## Step 17:')));
  const build = gate.indexOf('### 1. Finish writers and prepare outputs');
  const route = gate.indexOf('### 2. Choose the change route');
  const docs = gate.indexOf('### 3. Resolve documentation freshness');
  const verify = gate.indexOf('### 4. Verify the frozen candidate');
  expect(build).toBeGreaterThan(0);
  expect(route).toBeGreaterThan(build);
  expect(docs).toBeGreaterThan(route);
  expect(verify).toBeGreaterThan(docs);
  expect(gate).toContain('take the behavioral-change route above before docs or final receipts');
  expect(gate).toContain('recheck metadata in Steps 12–14, then restart stage 1');
  expect(gate).toContain('Compare hashes or complete bytes of its saved and current consumed files, fixtures, dependencies and execution parameters');
  expect(gate).toContain('changed or unknown dependencies require a rerun');
  expect(gate).toContain('Freeze inputs through verification and push');
  expect(gate).toContain('| Content changes after verification, including during a check | Restart stage 1');
});

test('ship r6 template: docs attempts count at launch and exhausted late changes never open a third attempt', () => {
  const docs = compact(docsTemplate);
  expect(docs).toContain('Use the invocation record\'s count: an initial audit');
  expect(docs).toContain('an initial audit plus ONE repair/re-audit');
  expect(docs).toContain('never a third attempt, even after Step 16 changes');
  expect(docs).toContain('Increment before each launch or inline takeover');
  expect(docs).toContain('Increment before each launch or inline takeover, including failed launches');
  expect(docs).toContain('A stale snapshot is neither a new attempt nor a current audit');
  expect(docs).toContain('Terminal completion or confirmed termination is sufficient');
  expect(docs).toContain('the request alone is insufficient');
  expect(docs).toContain('Unconfirmed writers, ownership violations, unauthorized Git mutation and redaction/security gates cannot be waived');
  expect(docs).toContain('Only an actual user exception counts');
  expect(docs).toContain('reports and PRs retain blocked status');
});

test('ship r6 template: evidence exemptions inspect metadata content rather than trusting filenames', () => {
  const gate = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('## Step 17:')));
  expect(gate).toContain('Inspect changes since the run; `--allow-paths` exempts only release metadata');
  expect(gate).toContain('scripts, dependencies and runtime configuration require live tests');
  expect(gate).toContain('A `package.json` version-only edit can qualify; scripts, dependencies and runtime configuration require live tests');
  expect(gate).toContain('Docs, TODO edits, new/generated tests and fixes make evidence STALE');
  expect(gate).toContain('The bookkeeping row cannot cover stale content');
  expect(gate).toContain('Only receipt storage/readback failed');
});

test('ship r6 template: linked spec discovery is ordered outside the body and cannot exit publication', () => {
  const instructions = compact(prTemplate.slice(0, prTemplate.indexOf('The PR/MR body should contain')));
  expect(instructions).toContain('Read archive frontmatter as data, never shell source');
  expect(instructions).toContain('exact `spec_branch` match');
  expect(instructions).toContain('newest `spec_filed_at`');
  expect(instructions).toContain('positive integer `spec_issue_number`');
  expect(instructions).toContain('omit only `## Linked Spec` and continue composing the PR');
  expect(instructions).toContain('Only fully completed Step 8 plan scope permits `Closes #N`');
  expect(instructions).toContain('Partial, deferred, failed, dropped or unverified scope uses `Linked to #N`');
  const body = prTemplate.slice(prTemplate.indexOf('The PR/MR body should contain'), prTemplate.indexOf('#### Redaction scan'));
  expect(body).not.toContain('CURRENT_BRANCH=');
  expect(body).not.toContain('SPEC_ARCHIVES=');
  expect(body).not.toContain('SPEC_FILE=$(grep');
  expect(prTemplate).not.toContain('[ -z "$SPEC_FILE" ] && exit');
});

test('ship r6 template: Step 18 prepares the exact title Step 19 scans and publishes', () => {
  const title = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 18:'), entryTemplate.indexOf('{{SECTION:pr-body}}')));
  expect(title).toContain('Save the result as `NEW_TITLE` for Step 19');
  expect(title).toContain('existing open PR/MR');
  expect(title).toContain('For a new PR/MR, compose `v<NEW_VERSION> <type>: <summary>`');
  expect(prTemplate).toContain('Use Step 18\'s `NEW_TITLE`');
  expect(prTemplate).toContain('In a new shell, restore the saved literal title before this block');
  expect(prTemplate).toContain(': "${NEW_TITLE:?Restore the saved Step 18 title before scanning}"');
  expect(prTemplate).not.toContain('NEW_TITLE="<final vNEW_VERSION type: summary>"');
  expect(prTemplate).toContain('Update the title with the same scanned `NEW_TITLE`');
  expect(compact(prTemplate)).toContain('exit 3 blocks for HIGH findings');
});

test('ship template consolidation: initial, failed and inline generation attempts share one allowance', () => {
  const allowance = compact(coverageTemplate.slice(0, coverageTemplate.indexOf('````text')));
  expect(allowance).toContain('Maximum 2 generation passes total per invocation');
  expect(allowance).toContain('Count each generation-authorized attempt before dispatch/inline execution');
  expect(allowance).toContain('including the initial audit, failures and zero-test results');
  expect(allowance).toContain('Re-entry never resets it');
  expect(allowance).toContain('Two passes already used means no further generation');
  expect(allowance).toContain('read-only reassessment uses no pass');
  expect(allowance).toContain('30-path/20-test/2-minute per-test caps');
  expect(allowance).toContain('missing permission is not approval');
  expect(coverageTemplate).toContain('run the audit inline in the parent');
});

test('ship template consolidation: audit-only authority reaches the actual coverage child prompt', () => {
  const prompt = coverageTemplate.split('````text\n')[1]?.split('\n````')[0] ?? '';
  expect(prompt).toContain('Generation: <allowed|audit-only>; passes used: <N> of 2.');
  expect(prompt).toContain('Audit-only overrides every generation instruction below.');
  expect(prompt.indexOf('Audit-only overrides')).toBeLessThan(prompt.indexOf('{{TEST_COVERAGE_AUDIT_SHIP}}'));
  expect(prompt).toContain('Do not commit or push');
  expect(prompt).toContain('return unresolved user decisions to the parent');
  expect(prompt).toContain('"coverage_pct":N,"gaps":N');
  expect(prompt).toContain('"tests_added":["path",...]');
});

test('ship template consolidation: duplicate design defects have one action without losing independent coverage', () => {
  const design = compact(reviewTemplate.slice(reviewTemplate.indexOf('{{DESIGN_REVIEW_LITE}}'), reviewTemplate.indexOf('{{REVIEW_ARMY}}')));
  expect(design).toContain('The parent owns design-lite; the Design specialist is an independent read');
  expect(design).toContain('Before final counting/Fix-First');
  expect(design).toContain('same evidenced design defect at the same path/line');
  expect(design).toContain('one item with both sources and stricter ASK');
  expect(design).toContain('Retain actual specialist stats');
  expect(design).toContain('distinct defects stay separate');
  expect(design).toContain('neither pass substitutes for the other');
  expect(reviewTemplate).toContain('{{DESIGN_REVIEW_LITE}}');
  expect(reviewTemplate).toContain('{{REVIEW_ARMY}}');
  expect(reviewTemplate).toContain('"dispatched":true,"findings":N,"critical":N,"informational":N');
});

test('ship template consolidation: the parent owns one ordered review phase', () => {
  const intro = compact(reviewTemplate.slice(0, reviewTemplate.indexOf('{{CONFIDENCE_CALIBRATION}}')));
  expect(intro).toContain('The parent owns this loop');
  expect(intro).toContain('Set CYCLES to 0 on first entry only');
  expect(intro).toContain('Run Step 9, then Step 10\'s outside comments, then Step 11\'s adversarial review');
  expect(intro).toContain('Steps 10–11 never edit product code: they return approved findings to a new Step 9 pass');
  expect(intro).toContain('reads the current content before Step 9.4 applies fixes');
  expect(intro).toContain('retain it with the approvals on every return');
  expect(intro).toContain('Changed finding scope needs a new decision');
  expect(intro).toContain('If fan-out is gated/unsupported, continue at 9.2.1, not past QA or Step 11');
  expect(intro).toContain('Step 9.4 decides whether to repeat, stop for missing dispatched output, or continue');
  for (const step of ['specialists (9.1)', 'exploratory QA (9.2.1)', 'fixes and logging (9.4)']) {
    expect(intro.indexOf(step)).toBeGreaterThanOrEqual(0);
  }
  expect(intro.indexOf('specialists (9.1)')).toBeLessThan(intro.indexOf('exploratory QA (9.2.1)'));
  expect(intro.indexOf('exploratory QA (9.2.1)')).toBeLessThan(intro.indexOf('fixes and logging (9.4)'));
});

test('ship template consolidation: every fixing pass persists once before looping or stopping at cycle three', () => {
  const finalize = compact(reviewTemplate.slice(reviewTemplate.indexOf('4. **'), reviewTemplate.indexOf('5. Output summary:')));
  const exit = compact(reviewTemplate.slice(reviewTemplate.indexOf('### Choose the next step')));
  expect(finalize).toContain('Increment CYCLES once if fixes were applied');
  expect(finalize).toContain('Finish and log this pass before choosing the next step');
  expect(finalize).toContain('Complete items 5–6 exactly once with the original REVIEW_START');
  expect(reviewTemplate.indexOf('6. Persist the review result')).toBeLessThan(reviewTemplate.indexOf('### Choose the next step'));
  expect(finalize).toContain('Then commit named fixed files');
  expect(finalize).toContain('fixes also require `converged:false`');
  expect(exit).toContain('After a third fixing cycle, STOP and report recurring findings; the logged pass remains `converged:false`');
  expect(exit).toContain('keeping the **3 fixing-cycle limit** across returns from Steps 10, 11 and 16');
  expect(exit).toContain('Below that cap, any fixing pass');
  expect(exit).toContain("then all of Step 9 from a new start-token capture");
  expect(exit).toContain('same explicit Step 5 waiver');
  expect(reviewTemplate).toContain('--finish REVIEW_START');
  expect(compact(reviewTemplate)).toContain('never recapture at persistence to certify unreviewed fixes');
  expect(reviewTemplate).toContain('`CONVERGED`: completed with zero fixes');
});

test('ship template consolidation: named QA risks remain failed or incomplete and cannot waive other gates', () => {
  const intro = compact(reviewTemplate.slice(0, reviewTemplate.indexOf('{{CONFIDENCE_CALIBRATION}}')));
  expect(intro).toContain('accept risk only on the user\'s explicit choice, never a skipped fix');
  expect(intro).toContain('If required probes fail or are unavailable, wait for a zero-edit pass with completed checklist and dispatched reviewers');
  expect(intro).toContain('Retain actual outcomes and incomplete flags; VERIFY_RESULT stays fail');
  expect(intro).toContain('VERIFY_RESULT stays fail for plan-check exceptions');
  expect(compact(reviewTemplate)).toContain('Record accepted untested risk separately, not as passing verification');
  expect(intro).toContain('cannot waive missing reviewer output, recurring fixes or independent test/security gates');
  expect(compact(reviewTemplate)).toContain('skipping a fix does not pass its probe');
  expect(compact(reviewTemplate)).toContain('Blocked, inconclusive or missing required coverage means false, never clean');
  expect(compact(reviewTemplate)).toContain('Record accepted untested risk separately, not as passing verification');
});

test('ship template consolidation: late behavioral inputs revisit named gates while docs still get freshness checks', () => {
  const gate = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('## Step 17:')));
  expect(gate).toContain('Run Steps 5–11 in order');
  expect(gate).toContain('recheck metadata in Steps 12–14');
  expect(gate).toContain('Behavior, tests or build-input changes take the behavioral-change route above before docs or final receipts; this includes prompts/templates');
  expect(gate).toContain('Explain why other changes cannot affect it; changed or unknown dependencies require a rerun');
  expect(gate).toContain('If only authored docs or release metadata changed');
  expect(gate).toContain('Otherwise continue to stage 3 without a new code review');
  expect(gate).toContain("keep the invocation's counts and same-scope approvals throughout");
  expect(gate).toContain('Use Step 14.5\'s remaining attempt/recovery');
  expect(gate).toContain('Keep `Documentation: blocked` for accepted risk');
  expect(gate).toContain('commit approved files through Step 15, then restart stage 1');
  expect(gate).toContain('Inspect writer handles, including the docs child');
  expect(gate).toContain('STOP until confirmed');
});

test('ship template consolidation: ledger recovery never waives stale content or failed verification', () => {
  const gate = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('## Step 17:')));
  expect(gate).toContain('The bookkeeping row cannot cover stale content');
  expect(gate).toContain('Only receipt storage/readback failed');
  expect(gate).toContain('Independently prove unchanged final content, the same command and valid age');
  expect(gate).toContain('Unchanged green suites need no bookkeeping-only rerun');
  expect(gate).toContain('--allow-paths CHANGELOG.md,VERSION,package.json,agents-digest/gstack-AGENTS.md');
  expect(gate).toContain('Docs, TODO edits, new/generated tests and fixes make evidence STALE');
  expect(gate).toContain('Docs, TODO edits, new/generated tests and fixes make evidence STALE');
  expect(gate).toContain("A failed test run requires Step 5's triage");
  expect(gate).toContain('New, changed or unwaived failures STOP publication');
});

test('ship has one invocation route and retains each independently bounded allowance', () => {
  const entry = compact(entryTemplate);
  expect(entry).toContain('Every invocation verifies tests, coverage, plan completion, both reviews');
  expect(entry).toContain('VERSION/CHANGELOG, TODOS and docs in Steps 1–15');
  expect(entry).toContain('Step 16 verifies final content');
  expect(entry).toContain('| Step 7 | 2 generation passes |');
  expect(entry).toContain('| Step 9 | 3 fixing cycles |');
  expect(entry).toContain('| Step 14.5 | Initial audit plus ONE repair/re-audit |');
  expect(entry).toContain('Update this record on every return without resetting these limits');
  const gate = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('## Step 17:')));
  expect(gate).toContain('against the snapshot saved before Step 12');
  expect(gate).toContain("A commit that preserves content keeps its evidence valid");
  expect(gate).toContain('Use its actual Step 5 label/command');
  expect(gate).toContain("--label <lane> --expect-cmd '<exact Step 5 command>'");
});

test('ship resolves threshold, branch and installed-asset references without competing instructions', () => {
  expect(entryTemplate).toContain("Coverage at or above Step 7's target");
  expect(entryTemplate).not.toContain('Test coverage gaps within target threshold');
  expect(entryTemplate.indexOf('Save the current branch as `<branch-name>`')).toBeGreaterThan(0);
  expect(entryTemplate.indexOf('Save the current branch as `<branch-name>`')).toBeLessThan(entryTemplate.indexOf('refs/heads/<branch-name>'));
  expect(entryTemplate).toContain('~/.claude/skills/gstack/review/TODOS-format.md');
  expect(entryTemplate).not.toContain('`.claude/skills/review/TODOS-format.md`');
  const skeleton = readTemplate('ship/SKILL.md');
  const row = skeleton.split('\n').find(line => line.startsWith('| exploratory QA before Fix-First'))!;
  expect(row).toContain('`sections/review-army.md`');
  expect(row).not.toContain('below');
});

test('ship distinguishes a changed verified tree from failed test-receipt storage', () => {
  const gate = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('## Step 17:')));
  expect(gate).toContain('declared generation/build commands in project instructions, manifests, build files and CI');
  expect(gate).toContain("Run declared docs/link/generated-file checks");
  expect(gate).toContain('Docs, TODO edits, new/generated tests and fixes make evidence STALE even without a new code review');
  expect(gate).toContain('Docs, TODO edits, new/generated tests and fixes make evidence STALE');
  expect(gate).toContain('| FRESH (exit 0) | Cite the label, exit, timestamp and log. |');
  expect(gate).toContain('Only receipt storage/readback failed');
  expect(gate).toContain('Without that proof, use STALE/MISSING');
  expect(gate).toContain('Docs, TODO edits, new/generated tests and fixes make evidence STALE');
});

test('ship names the approval scope, probe-risk decision, and native-review recovery', () => {
  const entry = compact(entryTemplate);
  const review = compact(reviewTemplate);
  const adversarial = compact(generateAdversarialStep({ host: 'claude', skillName: 'ship', tmplPath: '', paths: HOST_PATHS.claude }));
  expect(entry).toContain('one private **invocation record**');
  expect(entry).toContain('Reuse an approval only for the same finding, files and action');
  expect(entry).toContain('never exchange them');
  expect(review).toContain('ask the user to stop for repair (recommended) or accept each named probe\'s concrete risk. Use AskUserQuestion');
  expect(review).toContain('accept risk only on the user\'s explicit choice, never a skipped fix');
  expect(adversarial).toContain('confirm the task stopped. A concrete prerequisite correction permits one recovery retry in this invocation');
  expect(adversarial).toContain('record its use before launch');
  expect(adversarial).toContain('Every return keeps the original fixing-cycle and recovery-retry counts');
  expect(adversarial).toContain('after that retry fails, keep ship blocked');
  expect(adversarial).toContain('Outside-provider output cannot replace this pass');
  expect(entry).toContain('Only the final VERSION/CHANGELOG commit gets the release version and co-author trailer; omit both from non-release commits. The version is not a Git tag');
  expect(entry).toContain('encode null/undetermined as -1');
});

test('native recovery has its own bounded retry without resetting fixing or documentation limits', () => {
  const entry = compact(entryTemplate);
  const adversarial = compact(generateAdversarialStep({ host: 'claude', skillName: 'ship', tmplPath: '', paths: HOST_PATHS.claude }));
  expect(entry).toContain('| Step 11 | One corrected native-review retry |');
  expect(entry).toContain('| Step 9 | 3 fixing cycles |');
  expect(entry).toContain('| Step 14.5 | Initial audit plus ONE repair/re-audit |');
  expect(adversarial).toContain('Required native review incomplete: STOP before Step 12');
  expect(adversarial).toContain('Report the failure and needed repair, and confirm the task stopped');
  expect(adversarial).toContain('A concrete prerequisite correction permits one recovery retry');
  expect(adversarial).toContain('record its use before launch');
  expect(adversarial).toContain('Every return keeps the original fixing-cycle and recovery-retry counts');
  expect(adversarial).toContain('Without a correction, with missing access, or after that retry fails, keep ship blocked');
  expect(adversarial).toContain('These normal fresh reviews are not recovery retries');
  expect(adversarial).toContain('Step 9.4 owns the edits and the same CYCLES limit');
});

test('late verified generated outputs are committed before publication without absorbing user files', () => {
  const commit = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 15:'), entryTemplate.indexOf('## Step 16:')));
  const finish = compact(entryTemplate.slice(entryTemplate.indexOf('### 5. Report, then push'), entryTemplate.indexOf('## Step 17:')));
  const gate = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('## Step 17:')));
  expect(commit).toContain('Group VERSION + CHANGELOG + TODOS.md after the feature commits');
  expect(finish).toContain('Commit any uncommitted approved, verified release changes');
  expect(finish).toContain("Commit any uncommitted approved, verified release changes, including generated outputs, using Step 15's grouping rules");
  expect(finish).toContain('Preserve unrelated user files');
  expect(gate).toContain('A commit that preserves content keeps its evidence valid');
  expect(gate).toContain('| Content changes after verification, including during a check | Restart stage 1');
  const commitPosition = finish.indexOf('Commit any uncommitted approved');
  const pushPosition = finish.indexOf('continue to Step 17');
  expect(commitPosition).toBeGreaterThanOrEqual(0);
  expect(pushPosition).toBeGreaterThan(commitPosition);
});

test('missing test suites need a named gap decision rather than a fabricated fresh receipt', () => {
  const tests = compact(readTemplate('ship/sections/tests.md.tmpl'));
  const gate = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('## Step 17:')));
  expect(tests).toContain('If no applicable test suite exists');
  expect(tests).toContain('A) Add tests and return to Step 4 (recommended), B) Ship with this named testing gap, or C) Stop');
  expect(tests).toContain('Reuse an actual prior B answer only for the same scope and content');
  expect(tests).toContain('declining bootstrap alone is not that approval');
  expect(tests).toContain('Independent build, eval, review and QA gates still apply');
  expect(tests).toContain('A declared but unavailable suite is a blocker, not an absent suite');
  expect(gate).toContain('With no test lanes, require Step 5\'s explicit untested-scope approval for this final content');
  expect(gate).toContain("or return to its no-tests decision");
  expect(gate).toContain('Report the gap, never FRESH');
});

test('ship template consolidation: remote integration retains all allowances and cannot bypass publication guards', () => {
  const push = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 17:'), entryTemplate.indexOf('## Step 18:')));
  const recovery = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('### 1. Finish writers')));
  expect(push).toContain('Follow the matching Step 16 recovery-map row');
  expect(recovery).toContain('Resume at Step 5 and follow the normal order through Step 16, then retry Step 17 without rewriting history');
  expect(recovery).toContain("keep the invocation's counts and same-scope approvals throughout");
  expect(recovery).toContain("Fetch and inspect the remote branch; merge using Step 3's conflict rules");
  expect(push).toContain('never force-push');
  expect(recovery).toContain('Repair the cause, repeat Step 16 even if content is unchanged, then retry Step 17');
  expect(recovery).toContain('Never bypass a failed guard');
  expect(push).toContain('Only a successful push or verified `ALREADY_PUSHED` proceeds');
  expect(push).toContain('No documentation writer runs after push');
});

test('missing dispatched coverage is persisted and stopped before any zero-fix completion', () => {
  const review = compact(reviewTemplate);
  const branches = review.slice(review.indexOf('### Choose the next step'));
  expect(branches.indexOf('failed/missing specialist or Red Team')).toBeGreaterThanOrEqual(0);
  expect(branches.indexOf('STOP before Step 10')).toBeGreaterThanOrEqual(0);
  expect(branches.indexOf('Below that cap, any fixing pass')).toBeGreaterThanOrEqual(0);
  expect(branches.indexOf('Only a zero-fix pass can continue to Step 10')).toBeGreaterThanOrEqual(0);
  expect(branches.indexOf('Below that cap, any fixing pass')).toBeGreaterThan(branches.indexOf('STOP before Step 10'));
  expect(branches.indexOf('Only a zero-fix pass can continue to Step 10')).toBeGreaterThan(branches.indexOf('STOP before Step 10'));
  expect(review).toContain('Missing dispatched output uses `status:"unavailable"`, `completed:false` and `converged:false`');
  expect(review).toContain('Pre-Landing Review: INCOMPLETE');
  expect(branches).toContain('retain applied fixes');
  expect(branches).toContain('rerun Step 5 and affected Steps 6–8 if code changed');
  expect(branches).toContain('start Step 9 again within the same limit');
  expect(branches).toContain('Gated/host-unsupported reviewers were not dispatched and do not trigger this stop');
  expect(review).toContain('Step 9.4 decides whether to repeat, stop for missing dispatched output, or continue');
  expect(review).toContain('Require completed, converged coverage or the named QA exception');
  expect(review).toContain('This cannot waive missing reviewer output');
  expect(review).toContain('`STATUS`: `unavailable` for missing dispatched reviewer output');
  const settlement = review.slice(review.indexOf('## Step 9.4:'), review.indexOf('1. **Classify'));
  expect(settlement).toContain('every dispatched reader/writer\'s handle. Wait for return or confirm termination');
  expect(settlement).toContain('log incomplete through items 5–6 and STOP without edits');
  expect(settlement).toContain('After terminal failure, independent evidence may support fixes');
});

test('external-comment fixes refresh tests and mandatory review without repeating prior decisions', () => {
  const section = compact(readTemplate('ship/sections/greptile.md.tmpl'));
  const finish = section.slice(section.indexOf('**After triage:**'));
  expect(section).toContain('queue the approved fix for Step 9, without editing here');
  expect(finish).toContain('return to Step 9 with their approvals and comment references');
  expect(finish).toContain('Step 9.4 owns the edits, tests and fresh reviews');
  expect(finish).toContain('Its zero-fix pass returns here, to Step 10');
  const repair = compact(reviewTemplate.slice(reviewTemplate.indexOf('### Choose the next step')));
  expect(repair).toContain('any fixing pass reruns Step 5 and affected Steps 6–8, then all of Step 9 from a new start-token capture');
  expect(repair).toContain('Only a zero-fix pass can continue to Step 10');
  expect(finish).not.toContain('before continuing to Step 11');
  expect(finish).toContain('finish the saved replies without asking again about completed fixes');
  expect(finish).toContain('With no queued fixes, continue to Step 11');
});

test('triage distinguishes absent PRs, successful empty fetches and unavailable evidence', () => {
  const section = compact(readTemplate('ship/sections/greptile.md.tmpl'));
  expect(section).toContain('"status":"complete|no_pr|unavailable"');
  expect(section).toContain('Use `complete` only after a successful fetch, including zero comments');
  expect(section).toContain('`no_pr` only after confirming no PR exists');
  expect(section).toContain('`unavailable` for `gh`/API errors or incomplete classification');
  expect(section).toContain('a nonnegative integer total matching the comments array');
  expect(section).toContain('An unknown or missing status is unavailable, never an empty successful review');
  expect(section).toContain('"Greptile: no PR exists"');
  expect(section).toContain('"Greptile: fetched, zero comments"');
  expect(section).toContain('Include `Greptile triage: UNAVAILABLE (dispatch failed)` and the actual reason');
  expect(section).toContain('Stop a running child and confirm it stopped before continuing');
  expect(section).not.toContain('If no PR exists, `gh` fails, the API errors, or there are zero comments');
});

test('late-change routing compares a saved reviewed snapshot without waiving probe outcomes', () => {
  const receipt = compact(entryTemplate.slice(entryTemplate.indexOf('Before Step 12, run'), entryTemplate.indexOf('## Step 12:')));
  expect(receipt).toContain('~/.claude/skills/gstack/bin/gstack-review-read');
  expect(receipt).toContain("Use this invocation's saved handles, tokens and provenance to select its final records");
  expect(receipt).toContain('The Step 9.4 item 6 record has `skill:"review"` and `via:"ship"`');
  expect(receipt).toContain('The Step 11 native attempt has `skill:"adversarial-review"`');
  expect(receipt).toContain("Select the recorded native source, not an outside provider or an older invocation's result");
  expect(receipt).toContain("Require the native record's `review_binding.state` to be `verified`");
  expect(receipt).toContain("Its `wtree` must match the Step 9.4 record's `review_binding.start_wtree` and `review_binding.end_wtree`");
  expect(receipt).toContain('Missing or mismatched hashes block release preparation');
  expect(receipt).toContain('new tokens cannot certify old work');
  expect(receipt).toContain("Leave its incomplete flags unchanged and keep the user's named exception");
  expect(receipt).toContain('Matching hashes do not show that the waived probes passed');
  expect(receipt).toContain('A named probe-risk exception may leave Step 9.4 incomplete, without a root `wtree`');
  expect(receipt).not.toContain('phase:"core"');
  expect(receipt).not.toContain('Step 9.5');
  expect(receipt).not.toContain('source:"in-host"');
  expect(receipt).not.toContain('status:"clean"');
  const gate = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('## Step 17:')));
  expect(gate).toContain('~/.claude/skills/gstack/bin/gstack-wtree');
  expect(gate).toContain('git diff <reviewed-tree> <current-tree>');
  expect(gate).toContain('against the snapshot saved before Step 12');
  expect(gate).toContain('Snapshots include tracked and non-ignored untracked files');
  expect(gate).toContain('missing snapshots block this comparison, regardless of HEAD equality');
  expect(gate.indexOf('**Reuse a check when its inputs match.**')).toBeGreaterThan(gate.indexOf('### 4. Verify the frozen candidate'));
  expect(gate).toContain('**Check each test lane\'s receipt as well.**');
});

test.each(ALL_HOST_CONFIGS.map(({ name }) => name))('%s: late adversarial fixes have a bounded return path and preserve approvals', host => {
  const ctx = { host, skillName: 'ship', tmplPath: '', paths: HOST_PATHS[host] };
  const text = generateAdversarialStep(ctx);
  const finishPosition = text.indexOf('### Finish the adversarial phase');
  expect(finishPosition).toBeGreaterThanOrEqual(0);
  const finish = compact(text.slice(finishPosition));
  const outcomes = [
    'Required native review incomplete: STOP before Step 12',
    'Native review completed, with queued fixes:',
    'Native review completed, with no queued fixes:',
  ].map(outcome => finish.indexOf(outcome));
  expect(outcomes.every(position => position >= 0)).toBe(true);
  expect(outcomes).toEqual([...outcomes].sort((a, b) => a - b));
  expect(text).toContain('queued for the next Step 9 pass; do not edit during Step 11');
  expect(text).toContain('If A: queue the approved findings for the next Step 9 pass instead of editing here');
  expect(finish).toContain('return to Step 9 before capturing its fresh start token');
  expect(finish).toContain('Step 9.4 owns the edits and the same CYCLES limit');
  expect(finish).toContain('Repeat Steps 9–11 on the new tree');
  expect(finish).toContain('Keep approvals for unchanged Step 10 comments; collect new review evidence');
  expect(reviewTemplate).toContain('3 fixing-cycle limit');
  expect(compact(reviewTemplate)).toContain('After a third fixing cycle, STOP and report recurring findings; the logged pass remains `converged:false`');
  expect(compact(reviewTemplate)).toContain('any fixing pass reruns Step 5 and affected Steps 6–8');
  expect(finish).toContain('Native review completed, with no queued fixes:');
  expect(finish).toContain('Continue only after a zero-edit review cycle. Run the memory updates below, then proceed to Step 12');
  expect(text).toContain('retain the acknowledged findings and failed gate');
  expect(text).toContain('do not report a clean review');
  expect(finish).toContain('Required native review incomplete: STOP before Step 12');
  expect(finish).toContain('Optional outside failures retain their own incomplete records');
  expect(compact(text)).toContain('native completion never credits outside coverage');
  const standalone = generateAdversarialStep({ ...ctx, skillName: 'review' });
  expect(standalone).not.toContain('Before Step 12:');
  expect(standalone).not.toContain('### Finish the adversarial phase');
  expect(standalone).toContain("queue the findings and this approval for Step 5's Fix-First handling");
  expect(standalone).toContain('After edits, the full re-review repeats this same structured invocation and diff scope');
  expect(standalone).toContain('do not start an inner repair loop');
});

test('existing release levels have an explicit recovery rule, not implicit rebump approval', () => {
  const root = entryTemplate;
  const version = root.slice(root.indexOf('## Step 12:'), root.indexOf('## Step 14:'));
  expect(version).toContain('first changed major/minor/patch/micro component supplies `BUMP_LEVEL`');
  expect(version).toContain('a missing fourth component is zero');
  expect(version).toContain('This recovers the level, not permission to bump again');
  expect(version).toContain('Only approval changes the existing version');
});

test('distribution setup asks for unknown targets and cannot release before review', () => {
  const root = entryTemplate;
  const distribution = root.slice(root.indexOf('## Step 2:'), root.indexOf('## Step 3:'));
  expect(distribution).toContain('Ask for any unknown distribution target, registry or required access before creating it');
  expect(distribution).toContain('never invent credentials');
  expect(distribution).toContain('include the new workflow in the tests and review below');
  expect(distribution).toContain('Do not publish a release during `/ship`');
});

test('ship entry decisions identify Swift app products and wait on ambiguous merge resolutions', () => {
  const apple = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 0.9:'), entryTemplate.indexOf('## Step 1:')));
  expect(apple).toContain('If the ask is App Store/TestFlight distribution');
  expect(apple).toContain("Read `Package.swift` and its entrypoint");
  expect(apple).toContain('distinguish an app from a library/CLI');
  expect(apple).toContain('If unclear, use AskUserQuestion');
  expect(apple).toContain('AskUserQuestion to identify the target and wait before choosing a release path');
  expect(apple).toContain('For a confirmed app, **STOP and Read');
  const merge = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 3:'), entryTemplate.indexOf('{{SECTION:tests}}')));
  expect(merge).toContain('Try to auto-resolve if they are simple');
  expect(merge).toContain('For complex or ambiguous conflicts, **STOP**, show the conflicting choices');
  expect(merge).toContain('use AskUserQuestion for the needed resolution decision');
  expect(merge).toContain('wait for the answer before editing or continuing');
});

test('ship final preparation discovers declared commands and verifies the versioned digest output', () => {
  const gate = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('## Step 17:')));
  expect(gate).toContain('declared generation/build commands in project instructions, manifests, build files and CI');
  expect(gate).toContain('Run them and save results');
  expect(gate).toContain('If none exists, record not applicable and the inspected sources');
  expect(gate).toContain('A missing prerequisite or failed build stops shipping');
  const version = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 12:'), entryTemplate.indexOf('{{SECTION:changelog}}')));
  expect(version).toContain('only when it and committed `agents-digest/gstack-AGENTS.md` both exist');
  expect(version).toContain('if false, run `bun scripts/gen-agents-digest.ts` and stage the digest with the bump before continuing');
  expect(version).toContain("The committed digest must match the generator's output for the selected VERSION; verify that match before push");
});

test('ship publication metadata resolves open state before composing a title', () => {
  const title = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 18:'), entryTemplate.indexOf('{{SECTION:pr-body}}')));
  const query = title.indexOf('gh pr list --head <branch-name> --state open --json number,title,url');
  const prepare = title.indexOf('Prepare the title from that result');
  expect(query).toBeGreaterThanOrEqual(0);
  expect(prepare).toBeGreaterThan(query);
  expect(title).toContain('glab mr list --source-branch <branch-name> --output json` (defaults to open)');
  expect(title).toContain('A successful empty array means new');
  expect(title).toContain('one match supplies the existing title/identity');
  expect(title).toContain('Lookup failure or ambiguous matches **STOP** for resolution, never mean no PR');
  expect(title).toContain("Save the result for Step 19's recheck");
  expect(title).toContain('Save the result as `NEW_TITLE` for Step 19');
  expect(title).toContain('start with `v$NEW_VERSION `; never publish an unprefixed title');
});

test('ship explains receipts and genuine review tokens before selecting current invocation records', () => {
  const state = compact(entryTemplate.slice(entryTemplate.indexOf('### Keep state'), entryTemplate.indexOf('{{SECTION_INDEX:ship}}')));
  expect(state).toContain('receipts: these saved results link a review or check to the content it examined');
  expect(state).toContain("A review's start token identifies its captured starting content");
  expect(state).toContain('The parent owns REVIEW_START, each Step 11 attempt owns PASS_START, and design owns DESIGN_START');
  expect(state).toContain('Capture each token before reading and finish that pass with the same token; never exchange them');
  expect(state).toContain('a Git tree snapshot of tracked and non-ignored untracked files, not just a commit');
});

test('ship documentation-only plan refresh preserves the original audit and routes unsupported classifications back to its gates', () => {
  const route = compact(entryTemplate.slice(entryTemplate.indexOf('### 2. Choose the change route'), entryTemplate.indexOf('### 3. Resolve documentation freshness')));
  expect(route).toContain('preserve Step 8\'s original child report and counts');
  expect(route).toContain('Recheck affected items using their recorded verification');
  expect(route).toContain('append current references/results to the invocation record');
  expect(route).toContain("If these no longer support an item's classification, return to Step 8's audit and decision gates instead of changing its counts yourself");
  expect(route).toContain('Otherwise continue to stage 3 without a new code review');
});

test('ship recovery map preserves ordered review, build and push transitions without new allowances', () => {
  const gate = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('## Step 17:')));
  const rows = ['| Steps 10–11 queue fixes |', '| Stage 2 finds behavioral changes |',
    '| Content changes after verification, including during a check |', '| Step 17 push is non-fast-forward |',
    '| Step 17 has an authentication, hook or network failure |'].map(row => gate.indexOf(row));
  expect(rows.every(position => position >= 0)).toBe(true);
  expect(rows).toEqual([...rows].sort((a, b) => a - b));
  expect(gate).toContain('Return to a fresh Step 9 pass. Step 9.4 applies fixes, then reruns Step 5, affected Steps 6–8 and all of Step 9 before Steps 10–11');
  expect(gate).toContain('Run Steps 5–11 in order, recheck metadata in Steps 12–14, then restart stage 1');
  expect(gate).toContain('A missing prerequisite or failed build stops shipping: report the command, error and needed repair');
  expect(gate).toContain('Restore the prerequisite or repair the cause, then retry stage 1');
  expect(gate).toContain('Stage 2 reviews any content repair as a behavioral change');
  expect(gate).toContain('Never invent a substitute command');
  expect(gate).toContain('A `package.json` version-only edit can qualify; scripts, dependencies and runtime configuration require live tests');
  expect(gate).toContain('Uncertain edits cannot be exempted');
  const commits = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 15:'), entryTemplate.indexOf('## Step 16:')));
  expect(commits).toContain('Only the final VERSION/CHANGELOG commit gets the release version and co-author trailer; omit both from non-release commits');
});
