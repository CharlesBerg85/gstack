<!-- AUTO-GENERATED from exploratory.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
# Shared exploratory QA

The **caller** runs /qa, /qa-only, /review or /ship.
The caller owns decisions, tests, edits, commits, publication and continuation. Discovery writes only
reports/evidence and owned fixture state; never invoke workflows, install frameworks or publish.

Complete these Reads in order before writing charters or probing. Do not repeat a Read already completed in this invocation.
1. Read `sections/scope.md` relative to the installed `qa`/`gstack-qa` SKILL.md directory in full and select the surfaces.
2. Read the selected surface methods below in full.

**Functional surfaces:**
Read `sections/system-functional.md` in full.

**Browser surfaces only:**
Read `sections/qa-patterns.md` in full.

Missing or unreadable assets, prerequisites or permission block affected probes, not independent safe checks.
Report QA setup blockers.

## 1. Charter and preflight

Reuse resolved REPORT_DIR; otherwise resolve ownership of an invocation-owned `.gstack/qa-reports` subdirectory.
Write a **charter** (test plan) for each behavior: contract, risk,
entrypoint, isolation and exit condition. Keep charters as Markdown in the report with exact source, commands and inputs.

For /review and /ship, no plan/server is required.
Stop after 5 minutes or 12 probes, whichever comes first (SECONDS=300 across surfaces).
Explicit plan checks remain required beyond this smoke budget.
For /qa and /qa-only:
- Browser Quick: SECONDS=30. Browser Full/Regression: SECONDS=900.
- Functional Full, Quick and Regression have no default total timer.
Set SECONDS to the mode's limit or a shorter caller duration. With no mode limit, use the caller's duration or seconds remaining to its deadline.
Without a total time limit, do not use the guard. Use documented or announced finite command timeouts instead.
Stop when scoped contracts are tested or blocked.
Use REPORT_DIR for clocks/checkpoints. For mixed standalone runs, create REPORT_DIR/browser and REPORT_DIR/functional instead; keep one final report at REPORT_DIR. Caller paths win.
For bounded commands below, replace G with `$HOME/.claude/skills/gstack/bin/gstack-qa-deadline` and D with `<probe directory>/deadline.json`, using quoted absolute paths.
Start once before baseline: `bun G start D SECONDS [EARLIER_UTC]`; selected/caller limits apply.
EARLIER_UTC is the caller's absolute deadline, if set.
Every bounded probe: `bun G run D -- COMMAND ARGS` (scripts: `bash -c 'script'`). No detached probes.
Never reset D/bypass G. Expiry or missing/invalid state stops probes; report unfinished coverage.
QA_DEADLINE receipts are not observations; retain them as timing evidence.

Never bootstrap functional/report-only QA.

## 2. Probe loop

This loop decides each probe (one command/interaction plus checks).
Do not batch probes across a checkpoint.

1. First demonstrate success: output AND durable effects. Use the guard if bounded; wait for its result.
2. **Decide whether another probe is needed.** If bounded, run `bun G status D`.
   If expired or no safe next probe remains, STOP exploration; write the report, not a checkpoint.
   Otherwise **Write before probing.** Write a new `exploration-NNN.json` beside that surface's deadline file (or in its probe directory without a timer):
   exactly four top-level fields: observationCommand, observed, hypothesis, nextCommand.
   observationCommand: last completed probe's full outer command, including guard.
   observed: its exact decoded child JSON (no wrapper/extra keys), or its full non-JSON text.
   hypothesis explains nextCommand (exact command/request, guarded if bounded).
   Preserve every safe program-JSON key/value and identity hash unchanged. Put tool metadata in the report, interpretations in hypothesis.
   Redact secrets/private payloads; disclose limits.
   Wait for the successful Write result before dispatch.
   Captions, private thinking and retrospective notes do not count. Never overwrite notes.
3. Run that exact probe; G enforces the deadline when bounded.
   On refusal, mark the note not-run in the report. Retain initial state/inputs/results.
   Repeat from step 2.
4. Replay the exact failing command/request from the same initial fixture state via steps 2–3
   before repair, then minimize via those gates. Expiry leaves confirmation/minimization incomplete.
   Another input or a regression test is not that replay.
5. Compare recorded/current source, commands and fixtures. After changes, repeat affected review and
   return to step 2 for each affected revalidation without resetting limits/notes. Update status using fresh evidence.

Classify expected rejection, setup error, unclear contract or defect.
Test a causal hypothesis on the failing path before repair; launch/acceptance is not completion.

## 3. Parent handoff

- **/qa:** parent applies severity tiers/root-cause gate, then codifies and repairs.
  Healthy contracts may gain tests without product changes.
- **/review:** return before Fix-First; proposed tests carry test_stub and require ASK approval.
- **Planning:** propose charters only; no execution.

Use the smallest sufficient native test: unit for logic, integration for storage/requests/queues,
E2E when smaller tests or mocks miss the journey. Do not automatically use both.
Mock unrelated services, not the failing boundary. Require a failing regression BEFORE repair,
then green regression, original probe and adjacent happy path.
Never freeze buggy output, weaken tests or delete valid red tests.

## 4. Final report

Link each checkpoint in the final report. Include findings, unfinished charters, cleanup,
sanitized evidence, revision/runtime, replay limits, severity, browser scores,
functional outcomes and proposed/executed tests separately.
Evidence is invocation-local; /ship reruns once per invocation.
Missing prerequisites/expectations, timeouts, refusal and absent observations never pass.
Pass requires all required current-input contracts to pass with no required remainder.
Failed/unavailable required probes make /review incomplete and block /ship without explicit
user acceptance of that named risk; noninteractive runs return blocked. Only nonbehavioral diffs
may be not applicable with a reason; prompts/templates are behavioral.
