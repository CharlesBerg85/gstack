<!-- AUTO-GENERATED from pr-body.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Step 19: Create PR/MR

**Idempotency check:** Check if a PR/MR already exists for this branch.

**If GitHub:**
```bash
gh pr view --json url,number,state -q 'if .state == "OPEN" then "PR #\(.number): \(.url)" else "NO_PR" end' 2>/dev/null || echo "NO_PR"
```

**If GitLab:**
```bash
glab mr view -F json 2>/dev/null | jq -r 'if .state == "opened" then "MR_EXISTS" else "NO_MR" end' 2>/dev/null || echo "NO_MR"
```

Record whether an open PR/MR exists; both paths compose and scan fresh results below.

### Resolve Linked Spec before composing the body

1. Resolve the archive directory and branch:
   ```bash
   eval "$(~/.claude/skills/gstack/bin/gstack-paths)"
   eval "$(~/.claude/skills/gstack/bin/gstack-slug)"
   CURRENT_BRANCH=$(git branch --show-current)
   SPEC_ARCHIVES="$GSTACK_STATE_ROOT/projects/$SLUG/specs"
   ```
2. Read archive frontmatter as data, never shell source. Select an exact
   `spec_branch` match to `CURRENT_BRANCH`; among matches use the newest
   `spec_filed_at`. Never infer an issue number from a branch name. If no readable
   match or positive integer `spec_issue_number`, omit only `## Linked Spec` and
   continue composing the PR. Resolve ambiguous matches before linking an issue.
3. Compare that spec's acceptance criteria with Step 8's results. Only fully
   completed Step 8 plan scope permits `Closes #N`, with every spec criterion
   verified. Partial, deferred, failed, dropped or unverified scope uses `Linked to #N`
   and names the remaining work; never auto-close it. Include the archive filename
   and `spec_filed_at`, not a private absolute path. Send these fields through the same redaction scan.

The PR/MR body should contain these sections (never reuse a prior run's body):

```
## Summary
<Read `git log origin/<base>..HEAD --oneline`. Group every substantive commit by
theme, excluding VERSION/CHANGELOG bookkeeping. Do not paste the commit list.>

## Test Coverage
<coverage diagram from Step 7, or "All new code paths have test coverage.">
<If Step 7 ran: "Tests: {before} → {after} (+{delta} new)">

## Pre-Landing Review
<findings from Step 9 code review, or "No issues found.">

## Exploratory QA
<Step 9's current surfaces/charters, reproducers, approved regressions and red/green
proof, fixes and blocked/inconclusive/not-run coverage. Never present stale or
unavailable results as passing.>

## Design Review
<If design review ran: "Design Review (lite): N findings — M auto-fixed, K skipped. AI Slop: clean/N issues.">
<Detector: "clean" | "N findings (rule-id, rule-id)" | "not installed" | "not cached" | "off" — the state the probe printed; rule ids and counts only, finding text and snippets never reach the PR body.>
<If no frontend files changed: "No frontend files changed — design review skipped.">

## Eval Results
<If evals ran: suite names, pass/fail counts, cost dashboard summary. If skipped: "No prompt-related files changed — evals skipped.">

## Greptile Review
<If Greptile comments were found: bullet list with [FIXED] / [FALSE POSITIVE] / [ALREADY FIXED] tag + one-line summary per comment>
<If no Greptile comments found: "No Greptile comments.">
<If no PR existed during Step 10: omit this section entirely>

## Scope Drift
<If scope drift ran: "Scope Check: CLEAN" or list of drift/creep findings>
<If no scope drift: omit this section>

## Plan Completion
<If plan file found: completion checklist summary from Step 8>
<If no plan file: "No plan file detected.">
<If plan items deferred: list deferred items>

## Linked Spec
<Closes #N only when the Linked Spec check above permits it; otherwise
"Linked to #N (partial delivery — not auto-closing)" with remaining work and
"Close #N manually after follow-up lands." Include archive filename and filed date.
Without a valid match, omit this entire section.>

## Verification Results
<Step 8.1 obligations executed at Step 9: N PASS, M FAIL, K BLOCKED, J NOT RUN,
not-applicable reasons, unresolved obligations and accepted deferrals.
Unavailable/inconclusive is never PASS.>

## TODOS
<If items marked complete: bullet list of completed items with version>
<If no items completed: "No TODO items completed in this PR.">
<If TODOS.md created or reorganized: note that>
<If TODOS.md doesn't exist and user skipped: omit this section>

## Documentation
<Embed Step 14.5's vetted nonempty `documentation_section` for this invocation.>
<Always include the status and reviewed scope: updated, current, or blocked with the actual user's named risk exception. Never omit this section or reuse an earlier audit.>

## Test plan
- [x] <Each executed test lane's command>: <observed passing summary>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

#### Redaction scan (PR body + title) — runs before create AND edit

The PR body is world-readable on a public repo. Scan-at-sink before sending:
write the composed body to a temp file, scan THAT file with the shared engine,
and pass the same file to `gh`/`glab`. Wrap any Codex / Greptile / eval output
sections in tool-attributed fences (` ```codex-review ` / ` ```greptile `) so the
engine WARN-degrades the example credentials those tools quote instead of blocking
the PR (a live-format credential inside the fence still blocks).

Use Step 18's `NEW_TITLE`, prefixed with `v$NEW_VERSION `, for both the scan and
publication. If the open PR/MR or title changed since Step 18, refresh it there first.
In a new shell, restore the saved literal title before running this block.

```bash
: "${NEW_TITLE:?Restore the saved Step 18 title before scanning}"
REDACT_VIS=$(~/.claude/skills/gstack/bin/gstack-config get redact_repo_visibility 2>/dev/null)
[ -z "$REDACT_VIS" ] && REDACT_VIS=$(gh repo view --json visibility -q .visibility 2>/dev/null | tr 'A-Z' 'a-z')
REDACT_VIS="${REDACT_VIS:-unknown}"
PR_BODY_FILE=$(mktemp) || { echo "ERROR: mktemp failed — cannot scan the PR body; refusing to create the PR unscanned." >&2; exit 1; }
cat > "$PR_BODY_FILE" <<'PR_BODY_EOF'
<PR body from above>
PR_BODY_EOF
~/.claude/skills/gstack/bin/gstack-redact --from-file "$PR_BODY_FILE" --repo-visibility "$REDACT_VIS" --self-email "$(git config user.email 2>/dev/null)" --json
case $? in
  3) echo "BLOCKED — credential in PR body. Rotate + redact, do not create the PR."; exit 1 ;;
  2) echo "MEDIUM findings — confirm per finding (sterner on public) before proceeding." ;;
