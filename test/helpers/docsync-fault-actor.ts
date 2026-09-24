import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { DOC_PATH, fixtureDocs } from './docsync-fixture';

export type DocsFault = 'missing-marker' | 'missing-asset' | 'launch-failure' | 'timeout-unsettled' |
  'late-result' | 'stale-before' | 'stale-after' | 'recovery';
export interface ActorEvent { action: string; audit_id?: string; task_id?: string; detail?: string; }
export interface DocsActorState {
  root: string;
  scenario: DocsFault;
  events: ActorEvent[];
  tasks: Array<{ id: string; audit_id: string; settled: boolean; stopRequested: boolean; elapsed_ms: number;
    prompt: string; candidate: string; prompt_sha256: string; candidate_sha256: string }>;
  repaired: boolean;
  armed: boolean;
  lateChanged: boolean;
  acceptedId: string | null;
}

function owned(root: string, file: string): string {
  const absolute = path.resolve(file);
  if (!absolute.startsWith(fs.realpathSync(root) + path.sep)) throw Error('actor path outside fixture');
  const existing = fs.existsSync(absolute) ? absolute : path.dirname(absolute);
  if (!fs.realpathSync(existing).startsWith(fs.realpathSync(root) + path.sep)) throw Error('actor symlink escape');
  return absolute;
}

function load(file: string): DocsActorState {
  const s = JSON.parse(fs.readFileSync(file, 'utf8')) as DocsActorState;
  owned(s.root, file);
  return s;
}

function save(file: string, state: DocsActorState) {
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
}

