/**
 * Static and offline pins for `bun run test:ubicloud` (scripts/ubicloud/).
 * The VM path needs a Ubicloud token and costs money, so it is exercised by
 * hand; these checks keep its environment from drifting away from the
 * required CI free lane it mirrors, and prove it fails before any network
 * call when the token is absent.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const DIR = join(ROOT, 'scripts/ubicloud');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

type Step = { uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> };
const workflow = Bun.YAML.parse(read('.github/workflows/free-tests.yml')) as { jobs: Record<string, { steps: Step[] }> };
const freeSuite = workflow.jobs['free-suite'].steps;

describe('ubicloud free-suite runner', () => {
  test('setup pins the same Bun version as the CI free-suite job', () => {
    const ciBun = freeSuite.find(step => step.uses?.startsWith('oven-sh/setup-bun'))?.with?.['bun-version'];
    expect(ciBun).toBeDefined();
    expect(read('scripts/ubicloud/setup-free-suite.sh')).toContain(`BUN_VERSION=${ciBun}\n`);
  });

  test('setup performs the CI job’s build steps', () => {
    const setup = read('scripts/ubicloud/setup-free-suite.sh');
    for (const command of ['bun install --frozen-lockfile', 'bun run gen:skill-docs --host all', 'bun run vendor:xterm',
      'bash browse/scripts/build-node-server.sh', 'bun run build:gates', 'bun run build:cso']) {
      expect(freeSuite.some(step => step.run?.includes(command))).toBe(true);
      expect(setup).toContain(command);
    }
    expect(setup).toContain('chrome-sandbox');
    expect(setup).toContain('kernel.apparmor_restrict_unprivileged_userns=0');
  });

  test('the wrapper runs the suite under Xvfb with the CI lane’s strictness knobs', () => {
    const ciEnv = freeSuite.find(step => step.run?.includes('bun run test:free'))?.env ?? {};
    const wrapper = read('scripts/ubicloud/test-free.sh');
    expect(ciEnv.GSTACK_EXPECT_BINARIES).toBe('1');
    expect(ciEnv.GSTACK_FREE_RETRY_FLAKY).toBe('1');
    expect(wrapper).toContain('--env GSTACK_EXPECT_BINARIES=1');
    expect(wrapper).toContain('--env GSTACK_FREE_RETRY_FLAKY=1');
    expect(wrapper).toContain('xvfb-run -a bun run test:free');
    expect(JSON.parse(read('package.json')).scripts['test:ubicloud']).toBe('bash scripts/ubicloud/test-free.sh');
  });

  test('remote commands force umask 022 and teardown is trapped on exit', () => {
    const runner = read('scripts/ubicloud/ubi-runner.sh');
    expect(runner).toContain('"umask 022; $*"');
    expect(runner).toMatch(/trap 'cmd_down "\$RUN_VM"[^']*' EXIT/);
  });

  test('refuses to start without UBICLOUD_API_KEY, before any network call', () => {
    const env = { ...process.env, UBICLOUD_API_URL: 'http://127.0.0.1:9' } as Record<string, string | undefined>;
    delete env.UBICLOUD_API_KEY;
    const result = Bun.spawnSync(['bash', join(DIR, 'ubi-runner.sh'), 'list'], { env, timeout: 10_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('UBICLOUD_API_KEY is not set');
    expect(result.stdout.toString()).toBe('');
  });
});
