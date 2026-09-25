<!-- AUTO-GENERATED from exploratory.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
# Shared exploratory QA

The **caller** is the workflow you are running: /qa, /qa-only, /review or /ship.
The caller owns decisions, tests, edits, commits, publication and continuation.
Discovery writes reports/evidence and owned temporary fixture state only.
Never invoke workflows, install frameworks, publish or acquire authority.

Read `sections/scope.md` relative to the installed `qa`/`gstack-qa` SKILL.md directory in full.
Skip this Read only if you already read it in this invocation and completed surface selection and isolation.
Missing or unreadable assets, prerequisites or permission block affected probes, not independent safe checks.
Report QA setup blockers.

## 1. Charter and preflight

Use the caller's report directory or an invocation-owned subdirectory of `.gstack/qa-reports` after resolving ownership.
Write a **charter** (test plan) for each behavior: contract, risk,
entrypoint, isolated fixture and exit condition. Record exact source (including uncommitted/new files), commands and fixture inputs.
Source locates functional entrypoints, not correctness; browser discovery stays black-box.

Use the selected Full, Quick or Regression depth.
Start a timer before the first probe; check output and final state.
Bound commands by remaining time when a total limit applies; report unfinished work at the limit.
Functional Full/Regression has no default total limit: use documented command timeouts or
announce a finite per-command timeout before probing. End when scoped contracts are tested or blocked.

Clarify unknown expectations. Never bootstrap functional/report-only QA.

## 2. Probe loop

Read the selected surface methods first. Reuse only completed method Reads from this invocation.

Use this host's installed `qa`/`gstack-qa` SKILL.md directory for these reads:

**Functional surfaces:**
Read `sections/system-functional.md` in full.

**Browser surfaces only:**
Read `sections/qa-patterns.md` in full.

Methods guide checks; the following loop decides when to run each probe (one command or interaction plus its checks).
Do not batch probes across a checkpoint.

1. First demonstrate a successful operation's output AND durable effects. Wait for its result.
2. **Decide whether another probe is needed.** With no safe next probe, do not write a checkpoint.
   Terminal summaries belong in the report, not a checkpoint.
   Otherwise **Write before probing.** Before each next discovery probe, Write a new
   `exploration-NNN.json` in the owned report directory with exactly:
   observationCommand, observed, hypothesis, nextCommand. Copy the immediately preceding completed probe's
   command/result into the first two fields; hypothesis explains the nextCommand (exact command/request).
   For safe native JSON, copy every key and value of the program JSON only, including nonsecret source/fixture identity hashes.
   Do not add, rename, summarize or remove fields; tool wrapper metadata belongs in the report.
   Interpretations belong in hypothesis, not observed. Redact secrets/private payloads; disclose limits.
   Wait for the successful Write result before dispatch.
   Bash captions, private thinking and retrospective notes do not count. Never overwrite notes.
3. Run that exact probe; retain initial state, inputs and results.
   Return to step 2 for every subsequent probe, including replays and revalidation.
4. On a defect, stop: Re-run the exact failing command/request from the same initial fixture state
   to confirm it, with its own checkpoint. Then minimize it.
   A different malformed input or a regression test is not that replay.
5. Compare collaborator updates and recorded inputs with current source, commands and fixtures.
   After a change, repeat affected review and return to step 2 for each affected revalidation.
   Keep original limits/note sequence; update report/status. Old results cannot verify changed inputs.

Classify expected rejection, setup error, unclear contract or defect.
Test a causal hypothesis on the failing path to explain the failure; launch/acceptance is not completion.

## 3. Parent handoff

Never change product code, tests, configuration, dependencies or Git through any tool,
including shell, rename, deletion, commit, stash or edit-then-restore. Return test_stub proposals
with their failing contract and expected assertion; never create tests or freeze buggy output.

## 4. Final report

Link each checkpoint in the final report; include outcomes, findings, test proposals, unfinished charters,
cleanup, sanitized evidence, revision/runtime and replay limits. Separate severity, browser scores,
functional outcomes and proposed/executed tests.
Evidence is invocation-local.
Missing prerequisites/expectations, timeouts, refusal and absent observations never pass.
Pass requires all required current-input contracts to pass with no required remainder.
Report blocked, inconclusive and not-run coverage without claiming success.
