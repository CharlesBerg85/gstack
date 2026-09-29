import { describe, expect, test } from 'bun:test';
import { E2E_TIERS, E2E_TOUCHFILES, GLOBAL_TOUCHFILES, selectTests } from './helpers/touchfiles';

function selectedBy(file: string) {
  return selectTests([file], E2E_TOUCHFILES, GLOBAL_TOUCHFILES).selected;
}

describe('Codex eval selection', () => {
  test('recording-helper changes select every recorded Codex case in the periodic tier', () => {
    const selected = selectedBy('test/helpers/codex-eval.ts');
    expect(selected.sort()).toEqual([
      'codex-discover-skill',
      'codex-review-findings',
      'codex-sol-scope-termination',
    ].sort());
    expect(selected.every((id) => E2E_TIERS[id] === 'periodic')).toBe(true);
  });

  test('Sol fixture generation changes select its periodic case', () => {
    for (const file of ['test/helpers/sol-skill-fixture.ts', 'test/sol-skill-fixture.test.ts']) {
      expect(selectedBy(file)).toEqual(['codex-sol-scope-termination']);
    }
    expect(E2E_TIERS['codex-sol-scope-termination']).toBe('periodic');
  });

});
