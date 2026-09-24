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
  const adversarial = ship.slice(ship.indexOf('## Step 11:'), ship.indexOf('## Step 12:'));
  expect(review).toContain('queued Steps 10–11 findings');
  expect(review).toContain('3 fix cycles for this invocation');
  expect(review.replace(/\s+/g, ' ')).toContain('Keep this counter across returns from Steps 10, 11 and 16');
  expect(adversarial).toContain('queued for the next Step 9 pass; do not edit during Step 11');
  expect(adversarial).toContain('return to Step 9 before capturing its fresh start token');
  expect(adversarial).toContain('Before Step 12: STOP if the required native pass did not complete');
  expect(adversarial).toContain('Optional outside failures retain their own incomplete records');
  expect(adversarial).toContain('Repeat Steps 9–11 on the new tree');
  expect(adversarial).toContain('Continue only after a zero-edit review cycle');
  const greptile = ship.slice(ship.indexOf('## Step 10:'), ship.indexOf('## Step 11:'));
  expect(greptile).toContain('queue the approved fix for Step 9, without editing here');
  expect(greptile).toContain('finish the saved replies without asking again about completed fixes');
});

test('late source changes repeat affected gates without resetting either allowance', () => {
  const ship = readShip();
  const gate = ship.slice(ship.indexOf('## Step 16:'), ship.indexOf('## Step 17:'));
  const text = gate.replace(/\s+/g, ' ');
  expect(text).toContain('Behavior, tests or build inputs changed');
  expect(text).toContain("Keep the invocation record's counters and approvals");
  expect(text).toContain('Step 14.5 under the existing invocation allowance');
  const workflow = ship.replace(/\s+/g, ' ');
  expect(workflow).toContain('Increment the invocation count before dispatch or inline execution');
  expect(workflow).toContain('failed launches and inline takeover each consume an attempt');
  expect(workflow).toContain('A stale snapshot is not an attempt and is not a current audit');
  expect(workflow).toContain('2 used: no third attempt, including after a late Step 16 change');
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
  for (const heading of ['Release', 'Allowances and approvals', 'Review attempts', 'Checks and docs']) {
    expect(entryTemplate).toContain(`| ${heading} |`);
  }
  expect(entry).toContain('task/process handle, original token, terminal state, output path and queued fixes');
  expect(entry).toContain("Read `BUMP_LEVEL` from this invocation note's Release row");
  expect(entry).toContain('Save the selected or recovered level there before queue selection');
});

test('ship r12 template: reuse compares recorded observations and actual inputs without resampling judges', () => {
  const gate = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('## Step 17:')));
  expect(gate).toContain('original command, result/counts, timestamp and log');
  expect(gate).toContain('saved hashes or byte comparisons');
  expect(gate).toContain('consumed files, fixtures, dependencies and execution parameters');
  expect(gate).toContain('complete expanded request, rubric, parameters and builder/runtime dependencies');
  expect(gate).toContain('Do not resample an identical passing judge');
  expect(gate).toContain('does not replace mandatory review passes or the test-tree receipt rules below');
});

test('ship r12 template: undeclared builds differ from unavailable declared prerequisites', () => {
  const gate = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('## Step 17:')));
  expect(gate).toContain('If none is declared, record build/generation as not applicable with the inspected source');
  expect(gate).toContain('A declared command with missing prerequisites is blocked, not absent');
  expect(gate).toContain('A terminal result or confirmed termination permits the next writer');
  expect(gate).toContain('Timeout or cancellation acknowledgment alone does not');
  expect(gate).toContain('| No content changed |');
  expect(gate).toContain('| Only authored docs or release metadata changed |');
  expect(gate).toContain('| Behavior, tests or build inputs changed |');
});

test('ship r12 template: docs collection separates stopped work from acceptable coverage', () => {
  const docs = compact(docsTemplate);
  expect(docs).toContain('Stopped means the task/process handle reports a terminal result or confirmed termination');
  expect(docs).toContain('An acceptable audit also needs valid output, authorized edits and current inputs');
  expect(docs).toContain('An exited child with missing output is stopped but its audit is blocked');
  expect(docs).toContain('Compare HEAD, index entries, dirty/untracked paths and actual file changes with the saved candidate');
  expect(docs).toContain('Save post-child hashes only after all checks pass');
  expect(docs).toContain('A `blocked` result also goes to recovery, even when its JSON is valid');
  expect(docsTemplate).toContain('**Subagent prompt:**');
  expect(docsTemplate).toContain('**Parent processing:**');
});

