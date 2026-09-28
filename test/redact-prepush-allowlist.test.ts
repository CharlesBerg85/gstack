/**
 * Repo-committed allowlist for the pre-push hook (.gstack/redact-allowlist).
 *
 * Third-party text that cannot be edited (a byte-exact vendored README) may
 * carry a credential-shaped example. The pushing repo can list the exact
 * matched span in .gstack/redact-allowlist; the hook reads that file from the
 * LOCAL sha being pushed, so the allowlist is itself reviewed pushed content.
 * Only exact spans suppress; everything else still blocks.
 *
 * Credential-shaped literals are assembled at runtime so this file's own
 * pushed bytes never trip the repo's pre-push scanner.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

const PREPUSH = path.resolve(import.meta.dir, "..", "bin", "gstack-redact-prepush");
const ALLOWLIST = ".gstack/redact-allowlist";

const VENDORED_LINE = "const sql = postgres('postgres://username:" + "password@host:port/database', {";
const VENDORED_SPAN = "postgres://username:" + "password@host:port";
const OTHER_URL = "postgres://admin:" + "hun" + "ter2@db.internal/app";

let repo: string;
let base: string;

function git(args: string[]): string {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: 30_000 });
  return r.stdout?.trim() ?? "";
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
}

function commit(files: Record<string, string>, msg: string): string {
  for (const [file, content] of Object.entries(files)) {
    write(file, content);
    git(["add", file]);
  }
  git(["commit", "-q", "-m", msg]);
  return git(["rev-parse", "HEAD"]);
}

function push(head: string): { code: number; stderr: string } {
  const r = spawnSync("bun", [PREPUSH], {
    cwd: repo,
    input: Buffer.from(`refs/heads/main ${head} refs/heads/main ${base}\n`),
    encoding: "utf8",
    env: { ...process.env, GSTACK_REDACT_PREPUSH: "" },
    timeout: 30_000,
  });
  return { code: r.status ?? 0, stderr: r.stderr ?? "" };
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "prepush-allowlist-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "T"]);
  base = commit({ "README.md": "hello\n" }, "init");
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("pre-push repo allowlist", () => {
  test("missing allowlist file leaves blocking unchanged", () => {
    const head = commit({ "vendor/README.md": VENDORED_LINE + "\n" }, "vendor");
    const { code, stderr } = push(head);
    expect(code).toBe(1);
    expect(stderr).toContain("db.url_with_password");
    expect(stderr).not.toContain("redact-allowlist");
  });

  test("an exact span committed in the pushed tree is suppressed, with a visible count", () => {
    const head = commit(
      {
        "vendor/README.md": VENDORED_LINE + "\n" + VENDORED_LINE.replace("sql", "db") + "\n",
        [ALLOWLIST]: "# vendored upstream README example\n\n" + VENDORED_SPAN + "\n",
      },
      "vendor with allowlist",
    );
    const { code, stderr } = push(head);
    expect(code).toBe(0);
    expect(stderr).toContain(`3 finding(s) suppressed by exact spans in ${ALLOWLIST}`);
    expect(stderr).not.toContain(VENDORED_SPAN);
    expect(stderr).not.toContain("BLOCKED");
  });

  test("a different credential in the same push still blocks", () => {
    const head = commit(
      {
        "vendor/README.md": VENDORED_LINE + "\n",
        "config.txt": "DATABASE_URL=" + OTHER_URL + "\n",
        [ALLOWLIST]: VENDORED_SPAN + "\n",
      },
      "vendor plus real secret",
    );
    const { code, stderr } = push(head);
    expect(code).toBe(1);
    expect(stderr).toContain("BLOCKED");
    expect(stderr.match(/HIGH {2}db\.url_with_password/g)?.length).toBe(1);
    expect(stderr).toContain("finding(s) suppressed");
  });

  test("a near-miss of the allowlisted span still blocks", () => {
    const head = commit(
      {
        "vendor/README.md": "postgres://username:" + "password@host:port2/database\n",
        [ALLOWLIST]: VENDORED_SPAN + "\n",
      },
      "near miss",
    );
    const { code, stderr } = push(head);
    expect(code).toBe(1);
    expect(stderr).toContain("db.url_with_password");
  });

  test("the allowlist is read from the pushed sha, not the working tree", () => {
    const head = commit({ "vendor/README.md": VENDORED_LINE + "\n" }, "vendor");
    write(ALLOWLIST, VENDORED_SPAN + "\n");
    git(["add", ALLOWLIST]);
    const { code, stderr } = push(head);
    expect(code).toBe(1);
    expect(stderr).toContain("db.url_with_password");
    expect(stderr).not.toContain("suppressed");
  });

  test("a committed allowlist is honored even when the working tree deletes it", () => {
    const head = commit(
      { "vendor/README.md": VENDORED_LINE + "\n", [ALLOWLIST]: VENDORED_SPAN + "\n" },
      "vendor with allowlist",
    );
    fs.rmSync(path.join(repo, ALLOWLIST));
    const { code } = push(head);
    expect(code).toBe(0);
  });

  test("entries shorter than 12 characters are ignored", () => {
    const shortEmail = "bob@corp.io";
    const longEmail = "alice@corp.io";
    const shortOnly = commit(
      { "notes.md": `contact ${shortEmail}\n`, [ALLOWLIST]: shortEmail + "\n" },
      "short entry",
    );
    const shortRun = push(shortOnly);
    expect(shortRun.code).toBe(0);
    expect(shortRun.stderr).toContain("MEDIUM");
    expect(shortRun.stderr).toContain(`ignored 1 ${ALLOWLIST} entr(ies)`);

    const longOnly = commit(
      { "notes.md": `contact ${longEmail}\n`, [ALLOWLIST]: longEmail + "\n" },
      "long entry",
    );
    const longRun = push(longOnly);
    expect(longRun.code).toBe(0);
    expect(longRun.stderr).not.toContain("MEDIUM");
    expect(longRun.stderr).toContain("finding(s) suppressed");
  });

  test("a marker-only span such as a PEM header cannot be allowlisted", () => {
    const header = "-----BEGIN " + "PRIVATE KEY-----";
    const head = commit(
      { "key.pem": header + "\nMIIEvQ\n", [ALLOWLIST]: header + "\n" },
      "pem",
    );
    const { code, stderr } = push(head);
    expect(code).toBe(1);
    expect(stderr).toContain("pem.private_key");
    expect(stderr).toContain(`ignored 1 ${ALLOWLIST} entr(ies)`);
  });

  test("an oversized allowlist file is ignored entirely", () => {
    const padding = "# " + "x".repeat(200) + "\n";
    const head = commit(
      {
        "vendor/README.md": VENDORED_LINE + "\n",
        [ALLOWLIST]: VENDORED_SPAN + "\n" + padding.repeat(100),
      },
      "oversized allowlist",
    );
    const { code, stderr } = push(head);
    expect(code).toBe(1);
    expect(stderr).toContain("db.url_with_password");
    expect(stderr).toContain(`ignored ${ALLOWLIST}`);
  });

  test("an allowlist with too many entries is ignored entirely", () => {
    const filler = Array.from({ length: 100 }, (_, i) => `filler-entry-${String(i).padStart(4, "0")}`).join("\n");
    const head = commit(
      {
        "vendor/README.md": VENDORED_LINE + "\n",
        [ALLOWLIST]: VENDORED_SPAN + "\n" + filler + "\n",
      },
      "too many entries",
    );
    const { code, stderr } = push(head);
    expect(code).toBe(1);
    expect(stderr).toContain("db.url_with_password");
    expect(stderr).toContain(`ignored ${ALLOWLIST}`);
  });
});
