/**
 * The runners' launch seam and clock (PtyDriver). Moved from claude-pty-runner.ts.
 * Import through test/helpers/claude-pty-runner.ts from tests; pty/ modules import siblings directly.
 */
import type { ClaudePtyOptions, ClaudePtySession } from './launch';

/**
 * The runners' launch seam: how a session starts, and the clock the runner
 * loop reads. Omitted in production (real launcher, Date.now,
 * performance.now, Bun.sleep); tests pass the fake driver from
 * test/helpers/pty/fake-session.ts.
 */
export interface PtyDriver {
  launch(opts: ClaudePtyOptions): Promise<ClaudePtySession>;
  /** Wall clock, Date.now() semantics. */
  now(): number;
  /** Monotonic clock, performance.now() semantics. */
  monotonic(): number;
  sleep(ms: number): Promise<void>;
}
