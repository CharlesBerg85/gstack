import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import actual from './fixtures/eng-next-handoff-ah.json';
import { hasNativePlanTerminal } from './helpers/claude-pty-runner';
import type { PlanCountTranscript } from './helpers/plan-count-transcript';
import { isCurrentPlanApprovalScreen } from './helpers/plan-count-pending-exit';

test('exact final exit/report replay retains all freshness, identity and answer gates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-eng-next-ah-'));
  const file = path.join(dir, 'reviewed.md');
  const now = Date.now;
  try {
    fs.writeFileSync(file, actual.plan);
    fs.utimesSync(file, actual.source.stat.mtimeMs / 1000, actual.source.stat.mtimeMs / 1000);
    Date.now = () => Date.parse(actual.captureAt);
    const t = structuredClone(actual.transcript) as PlanCountTranscript;
    const id = actual.fingerprint.signature;
    const admin = new Set([id]);
    const check = (v = t, a = admin) => hasNativePlanTerminal(v, file, actual.startedAt, 'plan_ready', a);
    expect(isCurrentPlanApprovalScreen(actual.screen)).toBe(true);
    expect(check()).toBe(true);
    expect(check(t, new Set())).toBe(false);
    expect(check(t, new Set(['foreign:call']))).toBe(false);
    for (const mutate of [
      (v: PlanCountTranscript) => { v.planReadyRequests = []; },
      (v: PlanCountTranscript) => { v.planReadyRequests!.at(-1)!.failed = true; },
      (v: PlanCountTranscript) => { v.planReadyRequests!.at(-1)!.sessionId = 'foreign'; },
      (v: PlanCountTranscript) => { v.planReadyRequests!.at(-1)!.timestamp = '2026-09-10T03:29:40.000Z'; },
      (v: PlanCountTranscript) => { v.planReadyRequests!.at(-1)!.timestamp = new Date(Date.now() + 1).toISOString(); },
      (v: PlanCountTranscript) => { v.calls.at(-1)!.answered = false; },
      (v: PlanCountTranscript) => { v.calls.at(-2)!.answeredAt = '2026-09-10T03:29:00.000Z'; },
    ]) { const v = structuredClone(t); mutate(v); expect(check(v)).toBe(false); }
    fs.writeFileSync(file, actual.plan.replace('NO UNRESOLVED DECISIONS', 'Report still pending'));
    fs.utimesSync(file, actual.source.stat.mtimeMs / 1000, actual.source.stat.mtimeMs / 1000);
    expect(check()).toBe(false);
  } finally { Date.now = now; fs.rmSync(dir, { recursive: true, force: true }); }
});

const b176 = actual.sourceBoundB176;
const recorded = () => structuredClone(b176.transcript) as PlanCountTranscript;
test('actual pending ExitPlanMode needs the classified recap plus the unchanged fresh report and native gates',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'eng-b176-terminal-')),file=path.join(dir,'report.md'),now=Date.now;
 try{
  Date.now=()=>Date.parse(b176.capturedAt);fs.writeFileSync(file,b176.plan);fs.utimesSync(file,b176.sourceReport.mtimeMs/1000,b176.sourceReport.mtimeMs/1000);
  const t=recorded(),signature=b176.fingerprint.signature;
  const admin=new Set([signature]);
  const check=(transcript=t,administrative=admin)=>hasNativePlanTerminal(transcript,file,b176.startedAt,'plan_ready',administrative);
  expect(isCurrentPlanApprovalScreen(b176.screen)).toBe(true);
  expect(check()).toBe(true);expect(check(t,new Set())).toBe(false);expect(check(t,new Set(['foreign:call']))).toBe(false);
  for(const mutate of [
   (v:PlanCountTranscript)=>{v.planReadyRequests=[];},
   (v:PlanCountTranscript)=>{v.planReadyRequests![0]!.failed=true;},
   (v:PlanCountTranscript)=>{v.planReadyRequests![0]!.sessionId='foreign';},
   (v:PlanCountTranscript)=>{v.planReadyRequests![0]!.timestamp=new Date(Date.now()+1).toISOString();},
   (v:PlanCountTranscript)=>{v.planReadyRequests![0]!.timestamp=v.calls.at(-1)!.answeredAt!;},
   (v:PlanCountTranscript)=>{v.calls.at(-1)!.answered=false;},
   (v:PlanCountTranscript)=>{v.calls.at(-2)!.answeredAt=new Date(b176.sourceReport.mtimeMs+1).toISOString();},
  ]){const v=recorded();mutate(v);expect(check(v)).toBe(false);}
  fs.utimesSync(file,(b176.startedAt-1)/1000,(b176.startedAt-1)/1000);expect(check()).toBe(false);
  fs.writeFileSync(file,b176.plan.replace('NO UNRESOLVED DECISIONS','PENDING'));fs.utimesSync(file,b176.sourceReport.mtimeMs/1000,b176.sourceReport.mtimeMs/1000);expect(check()).toBe(false);
 }finally{Date.now=now;fs.rmSync(dir,{recursive:true,force:true});}
});
