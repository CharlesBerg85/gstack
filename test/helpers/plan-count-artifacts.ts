import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProjectEvalDir } from './eval-store';

interface PlanCountSnapshot {
  skillName: string;
  observation: object;
  raw: string;
  visible: string;
  viewport?: string;
  cwd: string;
  claudeConfigDir: string | null;
}

/** Copy the caller-owned plan and review-log rows into an attempt's artifact
 * directory before fixture cleanup removes them. Best-effort: each result
 * (copied, missing or its error) is recorded in evidence-copy.json and never
 * replaces the observation or its outcome. */
export function copyPlanCountEvidence(artifactDir: string | undefined,
  evidence: { planPath?: string; reviewLogDirectory?: string }): void {
  if (!artifactDir) return;
  const results: Record<string, string> = {};
  const copy = (label: string, source: string, target: string) => {
    try {
      if (!fs.existsSync(source)) { results[label] = `missing: ${source}`; return; }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o600);
      results[label] = `copied: ${source}`;
    } catch (error) { results[label] = `error: ${String(error)}`; }
  };
  if (evidence.planPath) copy('plan', evidence.planPath, path.join(artifactDir, 'evidence', 'plan', path.basename(evidence.planPath)));
  else results.plan = 'missing: no expected plan path';
  if (evidence.reviewLogDirectory) {
    let names: string[] = [];
    try { names = fs.readdirSync(evidence.reviewLogDirectory).filter(name => name.endsWith('-reviews.jsonl')); }
    catch (error) { results.reviewLog = fs.existsSync(evidence.reviewLogDirectory) ? `error: ${String(error)}` : `missing: ${evidence.reviewLogDirectory}`; }
    if (!names.length && !results.reviewLog) results.reviewLog = `missing: no *-reviews.jsonl in ${evidence.reviewLogDirectory}`;
    for (const name of names) copy(`reviewLog:${name}`, path.join(evidence.reviewLogDirectory, name), path.join(artifactDir, 'evidence', 'review-log', name));
  } else results.reviewLog = 'missing: no fixture-owned review log binding';
  try {
    fs.writeFileSync(path.join(artifactDir, 'evidence-copy.json'), JSON.stringify(results, null, 2) + '\n', { mode: 0o600 });
  } catch { /* the observation and its outcome stay authoritative */ }
}

/** One owned directory per count attempt; periodic captures replace files atomically. */
export function createPlanCountSnapshotWriter(env: NodeJS.ProcessEnv = process.env):
  (input: PlanCountSnapshot) => { artifactDir?: string; artifactError?: string } {
  let artifactDir: string | undefined;
  // An explicit output directory requests retention even outside CI's named
  // runs. Keep its fallback stable across checkpoints and unique per writer.
  const runId = env.EVALS_RUN_ID || (env.GSTACK_EVAL_DIR ? `local-${randomUUID()}` : undefined);
  return (input) => {
    if (!runId) return {};
    try {
      if (!artifactDir) {
        const segment = (text: string) => text.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'run';
        const root = path.resolve(env.GSTACK_EVAL_DIR || getProjectEvalDir(), 'pty-count', segment(runId));
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        artifactDir = fs.mkdtempSync(path.join(root, `${segment(input.skillName)}-${Date.now()}-`));
      }
      const write = (name: string, content: string) => {
        const target = path.join(artifactDir!, name);
        fs.writeFileSync(`${target}.tmp`, content, { mode: 0o600 });
        fs.renameSync(`${target}.tmp`, target);
      };
      write('terminal.raw.log', input.raw);
      write('terminal.visible.log', input.visible);
      if (input.viewport !== undefined) write('terminal.screen.log', input.viewport);
      write('observation.json', JSON.stringify({
        ...input.observation, artifactDir,
        capture: { skill: input.skillName, runId, cwd: input.cwd,
          claudeConfigDir: input.claudeConfigDir, at: new Date().toISOString() },
      }, null, 2) + '\n');
      return { artifactDir };
    } catch (error) {
      // Preserve any partial evidence and the original test outcome; make the
      // write failure visible instead of claiming diagnostics were retained.
      return { artifactDir, artifactError: String(error) };
    }
  };
}

/** Keep a single snapshot outside the temporary fixture that setup later removes. */
export function persistPlanCountSnapshot(input: PlanCountSnapshot, env: NodeJS.ProcessEnv = process.env) {
  return createPlanCountSnapshotWriter(env)(input);
}
