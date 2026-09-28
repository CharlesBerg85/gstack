import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createBootstrapRetentionScope, registerBootstrapRetention } from './helpers/bootstrap-retention';

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-retain-'));
  roots.push(root);
  const temporary = path.join(root, 'state');
  fs.mkdirSync(temporary);
  const scope = createBootstrapRetentionScope(temporary, path.join(root, 'durable'), 'run-1');
  return { root, temporary, scope };
}

function project(temporary: string) {
  const root = fs.mkdtempSync(path.join(temporary, 'skill-e2e-bs-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  const config = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'config'], { cwd: path.join(import.meta.dir, '..'), encoding: 'utf8', timeout: 5000 });
  expect(config.status).toBe(0);
  for (const args of [['init', '-q'], ['add', '.'], ['-c', `include.path=${config.stdout.trim()}`, 'commit', '-qm', 'initial']]) {
    const result = spawnSync('git', args, { cwd: root, timeout: 5000 });
    expect(result.status, result.stderr.toString()).toBe(0);
  }
  return root;
}

function installed(root: string) {
  fs.writeFileSync(path.join(root, 'bun.lock'), '{"lockfileVersion":1,"fixture":"exact bytes"}\n');
  fs.writeFileSync(path.join(root, 'bun.lockb'), Buffer.from([0, 255, 37, 10]));
  const pkg = path.join(root, 'node_modules', '.store', 'synthetic');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"synthetic","version":"2.0.1"}\n');
  fs.writeFileSync(path.join(pkg, 'index.js'), 'export const installed = true;\n');
  fs.symlinkSync('.store/synthetic', path.join(root, 'node_modules', 'synthetic'));
}

async function settled(retention: ReturnType<typeof registerBootstrapRetention>, root: string) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: root, detached: true, stdio: 'ignore' });
  children.push(child);
  retention.lifecycle.onSpawn(child.pid!);
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  process.kill(-child.pid!, 'SIGKILL');
  await exited;
  await retention.lifecycle.onSettled({ deadline: Date.now() + 1000, exited: true });
}

function register(root: string, scope: ReturnType<typeof createBootstrapRetentionScope>) {
  return registerBootstrapRetention(root, 'run-1', { env: scope.env, deadline: Date.now() + 10000 });
}

test('paid scope creation preserves non-Linux behavior without inherited qualification authority', () => {
  const source = fs.readFileSync(path.join(import.meta.dir, '../scripts/test-paid-shards.ts'), 'utf8');
  const start = source.indexOf('  const bootstrapFile =');
  const end = source.indexOf('  let retentionFailed =', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));
  for (const platform of ['linux', 'darwin']) {
    const env: any = { GSTACK_BOOTSTRAP_RETENTION: 'ambient-unowned-scope', GSTACK_EVAL_DIR: '/owned/artifacts' };
    const logs: string[] = [];
    let created = 0;
    new Function('files', 'normalizeRelativePath', 'env', 'process', 'log', 'label', 'createBootstrapRetentionScope', 'childTmp', 'path', 'getProjectEvalDir', body)(
      ['test/skill-e2e-qa-workflow.test.ts'], (file: string) => file, env, { platform, pid: 1 },
      (line: string) => logs.push(line), 'fixture', () => { created++; return { env: { GSTACK_BOOTSTRAP_RETENTION: 'new-owned-scope' } }; },
      '/owned/tmp', path, () => '/owned/default-artifacts',
    );
    expect(created).toBe(platform === 'linux' ? 1 : 0);
    expect(env.GSTACK_BOOTSTRAP_RETENTION).toBe(platform === 'linux' ? 'new-owned-scope' : undefined);
    expect(logs.length).toBe(platform === 'linux' ? 0 : 1);
    if (platform === 'darwin') expect(logs[0]).toContain('native behavior still runs without retained-dependency qualification');
  }
});

