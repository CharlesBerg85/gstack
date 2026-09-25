import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { observeQAWrites, type QAWriteObservation } from './qa-functional-observer';
import { nativeCalls } from './qa-checkpoint-evidence';
import type { SkillTestResult } from './session-runner';
import { DOC_PATH, type fixtureDocs } from './docsync-fixture';

export async function observeDocsWrites(fixture: ReturnType<typeof fixtureDocs>) {
  return observeQAWrites(fixture.repo);
}

type DocsWriteContext = {
  result: SkillTestResult;
  fixture: ReturnType<typeof fixtureDocs>;
  scripts?: string[];
  readOnly?: boolean;
};

function docsAtomicSources(observation: QAWriteObservation, allowed: string[], context?: DocsWriteContext): Set<string> {
  const denied = new Set<string>();
  if (!context || context.readOnly || !allowed.includes(DOC_PATH) || !observation.complete || observation.failures.length) return denied;
  const { result, fixture, scripts = [] } = context;
  if (result.exitReason !== 'success' || !Array.isArray(result.transcript) || docsToolFailures(result, fixture, scripts).length) return denied;
  const failures: string[] = [];
  const target = path.join(fixture.repo, DOC_PATH);
  const calls = nativeCalls(result.transcript, failures).filter(call => ['Write', 'Edit'].includes(call.name)
    && typeof call.input.file_path === 'string' && path.resolve(fixture.repo, call.input.file_path) === target);
  if (failures.length || !calls.length || calls.some((call, index) => call.failed || call.end <= call.start || (index > 0 && call.start <= calls[index - 1].end))) return denied;
  const before = observation.before[DOC_PATH];
  const after = observation.after[DOC_PATH];
  if (!/^\d+:[a-f0-9]{64}$/.test(before ?? '') || !/^\d+:[a-f0-9]{64}$/.test(after ?? '') || before.split(':')[0] !== after.split(':')[0]) return denied;
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  let contentHash = before.split(':')[1];
  const seen = new Set([contentHash]);
  for (const call of calls) {
    const event = result.transcript[call.end];
    const payload = event.tool_use_result;
    const results = event.message.content.filter((block: any) => block?.type === 'tool_result');
    if (results.length !== 1 || (results[0].is_error !== undefined && results[0].is_error !== false) || !payload || payload.filePath !== target
      || payload.userModified !== false || typeof payload.originalFile !== 'string' || hash(payload.originalFile) !== contentHash) return denied;
    let content: string;
    if (call.name === 'Write') {
      if (payload.type !== 'update' || typeof call.input.content !== 'string' || payload.content !== call.input.content) return denied;
      content = call.input.content;
    } else {
      const { old_string: old, new_string: replacement, replace_all: all = false } = call.input;
      if (typeof old !== 'string' || !old || typeof replacement !== 'string' || typeof all !== 'boolean'
        || payload.oldString !== old || payload.newString !== replacement || payload.replaceAll !== all) return denied;
      const parts = payload.originalFile.split(old);
      if (parts.length < 2 || (!all && parts.length !== 2)) return denied;
      content = parts.join(replacement);
    }
    contentHash = hash(content);
    if (seen.has(contentHash)) return denied;
    seen.add(contentHash);
  }
  if (contentHash !== after.split(':')[1]) return denied;
  const events = observation.events;
  const destinations = events.flatMap((event, index) => event.path === DOC_PATH && event.mask === 0x80 ? [index] : []);
  if (destinations.length !== calls.length) return denied;
  const sources = new Set<string>();
  let previous = -1;
  for (const destination of destinations) {
    const move = events[destination];
    if (!Number.isInteger(move.cookie) || move.cookie <= 0 || move.cookie > 0xffffffff) return denied;
    const pair = events.flatMap((event, index) => event.cookie === move.cookie ? [index] : []);
    if (pair.length !== 2 || pair[1] !== destination) return denied;
    const source = events[pair[0]];
    if (source.mask !== 0x40 || source.path === DOC_PATH || path.dirname(source.path) !== path.dirname(DOC_PATH)
      || Object.hasOwn(observation.before, source.path) || Object.hasOwn(observation.after, source.path) || sources.has(source.path)) return denied;
    const lifecycle = events.flatMap((event, index) => event.path === source.path ? [{ event, index }] : []);
    if (lifecycle[0]?.event.mask !== 0x100 || lifecycle[0].index <= previous || lifecycle.at(-1)?.index !== pair[0]) return denied;
    let modified = false;
    let closed = false;
    for (const { event, index } of lifecycle) {
      if (index === pair[0]) { if (!modified || !closed) return denied; continue; }
      if (event.cookie !== 0) return denied;
      if (index === lifecycle[0].index) continue;
      if (event.mask === 0x2 && !closed) modified = true;
      else if (event.mask === 0x4 && !closed) continue;
      else if (event.mask === 0x8 && modified) closed = true;
      else return denied;
    }
    sources.add(source.path);
    previous = destination;
  }
  if (events.some((event, index) => event.path === DOC_PATH && (index < destinations[0]
    || ![0x80, 0x4, 0x400, 0x800].includes(event.mask) || (event.mask !== 0x80 && event.cookie !== 0)))) return denied;
  for (const [index, destination] of destinations.entries()) {
    const replaced = events.slice(destination + 1, destinations[index + 1]).filter(event => event.path === DOC_PATH);
    if (replaced.filter(event => event.mask === 0x4).length !== 1 || replaced.filter(event => event.mask === 0x400).length !== 1
      || replaced.filter(event => event.mask === 0x800).length > 1) return denied;
  }
  return sources;
}