test('ship r12 template: review finalization precedes one prioritized return table', () => {
  const persist = reviewTemplate.indexOf('6. Persist the review result');
  const route = reviewTemplate.indexOf('### Choose the next step');
  expect(route).toBeGreaterThan(persist);
  const exits = reviewTemplate.slice(route);
  expect(exits.indexOf('| Missing dispatched coverage |')).toBeLessThan(exits.indexOf('| Third fixing cycle |'));
  expect(exits.indexOf('| Third fixing cycle |')).toBeLessThan(exits.indexOf('| Fixing pass below the cap |'));
  expect(exits.indexOf('| Fixing pass below the cap |')).toBeLessThan(exits.indexOf('| Zero-fix pass |'));
  expect(compact(reviewTemplate)).toContain('Complete items 5–6 exactly once with this pass\'s original REVIEW_START before taking a return route');
});

test('ship r6 template: one progress note defines surviving state and per-pass content tokens', () => {
  const entry = compact(entryTemplate);
  expect(entry).toContain('one progress note for this /ship request');
  expect(entry).toContain('Update it in place on re-entry');
  expect(entry).toContain('working-tree content snapshot (`wtree`)');
  expect(entry).toContain('tracked and non-ignored untracked content, not a commit id');
  expect(entry).toContain('Capture each `*_START` token before that pass reads its inputs');
  expect(entry).toContain('finish with that same token; never exchange tokens between passes');
  expect(entry).toContain('Approval carries over only for the same finding, files and action');
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
  expect(bump).toContain('Skip when the version is unchanged');
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
  expect(gate).toContain('Do not wait for final receipts or a fresh docs audit before the behavioral route');
  expect(gate).toContain('then recheck release metadata in Steps 12–14. Restart stage 1');
  expect(gate).toContain('Use saved hashes or byte comparisons to compare consumed files, fixtures, dependencies and execution parameters');
  expect(gate).toContain('unknown dependencies require reruns');
  expect(gate).toContain('Keep inputs frozen through verification and push');
  expect(gate).toContain('A later content edit restarts stage 1');
});

test('ship r6 template: docs attempts count at launch and exhausted late changes never open a third attempt', () => {
  const docs = compact(docsTemplate);
  expect(docs).toContain('0 used: launch the initial audit');
  expect(docs).toContain('1 used: only ONE repair/re-audit remains');
  expect(docs).toContain('2 used: no third attempt, including after a late Step 16 change');
  expect(docs).toContain('Increment the invocation count before dispatch or inline execution');
  expect(docs).toContain('failed launches and inline takeover each consume an attempt');
  expect(docs).toContain('A stale snapshot is not an attempt and is not a current audit');
  expect(docs).toContain('A settled successful child needs no stop request');
  expect(docs).toContain('A stop request alone is not settlement');
  expect(docs).toContain('Unsettled writers, ownership violations, unauthorized Git mutation and redaction/security gates cannot be waived');
  expect(docs).toContain('Only an actual user exception counts');
  expect(docs).toContain('status stays blocked');
});

test('ship r6 template: evidence exemptions inspect metadata content rather than trusting filenames', () => {
  const gate = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('## Step 17:')));
  expect(gate).toContain('Inspect changes since each lane ran before choosing `--allow-paths`');
  expect(gate).toContain('Remove any path with behavioral changes from the flag');
  expect(gate).toContain('Manifest scripts, dependencies and runtime configuration require live tests, even in `package.json`');
  expect(gate).toContain('Do not add `TODOS.md` or generated tests');
  expect(gate).toContain('Stale content cannot use the ledger-only path');
  expect(gate).toContain('only saving/reading the test receipt failed');
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
  expect(prTemplate).toContain('In a new shell, restore the saved literal title before running this block');
  expect(prTemplate).toContain(': "${NEW_TITLE:?Restore the saved Step 18 title before scanning}"');
  expect(prTemplate).not.toContain('NEW_TITLE="<final vNEW_VERSION type: summary>"');
  expect(prTemplate).toContain('Update the title with the same scanned `NEW_TITLE`');
  expect(prTemplate).toContain('HIGH blocks (exit 3, no skip)');
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
  expect(intro).toContain('Steps 9–11 are one parent-owned review phase');
  expect(intro).toContain('Initialize CYCLES to 0 only on first entry');
  expect(intro).toContain('Steps 10–11 queue findings; only Step 9.4 applies their fixes');
  expect(intro).toContain('changed scope needs a new decision');
  expect(intro).toContain('Gated/unsupported fan-out skips to 9.2.1, not past QA or Step 11');
  expect(intro).toContain('After persistence, STOP for missing dispatched reviewer output');
  expect(intro.indexOf('specialists (9.1)')).toBeLessThan(intro.indexOf('exploratory QA (9.2.1)'));
  expect(intro.indexOf('exploratory QA (9.2.1)')).toBeLessThan(intro.indexOf('fixes/persistence (9.4)'));
});

