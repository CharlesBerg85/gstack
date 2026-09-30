import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
// DESIGN.md content from the Write call of the census 36641820398 slice 8
// design-consultation capture. That run Read its section at 11s and wrote
// DESIGN.md and CLAUDE.md, then timed out composing the duplicate REPORT.md
// the generic fixture requested.
const designMd = fs.readFileSync(path.join(import.meta.dir, 'fixtures/design-consultation-section-design-md.md'), 'utf8');
const genericReport = '# Design report\n' + 'The design review summary is complete. '.repeat(8);

interface Fixture {
  output?: string;
  file?: 'DESIGN.md' | 'REPORT.md' | null;
  exitReason?: string;
  missingRead?: boolean;
}

// Run the actual paid registration and capture helper in an isolated free
// child; only the session-runner/provider boundary is replaced.
function exercise(fixture: Fixture = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-consultation-completion-'));
  const script = path.join(dir, 'capture.test.ts');
  const facts = path.join(dir, 'facts.json');
  const input = { output: designMd, file: 'DESIGN.md', exitReason: 'success', missingRead: false, ...fixture };
  fs.writeFileSync(script, `
import { expect, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CARVE_GUARDS } from ${JSON.stringify(path.join(ROOT, 'test/helpers/carve-guards.ts'))};
const input = ${JSON.stringify(input)};
const guard = CARVE_GUARDS['design-consultation'];
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/session-runner.ts'))}, () => ({
  runSkillTest: async opts => {
    fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify({ prompt: opts.prompt, timeout: opts.timeout, allowedTools: opts.allowedTools }));
    if (input.file) fs.writeFileSync(path.join(opts.workingDirectory, input.file), input.output);
    return {
      exitReason: input.exitReason, output: 'Wrote DESIGN.md and CLAUDE.md.',
      toolCalls: input.missingRead ? [] : guard.requiredReads.map(section => ({
        tool: 'Read', input: { file_path: path.join(opts.workingDirectory, 'design-consultation', 'sections', section) },
      })), transcript: [],
    };
  },
}));
const { registerCarveSectionCase } = await import(${JSON.stringify(path.join(ROOT, 'test/helpers/carve-section-case.ts'))});
registerCarveSectionCase('design-consultation');
`);
  try {
    const child = Bun.spawnSync([process.execPath, 'test', script], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? '', HOME: dir, TMPDIR: dir, TEMP: dir, TMP: dir,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
      timeout: 10_000,
    });
    expect(fs.existsSync(facts), child.stderr.toString()).toBe(true);
    expect(child.signalCode ?? null).toBeNull();
    return { code: child.exitCode, output: child.stdout.toString() + child.stderr.toString(),
      facts: JSON.parse(fs.readFileSync(facts, 'utf8')) as { prompt: string; timeout: number; allowedTools: string[] } };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the captured DESIGN.md is the completed output; no duplicate report is requested', () => {
  expect(designMd.split('\n')[1]).toBe('# gstack: design-md-format=spec');
  const result = exercise();
  expect(result.code, result.output).toBe(0);
  expect(result.facts.timeout).toBe(480_000);
  expect(result.facts.prompt).toContain('declined the optional outside design voices');
  expect(result.facts.prompt).toMatch(/write the skill's final output[^\n]*DESIGN\.md/);
  expect(result.facts.prompt).not.toContain('REPORT.md');
}, 20_000);

test('the census timeout still fails even after DESIGN.md was written', () => {
  expect(exercise({ exitReason: 'timeout' }).code).not.toBe(0);
}, 20_000);

test('a generic report without the DESIGN.md format marker does not count as completion', () => {
  expect(exercise({ output: genericReport }).code).not.toBe(0);
  expect(exercise({ output: genericReport, file: 'REPORT.md' }).code).not.toBe(0);
});

test('a terminal-only claim without writing DESIGN.md fails', () => {
  expect(exercise({ file: null }).code).not.toBe(0);
}, 20_000);

test('skipping the section Read fails', () => {
  expect(exercise({ missingRead: true }).code).not.toBe(0);
}, 20_000);