export function docsWriteFailures(observation: QAWriteObservation, allowed: string[], context?: DocsWriteContext): string[] {
  const failures = [...observation.failures];
  if (!observation.complete) failures.push('incomplete docs write observation');
  const atomicSources = docsAtomicSources(observation, allowed, context);
  for (const file of new Set([...observation.events.map(e => e.path), ...observation.changed])) {
    if (file !== '.qa-state/.observer-check' && !allowed.includes(file) && !atomicSources.has(file)) failures.push(`forbidden docs write: ${file}`);
    if (allowed.includes(file) && observation.before[file] && observation.after[file] &&
        observation.before[file].split(':')[0] !== observation.after[file].split(':')[0]) failures.push(`document mode changed: ${file}`);
  }
  return failures;
}

export function docsPreambleCommands(fixture: ReturnType<typeof fixtureDocs>): string[] {
  const source = fs.readFileSync(path.join(fixture.skills, 'document-release/SKILL.md'), 'utf8');
  const section = source.slice(source.indexOf('## Preamble (run first)'));
  const command = section.match(/```bash\n([\s\S]*?)\n```/)?.[1];
  if (!command) throw Error('native docs preamble missing');
  return [command, command.replace(/(^|\n)("\$_SS" --skill)/, '$1GSTACK_SESSION_KIND=spawned $2')];
}

