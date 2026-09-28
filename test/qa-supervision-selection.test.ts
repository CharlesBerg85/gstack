import { expect, test } from 'bun:test';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const ptyIds = [
  'plan-ceo-review-plan-mode', 'plan-eng-review-plan-mode', 'plan-design-review-plan-mode',
  'plan-devex-review-plan-mode', 'plan-mode-no-op', 'office-hours-auto-mode',
  'auto-decide-preserved', 'conductor-prose', 'plan-ceo-mode-routing', 'plan-design-with-ui-scope',
  'ship-idempotency-pty', 'autoplan-chain-pty', 'plan-ceo-finding-count', 'plan-eng-finding-count',
  'plan-design-finding-count', 'plan-devex-finding-count', 'plan-eng-finding-floor',
  'plan-ceo-finding-floor', 'plan-design-finding-floor', 'plan-devex-finding-floor',
  'plan-eng-multi-finding-batching', 'plan-ceo-split-overflow',
].sort();

test('PTY supervision controls select every current runner consumer', () => {
  expect(selectTests(['test/pty-screen-supervision.test.ts'], E2E_TOUCHFILES).selected.sort()).toEqual(ptyIds);
  expect(selectTests(['test/helpers/claude-pty-runner.ts'], E2E_TOUCHFILES).selected.sort()).toEqual(ptyIds);
});

test('screen changes also select UI and all finding-floor consumers', () => {
  const screenIds = ptyIds.filter(id => !['office-hours-auto-mode', 'ship-idempotency-pty'].includes(id));
  expect(selectTests(['test/helpers/pty-screen.ts'], E2E_TOUCHFILES).selected.sort()).toEqual(screenIds);
});

test.each([
  'test/helpers/bootstrap-retention.ts', 'test/bootstrap-retention.test.ts',
  'test/bootstrap-session-lifecycle.test.ts', 'test/bootstrap-retention-shard.test.ts',
])('%s selects the actual bootstrap contract', file => {
  expect(selectTests([file], E2E_TOUCHFILES).selected).toEqual(['qa-bootstrap']);
});
