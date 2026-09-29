import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hasNativePlanTerminal } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import captured from './fixtures/ceo-completion-handoff-o-call.json';
import capturedQ from './fixtures/ceo-completion-handoff-q-call.json';

const calls = () => structuredClone(captured.calls) as NativePlanQuestionCall[];
const handoff = () => calls().at(-1)!;
describe('closed CEO navigation with the native review-prefixed identity', () => {
});

describe('CEO completion recap after native project metadata', () => {
  const qCalls = () => structuredClone(capturedQ.calls) as NativePlanQuestionCall[];
  const qHandoff = () => qCalls().at(-1)!;
  test('actual full report and Exit chronology retain last substantive-answer freshness', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-metadata-navigation-'));
    const report = path.join(dir, 'plan.md');
    try {
      fs.writeFileSync(report, capturedQ.reportContent);
      const reportAt = Date.parse(capturedQ.reportAt) / 1000;
      fs.utimesSync(report, reportAt, reportAt);
      const transcript = { status: 'ready' as const, calls: qCalls(), assistantMessages: [], planReadyRequests: structuredClone(capturedQ.planReadyRequests) };
      const administrative = new Set([`${qHandoff().sessionId}:${qHandoff().toolUseId}`]);
      const start = Date.parse('2026-09-09T03:25:54Z');
      expect(hasNativePlanTerminal(transcript, report, start, 'plan_ready')).toBe(false);
      expect(hasNativePlanTerminal(transcript, report, start, 'plan_ready', administrative)).toBe(true);
      transcript.planReadyRequests[0]!.failed = true;
      expect(hasNativePlanTerminal(transcript, report, start, 'plan_ready', administrative)).toBe(false);
      transcript.planReadyRequests = structuredClone(capturedQ.planReadyRequests);
      fs.utimesSync(report, start / 1000, start / 1000);
      expect(hasNativePlanTerminal(transcript, report, start, 'plan_ready', administrative)).toBe(false);
      fs.writeFileSync(report, 'Incomplete plan');
      fs.utimesSync(report, reportAt, reportAt);
      expect(hasNativePlanTerminal(transcript, report, start, 'plan_ready', administrative)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
