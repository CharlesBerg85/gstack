import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

function suppliedCountPlan() {
  // Execute only the actual pure prompt builder, never import its paid test.
  const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-plan-eng-finding-count.test.ts'), 'utf8');
  const start = source.indexOf('const planEng5Findings = ');
  const end = source.indexOf("].join('\\n');", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const builder = new Function(new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end + "].join('\\n');".length)) + '\nreturn planEng5Findings;')();
  return builder('/fixture-only/reviewed-plan.md') as string;
}

test('count fixture supplies the author-owned RequestPolicy contract before review', () => {
  const plan = suppliedCountPlan();
  const context = plan.split('## Context supplied by the plan author\n')[1]?.split('\n## ')[0];
  expect(context).toBeDefined();
  expect(context).toContain('without changing\nits product behavior');
  expect(context).toContain('given already-fetched claims and tenant/request context');
  expect(context).toContain('returns\nallow or deny under the existing access policy');
  expect(context).toContain('AuthBroker.validateAndDispatch()\ncalls it after validation and before dispatch');
  expect(context).toContain('adds no policy, network call,\ncache mutation or state');
  expect(context).toContain('class boundary remains a proposal to review');
  expect(plan).toContain('to /fixture-only/reviewed-plan.md (use Edit/Write to that exact path)');
});

test('count fixture retains all five seeded defects and a coherent class inventory', () => {
  const plan = suppliedCountPlan();
  for (const defect of [
    'Two new services (`AuthBroker` and `SessionMint`) share a global mutable\n`AuthCache` instance via module-level export. Both services mutate it.',
    'The `validateAndDispatch()` function is 60 lines with three nested\ntry/catch blocks; each catch swallows a different error class.',
    'The existing `legacyAuthFlow()` will get rewritten as part of this work;\nno regression test for the prior behavior is planned.',
    'Token validation issues 5 sequential API calls to the IDP; they could be\nparallelized via Promise.all trivially (calls are independent).',
    'This touches 12 files and introduces 5 new classes',
  ]) expect(plan).toContain(defect);
  expect(plan).toContain('unchanged validity and tenant-key rules; they do not serialize mutations');
  expect(plan).toContain('That coverage does not exercise legacyAuthFlow() or\nassert compatibility with its prior behavior');
  const inventory = /introduces (\d+) new classes \(([^)]+)\)/.exec(plan);
  expect(inventory).not.toBeNull();
  const names = inventory![2]!.split(/,\s*/);
  expect(names).toEqual(['AuthBroker', 'TokenStore', 'SessionMint', 'AuthCache', 'RequestPolicy']);
  expect(new Set(names).size).toBe(Number(inventory![1]));
});
