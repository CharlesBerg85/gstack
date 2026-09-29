import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CAPTURE_MS } from './eval-budgets';
import { runSkillTest, SESSION_DRAIN_GRACE_MS, type SkillTestResult } from './session-runner';
import { ROOT, runId, copyDirSync, logCost } from './e2e-helpers';
import { getProjectEvalDir, type EvalCollector } from './eval-store';
import { extractSkillBody } from './skill-fixture';
import { runRecordedOfficeHoursAttempt, OFFICE_HOURS_BUN_GRACE_MS } from './office-hours-attempt';
import { resolveEvalModel } from '../../lib/eval-model';
import { createQAFunctionalFixture, fixtureGit, ownedPath, qaFixtureActor, QA_TOOLS, type QAFamily, type QAMode } from './qa-functional-fixture';
import { observeQAWrites, type QAWriteObservation } from './qa-functional-observer';
import { qaFunctionalVerdict, verifyQANativeRegression, preserveQAArtifact } from './qa-functional-evidence';

export const QA_FUNCTIONAL_CASES = [
  { id: 'qa-functional-cli-report', family: 'cli', mode: 'qa-only' },
  { id: 'qa-functional-webhook-report', family: 'webhook', mode: 'qa-only' },
  { id: 'qa-functional-cli-fix', family: 'cli', mode: 'qa' },
  { id: 'qa-functional-webhook-fix', family: 'webhook', mode: 'qa' },
] as const;

export const QA_FUNCTIONAL_INPUTS = [
  'qa/SKILL.md.tmpl', 'qa-only/SKILL.md.tmpl',
  'qa/sections/', 'qa-only/sections/', 'qa/templates/',
  'scripts/resolvers/qa.ts', 'scripts/resolvers/utility.ts', 'scripts/resolvers/sections.ts',
  'scripts/gen-skill-docs.ts', 'test/helpers/qa-functional-fixture.ts',
  'test/helpers/qa-functional-observer.ts', 'test/helpers/qa-functional-evidence.ts',
  'test/helpers/qa-checkpoint-evidence.ts',
  'test/helpers/qa-functional-eval.ts', 'test/helpers/session-runner.ts',
  'test/helpers/hermetic-env.ts', 'test/helpers/skill-fixture.ts',
];