export function docsCommandAllowed(command: string, fixture: ReturnType<typeof fixtureDocs>, scripts: string[] = []): boolean {
  const text = command.trim();
  if (docsPreambleCommands(fixture).some(block => block.trim() === text)) return true;
  if (/[\n\r;&|<>`$\\(){}]/.test(text)) return false;
  const args = text.match(/'[^']*'|"[^"]*"|[^\s'"]+/g)?.map(s => /^['"]/.test(s) ? s.slice(1, -1) : s) ?? [];
  if (!args.length) return false;
  const [commandName, ...rest] = args;
  if (args.some(arg => path.basename(arg) === 'actor-state.json') &&
      !((commandName === 'bun' || commandName === process.execPath) && scripts.includes(rest[0]))) return false;
  if (['pwd', 'ls', 'cat', 'sha256sum', 'stat'].includes(commandName)) return true;
  if (commandName === 'git') {
    if (rest.some(arg => /^(?:--output|--ext-diff|--textconv|-w)(?:=|$)/.test(arg))) return false;
    if (rest[0] === 'branch') return rest.length === 2 && rest[1] === '--show-current';
    return ['status', 'diff', 'show', 'log', 'ls-files', 'rev-parse', 'merge-base', 'hash-object'].includes(rest[0]);
  }
  if (commandName === 'bun' || commandName === process.execPath) {
    return scripts.includes(rest[0]);
  }
  const marker = 'GSTACK_SESSION_KIND=spawned';
  const start = path.join(fixture.skills, 'bin/gstack-skill-start');
  const end = path.join(fixture.skills, 'bin/gstack-skill-end');
  return (commandName === marker && rest[0] === start || commandName === start || commandName === end) && args.includes('document-release');
}

export function docsNativeInterface(fixture: ReturnType<typeof fixtureDocs>, scripts: string[] = []): string {
  return `Fixture observation interface (applies to parent and every child; include this interface in child prompts): Bash may execute only separate literal pwd, ls, cat, stat, sha256sum, Git read commands (status, diff, show, log, ls-files, rev-parse, merge-base, hash-object without -w, branch --show-current), the exact generated Preamble block with its spawned prefix, or literal installed gstack-skill-start/gstack-skill-end commands for document-release (start requires GSTACK_SESSION_KIND=spawned). No shell composition, custom interpreters, arbitrary scripts, inline eval or memory-mapped writes. The only additional scripts are ${scripts.length ? scripts.join(', ') : 'none'}. Read/Glob/Grep remain available. Use Write/Edit for permitted docs and private JSON/Markdown artifacts under ${fixture.home}; do not rewrite installed skills, config, actor state or scripts. No effects outside the owned fixture. The owner preserves evidence and cleans up. Missing observer coverage blocks acceptance; the Linux kernel monitor covers syscall writes in the product tree, not hostile processes or arbitrary external destinations.`;
}

function within(file: string, root: string): boolean {
  return file === root || file.startsWith(root + path.sep);
}

function actualWritePath(file: string): string | null {
  let ancestor = file;
  const missing: string[] = [];
  while (!fs.existsSync(ancestor) && !fs.lstatSync(ancestor, { throwIfNoEntry: false })) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return null;
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  try {
    return path.join(fs.realpathSync(ancestor), ...missing);
  } catch {
    return null;
  }
}

export function docsToolFailures(result: SkillTestResult, fixture: ReturnType<typeof fixtureDocs>, scripts: string[] = [], readOnly = false): string[] {
  const failures: string[] = [];
  const home = fs.realpathSync(fixture.home);
  const repo = fs.realpathSync(fixture.repo);
  const authoredDoc = path.join(repo, DOC_PATH);
  const protectedRoots = [fixture.skills, fixture.env.CLAUDE_CONFIG_DIR, fixture.env.GSTACK_HOME,
    path.join(fixture.home, 'remote.git')];
  for (const call of result.toolCalls) {
    if (call.tool === 'Bash' && !docsCommandAllowed(String(call.input?.command ?? ''), fixture, scripts)) failures.push('command outside declared docs observation interface');
    if (['Write', 'Edit'].includes(call.tool)) {
      const file = path.resolve(fixture.repo, call.input?.file_path ?? '');
      const actual = actualWritePath(file);
      const productWrite = within(file, fixture.repo) || (actual !== null && within(actual, repo));
      if (readOnly && productWrite) failures.push('read-only docs write attempt');
      const allowedDoc = file === path.join(fixture.repo, DOC_PATH) && actual === authoredDoc;
      if (productWrite && !allowedDoc) {
        failures.push('non-document product write attempt');
      }
      if (!within(file, fixture.home) || !actual || !within(actual, home) ||
          (!allowedDoc &&
          (productWrite || !/\.(?:json|md|markdown)$/i.test(file) || !/\.(?:json|md|markdown)$/i.test(actual) ||
            protectedRoots.some(root => within(file, root) || within(actual, actualWritePath(root) ?? root)) ||
            scripts.some(script => file === script || actual === actualWritePath(script)) ||
            path.basename(file) === 'actor-state.json' || path.basename(actual) === 'actor-state.json')))
        failures.push('write outside docs fixture authority');
    }
    if (call.tool === 'Read' && path.basename(call.input?.file_path ?? '') === 'actor-state.json') failures.push('private actor state was read');
  }
  return failures;
}

export function docsCompletedRead(result: SkillTestResult, file: string, fixture: ReturnType<typeof fixtureDocs>,
  options: { source?: string; beforeFirstEdit?: boolean } = {}): boolean {
  const source = (options.source ?? fs.readFileSync(file, 'utf8')).trim();
  if (!source) return false;
  const target = path.resolve(file);
  const resolve = (p: string) => path.resolve(p.startsWith('~/') ? path.join(fixture.home, p.slice(2)) : path.resolve(fixture.repo, p));
  for (const call of result.toolCalls) {
    if (options.beforeFirstEdit && ['Write', 'Edit'].includes(call.tool) && resolve(call.input?.file_path ?? '') === target) break;
    const read = call.tool === 'Read' && resolve(call.input?.file_path ?? '') === target;
    const command = String(call.input?.command ?? '').trim();
    const catArgs = /^cat\s+/.test(command) && !/[\n\r;&|<>`$\\(){}]/.test(command)
      ? command.match(/'[^']*'|"[^"]*"|[^\s'"]+/g)?.slice(1).map(arg => /^['"]/.test(arg) ? arg.slice(1, -1) : arg) ?? [] : [];
    const cat = call.tool === 'Bash' && catArgs.some(arg => resolve(arg) === target);
    if ((read || cat) && !/^(?:<tool_use_error>|Error(?: reading file|:)|Exit code [1-9]\d*\b)/i.test(call.output.trimStart()) &&
        call.output.replace(/^\s*\d+(?:→|\t)/gm, '').includes(source)) return true;
  }
  return false;
}
