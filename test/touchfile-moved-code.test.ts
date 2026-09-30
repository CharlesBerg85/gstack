/**
 * Touchfile coverage for moved code.
 *
 * Each JSON file in test/fixtures/touchfile-moved-code/ records, before a
 * refactor moved code, the paid evals that touching each source file selected
 * ("global" when the source was a global touchfile). Touching any module the
 * code moved into must select a superset, so a move never silently drops eval
 * coverage. A module key ending in "/" covers every .ts file under it.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { E2E_TOUCHFILES, GLOBAL_TOUCHFILES, LLM_JUDGE_TOUCHFILES, selectTests } from './helpers/touchfiles';

const ROOT = path.resolve(import.meta.dir, '..');
const GOLDEN_DIR = 'test/fixtures/touchfile-moved-code';
const LANES = ['e2e', 'llmJudge'] as const;

type Lane = typeof LANES[number];
type Selection = 'global' | string[];
type Maps = Record<Lane, Record<string, string[]>>;
interface Golden {
  workstream: string;
  recordedAt: string;
  sources: Record<string, Record<Lane, Selection>>;
  modules: Record<string, string[]>;
}

const MAPS: Maps = { e2e: E2E_TOUCHFILES, llmJudge: LLM_JUDGE_TOUCHFILES };

function expandModule(key: string): string[] {
  if (!key.endsWith('/')) return [key];
  return fs.readdirSync(path.join(ROOT, key), { recursive: true })
    .map(String).filter(file => file.endsWith('.ts')).map(file => key + file.replace(/\\/g, '/'));
}

export function selectionGaps(golden: Golden, maps: Maps, globals: string[], modulesFor = expandModule): string[] {
  const gaps: string[] = [];
  for (const [key, sources] of Object.entries(golden.modules)) {
    for (const module of modulesFor(key)) {
      for (const lane of LANES) {
        const result = selectTests([module], maps[lane], globals);
        if (result.reason.startsWith('global')) continue;
        const selected = new Set(result.selected);
        for (const source of sources) {
          const recorded = golden.sources[source]?.[lane];
          if (recorded === undefined) { gaps.push(`${module}  no recorded ${lane} selection for source ${source}`); continue; }
          const missing = recorded === 'global' ? ['(every eval: source was a global touchfile)'] : recorded.filter(name => !selected.has(name));
          if (missing.length) gaps.push(`${module}  ${lane} misses ${missing.join(', ')} (selected by ${source} before the move)`);
        }
      }
    }
  }
  return gaps;
}

function formatGaps(gaps: string[], file: string): string {
  return [
    `Touchfile move coverage: ${gaps.length} gap(s):`,
    ...gaps.map(gap => `  ${gap}`),
    'Rule: code moved out of a file keeps that file\'s paid-eval selection, so an edit to the new module still runs the evals the old file ran.',
    'Fix: add the new module (or a directory glob such as \'test/helpers/pty/**\') to every touchfile entry that lists its source file in test/helpers/touchfiles-data.ts (E2E, LLM judge, or GLOBAL_TOUCHFILES).',
    `Golden: ${GOLDEN_DIR}/${file}; re-record a source's selection only for a deliberate, reviewed touchfile change.`,
  ].join('\n');
}

const goldens = fs.readdirSync(path.join(ROOT, GOLDEN_DIR)).filter(file => file.endsWith('.json')).sort();

describe('touchfile coverage for moved code', () => {
  test('at least one golden is recorded', () => {
    expect(goldens.length).toBeGreaterThan(0);
  });

  test.each(goldens)('%s: every moved module exists and selects a superset of its sources', file => {
    const golden = JSON.parse(fs.readFileSync(path.join(ROOT, GOLDEN_DIR, file), 'utf8')) as Golden;
    for (const key of Object.keys(golden.modules)) {
      const modules = expandModule(key);
      expect(modules.length, `${key} in ${GOLDEN_DIR}/${file} names no files`).toBeGreaterThan(0);
      for (const module of modules) expect(fs.existsSync(path.join(ROOT, module)), `${module} is listed in ${GOLDEN_DIR}/${file} but does not exist`).toBe(true);
    }
    const gaps = selectionGaps(golden, MAPS, GLOBAL_TOUCHFILES);
    if (gaps.length) throw new Error(formatGaps(gaps, file));
  });

  test('a planted module missing one source entry, or a dropped global source, is reported with the fix', () => {
    const golden: Golden = {
      workstream: 'planted', recordedAt: 'test',
      sources: {
        'src/old.ts': { e2e: ['eval-a', 'eval-b'], llmJudge: [] },
        'src/global.ts': { e2e: 'global', llmJudge: [] },
      },
      modules: { 'src/new/': ['src/old.ts'], 'src/moved-global.ts': ['src/global.ts'] },
    };
    const maps: Maps = { e2e: { 'eval-a': ['src/old.ts', 'src/new/**'], 'eval-b': ['src/old.ts'] }, llmJudge: {} };
    const gaps = selectionGaps(golden, maps, ['src/global.ts'], key => key.endsWith('/') ? ['src/new/module.ts'] : [key]);
    expect(gaps).toEqual([
      'src/new/module.ts  e2e misses eval-b (selected by src/old.ts before the move)',
      'src/moved-global.ts  e2e misses (every eval: source was a global touchfile) (selected by src/global.ts before the move)',
    ]);
    expect(formatGaps(gaps, 'planted.json')).toContain('Fix: add the new module');
    expect(formatGaps(gaps, 'planted.json')).toContain(`Golden: ${GOLDEN_DIR}/planted.json`);
  });
});
