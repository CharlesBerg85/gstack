/**
 * Touchfile coverage for moved code.
 *
 * Each JSON file in test/fixtures/moved-module-selection/ records, before a
 * refactor moved code out of `source`, the paid evals selected by touching
 * that source file. Touching any module the code moved into must select a
 * superset, so a move can never silently drop eval coverage.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES, GLOBAL_TOUCHFILES, selectTests } from './helpers/touchfiles';

const ROOT = path.resolve(import.meta.dir, '..');
const GOLDEN_DIR = 'test/fixtures/moved-module-selection';

interface Golden { workstream: string; source: string; modules: string[]; e2e: string[]; llmJudge: string[] }

const goldens = fs.readdirSync(path.join(ROOT, GOLDEN_DIR))
  .filter(f => f.endsWith('.json'))
  .map(f => ({ file: `${GOLDEN_DIR}/${f}`, golden: JSON.parse(fs.readFileSync(path.join(ROOT, GOLDEN_DIR, f), 'utf-8')) as Golden }));

function missingSelections(module: string, golden: Golden): string[] {
  const e2e = new Set(selectTests([module], E2E_TOUCHFILES, GLOBAL_TOUCHFILES).selected);
  const judge = new Set(selectTests([module], LLM_JUDGE_TOUCHFILES, GLOBAL_TOUCHFILES).selected);
  return [
    ...golden.e2e.filter(t => !e2e.has(t)).map(t => `E2E ${t}`),
    ...golden.llmJudge.filter(t => !judge.has(t)).map(t => `LLM judge ${t}`),
  ];
}

describe('moved modules keep their source file\'s paid-eval selection', () => {
  test('at least one golden is recorded', () => {
    expect(goldens.length).toBeGreaterThan(0);
  });

  for (const { file, golden } of goldens) {
    test(`${golden.workstream}: every module moved out of ${golden.source} selects a superset`, () => {
      const problems: string[] = [];
      for (const module of golden.modules) {
        if (!fs.existsSync(path.join(ROOT, module))) problems.push(`${module}  (listed in ${file} but missing)`);
        for (const miss of missingSelections(module, golden)) problems.push(`${module}  does not select ${miss}`);
      }
      if (problems.length) {
        throw new Error([
          'Moved modules lost paid-eval selection:',
          ...problems.map(p => `  ${p}`),
          `Rule: code moved out of ${golden.source} must keep every eval that touching ${golden.source} selected, or a regression in the moved code ships unevaluated.`,
          `Fix: add the new module to ${golden.source}'s touchfile entries in test/helpers/touchfiles-data.ts (a directory glob is fine).`,
          `Golden: ${file} — re-record it only when the source file's own selection legitimately changes.`,
        ].join('\n'));
      }
    });
  }

  test('a module outside every touchfile entry is reported', () => {
    const golden: Golden = { workstream: 'self-test', source: 'browse/src/server.ts', modules: [], e2e: ['browse-basic'], llmJudge: [] };
    expect(missingSelections('nowhere/planted-module.ts', golden)).toEqual(['E2E browse-basic']);
  });
});