test('ship template consolidation: every fixing pass persists once before looping or stopping at cycle three', () => {
  const finalize = compact(reviewTemplate.slice(reviewTemplate.indexOf('4. **'), reviewTemplate.indexOf('5. Output summary:')));
  const exit = compact(reviewTemplate.slice(reviewTemplate.indexOf('### Choose the next step')));
  expect(finalize).toContain('Increment CYCLES once if fixes were applied');
  expect(finalize).toContain("Complete items 5–6 exactly once with this pass's original REVIEW_START before taking a return route");
  expect(reviewTemplate.indexOf('6. Persist the review result')).toBeLessThan(reviewTemplate.indexOf('### Choose the next step'));
  expect(finalize).toContain('After persistence, commit named fixed files');
  expect(finalize).toContain('any fixing pass uses `converged:false`');
  expect(exit).toContain('| Third fixing cycle | STOP and report which findings keep reappearing. The persisted pass remains `converged:false`');
  expect(exit).toContain('Keep this counter across returns from Steps 10, 11 and 16');
  expect(exit).toContain('Fixing pass below the cap');
  expect(exit).toContain("re-run the whole Step 9 cycle from a new pass's start-token capture");
  expect(exit).toContain('same explicit Step 5 waiver');
  expect(reviewTemplate).toContain('--finish REVIEW_START');
  expect(compact(reviewTemplate)).toContain('never recapture at persistence to certify unreviewed fixes');
  expect(reviewTemplate).toContain('`CONVERGED`: completed with zero fixes');
});

test('ship template consolidation: named QA risks remain failed or incomplete and cannot waive other gates', () => {
  const intro = compact(reviewTemplate.slice(0, reviewTemplate.indexOf('{{CONFIDENCE_CALIBRATION}}')));
  expect(intro).toContain('Only an actual user may accept named failed/unavailable required probes');
  expect(intro).toContain('after a zero-edit pass with completed checklist and dispatched reviewers');
  expect(intro).toContain('Retain actual probe outcomes and incomplete flags; VERIFY_RESULT stays fail');
  expect(intro).toContain('VERIFY_RESULT stays fail for plan-check exceptions');
  expect(intro).toContain('never claim a pass');
  expect(intro).toContain('cannot waive missing reviewer output, recurring fixes, or independent test/security gates');
  expect(compact(reviewTemplate)).toContain('Skipping a fix does not pass its probe');
  expect(compact(reviewTemplate)).toContain('Blocked, inconclusive or missing required coverage means false, never clean');
  expect(compact(reviewTemplate)).toContain('Record accepted untested risk separately, not as passing verification');
});

test('ship template consolidation: late behavioral inputs revisit named gates while docs still get freshness checks', () => {
  const gate = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('## Step 17:')));
  expect(gate).toContain('Revisit Step 5 test lanes, Step 6 eval selection, Step 7 coverage, Step 8 plan obligations and full Steps 9–11');
  expect(gate).toContain('then recheck release metadata in Steps 12–14');
  expect(gate).toContain('Prompts/templates are behavioral inputs, not automatically documentation');
  expect(gate).toContain('Record why changes outside those inputs cannot affect the result; changed or unknown dependencies require reruns');
  expect(gate).toContain('Only authored docs or release metadata changed');
  expect(gate).toContain('Refresh affected plan items, then continue to stage 3 without a new code review');
  expect(gate).toContain("Keep the invocation record's counters and approvals");
  expect(gate).toContain('Step 14.5 under the existing invocation allowance');
  expect(gate).toContain('An approved exception leaves `Documentation: blocked`; it never certifies current docs');
  expect(gate).toContain('commit approved files through Step 15 and restart stage 1');
  expect(gate).toContain('Inspect the recorded handles of all writers, including the docs child');
  expect(gate).toContain('If a writer cannot be confirmed stopped, STOP');
});

