import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { E2E_TOUCHFILES, GLOBAL_TOUCHFILES, LLM_JUDGE_TOUCHFILES } from './helpers/touchfiles-data';
import { selectTests } from './helpers/test-selection';

// Each refactor workstream records, before moving code, which paid evals
// touching its source files selected. Touching any module that received that
// code must still select a superset, so moving code never narrows coverage.
const ROOT = path.resolve(import.meta.dir, '..');
const GOLDEN_DIR = path.join(ROOT, 'test', 'fixtures', 'touchfile-selection');
const DATA_FILE = 'test/helpers/touchfiles-data.ts';

interface SourceSelection { modules: string[]; e2e: string[]; llmJudge: string[]; global: boolean }
interface Golden { workstream: string; recordedAt: string; sources: Record<string, SourceSelection> }

export function selectionViolations(golden: Golden, goldenFile: string): string[] {
  const violations: string[] = [];
  for (const [source, recorded] of Object.entries(golden.sources)) {
    for (const module of recorded.modules) {
      if (recorded.global && !GLOBAL_TOUCHFILES.includes(module)) {
        violations.push(`${goldenFile}  ${module} (from ${source}): source was global, module is not in GLOBAL_TOUCHFILES`);
      }
      for (const [map, name, expected] of [
        [E2E_TOUCHFILES, 'E2E_TOUCHFILES', recorded.e2e],
        [LLM_JUDGE_TOUCHFILES, 'LLM_JUDGE_TOUCHFILES', recorded.llmJudge],
      ] as const) {
        const selected = new Set(selectTests([module], map, GLOBAL_TOUCHFILES).selected);
        const missing = expected.filter((id) => !selected.has(id));
        if (missing.length) violations.push(`${goldenFile}  ${module} (from ${source}): ${name} misses ${missing.join(', ')}`);
      }
    }
  }
  return violations;
}

export function formatViolations(violations: string[]): string {
  return [
    ...violations,
    'Rule: a module that received moved code must select every paid eval its source file selected, so a move never narrows eval coverage.',
    `Fix: add the new module to its source file's touchfile entries in ${DATA_FILE} (all three maps).`,
    `Golden files: ${path.relative(ROOT, GOLDEN_DIR)}/*.json, recorded before the move; regenerate one only when a source's selection changed on purpose.`,
  ].join('\n');
}

const goldens = fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json')).sort();

describe('touchfile selection goldens', () => {
  test('at least one golden is committed', () => {
    expect(goldens.length).toBeGreaterThan(0);
  });

  test.each(goldens)('%s: every receiving module exists and selects a superset of its source', (file) => {
    const golden: Golden = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, file), 'utf8'));
    const rel = `test/fixtures/touchfile-selection/${file}`;
    for (const recorded of Object.values(golden.sources)) {
      expect(recorded.modules.length).toBeGreaterThan(0);
      for (const module of recorded.modules) expect(fs.existsSync(path.join(ROOT, module))).toBe(true);
    }
    const violations = selectionViolations(golden, rel);
    if (violations.length) throw new Error(formatViolations(violations));
  });

  test('a module missing one of its source entries is reported with the fix', () => {
    const golden: Golden = {
      workstream: 'planted', recordedAt: 'test',
      sources: { 'scripts/planted-source.ts': { modules: ['scripts/planted-module.ts'], e2e: ['review-dashboard-via'], llmJudge: [], global: false } },
    };
    const violations = selectionViolations(golden, 'planted.json');
    expect(violations).toEqual(['planted.json  scripts/planted-module.ts (from scripts/planted-source.ts): E2E_TOUCHFILES misses review-dashboard-via']);
    const message = formatViolations(violations);
    expect(message).toContain(`Fix: add the new module to its source file's touchfile entries in ${DATA_FILE}`);
    expect(message).toContain('test/fixtures/touchfile-selection/*.json');
  });
});