describe.skipIf(process.platform !== 'linux')('bootstrap attempt retention boundaries', () => {
  test.each(['success', 'assertion failure'])('%s retains exact installation before fixture and shard cleanup', async outcome => {
    const { temporary, scope } = fixture();
    const root = project(temporary);
    const retention = register(root, scope);
    installed(root);
    await settled(retention, root);
    let failure: unknown;
    try {
      try { if (outcome === 'assertion failure') throw new Error('original assertion'); }
      finally { retention.cleanup(); }
    } catch (error) { failure = error; }
    expect(String(failure)).toBe(outcome === 'success' ? 'undefined' : 'Error: original assertion');
    expect(fs.existsSync(root)).toBe(false);
    const result = await scope.cleanup(Date.now() + 1000);
    expect(result.complete).toBe(true);
    expect(result.removable).toBe(true);
    fs.rmSync(temporary, { recursive: true });
    expect(fs.readFileSync(path.join(retention.artifact, 'files', 'bun.lockb'))).toEqual(Buffer.from([0, 255, 37, 10]));
    expect(fs.readFileSync(path.join(retention.artifact, 'files', 'bun.lock'), 'utf8')).toContain('exact bytes');
    const evidence = JSON.parse(fs.readFileSync(path.join(retention.artifact, 'evidence.json'), 'utf8'));
    expect(evidence.entries.filter((entry: any) => entry.kind === 'file').map((entry: any) => entry.path).sort()).toEqual([
      'bun.lock', 'bun.lockb', 'node_modules/.store/synthetic/index.js', 'node_modules/.store/synthetic/package.json', 'package.json',
    ]);
    expect(evidence.entries.find((entry: any) => entry.kind === 'link').resolved).toBe('node_modules/.store/synthetic');
    expect(evidence.registration.native.settled).toBe(true);
    expect(evidence.registration.initial.gitHead.trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.existsSync(path.join(retention.artifact, 'files/node_modules/.store/synthetic/index.js'))).toBe(false);
    expect(fs.readFileSync(path.join(retention.artifact, 'files/node_modules/.store/synthetic/package.json'), 'utf8')).toContain('2.0.1');
  });

  test('both configured retry attempts retain distinct actual roots', async () => {
    const { temporary, scope } = fixture();
    const attempts: string[] = [];
    for (let retry = 0; retry <= 1; retry++) {
      const root = project(temporary);
      const retention = register(root, scope);
      attempts.push(retention.attempt);
      installed(root);
      await settled(retention, root);
      retention.cleanup();
    }
    expect(new Set(attempts).size).toBe(2);
    expect((await scope.cleanup(Date.now() + 1000)).receipts.map(receipt => receipt.attempt).sort()).toEqual(attempts.sort());
  });

  test.each(['success', 'assertion failure', 'scope absent success', 'scope absent assertion failure'])('registered qa-bootstrap body: %s preserves installation and work budget', async outcome => {
    const { temporary, scope } = fixture();
    const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-qa-workflow.test.ts'), 'utf8');
    const start = source.indexOf("  testConcurrentIfSelected('qa-bootstrap', async () => {");
    const end = source.indexOf('  }, JUDGE_MS);', start) + '  }, JUDGE_MS);'.length;
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));
    let callback: () => Promise<void>;
    let actualRoot = '';
    let retained: ReturnType<typeof registerBootstrapRetention>;
    const scoped = !outcome.startsWith('scope absent');
    const succeeds = !outcome.endsWith('assertion failure');
    let declaredBudget = 0;
    const runSkillTest = async (options: any) => {
      actualRoot = options.workingDirectory;
      expect(path.dirname(actualRoot)).toBe(temporary);
      expect(path.basename(actualRoot)).toStartWith('skill-e2e-bs-');
      expect(options.prompt).toContain('Install vitest: bun add -d vitest');
      expect(options.timeout).toBe(120000);
      expect(options.maxTurns).toBe(12);
      expect(options.nativeLifecycle).toBe(scoped ? retained.lifecycle : undefined);
      installed(actualRoot);
      if (succeeds) fs.writeFileSync(path.join(actualRoot, 'vitest.config.ts'), 'export default {};');
      if (scoped) await settled(retained, actualRoot);
      return { exitReason: 'success' };
    };
    const names = ['testConcurrentIfSelected', 'JUDGE_MS', 'fs', 'path', 'os', 'spawnSync', 'registerBootstrapRetention', 'process', 'runId', 'runSkillTest', 'logCost', 'recordE2E', 'evalCollector', 'expect'];
    new Function(...names, body)(
      (_id: string, run: () => Promise<void>, budget: number) => { callback = run; declaredBudget = budget; },
      120000, fs, path, { tmpdir: () => temporary }, spawnSync,
      (root: string, runId: string, options: { deadline: number }) => {
        retained = registerBootstrapRetention(root, runId, { ...options, env: scope.env });
        return retained;
      },
      { env: { EVALS_RUN_ID: 'run-1', ...(scoped ? scope.env : {}) } }, 'native-run-1', runSkillTest, () => {}, () => {}, {}, expect,
    );
    expect(declaredBudget).toBe(120000);
    if (succeeds) await callback!();
    else await expect(callback!()).rejects.toThrow();
    expect(fs.existsSync(actualRoot)).toBe(false);
    const receipt = await scope.cleanup(Date.now() + 1000);
    expect(receipt.complete).toBe(true);
    expect(receipt.receipts.length).toBe(scoped ? 1 : 0);
    fs.rmSync(temporary, { recursive: true });
    if (scoped) expect(fs.existsSync(path.join(retained!.artifact, 'ack.json'))).toBe(true);
    else expect(retained!).toBeUndefined();
  });

  test.each(['missing lock', 'missing graph', 'escaping link', 'copy failure', 'ack failure', 'root replacement', 'expired deadline'])('%s fails qualification without claiming complete evidence', async failure => {
    const { temporary, scope } = fixture();
    const root = project(temporary);
    const deadline = Date.now() + (failure === 'expired deadline' ? 1500 : 10000);
    const retention = registerBootstrapRetention(root, 'run-1', { env: scope.env, deadline });
    installed(root);
    await settled(retention, root);
    if (failure === 'missing lock') for (const name of ['bun.lock', 'bun.lockb']) fs.unlinkSync(path.join(root, name));
    if (failure === 'missing graph') fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
    if (failure === 'escaping link') fs.symlinkSync(os.tmpdir(), path.join(root, 'node_modules', 'escape'));
    if (failure === 'copy failure') fs.writeFileSync(path.join(retention.artifact, 'files'), 'not a directory');
    if (failure === 'ack failure') fs.mkdirSync(path.join(retention.artifact, 'ack.json.tmp'));
    if (failure === 'root replacement') { fs.renameSync(root, root + '-original'); fs.mkdirSync(root); }
    if (failure === 'expired deadline') {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now())));
    }
    const receipt = retention.retain();
    expect(receipt.complete).toBe(false);
    expect(receipt.errors.length).toBeGreaterThan(0);
    expect(receipt.acknowledged).toBe(failure !== 'ack failure');
    if (failure === 'expired deadline') expect(receipt.errors).toContain('retention deadline expired');
    expect(fs.existsSync(root)).toBe(true);
    if (failure !== 'ack failure') expect(fs.existsSync(path.join(retention.artifact, 'evidence.json'))).toBe(true);
    expect(() => retention.cleanup()).toThrow();
    expect(fs.existsSync(root)).toBe(true);
    const fallback = await scope.cleanup(Date.now() + 1000);
    expect(fallback.complete).toBe(false);
    expect(fallback.removable).toBe(false);
  });

  test('wrong run, unowned root, replaced attempt registration and absent scope are rejected', async () => {
    const { temporary, scope, root: outer } = fixture();
    const root = project(temporary);
    expect(() => registerBootstrapRetention(root, 'wrong-run', { env: scope.env, deadline: Date.now() + 1000 })).toThrow('wrong');
    expect(() => registerBootstrapRetention(outer, 'run-1', { env: scope.env, deadline: Date.now() + 1000 })).toThrow('wrong');
    expect(() => registerBootstrapRetention(root, 'run-1', { env: {}, deadline: Date.now() + 1000 })).toThrow('runner-owned');
    const retention = register(root, scope);
    const registry = JSON.parse(scope.env.GSTACK_BOOTSTRAP_RETENTION).registry.path;
    const file = path.join(registry, retention.attempt + '.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.attempt = '../outside';
    fs.writeFileSync(file, JSON.stringify(data));
    await expect(scope.cleanup(Date.now() + 1000)).rejects.toThrow('wrong attempt');
  });

  test('live native writer cannot be acknowledged as quiescent', async () => {
    const { temporary, scope } = fixture();
    const root = project(temporary);
    const retention = register(root, scope);
    installed(root);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: root, detached: true, stdio: 'ignore' });
    children.push(child);
    retention.lifecycle.onSpawn(child.pid!);
    await expect(retention.lifecycle.onSettled({ deadline: Date.now(), exited: true })).rejects.toThrow('live');
    const receipt = retention.retain();
    expect(receipt.quiescent).toBe(false);
    expect(receipt.complete).toBe(false);
    expect(receipt.acknowledged).toBe(true);
    expect((await scope.cleanup(Date.now())).removable).toBe(false);
  });

  test('inventory mutation during capture is rejected and bounded partial evidence is acknowledged', async () => {
    const { temporary, scope } = fixture();
    const root = project(temporary);
    const retention = register(root, scope);
    installed(root);
    await settled(retention, root);
    const original = fs.readFileSync;
    let changed = false;
    const read = spyOn(fs, 'readFileSync').mockImplementation(((...args: any[]) => {
      const content = (original as any)(...args);
      if (!changed && Buffer.isBuffer(content) && content.toString() === 'export const installed = true;\n') {
        changed = true;
        fs.writeFileSync(path.join(root, 'node_modules/.store/synthetic/index.js'), 'changed installed bytes');
      }
      return content;
    }) as any);
    try {
      const receipt = retention.retain();
      expect(changed).toBe(true);
      expect(receipt.complete).toBe(false);
      expect(receipt.acknowledged).toBe(true);
      expect(receipt.errors.join(' ')).toContain('changed');
    } finally { read.mockRestore(); }
  });

  test('artifact symlinks never receive package bytes and missing acknowledgment never passes cleanup', async () => {
    const { temporary, scope, root: outer } = fixture();
    const root = project(temporary);
    const retention = register(root, scope);
    installed(root);
    await settled(retention, root);
    const outside = path.join(outer, 'outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(retention.artifact, 'files'));
    expect(retention.retain().complete).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
    fs.unlinkSync(path.join(retention.artifact, 'ack.json'));
    fs.mkdirSync(path.join(retention.artifact, 'ack.json.tmp'));
    const result = await scope.cleanup(Date.now() + 1000);
    expect(result.complete).toBe(false);
    expect(result.removable).toBe(false);
  });

  test('runner fallback terminates the registered native after callback SIGKILL and keeps durable evidence', async () => {
    const { temporary, scope, root: outer } = fixture();
    const root = project(temporary);
    const script = path.join(outer, 'callback.ts');
    fs.writeFileSync(script, `
      import { spawn } from 'node:child_process';
      import * as fs from 'node:fs';
      import { registerBootstrapRetention } from ${JSON.stringify(path.join(import.meta.dir, 'helpers/bootstrap-retention.ts'))};
      const r = registerBootstrapRetention(${JSON.stringify(root)}, 'run-1', {deadline: Date.now()+10000});
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {cwd:${JSON.stringify(root)},detached:true,stdio:'ignore'});
      r.lifecycle.onSpawn(child.pid!);
      fs.writeFileSync(${JSON.stringify(path.join(outer, 'ready.json'))}, JSON.stringify({artifact:r.artifact,pid:child.pid}));
      console.log('ready');
      setInterval(()=>{},1000);
    `);
    const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH, ...scope.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('callback did not register')), 3000);
      child.stdout!.once('data', () => { clearTimeout(timer); resolve(); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('callback exited before registration')); });
    });
    installed(root);
    const saved = JSON.parse(fs.readFileSync(path.join(outer, 'ready.json'), 'utf8'));
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    process.kill(-child.pid!, 'SIGKILL');
    await exited;
    const result = await scope.cleanup(Date.now() + 2000);
    expect(result.complete, JSON.stringify(result.receipts)).toBe(true);
    expect(result.removable).toBe(true);
    fs.rmSync(temporary, { recursive: true });
    expect(fs.existsSync(path.join(saved.artifact, 'ack.json'))).toBe(true);
    expect(fs.readFileSync(path.join(saved.artifact, 'files/bun.lock'), 'utf8')).toContain('exact bytes');
  });
});