esac
printf '%s' "$NEW_TITLE" | ~/.claude/skills/gstack/bin/gstack-redact --repo-visibility "$REDACT_VIS" --json
```

HIGH blocks (exit 3, no skip). MEDIUM → AskUserQuestion (PII subset offers
`--auto-redact`).

For every create/edit command below, send the same scanned bytes. Never re-render
the body. In a new shell, restore the literal `PR_BODY_FILE` path and `NEW_TITLE`.

**Existing open PR/MR:** update using `gh pr edit --body-file "$PR_BODY_FILE"` (GitHub)
or `glab mr update -d "$(cat "$PR_BODY_FILE")"` (GitLab).

Update the title with the same scanned `NEW_TITLE`: `gh pr edit --title "$NEW_TITLE"` (or `glab mr update -t "$NEW_TITLE"`).

**REST fallback (#1079):** if `gh pr edit` fails with the `repository.pullRequest.projectCards` GraphQL deprecation, do not re-ask for auth. Use the SAME scanned file: `PR_NUMBER=$(gh pr view --json number -q .number)`, then `gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER" -X PATCH -F body=@"$PR_BODY_FILE"`; for the title use `gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER" -X PATCH -f title="$NEW_TITLE"`.

**Self-check:** re-fetch the title and assert it starts with `v$NEW_VERSION `. Retry once if wrong, then surface any failure. Print the existing URL and continue to Step 20; do not run the create commands below.

**No open PR/MR, GitHub:**

```bash
[ -s "$PR_BODY_FILE" ] || { echo "ERROR: scanned body file missing/empty — re-run the scan block." >&2; exit 1; }
gh pr create --base <base> --title "$NEW_TITLE" --body-file "$PR_BODY_FILE"
rm -f "$PR_BODY_FILE"
```

**No open PR/MR, GitLab:**

```bash
[ -s "$PR_BODY_FILE" ] || { echo "ERROR: scanned body file missing/empty — re-run the scan block." >&2; exit 1; }
glab mr create -b <base> -t "$NEW_TITLE" -d "$(cat "$PR_BODY_FILE")"
rm -f "$PR_BODY_FILE"
```

**If neither CLI is available:**
Print the branch name, remote URL, and instruct the user to create the PR/MR manually via the web UI. Do not stop — the code is pushed and ready.

**Output the PR/MR URL** — then proceed to Step 20.

---