test('ship template consolidation: ledger recovery never waives stale content or failed verification', () => {
  const gate = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('## Step 17:')));
  expect(gate).toContain('Stale content cannot use the ledger-only path');
  expect(gate).toContain('Ledger-only failure on unchanged inputs');
  expect(gate).toContain('Independently prove unchanged final content, command and valid age');
  expect(gate).toContain('only the ledger record may need repair, not changed content');
  expect(gate).toContain('--allow-paths CHANGELOG.md,VERSION,package.json,agents-digest/gstack-AGENTS.md');
  expect(gate).toContain('Do not add `TODOS.md` or generated tests');
  expect(gate).toContain('authored docs, new tests, fixes and TODO edits make evidence STALE');
  expect(gate).toContain("A failed RUN requires Step 5's triage");
  expect(gate).toContain('New, changed or unwaived failures STOP publication');
});

test('ship has one invocation route and retains each independently bounded allowance', () => {
  const entry = compact(entryTemplate);
  expect(entry).toContain('9–11 review until no fixes remain');
  expect(entry).toContain('12–15 prepare release metadata, audit docs and commit');
  expect(entry).toContain('16 verifies final content');
  expect(entry).toContain("Step 7's 2 generation passes, Step 9's 3 fix cycles");
  expect(entry).toContain("Step 14.5's initial audit plus ONE repair/re-audit");
  expect(entry).toContain('Returning to an earlier step never resets these counts');
  const gate = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('## Step 17:')));
  expect(gate).toContain('content last examined in Steps 9–11, not the original branch diff');
  expect(gate).toContain("A commit alone doesn't change content");
  expect(gate).toContain('For EACH Step 5 test lane, use its actual label/command');
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
  expect(gate).toContain('generation/build commands from its scripts or CI configuration');
  expect(gate).toContain("repo's declared docs/link/generated-file checks");
  expect(gate).toContain('Skipping code review for docs-only changes does not preserve test evidence');
  expect(gate).toContain('authored docs and TODO edits change the verified tree');
  expect(gate).toContain('Choose exactly one result for each lane');
  expect(gate).toContain('only saving/reading the test receipt failed');
  expect(gate).toContain('Without that proof, use STALE/MISSING');
  expect(gate).toContain('authored docs, new tests, fixes and TODO edits make evidence STALE');
});

test('ship names the approval scope, probe-risk decision, and native-review recovery', () => {
  const entry = compact(entryTemplate);
  const review = compact(reviewTemplate);
  const adversarial = compact(readTemplate('ship/sections/adversarial.md.tmpl'));
  expect(entry).toContain('one progress note for this /ship request');
  expect(entry).toContain('Approval carries over only for the same finding, files and action');
  expect(entry).toContain('never exchange tokens between passes');
  expect(review).toContain('use AskUserQuestion: stop for repair (recommended), or accept each named probe');
  expect(review).toContain('A skipped fix is not an answer to this separate question');
  expect(adversarial).toContain('Restore its prerequisites before resuming Step 11 within the remaining allowances');
  expect(adversarial).toContain('Outside-provider output never replaces that pass');
  expect(entry).toContain('version in its message and co-author trailer (not a Git tag)');
  expect(entry).toContain('encode null/undetermined as -1');
});

test('ship template consolidation: remote integration retains all allowances and cannot bypass publication guards', () => {
  const push = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 17:'), entryTemplate.indexOf('## Step 18:')));
  expect(push).toContain('return to Step 5 through Step 16 before retrying');
  expect(push).toContain('retain all generation/review/docs counters and same-scope approvals');
  expect(push).toContain('Resolve ambiguous conflicts with the user; never force-push');
  expect(push).toContain('recheck Step 16 before retrying, even with unchanged content');
  expect(push).toContain('Never bypass a failed guard');
  expect(push).toContain('Only a successful push or verified `ALREADY_PUSHED` proceeds');
  expect(push).toContain('No documentation writer runs after push');
});

