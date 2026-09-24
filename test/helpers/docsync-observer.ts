import * as fs from 'node:fs';
import * as path from 'node:path';
import { observeQAWrites, type QAWriteObservation } from './qa-functional-observer';
import type { SkillTestResult } from './session-runner';
import { DOC_PATH, type fixtureDocs } from './docsync-fixture';

export async function observeDocsWrites(fixture: ReturnType<typeof fixtureDocs>) {
  return observeQAWrites(fixture.repo);
}

export function docsWriteFailures(observation: QAWriteObservation, allowed: string[]): string[] {
  const failures = [...observation.failures];
  if (!observation.complete) failures.push('incomplete docs write observation');
  for (const file of new Set([...observation.events.map(e => e.path), ...observation.changed])) {
    if (file !== '.qa-state/.observer-check' && !allowed.includes(file)) failures.push(`forbidden docs write: ${file}`);
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
