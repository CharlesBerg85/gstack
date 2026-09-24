<!-- AUTO-GENERATED from browser-verify.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
# Browser repair verification

Use this section only for a browser defect. Re-run the original interaction and an
adjacent happy path. The Phase 5 evidence is the before; capture the after now.
Compare the snapshot tree and console errors against the original evidence.

One flow, one script (tabs close when the script ends, so re-navigate from the URL):

```bash
aside repl '
const HOOK = `(() => { window.__gstackErrs = window.__gstackErrs || []; const oe = console.error; console.error = (...a) => { window.__gstackErrs.push(a.map(String).join(" ")); oe.apply(console, a); }; window.addEventListener("error", e => window.__gstackErrs.push("uncaught: " + e.message)); })()`;
const pg = await openTab("about:blank");
await pg._sendToTarget("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
await pg.goto("<affected-url>");
const s = await snapshot(pg, { interactive: true });
console.log(s.tree);
console.log("CONSOLE_ERRORS=" + JSON.stringify(await pg.evaluate(() => window.__gstackErrs)));
await pg.screenshot({ path: "issue-NNN-after.jpg", type: "jpeg", quality: 60, fullPage: true });
console.log("ASIDE_DIR=" + pwd);
await closeTab(pg);
console.log("GSTACK_STEP_OK");
'
```

Copy the evidence out of the printed `ASIDE_DIR` into the chosen report directory:

```bash
cp "<ASIDE_DIR>/issue-NNN-after.jpg" "<report-dir>/screenshots/issue-NNN-after.jpg"
```

Read the copied screenshot so the user sees it. For interaction bugs, rerun the
Phase 3 read/flow script in qa-patterns with `flow = true` and compare `DIFF` and
`CONSOLE_ERRORS=`. When Aside is
unavailable, use the browser setup's existing fallback equivalents for the same
interaction, snapshot, console and screenshot evidence; never make a functional
repair depend on this section.
