import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readQACheckpointFiles, validateQACheckpoints } from './helpers/qa-checkpoint-evidence';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function temporaryRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-checkpoint-')));
  roots.push(root);
  return root;
}
function use(id: string, name: string, input: unknown, parent: string | null = null): any {
  return { type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
}
function result(id: string, content: unknown, parent: string | null = null, failed = false): any {
  return { type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: failed }] } };
}
function fixture() {
  const reportRoot = temporaryRoot();
  const probes = [1, 2, 3].map(id => ({ command: id === 1 ? 'bun run probe -- happy' : 'bun run probe -- duplicate',
    observed: { id, stateRoot: `/fixture/state-${id}`, scenario: id === 1 ? 'happy' : 'duplicate', requests: [{ status: 202 }], state: { jobs: {}, effects: [] } } }));
  const transcript: any[] = [];
  let reportMarkdown = '# QA report\n';
  for (const [index, probe] of probes.entries()) {
    if (index) {
      const name = `exploration-00${index}.json`;
      const content = JSON.stringify({ observationCommand: probes[index - 1].command, observed: probes[index - 1].observed,
        hypothesis: 'Replaying this request should not apply the effect twice.', nextCommand: probe.command }, null, 2);
      fs.writeFileSync(path.join(reportRoot, name), content);
      transcript.push(use(`write-${index}`, 'Write', { file_path: path.join(reportRoot, name), content }), result(`write-${index}`, `File created successfully at: ${path.join(reportRoot, name)}`));
      reportMarkdown += `[Checkpoint ${index}](exploration-00${index}.json)\n`;
    }
    transcript.push(use(`probe-${index}`, 'Bash', { command: probe.command }), result(`probe-${index}`, JSON.stringify(probe.observed)));
  }
  return { reportRoot, probes, requiredProbes: probes.slice(1), transcript, reportMarkdown, files: readQACheckpointFiles(reportRoot) };
}
function updateNote(input: ReturnType<typeof fixture>, edit: (value: any) => void) {
  const write = input.transcript[2].message.content[0];
  const value = JSON.parse(write.input.content);
  edit(value);
  write.input.content = JSON.stringify(value);
  fs.writeFileSync(write.input.file_path, write.input.content);
  input.files = readQACheckpointFiles(input.reportRoot);
}
function rejected(input: ReturnType<typeof fixture>, message: string) {
  expect(validateQACheckpoints(input).some(failure => failure.includes(message))).toBe(true);
}

describe('QA checkpoint file reader', () => {
  test('reads only exact checkpoint basenames and preserves bytes', () => {
    const root = temporaryRoot();
    fs.writeFileSync(path.join(root, 'exploration-001.json'), ' complete bytes\n');
    for (const name of ['exploration-1.json', 'exploration-0001.json', 'report.md']) fs.writeFileSync(path.join(root, name), 'ignored');
    expect(readQACheckpointFiles(root)).toEqual({ 'exploration-001.json': ' complete bytes\n' });
  });
  test('rejects relative, missing, root, traversal, and linked report roots', () => {
    const root = temporaryRoot();
    fs.mkdirSync(path.join(root, 'reports'));
    fs.symlinkSync(path.join(root, 'reports'), path.join(root, 'linked'));
    for (const unsafe of ['.', '/', `${root}/missing`, `${root}/reports/..`, `${root}/linked`]) {
      expect(() => readQACheckpointFiles(unsafe)).toThrow();
    }
    fs.mkdirSync(path.join(root, 'reports', 'nested'));
    expect(() => readQACheckpointFiles(path.join(root, 'linked', 'nested'))).toThrow();
  });
  test.each(['symlink', 'hardlink', 'directory'])('rejects %s checkpoint artifacts', kind => {
    const root = temporaryRoot();
    const target = path.join(root, 'exploration-001.json');
    const outside = path.join(temporaryRoot(), 'outside');
    fs.writeFileSync(outside, 'original');
    if (kind === 'symlink') fs.symlinkSync(outside, target);
    if (kind === 'hardlink') fs.linkSync(outside, target);
    if (kind === 'directory') fs.mkdirSync(target);
    expect(() => readQACheckpointFiles(root)).toThrow();
    expect(fs.readFileSync(outside, 'utf8')).toBe('original');
  });
});

