import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import capture from './fixtures/eng-task-pause-navigation-f359.json';
import { nativePlanCallFingerprint, hasNativePlanTerminal } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall, PlanCountTranscript } from './helpers/plan-count-transcript';
const actual=()=>({call:structuredClone(capture.transcript.calls.at(-1)!) as NativePlanQuestionCall,prior:structuredClone(capture.transcript.calls.slice(0,-1)) as NativePlanQuestionCall[],plan:capture.plan});
test('handoff alone never supplies a native terminal or refreshes modifying answers',()=>{
 const x=actual(),fp=nativePlanCallFingerprint(x.call,0,false),admin=new Set([fp.signature]);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-eng-task-pause-')),file=path.join(dir,'reviewed.md'),now=Date.now;
 try {
  fs.writeFileSync(file,x.plan);fs.utimesSync(file,capture.reportSource.mtimeMs/1000,capture.reportSource.mtimeMs/1000);
  Date.now=()=>Date.parse('2026-09-16T07:04:00.000Z');
  const t=structuredClone(capture.transcript) as PlanCountTranscript;
  const check=(v=t,a=admin)=>hasNativePlanTerminal(v,file,Date.parse('2026-09-16T06:40:00.000Z'),'plan_ready',a);
  expect(check()).toBe(false); // Actual capture precedes the native exit.
  // The later retained native exit is real; this is a gate replay, not a
  // replacement verdict for the original paid timeout/failure.
  expect(createHash('sha256').update(JSON.stringify(t.calls)).digest('hex')).toBe(capture.terminalCapture.callsSha256);
  t.planReadyRequests=structuredClone(capture.terminalCapture.planReadyRequests);
  t.assistantMessages=structuredClone(capture.terminalCapture.assistantMessages);
  expect(check()).toBe(true);expect(check(t,new Set())).toBe(false);expect(check(t,new Set(['foreign:call']))).toBe(false);
  for(const mutate of [
   (v:PlanCountTranscript)=>{v.planReadyRequests![0]!.failed=true;},
   (v:PlanCountTranscript)=>{v.planReadyRequests![0]!.sessionId='foreign';},
   (v:PlanCountTranscript)=>{v.planReadyRequests![0]!.timestamp=x.call.answeredAt!;},
   (v:PlanCountTranscript)=>{v.planReadyRequests=[];},
   (v:PlanCountTranscript)=>{v.calls[5]!.answeredAt=x.call.answeredAt;},
   (v:PlanCountTranscript)=>{v.calls[5]!.answered=false;v.calls[5]!.unansweredQuestionIndices=[0];},
  ]){const v=structuredClone(t);mutate(v);expect(check(v)).toBe(false);}
 }finally{Date.now=now;fs.rmSync(dir,{recursive:true,force:true});}
});
