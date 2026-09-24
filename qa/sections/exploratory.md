<!-- AUTO-GENERATED from exploratory.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
# Shared exploratory QA

The caller owns questions, edits, commits and continuation. Discovery writes only
reports/evidence and owned temporary fixture state. Never invoke another workflow,
install a framework, publish or acquire extra authority.

Read shared QA assets from this host's sibling qa/gstack-qa, never product or cross-host copies.
If missing or unreadable, report a QA setup blocker and its affected probes as blocked; continue other safe probes (independent functional/static checks). Missing/unreadable assets block required QA.

If the caller has not selected surfaces and established isolation:
Read `sections/scope.md` relative to the installed `qa`/`gstack-qa` SKILL.md directory in full.

## 1. Charter and preflight

Use the caller's report directory, or create an invocation-owned subdirectory of
`.gstack/qa-reports` after resolving ownership.
Record each charter's behavior, documented expectation, risky assumption, entrypoint,
isolated fixture and completion condition. Bind current source, commands and fixture inputs,
including uncommitted/new files. Read functional source for entrypoints, not correctness.
Browser discovery stays black-box.

For /review and /ship, test changed and high-risk adjacent paths even without a plan or
server. Stop after 5 minutes or 12 probes, whichever comes first; a stricter caller limit
wins. A probe is one scenario, including its output and final-state checks. Bound each
command by the remaining time and return unfinished charters. Explicit plan checks remain
required even when they exceed this smoke budget. /qa and /qa-only use their selected depth.

Missing prerequisites or permission block affected probes, not independent safe checks.
Unknown expectations remain questions. Never bootstrap for functional/report-only QA.

## 2. Establish behavior, then challenge it

This loop owns execution order; surface methods supply contracts and evidence checks,
not a second probe sequence. Complete the caller's required surface reads first.
Do not batch probes across a checkpoint.

1. First demonstrate a successful operation's output AND durable effects. Wait for its result.
2. **Write before probing.** Before each next discovery probe, Write a new
   `exploration-NNN.json` in the owned report directory with these JSON fields:
   observationCommand, observed, hypothesis, nextCommand. Use the preceding exact command,
   its actual sanitized result (complete native JSON when safe), the assumption to challenge,
   and the exact next command/request. Wait for the successful Write result before dispatch.
   Bash captions, private thinking and retrospective notes do not count. Never overwrite notes.
3. Run that exact probe using supported seeds/barriers/fault injection. Retain initial state,
   inputs and results. Return to step 2 before another discovery probe.
4. On a defect, stop: Re-run the exact failing command/request from the same initial fixture state
   before repair, with its own checkpoint. Then minimize it.
   A different malformed input or a regression test is not that replay.

Distinguish expected rejection, setup errors, unclear contracts and defects.
Trace the failing path and test a causal hypothesis before repair. A process starting
or an HTTP request being accepted does not prove the operation finished correctly.

## 3. Return discoveries; the parent promotes tests

Return the probes and outcomes, findings, proposed tests, unfinished charters and cleanup
state. When inputs change, repeat affected probes and review. Reuse evidence only within
this invocation; every new /ship reruns. Specialists guide this pass, not duplicate it.

- **/qa:** parent applies severity tiers/root-cause gate, then codifies and repairs.
  Uncovered healthy contracts may gain tests without product changes.
- **/review:** return before Fix-First; proposed tests carry test_stub and require ASK approval.
- **/ship:** parent owns approved tests/fixes and publication; discovery grants no permission.
- **Planning:** propose charters only; no execution.

Approved tests follow native conventions: unit for logic, real integration for storage/
requests/queues, E2E where smaller tests cannot prove journeys or mocks hide the bug.
Do not automatically use both. Mock unrelated services, not the failing boundary.
Confirm the regression fails for the defect BEFORE repair; then require green regression,
original probe and adjacent happy path. Never freeze buggy output, weaken tests or delete
valid red tests. Missing infrastructure/unclear expectations stay coverage gaps.

## 4. Report honestly

Link each checkpoint in the final report. Report contract outcomes separately from severity, with sanitized replay/evidence,
revision/runtime and limits. Separate browser scores from functional outcomes and tests
run from proposals. Setup errors, timeouts, refusal or missing observations never pass.
Failed/unavailable required probes make /review incomplete. They block /ship absent explicit
user acceptance of that named risk; noninteractive runs return blocked. A truly nonbehavioral diff may be not
applicable with a reason; prompts/templates are behavioral. Independent safe checks may finish.
