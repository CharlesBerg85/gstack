import {describe,expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fixture from './fixtures/ceo-handoff-y-call.json';
import type {NativePlanQuestionCall} from './helpers/plan-count-transcript';
import {hasNativePlanTerminal,nativePlanCallFingerprint} from './helpers/claude-pty-runner';
const fp=(c:NativePlanQuestionCall)=>nativePlanCallFingerprint(c,0,false);
describe('Y bare next-Eng navigation is administrative, not completion evidence',()=>{
 test('independent fresh report and native Exit still gate completion; menu alone cannot pass',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-handoff-y-free-'));const report=path.join(dir,'report.md');
  try{fs.writeFileSync(report,fixture.report);const calls=structuredClone(fixture.calls) as NativePlanQuestionCall[];const transcript={status:'ready' as const,calls,assistantMessages:[],planReadyRequests:structuredClone(fixture.planReadyRequests)};const handoff=calls.at(-1)!;const admin=new Set([fp(handoff).signature]);const issueAt=Date.parse(calls.at(-2)!.answeredAt!),handoffAt=Date.parse(handoff.answeredAt!);const started=Date.parse(calls[0]!.answeredAt!)-1000;
   // Controlled metadata only: original Y report mtime was not captured.
   const between=(issueAt+handoffAt)/2;fs.utimesSync(report,between/1000,between/1000);
   expect(hasNativePlanTerminal(transcript,report,started,'plan_ready')).toBe(false);expect(hasNativePlanTerminal(transcript,report,started,'plan_ready',admin)).toBe(true);
   fs.utimesSync(report,(issueAt-1)/1000,(issueAt-1)/1000);expect(hasNativePlanTerminal(transcript,report,started,'plan_ready',admin)).toBe(false);
   fs.utimesSync(report,between/1000,between/1000);expect(hasNativePlanTerminal({...transcript,planReadyRequests:[]},report,started,'plan_ready',admin)).toBe(false);
   expect(hasNativePlanTerminal({...transcript,calls:[handoff]},report,started,'plan_ready',admin)).toBe(false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
 });
});
