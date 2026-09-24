import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateReviewArmy } from '../scripts/resolvers/review-army';
import { generateSharedCodeReuse } from '../scripts/resolvers/review';
import { generateQAReview } from '../scripts/resolvers/qa';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';

const root = join(import.meta.dir, '..');
const skill = readFileSync(join(root, 'review/SKILL.md.tmpl'), 'utf8');
const adversarial = readFileSync(join(root, 'review/sections/adversarial.md.tmpl'), 'utf8');

test('review collects every source before its single parent fix phase', () => {
  const markers = [
    '## Step 4: Critical pass', '### TODOS cross-reference',
    '### Documentation staleness check', '{{SECTION:review-army}}',
    '{{QA_REVIEW}}', '{{SECTION:adversarial}}',
    '## Step 5: Fix-First Review', '{{CROSS_REVIEW_DEDUP}}',
    '### Step 5a:', '### Step 5b:', '### Step 5c:', '### Step 5d:',
    '## Step 5.8: Persist Eng Review result',
  ];
  const positions = markers.map(marker => skill.indexOf(marker));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(skill.match(/## Step 5: Fix-First Review/g)).toHaveLength(1);
  expect(skill.replace(/\s+/g, ' ')).toContain('Do not edit reviewed source until Step 5');
  expect(skill.replace(/\s+/g, ' ')).toContain('every dispatched reader has returned or is confirmed stopped');
});

test('review settles adversarial attempts before fixing and has one full-pass back edge', () => {
  const generated = readFileSync(join(root, 'review/sections/adversarial.md'), 'utf8');
  const decision = skill.slice(skill.indexOf('## Step 5.8: Persist Eng Review result')).replace(/\s+/g, ' ');
  expect(generated).toContain('## Step 4.8: Adversarial review');
  expect(generated).toContain("queued for the parent's Fix-First handling at Step 5; do not edit during Step 4.8");
  expect(generated.replace(/\s+/g, ' ')).toContain('before the parent applies queued fixes');
  expect(generated).toContain('Return all findings and structured-review decisions to Step 5');
  expect(decision).toContain('A pass covers Steps 3–5, including all reviewers before fixes');
  expect(decision).toContain('Below 3, repeat Steps 3–5 with a new REVIEW_START');
  expect(decision).not.toContain('Route Step');
  expect(decision).not.toContain('Steps 5.0–5d');
  expect(decision).toContain('without a clean summary or a fourth pass');
});

test('review small-diff and failed-reader paths retain QA and the required adversarial pass', () => {
  const army = generateReviewArmy({ skillName: 'review', tmplPath: 'review/SKILL.md.tmpl',
    host: 'claude', paths: HOST_PATHS.claude });
  expect(army).toContain('then continue to Step 4.8 (adversarial review), then Step 5');
  expect(army).toContain('Missing dispatched coverage remains incomplete, never completed or clean');
  expect(army).toContain('Continue independent Step 4.7 QA and Step 4.8 adversarial review');
  expect(army).not.toContain("Exploratory QA step, then continue to Step 5.");
  expect(army).not.toContain('If the Red Team subagent fails or times out, skip silently');
});

test('review defines QA confidence, severity, impact selection and numeric version comparison', () => {
  const flat = skill.replace(/\s+/g, ' ');
  expect(flat).toContain('For QA findings, the parent assigns confidence (1–10) from replay/code evidence');
  expect(flat).toContain("use the checklist's category to choose CRITICAL or INFORMATIONAL, not confidence");
  expect(flat).toContain('A probe is affected when its entrypoint, dependencies, contract or replay inputs change');
  expect(flat).toContain('If impact is uncertain, rerun it');
  expect(flat).toContain('Compare dotted version components as integers from left to right');
});

test('review emits scope check after the plan audit and before the checklist', () => {
  const markers = [
    '{{SCOPE_DRIFT}}', '{{SECTION:plan-completion}}',
    'Finish Step 1.5 here', '## Step 2: Read the checklist',
  ];
  const positions = markers.map(marker => skill.indexOf(marker));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(skill).toContain('emit one final Scope Check; do not\npublish a preliminary Scope Check');
});

test('review prepares context and deduplicates before classifying findings', () => {
  const positions = [
    '## Step 3.5: Slop scan', '## Step 3.6: Gather review context',
    '{{LEARNINGS_SEARCH}}', '{{ASIDE_RESEARCH}}', '## Step 4: Critical pass',
    '## Step 5: Fix-First Review', '{{CROSS_REVIEW_DEDUP}}',
    '**Keep decisions through fix cycles.**', '### Step 5a: Classify each finding',
  ].map(marker => skill.indexOf(marker));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(skill).toContain('findings before Step 5a classification');
});

test('review owns the complete persistence contract after the adversarial read', () => {
  const step = skill.slice(skill.indexOf('## Step 5.8: Persist Eng Review result'));
  expect(skill.indexOf('{{SECTION:adversarial}}')).toBeLessThan(skill.indexOf('## Step 5.8: Persist Eng Review result'));
  expect(adversarial).not.toContain('### Before persisting Eng Review (Step 5.8)');
  for (const contract of [
    'repeat Steps 3–5', 'at most 3 fix cycles', 'final zero-edit pass verifies',
    'per structural identity', 'advisory/defect kind',
    'original `evidence_paths`/`helper_target`', 'without removed blocks',
    'Current findings, not prior fixes', 'recurring defects and unresolved counts/completion',
    'snapshot_covered_paths',
    'raw-byte equality', 'prior-cycle, supplied or prior-record coverage',
    'REVIEW_START', 'COMPLETED', 'CONVERGED', 'CYCLES', 'Step 4.7',
    'native Step 4.8 adversarial pass', 'failed native review mean false',
    'optional outside', 'incomplete in its own record', 'named-risk',
    'zero counts', '`completed:false`', '`specialists`', '`findings`',
    'verified exploratory QA findings',
    'approved **and completed**', 'explicit Skip', 'sharedLibsFingerprint',
    '`review_binding`', 'validated captured branch',
  ]) expect(step.toLowerCase().replace(/\s+/g, ' ')).toContain(contract.toLowerCase());
  expect(step.indexOf('### 1. Re-review after edits'))
    .toBeLessThan(step.indexOf('### 2. Fill the record'));
  expect(step.indexOf('### 2. Fill the record'))
    .toBeLessThan(step.indexOf('~/.claude/skills/gstack/bin/gstack-review-log'));
  expect(step).toContain('`quality_score` is Step 4.6\'s specialist score');
  expect(step).toContain('unresolved non-advisory core defects still count');
  expect(step.indexOf('Pre-Landing Review: N issues (X critical, Y informational)'))
    .toBeGreaterThan(step.indexOf('~/.claude/skills/gstack/bin/gstack-review-log'));
  expect(step).toContain('`## Exploratory QA and Verification Results`');
});

test('review distinguishes required native coverage from optional outside coverage', () => {
  const section = readFileSync(join(root, 'review/sections/adversarial.md'), 'utf8');
  expect(section).toContain('Only this optional outside adversarial pass is non-blocking');
  expect(section).not.toContain('All errors are non-blocking');
  expect(section).toContain('The native pass is required for Step 5.8 completion');
  expect(skill).toContain('Core findings use the confidence gates below');
  expect(skill).toContain('Step 4.6 applies its separate specialist gates');
});

test('review identifies probe selection, report assets and the detected diff base', () => {
  const generated = generateQAReview({ skillName: 'review', tmplPath: 'review/SKILL.md.tmpl',
    host: 'claude', paths: HOST_PATHS.claude });
  const checklist = readFileSync(join(root, 'review/checklist.md'), 'utf8');
  expect(generated).toContain('Required smoke within the 5-minute/12-probe bound, even on small diffs without a plan/server');
  expect(generated).toContain('pair success with the riskiest changed contract edge/failure');
  expect(generated).toContain('`CRITICAL`/`INFORMATIONAL` severity');
  expect(generated).toContain("Read QA's `templates/functional-report-template.md` for this one final QA section");
  expect(generated).toContain('Its checkpoint files are supporting evidence');
  expect(checklist).toContain('merge-base diff from the caller');
  expect(checklist).not.toContain('git diff origin/main');
});

test('review finalization ownership: initialize invocation state and capture the core token before reading', () => {
  const start = skill.slice(skill.indexOf('## Step 3: Get the diff'), skill.indexOf('## Step 3.4:'));
  expect(start).toContain('one invocation action list and CYCLES=0');
  expect(start).toContain('Keep both through re-reviews');
  expect(skill.match(/CYCLES=0/g)).toHaveLength(1);
  expect(start).toContain('gstack-review-log --start review\ngit diff "$DIFF_BASE"');
  expect(start).toContain('REVIEW_START for this core pass');
  expect(start).toContain('before reading the diff, never at log time');
  expect(start).toContain('earlier core captures remain unused');
  expect(start).toContain('Step 5.8 finishes only the final core token');
});

test('review finalization ownership: late findings use Fix-First before the bounded parent transition', () => {
  const flat = skill.replace(/\s+/g, ' ');
  const markers = [
    '{{SECTION:adversarial}}',
    '## Step 5: Fix-First Review',
    'Structured approval does not waive advisory/test_stub ASK gates',
    '## Step 5.8: Persist Eng Review result',
    'Edited: increment CYCLES once',
    'No edits: fill the record below',
    '### 2. Fill the record',
    '--finish REVIEW_START',
  ];
  const positions = markers.map(marker => flat.indexOf(marker));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(flat).toContain('Structured approval does not waive advisory/test_stub ASK gates');
  expect(flat).toContain('A pass covers Steps 3–5, including all reviewers before fixes');
  expect(flat).toContain('at most 3 fix cycles');
  expect(flat).toContain('Below 3, repeat Steps 3–5 with a new REVIEW_START');
  expect(flat).toContain('At 3, persist `converged:false` and remaining findings');
  const limit = flat.slice(flat.indexOf('At 3,'), flat.indexOf('No edits:'));
  expect(limit).toContain('by filling and saving the record below');
  expect(limit).toContain('Report nonconvergence and coverage gaps, then STOP this invocation');
  expect(limit).toContain('without a clean summary or a fourth pass');
});

test('review finalization ownership: affected QA reuse cannot replace a full review or erase decisions', () => {
  const step = skill.slice(skill.indexOf('## Step 5.8: Persist Eng Review result'));
  const flat = step.replace(/\s+/g, ' ');
  expect(flat).toContain('Revisit every step');
  expect(flat).toContain('Step 4.7 reruns affected probes after source, test, contract, command or fixture changes');
  expect(flat).toContain("Only this invocation's unchanged-input QA evidence is reusable");
  expect(flat).toContain('it does not replace the full review traversal');
  expect(flat).toContain('final zero-edit pass verifies retained actions');
  expect(flat).toContain('original `evidence_paths`/`helper_target`');
  expect(flat).toContain('Current findings, not prior fixes');
  expect(flat).toContain('Re-read all final-snapshot evidence before saving skipped advice');
  expect(flat).toContain('include this invocation\'s revalidated decisions');
});

test('review finalization ownership: required native completion and optional outside records stay separate', () => {
  const step = skill.slice(skill.indexOf('### 2. Fill the record'));
  const flat = step.replace(/\s+/g, ' ');
  expect(flat).toContain('native Step 4.8 adversarial pass finish');
  expect(flat).toContain('required probes or failed native review mean false');
  expect(flat).toContain('`/ship` named-risk acceptance cannot complete `/review`');
  expect(flat).toContain('Each optional outside pass keeps its own result.');
  expect(flat).toContain('An unavailable pass stays incomplete in its own record.');
  expect(flat).toContain('Native and outside coverage cannot certify each other.');
  expect(flat).toContain('structured-review gate still applies');
  expect(flat).toContain('zero counts and `completed:false`');
  expect(flat).toContain('`CONVERGED`: true only for a completed zero-edit pass');
});

test('review finalization ownership: finish only the final core token without log-time capture', () => {
  const step = skill.slice(skill.indexOf('## Step 5.8: Persist Eng Review result'));
  const flat = step.replace(/\s+/g, ' ');
  expect(step.match(/--finish REVIEW_START/g)).toHaveLength(1);
  expect(step).not.toContain('--start review');
  expect(step).not.toContain('--finish PASS_START');
  expect(flat).toContain('Never invent a binding or replace REVIEW_START at log time');
  expect(flat).toContain('finish only the final core token');
  expect(step).toContain('"completed":COMPLETED,"converged":CONVERGED,"cycles":CYCLES');
});

test('review finalization ownership: the plan audit retains its high-impact gate before the final scope check', () => {
  const plan = readFileSync(join(root, 'review/sections/plan-completion.md.tmpl'), 'utf8');
  expect(plan).toContain('INFORMATIONAL except for the HIGH-impact discrepancy question below');
  expect(plan).toContain('resolve that gate before the final Scope Check');
  expect(plan).not.toContain('never blocks the review');
  expect(plan).toContain('{{PLAN_COMPLETION_AUDIT_REVIEW}}');
  expect(skill).toContain('honor its HIGH-impact discrepancy question before continuing');
});

for (const skillName of ['review', 'ship']) {
  const ctx: TemplateContext = { skillName, tmplPath: `${skillName}/SKILL.md.tmpl`,
    host: 'claude', paths: HOST_PATHS.claude };
  const army = generateReviewArmy(ctx);
  const flat = army.replace(/\s+/g, ' ');

  test(`${skillName} clarity: terminal failure permits independent work but never certifies coverage`, () => {
    expect(flat).toContain('Confirm that each task has finished or is stopped');
    expect(flat).toContain('A timeout alone does not prove termination');
    expect(flat).toContain("If a reader or writer is still active, wait; if its state is unknown, inspect its task/process status");
    expect(flat).toContain("If you cannot confirm it stopped, use the parent's Fix-First stop path without edits");
    expect(flat).toContain('Continue independent evidence collection after a terminal failure');
    expect(flat).toContain('Missing dispatched coverage remains incomplete, never completed or clean');
    expect(flat).not.toContain('Specialists are additive — partial results are better than no results');
    const redTeam = flat.slice(flat.indexOf('### Red Team dispatch'));
    expect(redTeam).toContain('confirm it stopped and record its review as incomplete, just as for other specialists');
    expect(redTeam).toContain('original specialist outputs and rerun stages 1–7');
  });

  test(`${skillName} clarity: ordered specialist merge separates validation from scoring and provenance`, () => {
    const markers = ['#### 1. Parse outputs', '#### 2. Validate severity',
      '#### 3. Identify and merge', '#### 4. Apply specialist confidence gates',
      '#### 5. Score and present specialists', '#### 6. Save specialist activity',
      '#### 7. Hand off to Fix-First'];
    const positions = markers.map(marker => army.indexOf(marker));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const validation = flat.slice(flat.indexOf('#### 2.'), flat.indexOf('#### 3.'));
    expect(validation).toContain('core and specialist findings');
    expect(validation).toContain('remove `advisory` and retain its `CRITICAL` severity');
    expect(validation).toContain('Never downgrade severity');
    expect(validation).toContain('Valid INFORMATIONAL advisories remain advisory');
    const merge = flat.slice(flat.indexOf('#### 3.'), flat.indexOf('#### 4.'));
    expect(merge.indexOf('Partition defects and advisories')).toBeLessThan(merge.indexOf('grouping by fingerprint'));
    for (const gate of ['sharedLibsFingerprint', 'literal JSON on stdin', 'never trust a supplied hash',
      'Missing/malformed metadata cannot deduplicate', 'highest confidence', '+1 (cap at 10)',
      'distinct specialists', 'all source names', 'Core findings never earn a specialist confidence boost']) {
      expect(merge).toContain(gate);
    }
    for (const gate of ['Confidence 7+', 'Confidence 5-6', 'Confidence 3-4', 'Confidence 1-2']) expect(army).toContain(gate);
    const scoring = flat.slice(flat.indexOf('#### 5.'), flat.indexOf('#### 6.'));
    expect(scoring).toContain('Only specialist findings enter this header and `quality_score`; core findings do not');
    expect(scoring).toContain('NON-advisory');
    expect(scoring).toContain('quality_score = max(0, 10 - (critical_count * 2 + informational_count * 0.5))');
    expect(scoring).toContain('unresolved-defect totals');
    expect(flat).toContain('Advisory findings COUNT in the stats `findings` field');
    expect(flat).toContain('Count only findings that specialist actually returned');
    expect(flat).toContain('core-only advice must not create a specialist dispatch or finding');
    expect(flat).toContain('ASK-only');
  });

  test(`${skillName} clarity: shared-code reuse gives executable decisions and retains checker safeguards`, () => {
    const reuse = generateSharedCodeReuse(ctx).replace(/\s+/g, ' ');
    const markers = ['1. **Read the evidence.**', '2. **Run the checker.**',
      '3. **Act on its result.**', '4. **Persist through the logger.**'];
    const positions = markers.map(marker => reuse.indexOf(marker));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    for (const gate of ['first-party authored provenance', 'all supporting callers and the helper destination',
      '--check-shared-libs REVIEW_START', "<<'GSTACK_SHARED_LIBS_REUSE_JSON'", 'literal JSON on stdin',
      '`reusable: true`', 'False, command failure or unreadable output', 'never suppression',
      'Do not supply your own snapshot, prior record or coverage', 'sharedLibsFingerprint',
      'without consuming/replacing it', 'actual repo, raw branch and current snapshot',
      'completed/converged', 'verified binding', 'explicit Skip', 'logger-versioned `snapshot_covered_paths`',
      'older unversioned coverage', 'Sanitized branch names are not identity', 'canReuseSharedLibsAdvisory',
      'byte-for-byte with its blob', 'assume-unchanged, skip-worktree', 'sparse index', 'symlinks/ancestors',
      'submodules', 'ignored/outside or unreadable', 'active/unknown Git filters', 'encodings and line conversion',
      'fsmonitor and optional locks', 'never uses external diff/textconv', 'Unknown evidence fails closed',
      'logger recomputes final coverage', 'Real defects retain normal Fix-First handling independently']) {
      expect(reuse).toContain(gate);
    }
  });
}

test('review clarity: settlement gates edits separately from incomplete required coverage', () => {
  const fix = skill.slice(skill.indexOf('## Step 5: Fix-First Review'), skill.indexOf('{{CROSS_REVIEW_DEDUP}}')).replace(/\s+/g, ' ');
  expect(fix).toContain('every dispatched reader has returned or is confirmed stopped');
  expect(fix).toContain('active or unknown reader/writer');
  expect(fix).toContain('persist incomplete at Step 5.8 and STOP without edits');
  expect(fix).toContain('Terminal failure does not block fixes from independent evidence');
  expect(fix).toContain('Missing required output still makes the pass incomplete');
});

test('review clarity: Greptile reply choices never substitute for Fix-First approval', () => {
  const fix = skill.slice(skill.indexOf('## Step 5: Fix-First Review'), skill.indexOf('{{CROSS_REVIEW_DEDUP}}'));
  expect(fix).toContain('VALID & ACTIONABLE Greptile findings');
  const greptile = skill.slice(skill.indexOf('### Greptile comment resolution'), skill.indexOf('## Step 5.8:'));
  const flat = greptile.replace(/\s+/g, ' ');
  expect(flat).toContain('Step 5c alone supplies A) Fix / B) Skip');
  expect(flat).not.toContain('A: Fix it now, B: Acknowledge, C: False positive');
  expect(flat).toContain('reply decisions, not code approval');
  expect(flat).toContain('B) Propose a code change');
  expect(flat).toContain('return to Steps 5c–5d with an ASK proposal');
  expect(flat).toContain('Show the exact change and any `test_stub`; wait for approval before editing');
  expect(flat).toContain('no new fix permission');
});

test('ship review clarity: parent settlement gate precedes classification and cannot waive coverage', () => {
  const ship = readFileSync(join(root, 'ship/sections/review-army.md.tmpl'), 'utf8');
  const gate = ship.slice(ship.indexOf('## Step 9.4:'), ship.indexOf('1. **Classify')).replace(/\s+/g, ' ');
  expect(gate).toContain("Before edits, inspect every dispatched reader/writer's handle");
  expect(gate).toContain('Wait for return or confirm termination');
  expect(gate).toContain('otherwise log incomplete through items 5–6 and STOP without edits');
  expect(gate).toContain('After terminal failure, independent evidence may support fixes');
  expect(gate).toContain('missing dispatched output still blocks continuation, even with a QA exception');
});