describe('QA native checkpoint evidence', () => {
  test('accepts successful Writes between real results and repeated command dispatches', () => {
    expect(validateQACheckpoints(fixture())).toEqual([]);
  });
  test('accepts native text arrays, multiline JSON, and object key reordering', () => {
    const input = fixture();
    input.transcript[1].message.content[0].content = [{ type: 'text', text: JSON.stringify(input.probes[0].observed, null, 2) }];
    input.transcript[3].message.content[0].content = [{ type: 'text', text: 'File created successfully' }];
    updateNote(input, value => { value.observed = Object.fromEntries(Object.entries(value.observed).reverse()); });
    expect(validateQACheckpoints(input)).toEqual([]);
  });
  test('pairs interleaved parent and child IDs without borrowing results', () => {
    const input = fixture();
    input.transcript.splice(1, 0, use('probe-0', 'Bash', { command: 'unrelated' }, 'child'));
    input.transcript.splice(3, 0, result('probe-0', 'unrelated child output', 'child'));
    expect(validateQACheckpoints(input)).toEqual([]);
    input.transcript[2].parent_tool_use_id = 'other-child';
    rejected(input, 'Orphaned');
  });
  test('accepts complete child-local probe and checkpoint streams', () => {
    const input = fixture();
    for (const event of input.transcript) event.parent_tool_use_id = 'qa-child';
    input.transcript.unshift(use('probe-0', 'Agent', { prompt: 'qa' }));
    input.transcript.push(result('probe-0', 'QA complete'));
    expect(validateQACheckpoints(input)).toEqual([]);
  });
  test('only requires selected discovery checkpoints, while permitting valid optional notes', () => {
    const input = fixture();
    input.requiredProbes = [input.probes[1]];
    expect(validateQACheckpoints(input)).toEqual([]);
    input.transcript.splice(6, 2);
    fs.unlinkSync(path.join(input.reportRoot, 'exploration-002.json'));
    input.files = readQACheckpointFiles(input.reportRoot);
    expect(validateQACheckpoints(input)).toEqual([]);
  });
  test('rejects multiple JSON results instead of selecting a convenient observation', () => {
    const input = fixture();
    input.transcript[1].message.content[0].content += '\n' + JSON.stringify({ fabricated: true });
    rejected(input, 'Unbound or ambiguous native probe');
  });
  test('rejects unsupported rewrites even when bytes remain unchanged', () => {
    const input = fixture();
    input.transcript.push(use('shell-write', 'Bash', { command: 'printf unchanged > exploration-001.json' }), result('shell-write', ''));
    rejected(input, 'Unsupported checkpoint Bash');
  });
  test('does not count one observation or one note twice', () => {
    const input = fixture();
    input.probes.push(input.probes[1]);
    rejected(input, 'Unbound or ambiguous native probe');
    input.probes.pop();
    const original = input.transcript[2].message.content[0].input;
    const name = 'exploration-099.json';
    const file_path = path.join(input.reportRoot, name);
    fs.writeFileSync(file_path, original.content);
    input.files = readQACheckpointFiles(input.reportRoot);
    input.reportMarkdown += `[extra](${name})`;
    input.transcript.splice(4, 0, use('extra-note', 'Write', { file_path, content: original.content }), result('extra-note', 'ok'));
    rejected(input, 'Missing unique');
  });
  test('all failure diagnostics carry the stable checkpoint marker', () => {
    const input = fixture();
    input.transcript = [result('orphan', 'ok')];
    const failures = validateQACheckpoints(input);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every(failure => failure.includes('checkpoint'))).toBe(true);
  });
  test('binds completed exit-69 dependency results as both target and prior observation', () => {
    const input = fixture();
    const dependency = { command: 'bun run probe -- dependency', observed: { scenario: 'dependency', stateRoot: '/fixture/dependency',
      exit: 69, stdout: '', stderr: 'SETUP_BLOCKED: optional qa-fixture-exporter-unavailable is not installed\n', state: { jobs: {}, effects: [] } } };
    input.probes[1] = dependency as any;
    input.requiredProbes = input.probes.slice(1);
    input.transcript[4].message.content[0].input.command = dependency.command;
    input.transcript[5].message.content[0].is_error = true;
    input.transcript[5].message.content[0].content = `Exit code 69\n$ bun probe.ts dependency\n${JSON.stringify(dependency.observed)}`;
    updateNote(input, value => { value.nextCommand = dependency.command; });
    const write = input.transcript[6].message.content[0].input;
    const note = JSON.parse(write.content);
    note.observationCommand = dependency.command;
    note.observed = dependency.observed;
    write.content = JSON.stringify(note);
    fs.writeFileSync(write.file_path, write.content);
    input.files = readQACheckpointFiles(input.reportRoot);
    expect(validateQACheckpoints(input)).toEqual([]);
    input.transcript[5].message.content[0].content = 'Exit code 69\n$ bun probe.ts dependency\nProcess failed without native JSON';
    rejected(input, 'Unbound or ambiguous native probe');
  });
  test.each(['missing result', 'orphan result', 'duplicate result', 'duplicate use', 'failed Write', 'failed probe without JSON'])('rejects %s', kind => {
    const input = fixture();
    if (kind === 'missing result') input.transcript.splice(3, 1);
    if (kind === 'orphan result') input.transcript.push(result('orphan', 'ok'));
    if (kind === 'duplicate result') input.transcript.push(input.transcript[3]);
    if (kind === 'duplicate use') input.transcript.push(input.transcript[2]);
    if (kind === 'failed Write') input.transcript[3].message.content[0].is_error = true;
    if (kind === 'failed probe without JSON') {
      input.transcript[1].message.content[0].is_error = true;
      input.transcript[1].message.content[0].content = 'Command failed before producing native JSON';
    }
    expect(validateQACheckpoints(input).length).toBeGreaterThan(0);
  });
  test.each(['target before Write completion', 'note before observation completion', 'retrospective Write', 'same-event dispatch'])('rejects %s chronology', kind => {
    const input = fixture();
    if (kind === 'target before Write completion') [input.transcript[3], input.transcript[4]] = [input.transcript[4], input.transcript[3]];
    if (kind === 'note before observation completion') [input.transcript[1], input.transcript[2]] = [input.transcript[2], input.transcript[1]];
    if (kind === 'retrospective Write') input.transcript.push(...input.transcript.splice(2, 2));
    if (kind === 'same-event dispatch') {
      input.transcript[2].message.content.push(input.transcript[4].message.content[0]);
      input.transcript.splice(4, 1);
    }
    rejected(input, 'Missing unique');
  });
  test.each(['partial observation', 'invented observation', 'stale observation', 'wrong prior command', 'wrong next command', 'short hypothesis', 'extra schema key'])('rejects %s', kind => {
    const input = fixture();
    updateNote(input, value => {
      if (kind === 'partial observation') delete value.observed.state;
      if (kind === 'invented observation') value.observed.stateRoot = '/fabricated';
      if (kind === 'stale observation') value.observed = input.probes[1].observed;
      if (kind === 'wrong prior command') value.observationCommand += ' fabricated';
      if (kind === 'wrong next command') value.nextCommand += ' fabricated';
      if (kind === 'short hypothesis') value.hypothesis = 'Try another thing';
      if (kind === 'extra schema key') value.fabricated = true;
    });
    expect(validateQACheckpoints(input).length).toBeGreaterThan(0);
  });
  test('rejects a fabricated probe even when its checkpoint copies it exactly', () => {
    const input = fixture();
    input.probes[0].observed.stateRoot = '/invented';
    updateNote(input, value => { value.observed = input.probes[0].observed; });
    rejected(input, 'Unbound or ambiguous native probe');
  });
  test('does not confuse repeated commands with different native observations', () => {
    const input = fixture();
    input.requiredProbes = [input.probes[1], input.probes[1]];
    rejected(input, 'reused checkpoint target');
    input.requiredProbes = input.probes.slice(1);
    input.transcript[5].message.content[0].content = JSON.stringify(input.probes[2].observed);
    rejected(input, 'ambiguous native probe');
  });
  test.each(['missing disk', 'changed disk', 'forged files', 'stale artifact', 'overwritten Write', 'missing link', 'plain filename'])('rejects %s', kind => {
    const input = fixture();
    const name = 'exploration-001.json';
    if (kind === 'missing disk') fs.unlinkSync(path.join(input.reportRoot, name));
    if (kind === 'changed disk') fs.writeFileSync(path.join(input.reportRoot, name), 'replaced');
    if (kind === 'forged files') input.files[name] = 'forged';
    if (kind === 'stale artifact') {
      fs.writeFileSync(path.join(input.reportRoot, 'exploration-099.json'), input.files[name]);
      input.files = readQACheckpointFiles(input.reportRoot);
    }
    if (kind === 'overwritten Write') input.transcript.push(use('overwrite', 'Write', input.transcript[2].message.content[0].input), result('overwrite', 'ok'));
    if (kind === 'missing link') input.reportMarkdown = '';
    if (kind === 'plain filename') input.reportMarkdown = Object.keys(input.files).join('\n');
    expect(validateQACheckpoints(input).length).toBeGreaterThan(0);
  });
  test.each(['escape', 'relative', 'nested', 'Edit', 'Bash', 'thinking', 'text'])('does not credit %s notes', kind => {
    const input = fixture();
    const block = input.transcript[2].message.content[0];
    if (kind === 'escape') block.input.file_path = path.join(temporaryRoot(), 'exploration-001.json');
    if (kind === 'relative') block.input.file_path = 'exploration-001.json';
    if (kind === 'nested') block.input.file_path = path.join(input.reportRoot, 'nested', 'exploration-001.json');
    if (kind === 'Edit') block.name = 'Edit';
    if (kind === 'Bash') { block.name = 'Bash'; block.input = { command: 'printf checkpoint > exploration-001.json', description: block.input.content }; }
    if (kind === 'thinking' || kind === 'text') {
      input.transcript[2].message.content = [{ type: kind, [kind]: block.input.content }];
      input.transcript.splice(3, 1);
    }
    expect(validateQACheckpoints(input).length).toBeGreaterThan(0);
  });
  test('cannot borrow a note from another parent scope', () => {
    const input = fixture();
    input.transcript[2].parent_tool_use_id = 'other';
    input.transcript[3].parent_tool_use_id = 'other';
    rejected(input, 'Missing unique');
  });
});
