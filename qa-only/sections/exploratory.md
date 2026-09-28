<!-- AUTO-GENERATED from exploratory.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
# Shared exploratory QA

The **caller** runs /qa, /qa-only, /review or /ship.
The caller owns decisions, tests, edits, commits, publication and continuation. Discovery writes only
reports/evidence and owned fixture state; never invoke workflows, install frameworks or publish.

Complete these Reads in order before writing charters or probing. Do not repeat a Read already completed in this invocation.
1. Read `sections/scope.md` relative to the installed `qa`/`gstack-qa` SKILL.md directory in full and select the surfaces.
2. Read the selected surface methods below in full.

Use this host's installed `qa`/`gstack-qa` SKILL.md directory for these reads:

**Functional surfaces:**
Read `sections/system-functional.md` in full.

**Browser surfaces only:**
Read `sections/qa-patterns.md` in full.

Missing or unreadable assets, prerequisites or permission block affected probes, not independent safe checks.
Report QA setup blockers.

## 1. Charter and preflight

Reuse resolved REPORT_DIR; otherwise resolve ownership of an invocation-owned `.gstack/qa-reports` subdirectory.
Write a **charter** (test plan) for each behavior: contract, risk,
entrypoint, isolation and exit condition. Save charters as Markdown in the report: exact source, commands and inputs.


For /qa and /qa-only:
- Browser Quick: SECONDS=30. Browser Full/Regression: SECONDS=900.
- Functional Full, Quick and Regression have no default total timer.
Set SECONDS to the mode's limit or a shorter caller duration. With no mode limit, use the caller's duration or seconds remaining to its deadline.
Without a total time limit, do not use the guard. Use documented or announced finite command timeouts instead.
Stop when scoped contracts are tested or blocked.
Use REPORT_DIR for clocks/checkpoints. For mixed standalone runs, create REPORT_DIR/browser and REPORT_DIR/functional instead; keep one final report at REPORT_DIR. Caller paths win.
G = `$HOME/.claude/skills/gstack/bin/gstack-qa-deadline`, D = `<probe directory>/deadline.json`; quote absolute paths.
Start once before baseline: `bun G start D SECONDS [EARLIER_UTC]`.
EARLIER_UTC is the caller's absolute deadline, if set.
Every bounded probe: `bun G run D -- COMMAND ARGS` (scripts: `bash -c 'script'`). No detached probes.
Never reset D/bypass G. Expiry or missing/invalid state stops probes; report unfinished coverage.
QA_DEADLINE receipts are not observations; retain them as timing evidence.

Never bootstrap functional/report-only QA.

## 2. Probe loop

This loop decides each probe (one command/interaction plus checks).
Do not batch probes across a checkpoint.

1. First demonstrate success: output AND durable effects. Guard if bounded; await completion.
2. **Decide whether another probe is needed.** If bounded, run `bun G status D`.
   If expired or no safe next probe remains, STOP exploration; write the report, not a checkpoint.
   Otherwise **Write before probing.** Write a new `exploration-NNN.json` in the probe directory, beside its deadline if bounded, with exactly four top-level fields:
   observationCommand: last completed probe's full outer command, including guard.
   observed: its exact decoded child JSON (no wrapper/extra keys), or its full non-JSON text.
   For guarded text, copy the complete span between the guard's started and finished receipt lines.
   Keep its whitespace and content fences verbatim. Do not summarize, relabel or add timing text.
   The guard adds one newline before its finished receipt; that separator is not child text.
   For unguarded text, copy the complete result instead.
   If capture is incomplete, report that limit instead of reconstructing it.
   hypothesis: why nextCommand. nextCommand: exact command/request, guarded if bounded.
   Preserve every safe program-JSON key/value and identity hash unchanged. Put tool metadata in the report, interpretations in hypothesis.
   Redact secrets/private payloads; disclose limits.
   Before Write, complete and check all fields against the result and next probe. No drafts/placeholders or invented safe-path redactions; corrections cannot repair published notes.
   Wait for the successful Write result before dispatch.
   Captions, private thinking and retrospective notes do not count. Never overwrite notes.
3. Run that exact probe; G enforces the deadline when bounded.
   Report refusals as not-run. Retain initial state/inputs/results.
   Repeat from step 2.
4. Replay the exact failing command/request from the same initial fixture state via steps 2–3
   to confirm it, then minimize via those gates. Expiry leaves confirmation/minimization incomplete.
   Another input or a regression test is not that replay.
5. If the user or another process changes source, commands or fixtures, review the affected
   contracts and return to step 2 for each affected revalidation. Do not make product changes yourself.
   Keep the original limits/notes; update outcomes only from fresh evidence.

Classify expected rejection, setup error, unclear contract or defect.
Test a causal hypothesis on the failing path to explain the failure; launch/acceptance is not completion.

## 3. Parent handoff

Never change product code, tests, configuration, dependencies or Git through any tool,
including shell, rename, deletion, commit, stash or edit-then-restore. Return test_stub proposals
with their failing contract and expected assertion; never create tests or freeze buggy output.

## 4. Final report

Link each checkpoint in the final report. Include findings, unfinished charters, cleanup,
sanitized evidence, revision/runtime, replay limits, severity, browser scores,
functional outcomes and proposed/executed tests separately.
Evidence is invocation-local.
Missing prerequisites/expectations, timeouts, refusal and absent observations never pass.
Pass requires all required current-input contracts to pass with no required remainder.
Report blocked, inconclusive and not-run coverage without claiming success.