export function qaFunctionalPrompt(entry: { family: QAFamily; mode: QAMode }): string {
  return `Read ${entry.mode}/SKILL.md to load gstack's /${entry.mode} functional workflow for this repository with ${entry.mode === 'qa' ? 'Full exploration and the Standard fix tier' : 'Full report-only exploration'}. This is a CLI/webhook product, not a browser or DX request. The generated local skill copies are the current evaluation inputs; all their installed-root references resolve inside this fixture. The common preamble alone was removed using the repository extractor.

The fixture README and AGENTS define intended contracts, native tests and owned state. Investigate behavior without assuming implementation correctness. Establish a happy path${entry.family === 'cli' ? ' with a successful apply; balance alone is not enough' : ''}. Choose adverse probes from observations, reproduce discoveries, and obey the skill's mutation authority. Follow its written checkpoints: copy the most recent completed native probe's exact command into observationCommand and complete unchanged native JSON into observed. Tests, source edits and clock reads do not replace that observation; put red/green test output in the report, not in observed. Retain each note under qa-reports, wait for the successful Write result before the next probe, and link the notes in the final report; write no checkpoint when there is no next probe. No defect is disclosed here. On discovering a defect, replay that exact command from the same initial fixture state before repair, then minimize it; a different input or a regression test is not that replay. Test documented cancellation and unavailable dependency paths too.

${qaFixtureActor(entry.mode)}${entry.mode === 'qa' ? `

This is a fix run, not an optional report-only handoff: a reproduced in-tier defect requires the authorized native regression, repair and verification. Complete these stages in order:
1. Prove the regression red with a new native test under test/; existing tests remain read-only. Freeze all test files after red, repair only src/${entry.family === 'cli' ? 'cli' : 'worker'}.ts, and prove the unchanged regression green.
2. On the repaired source, run the original failing probe, an adjacent happy-path probe, cancellation and the unavailable-dependency probe.${entry.family === 'webhook' ? ' Complete required webhook coverage: `happy`, `reject`, `duplicate`, `partial`, `concurrent-ab`, `concurrent-ba`, `cancel`, `dependency`. Run every still-unobserved scenario and recheck earlier scenarios affected by the repair. None of these scenarios is optional exploration. All eight scenarios are required coverage; a replay does not replace another scenario.' : ''} Preserve their actual JSON and checkpoints. A green test suite does not substitute for these native probes. Expected dependency blockage stays blocked, never pass.
3. Save the evidence and Markdown artifacts, then return their paths and the actual completion status.

The completion reserve is for both required verification and artifacts, not a signal to stop stage 2: the completion reserve does not end required coverage. Stop only exploration beyond the required contracts to protect that work. If required verification remains unfinished at the hard deadline, report incomplete; do not call it complete with a caveat.` : ''}

Use one causal sentence per checkpoint hypothesis (English, more than 20 characters) and compact JSON formatting, preserving every field and value. Keep the Markdown report compact (aim under 400 words, excluding actual test output): retain its headings and required fields, but link to evidence.json and checkpoints for details already recorded there. Include the diagnosis, ${entry.mode === 'qa' ? 'red/green test results' : 'proposed test stubs'} and coverage limits; do not repeat the evidence table or add a second PR summary. After saving both artifacts, return only their paths and the actual completion status, not another copy of the report. Never shorten native JSON or omit a required probe, check or field to meet this presentation target.

Fixture execution boundary:
- No prior plans, global learnings, remote or cross-session artifact store. Branch/base are main, with a clean successful seed commit. Do not run global setup, telemetry, plan discovery, base-detection scripts or learning writes.
- Reports belong only in existing qa-reports. Retain fixture state; the owner cleans it after preserving evidence. Authorized source/test edits use Write/Edit. Read/Glob/Grep support arbitrary read-only discovery, including directory/path inventory.
- Bash accepts separate literal commands only: no shell composition, scripts or added path operands. Read-only forms are pwd, ls, ls -la, git status --short, git status --porcelain, git branch --show-current, git diff, git diff --stat, git rev-parse HEAD, bun --version, and exactly date -u +%Y-%m-%dT%H:%M:%SZ. Native tests use bun test with optional named test/*.test.ts selectors.
- These are complete command forms, not general shell examples. For inventory inside a named directory, use Read/Glob/Grep; the listed ls forms inspect only the working directory. Do not add operands or flags beyond the declared forms, even for read-only discovery.
- ${entry.family === 'cli' ? 'CLI observation forms: bun run probe -- balance; bun run probe -- export; bun run probe -- apply with zero to three literal arguments; bun cancel.ts. The equivalent bun run cli commands may be diagnostic but do not emit probe JSON. Arguments use ASCII letters/digits/._+- or quoted forms including spaces. The generic wrapper does NOT support wait: the only bounded wait/cancellation interface is bun cancel.ts.' : `Webhook observation form: bun run probe -- followed by one of happy, reject, duplicate, partial, concurrent-ab, concurrent-ba, cancel, dependency. ${entry.mode === 'qa-only' ? 'All eight scenarios are required coverage; a replay does not replace another scenario. ' : ''}Choose their order from observations after the happy path. bun cancel.ts is a CLI-only entrypoint, not part of this fixture.`}
Actions outside this interface are unsupported and fail acceptance; they are not implicitly approved.

Preserve qa-reports/evidence.json first, then write a concise qa-reports/report.md using the functional report structure. Link the evidence and checkpoint files rather than repeating full probe payloads in Markdown. Both artifacts are required before completion. The evidence.json schema is:
{ "revision": "<git HEAD>", "runtime": "bun <version>", "cwd": "<working directory>", "evidence": [{"command":"<exact executed native probe command>","contract":"README.md","expected":"<declared expected behavior>","classification":"pass|product-defect|setup-blocked|inconclusive","observed":<complete unchanged JSON emitted by the native probe>}], "learning":[{"observationCommand":"<earlier probe>","hypothesis":"<what it taught you to challenge>","nextCommand":"<later probe>"}], "limits":["<untested or blocked coverage>"] }
Evidence rows contain ONLY complete JSON actually emitted by native probes, including failures and repeats; retain pre-repair results alongside green results. Never synthesize JSON from a tool error or raw test output. Put tests, raw CLI diagnostics, launch failures and timeouts in Markdown with their actual output and limits. The learning array is a summary: choose one completed checkpoint where an observation motivated a different later command, not the required same-command replay. Copy that checkpoint's observationCommand, hypothesis and nextCommand; both commands must name exact captured probes and must differ, never a combined command list. This selects existing exploration evidence, not another probe or a duplicate of the complete checkpoint ledger. Preserve every checkpoint and link every checkpoint in Markdown; keep every executed probe and its complete JSON in evidence, including the required replay. Missing dependencies remain setup blockers, not repairs. No browser installation or execution is needed.`;
}

