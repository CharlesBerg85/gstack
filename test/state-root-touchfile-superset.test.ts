/**
 * Touchfile coverage for W1's new modules: touching lib/state-root.ts,
 * bin/gstack-state-root.sh or hosts/claude/hooks/hook-log.ts must select at
 * least the paid evals their source files selected on the base commit
 * (test/fixtures/state-root-selection-golden.json, recorded before the move).
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES, GLOBAL_TOUCHFILES, selectTests } from './helpers/touchfiles';
import { resolveStateRoot } from '../lib/state-root';

const ROOT = path.resolve(import.meta.dir, '..');
const GOLDEN = 'test/fixtures/state-root-selection-golden.json';
const golden: { modules: Record<string, { sources: string[]; e2e: string[]; llmJudge: string[] }> } =
  JSON.parse(fs.readFileSync(path.join(ROOT, GOLDEN), 'utf-8'));

describe('W1 touchfile superset', () => {
  test('the golden covers every new state-root module', () => {
    expect(Object.keys(golden.modules).sort()).toEqual(['bin/gstack-state-root.sh', 'hosts/claude/hooks/hook-log.ts', 'lib/state-root.ts']);
    expect(typeof resolveStateRoot).toBe('function');
  });

  for (const [mod, rec] of Object.entries(golden.modules)) {
    test(`touching ${mod} selects a superset of ${rec.sources.join(', ')}`, () => {
      const e2e = new Set(selectTests([mod], E2E_TOUCHFILES, GLOBAL_TOUCHFILES).selected);
      const llm = new Set(selectTests([mod], LLM_JUDGE_TOUCHFILES, GLOBAL_TOUCHFILES).selected);
      const missing = [...rec.e2e.filter((t) => !e2e.has(t)), ...rec.llmJudge.filter((t) => !llm.has(t))];
      expect(missing, [
        `${mod} selects fewer paid evals than its source files did: ${missing.join(', ')}`,
        `Fix: add ${mod} to those entries in test/helpers/touchfiles-data.ts (golden: ${GOLDEN}).`,
      ].join('\n')).toEqual([]);
    });
  }
});