function locked<T>(file: string, body: () => T): T {
  const lock = file + '.lock';
  const fd = fs.openSync(lock, 'wx', 0o600);
  try { return body(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

function changeCandidate(s: DocsActorState) {
  fs.writeFileSync(path.join(s.root, 'repo/app.ts'), 'export const format = "json";\n');
  s.lateChanged = true;
  s.armed = false;
  s.events.push({ action: 'scheduled-input-edit', detail: 'app.ts' });
}

export function docsActorCommand(file: string, action: string, args: Record<string, string> = {}): { text: string; exit: number } {
  return locked(file, () => {
    const s = load(file);
    let text = '';
    let exit = 0;
    const last = () => {
      const task = s.tasks.find(t => t.id === args.task_id);
      if (!task) throw Error('unknown fixture child');
      return task;
    };
    const complete = (auditId: string, status: 'current' | 'updated' | 'blocked', blockers: string[] = [], updated: string[] = []) => {
      return `SESSION_KIND: ${blockers.includes('Missing spawned marker') ? 'interactive' : 'spawned'}\n` + JSON.stringify({
        schema_version: 1, audit_id: auditId, status, files_updated: updated,
        files_reviewed: blockers.length ? [] : [DOC_PATH],
        documentation_section: `${status} — fixture child audit ${auditId}; ${blockers.length ? blockers.join('; ') : 'reviewed the selected command reference'}.`,
        blockers, decisions: [],
      });
    };
    try {
      if (action === 'dispatch') {
        if (!args.audit_id || args.run_in_background !== 'false') throw Error('dispatch requires identity and explicit foreground flag');
        if (s.tasks.some(t => !t.settled)) throw Error('attempted writer overlap');
        if (s.tasks.some(t => t.audit_id === args.audit_id)) throw Error('reused audit identity');
        const prompt = fs.readFileSync(owned(s.root, args.prompt), 'utf8');
        const candidate = fs.readFileSync(owned(s.root, args.candidate));
        if (!prompt.includes('document-release') || !prompt.includes('files_updated') || !prompt.includes(args.audit_id)) throw Error('dispatch did not carry the actual workflow prompt');
        const task = { id: `fixture-child-${s.tasks.length + 1}`, audit_id: args.audit_id, settled: true, stopRequested: false, elapsed_ms: 0,
          prompt, candidate: candidate.toString('utf8'), prompt_sha256: createHash('sha256').update(prompt).digest('hex'),
          candidate_sha256: createHash('sha256').update(candidate).digest('hex') };
        s.tasks.push(task);
        s.events.push({ action, audit_id: args.audit_id, task_id: task.id });
        if (s.scenario === 'missing-asset') throw Error('missing installed asset must block before dispatch');
        if (s.scenario === 'launch-failure') {
          exit = 23;
          text = 'Child launch failed: injected unavailable worker. No child was started.';
        } else if (s.scenario === 'missing-marker' || s.scenario === 'recovery' && !s.repaired) {
          text = complete(args.audit_id, 'blocked', ['Missing spawned marker']);
        } else if (s.scenario === 'timeout-unsettled' || s.scenario === 'late-result' && s.tasks.length === 1) {
          task.settled = false;
          text = JSON.stringify({ task_id: task.id, status: 'running', elapsed_ms: 0, virtual_clock: true });
        } else if (s.scenario === 'late-result') {
          if (!s.repaired) throw Error('transport must be repaired before retry');
          text = complete(s.tasks[0].audit_id, 'current');
          s.events.push({ action: 'late-callback', audit_id: s.tasks[0].audit_id });
        } else if (s.scenario.startsWith('stale-') && s.tasks.length === 1) {
          if (s.scenario === 'stale-before') changeCandidate(s);
          else s.armed = true;
          text = complete(args.audit_id, 'current');
          s.events.push({ action: 'completion', audit_id: args.audit_id });
        } else {
          const updated: string[] = [];
          if (s.lateChanged) {
            const doc = path.join(s.root, 'repo', DOC_PATH);
            fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace('Default format: text.', 'Default format: JSON.'));
            updated.push(DOC_PATH);
            s.events.push({ action: 'factual-doc-edit', audit_id: args.audit_id, detail: DOC_PATH });
          }
          s.acceptedId = args.audit_id;
          text = complete(args.audit_id, updated.length ? 'updated' : 'current', [], updated);
          s.events.push({ action: 'completion', audit_id: args.audit_id });
        }
      } else if (action === 'status') {
        const task = last();
        task.elapsed_ms += task.stopRequested ? 300_001 : 600_001;
        s.events.push({ action, task_id: task.id, detail: task.settled ? 'settled' : 'running' });
        text = JSON.stringify({ task_id: task.id, status: task.settled ? 'stopped' : 'running', settled: task.settled,
          elapsed_ms: task.elapsed_ms, virtual_clock: true });
      } else if (action === 'stop') {
        const task = last();
        task.stopRequested = true;
        if (s.scenario !== 'timeout-unsettled') task.settled = true;
        s.events.push({ action, task_id: task.id, detail: task.settled ? 'settled' : 'unsettled' });
        text = JSON.stringify({ task_id: task.id, stop_requested: true, settled: task.settled });
      } else if (action === 'repair') {
        if (!['recovery', 'late-result'].includes(s.scenario) || s.repaired || !s.tasks.length || s.tasks.some(t => !t.settled)) throw Error('repair not available');
        s.repaired = true;
        s.events.push({ action, detail: 'fixture transport/marking repaired' });
        text = 'Fixture transport/marking repaired; future dispatches use the corrected launcher.';
      } else if (action === 'publish') {
        s.events.push({ action, audit_id: args.audit_id });
        if (!s.acceptedId || args.audit_id !== s.acceptedId || s.tasks.some(t => !t.settled)) throw Error('publication attempted without a current settled audit');
        const report = fs.readFileSync(owned(s.root, args.report), 'utf8');
        if (!report.includes(s.acceptedId)) throw Error('publication did not consume actual audit result');
        fs.writeFileSync(path.join(s.root, 'publication.json'), JSON.stringify({ audit_id: s.acceptedId, report }), { mode: 0o600 });
        text = 'Mock publication recorded.';
      } else throw Error('unsupported fixture action');
    } catch (error) {
      s.events.push({ action: 'rejected', audit_id: args.audit_id, detail: String(error) });
      text = String(error);
      exit = 24;
    }
    save(file, s);
    return { text, exit };
  });
}

export function docsActorHook(file: string, input: string) {
  return locked(file, () => {
    const s = load(file);
    const e = JSON.parse(input);
    if (s.armed && e.hook_event_name === 'PreToolUse' && e.cwd === path.join(s.root, 'repo') &&
        !JSON.stringify(e.tool_input ?? {}).includes('docsync-fault-actor.ts')) {
      changeCandidate(s);
      save(file, s);
    }
  });
}

export function installDocsActor(fixture: ReturnType<typeof fixtureDocs>, scenario: DocsFault): string {
  const file = path.join(fixture.home, 'actor-state.json');
  save(file, { root: fixture.home, scenario, events: [], tasks: [], repaired: false, armed: false, lateChanged: false, acceptedId: null });
  const configFile = path.join(fixture.env.CLAUDE_CONFIG_DIR, 'settings.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const quote = (p: string) => `'${p.replaceAll("'", "'\\''")}'`;
  config.hooks.PreToolUse.push({ matcher: '^(Bash|Read|Write|Edit|Glob|Grep)$', hooks: [{ type: 'command',
    command: `${quote(process.execPath)} ${quote(import.meta.path)} hook ${quote(file)}`, timeout: 5 }] });
  fs.writeFileSync(configFile, JSON.stringify(config));
  if (scenario === 'missing-asset') fs.unlinkSync(path.join(fixture.skills, 'document-release/sections/audit-scope.md'));
  return file;
}

if (import.meta.main) {
  const [action, file, ...rest] = process.argv.slice(2);
  if (action === 'hook') docsActorHook(file, fs.readFileSync(0, 'utf8'));
  else {
    const args = Object.fromEntries(rest.map(arg => {
      const at = arg.indexOf('=');
      if (at < 1) throw Error('fixture arguments use key=value');
      return [arg.slice(0, at), arg.slice(at + 1)];
    }));
    const result = docsActorCommand(file, action, args);
    console.log(result.text);
    process.exitCode = result.exit;
  }
}