export async function runQAFunctionalCase(entry: { id: string; family: QAFamily; mode: QAMode }, collector: EvalCollector | null) {
  if (!process.env.EVALS_RUN_ID) throw new Error('Functional QA acceptance requires EVALS_RUN_ID from the documented detached runner');
  const deadlineAt = Date.now() + CAPTURE_MS - OFFICE_HOURS_BUN_GRACE_MS;
  const fixture = createQAFunctionalFixture(entry.family, { deadlineAt });
  const inputs: Record<string, string> = {};
  let observer: Awaited<ReturnType<typeof observeQAWrites>> | undefined;
  let observation: QAWriteObservation | undefined;
  let result: SkillTestResult | undefined;
  let report: unknown;
  let verification: unknown;
  let failure: unknown;
  let passed = false;
  const artifactRoot = path.join(process.env.GSTACK_EVAL_DIR || getProjectEvalDir(), 'qa-functional', process.env.EVALS_RUN_ID, `${entry.id}-${randomUUID()}`);
  try {
    for (const skill of ['qa', 'qa-only']) {
      copyDirSync(path.join(ROOT, skill), ownedPath(fixture.root, skill));
      fs.writeFileSync(ownedPath(fixture.root, `${skill}/SKILL.md`), extractSkillBody(path.join(ROOT, skill)));
      const rewrite = (relative: string) => {
        for (const item of fs.readdirSync(ownedPath(fixture.root, relative), { withFileTypes: true })) {
          const child = path.join(relative, item.name);
          if (item.isDirectory()) rewrite(child);
          else if (item.name.endsWith('.md')) {
            const file = ownedPath(fixture.root, child);
            const text = fs.readFileSync(file, 'utf8').replaceAll('~/.claude/skills/gstack/', fixture.root + '/');
            fs.writeFileSync(file, text);
            inputs[child] = createHash('sha256').update(text).digest('hex');
          }
        }
      };
      rewrite(skill);
    }
    for (const asset of ['qa/sections/scope.md', 'qa/sections/system-functional.md', 'qa/sections/exploratory.md', 'qa/templates/functional-report-template.md']) {
      if (!inputs[asset]) throw new Error(`Missing integrated functional instruction asset: ${asset}`);
    }
    fixtureGit(fixture.root, ['add', 'qa', 'qa-only']);
    fixtureGit(fixture.root, ['commit', '-m', 'Bind current QA instructions to fixture']);
    fixture.revision = fixtureGit(fixture.root, ['rev-parse', 'HEAD']);
    if (fixtureGit(fixture.root, ['status', '--porcelain'])) throw new Error('QA fixture must start clean');
    observer = await observeQAWrites(fixture.root);
    await runRecordedOfficeHoursAttempt({
      collector, name: entry.id, suite: 'Functional QA native E2E',
      model: process.env.EVALS_MODEL ?? resolveEvalModel('capture'),
      budgetMs: Math.max(1, deadlineAt - Date.now()),
      run: async signal => {
        const timeout = Math.max(1, deadlineAt - Date.now() - SESSION_DRAIN_GRACE_MS);
        result = await runSkillTest({
          prompt: qaFunctionalPrompt(entry),
          workingDirectory: fixture.root, maxTurns: 40, allowedTools: QA_TOOLS, tools: QA_TOOLS,
          timeout, completionReserveMs: timeout / 4,
          testName: entry.id, runId, signal, env: { CLAUDE_CONFIG_DIR: fixture.config,
            GIT_OPTIONAL_LOCKS: '0', QA_STATE_ROOT: path.join(fixture.root, '.qa-state') },
        });
        return result;
      },
      validate: captured => {
        logCost(entry.id, captured);
        observation = observer!.stop();
        observer = undefined;
        const reportFile = ownedPath(fixture.root, 'qa-reports/report.md');
        if (!fs.existsSync(reportFile) || !fs.readFileSync(reportFile, 'utf8').trim()) throw new Error('Missing functional Markdown report');
        report = JSON.parse(fs.readFileSync(ownedPath(fixture.root, 'qa-reports/evidence.json'), 'utf8'));
        const functionalPath = 'qa/sections/system-functional.md';
        const failures = qaFunctionalVerdict(fixture, entry.mode, captured, observation, report,
          { path: functionalPath, content: fs.readFileSync(ownedPath(fixture.root, functionalPath), 'utf8') }, fs.readFileSync(reportFile, 'utf8'));
        for (const relative of [`${entry.mode}/SKILL.md`, `${entry.mode}/sections/exploratory.md`, 'qa/sections/scope.md']) {
          const content = fs.readFileSync(ownedPath(fixture.root, relative), 'utf8').trim();
          if (!captured.toolCalls.some(call => call.tool === 'Read' && call.input?.file_path?.endsWith(relative)
            && call.output.replace(/^\s*\d+(?:→|\t)/gm, '').includes(content))) failures.push(`missing completed instruction read: ${relative}`);
        }
        if (failures.length) throw new Error(failures.join('; '));
        if (entry.mode === 'qa') verification = verifyQANativeRegression(fixture, false, deadlineAt);
        passed = true;
      },
    });
  } catch (error) { passed = false; failure = error; throw error; }
  finally {
    if (observer) observation = observer.stop();
    const reports: Record<string, string> = {};
    try {
      for (const name of fs.readdirSync(ownedPath(fixture.root, 'qa-reports'))) {
        const file = ownedPath(fixture.root, `qa-reports/${name}`);
        if (fs.lstatSync(file).isFile()) reports[name] = fs.readFileSync(file, 'utf8');
      }
    } catch (error) { failure ??= error; passed = false; }
    try {
      preserveQAArtifact(artifactRoot, 'attempt.json', { case: entry, passed, revision: fixture.revision, inputs, observation, report, reports, verification, result, error: failure instanceof Error ? failure.message : failure });
    } finally { fixture.cleanup(); }
  }
}
