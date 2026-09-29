import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hasNativePlanTerminal,
  nativePlanCallFingerprint } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import captured from './fixtures/ceo-completion-handoff-m-call.json';
import nextStepCapture from './fixtures/ceo-handoff-n-calls.json';

const calls = () => structuredClone(captured.calls) as NativePlanQuestionCall[];
const handoff = () => calls().at(-1)!;
const fingerprint = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, false);
describe('CEO completion described by a native navigation choice', () => {
});

describe('native next-review navigation with a resolved CEO recap', () => {
  const retryCalls = () => structuredClone(captured.distinctRetry.calls) as NativePlanQuestionCall[];
  const retryHandoff = () => retryCalls().at(-1)!;
});

describe('CEO completed next-step identity in native option order', () => {
  const input = () => structuredClone(nextStepCapture.calls) as NativePlanQuestionCall[];
  const actual = () => input().at(-1)!;
  test('the actual report precedes handoff but the captured absent Exit remains incomplete', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-native-next-step-'));
    const report = path.join(dir, 'plan.md');
    try {
      fs.writeFileSync(report, nextStepCapture.report.content);
      const written = Date.parse(nextStepCapture.report.successfulUpdateAt) / 1000;
      fs.utimesSync(report, written, written);
      const calls = input();
      expect(Date.parse(calls.at(-2)!.answeredAt!)).toBeLessThan(written * 1000);
      expect(Date.parse(calls.at(-1)!.answeredAt!)).toBeGreaterThan(written * 1000);
      const transcript = { status: 'ready' as const, calls, assistantMessages: [],
        planReadyRequests: structuredClone(nextStepCapture.planReadyRequests) };
      const admin = new Set([fingerprint(calls.at(-1)!).signature]);
      expect(hasNativePlanTerminal(transcript, report, Date.parse('2026-09-09T01:06:22Z'), 'plan_ready', admin)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