test('missing dispatched coverage is persisted and stopped before any zero-fix completion', () => {
  const review = compact(reviewTemplate);
  const branches = review.slice(review.indexOf('### Choose the next step'));
  expect(branches.indexOf('failed/missing specialist or Red Team')).toBeGreaterThanOrEqual(0);
  expect(branches.indexOf('Fixing pass below the cap')).toBeGreaterThan(branches.indexOf('STOP before Step 10'));
  expect(branches.indexOf('Zero-fix pass')).toBeGreaterThan(branches.indexOf('STOP before Step 10'));
  expect(review).toContain('Missing dispatched output uses `status:"unavailable"`, `completed:false` and `converged:false`');
  expect(review).toContain('Pre-Landing Review: INCOMPLETE');
  expect(branches).toContain('retaining applied fixes');
  expect(branches).toContain('rerun Step 5 and affected Steps 6–8 if code changed');
  expect(branches).toContain('new Step 9 pass');
  expect(branches).toContain('Gated/host-unsupported reviewers were not dispatched and do not trigger this stop');
  expect(review).toContain('After persistence, STOP for missing dispatched reviewer output');
  expect(review).toContain('Step 10 only with completed, converged coverage or the named QA exception');
  expect(review).toContain('This exception cannot waive missing reviewer output');
  expect(review).toContain('`STATUS`: `unavailable` for missing dispatched reviewer output');
  const settlement = review.slice(review.indexOf('## Step 9.4:'), review.indexOf('1. **Classify'));
  expect(settlement).toContain('every dispatched reader has returned or is confirmed stopped');
  expect(settlement).toContain('persist incomplete via items 5–6 and STOP without edits');
  expect(settlement).toContain('Terminal failure permits fixes from independent evidence');
});

test('external-comment fixes refresh tests and mandatory review without repeating prior decisions', () => {
  const section = compact(readTemplate('ship/sections/greptile.md.tmpl'));
  const finish = section.slice(section.indexOf('**After triage:**'));
  expect(section).toContain('queue the approved fix for Step 9, without editing here');
  expect(finish).toContain('return to Step 9 with their approvals and comment references');
  expect(finish).toContain('owns the edits and commits');
  expect(finish.indexOf('rerun Step 5')).toBeGreaterThan(-1);
  expect(finish.indexOf('affected Steps 6–8')).toBeGreaterThan(finish.indexOf('rerun Step 5'));
  expect(finish.indexOf('then the full Step 9')).toBeGreaterThan(finish.indexOf('affected Steps 6–8'));
  expect(finish.indexOf('before continuing to Step 11')).toBeGreaterThan(finish.indexOf('then the full Step 9'));
  expect(finish).toContain('finish the saved replies without asking again about completed fixes');
  expect(finish).toContain('With no queued fixes, continue to Step 11');
});

test.each(ALL_HOST_CONFIGS.map(({ name }) => name))('%s: late adversarial fixes have a bounded return path and preserve approvals', host => {
  const ctx = { host, skillName: 'ship', tmplPath: '', paths: HOST_PATHS[host] };
  const text = generateAdversarialStep(ctx);
  const finish = text.slice(text.indexOf('Before Step 12:'));
  expect(text).toContain('queued for the next Step 9 pass; do not edit during Step 11');
  expect(text).toContain('If A: queue the approved findings for the next Step 9 pass instead of editing here');
  expect(finish).toContain('return to Step 9 before capturing its fresh start token');
  expect(finish).toContain('Step 9.4 owns their edits and the same CYCLES limit');
  expect(finish).toContain('Repeat Steps 9–11 on the new tree');
  expect(finish).toContain('Reuse unchanged Step 10 comment decisions, not the old review evidence');
  expect(reviewTemplate).toContain('3 fix cycles for this invocation');
  expect(reviewTemplate).toContain('| Third fixing cycle | STOP and report which findings keep reappearing. The persisted pass remains `converged:false`');
  expect(reviewTemplate).toContain('re-run the test suite (Step 5) and affected Steps 6–8');
  expect(finish).toContain('With no queued fixes and a completed native pass, proceed to Step 12');
  expect(finish).toContain('Continue only after a zero-edit review cycle with no queued fixes');
  expect(text).toContain('retain the acknowledged findings and failed gate');
  expect(text).toContain('do not report a clean review');
  expect(finish).toContain('STOP if the required native pass did not complete');
  expect(finish).toContain('Optional outside failures retain their own incomplete records');
  expect(text).toContain('Native\ncompletion never credits outside coverage');
  const standalone = generateAdversarialStep({ ...ctx, skillName: 'review' });
  expect(standalone).not.toContain('Before Step 12:');
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
  expect(distribution).toContain('Ask for the intended distribution target if it is unknown');
  expect(distribution).toContain('do not invent a registry or credentials');
  expect(distribution).toContain('include the new workflow in the tests and review below');
  expect(distribution).toContain('Do not publish a release during `/ship`');
});
