import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fixture from './fixtures/design-count-native-8525.json';
import { hasNativePlanTerminal } from './helpers/claude-pty-runner';
import type { PlanCountTranscript } from './helpers/plan-count-transcript';

function completion() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-8525-replay-'));
  const file = path.join(dir, path.basename(fixture.provenance.planPath));
  const transcript = structuredClone(fixture.transcript) as PlanCountTranscript;
  const edit = fixture.provenance.operations.filter(o => o.tool === 'Edit').at(-1)!;
  const mtime = Date.parse(edit.acknowledgedAt) / 1000;
  const write = (content = fixture.report) => { fs.writeFileSync(file, content); fs.utimesSync(file, mtime, mtime); };
  write();
  // The replay starts before the first retained native assistant message.
  const startedAt = Math.min(...transcript.assistantMessages.map(m => Date.parse(m.timestamp))) - 1_000;
  const final = transcript.assistantMessages.at(-1)!;
  const check = () => hasNativePlanTerminal(transcript, file, startedAt, 'completion_summary');
  return { dir, file, transcript, final, write, check, cleanup: () => fs.rmSync(dir, {recursive:true, force:true}) };
}

test('exact native final text and reconstructed read-back-verified report supply completion', () => {
  const f = completion(); try { expect(f.check()).toBe(true); } finally { f.cleanup(); }
});
test('current typed status accepts presentation, field order and current report prose independently', () => {
  const f=completion();try {
    for (const heading of ['## Completion','### Completion summary','## Review complete','## Design review complete','**Review completion:**']) {
      for (const status of ['STATUS: DONE','**STATUS:** DONE — review saved and verified.','**STATUS: DONE**']) {
        for (const fields of [
          [status,`What changed: \`${path.basename(f.file)}\` now carries the current review report.`],
          [`Report: ${f.file} contains the reviewed plan and verification.`,status],
          [status,`- Plan saved to \`${f.file}\`.`],
        ]) {f.final.text=heading+'\n\n'+fields.join('\n\n');expect(f.check(),f.final.text).toBe(true);}
      }
    }
  } finally {f.cleanup();}
});
for (const [name, change] of Object.entries({
  'blocked':(s:string)=>s.replace('DONE —','BLOCKED —'),
  'concerns':(s:string)=>s.replace('DONE —','DONE_WITH_CONCERNS —'),
  'pending':(s:string)=>s.replace('DONE —','NEEDS_CONTEXT —'),
  'conditional status':(s:string)=>s.replace('DONE —','DONE if approved —'),
  'conditional reason':(s:string)=>s.replace('completed with evidence','will be completed with evidence'),
  'quoted status':(s:string)=>s.replace('**STATUS:**','> **STATUS:**'),
  'literal status':(s:string)=>s.replace(/\*\*STATUS:\*\* (.+)/,'`STATUS: $1`'),
  'fenced status':(s:string)=>s.replace(/\*\*STATUS:\*\* (.+)/,'```text\nSTATUS: $1\n```'),
  'duplicate status':(s:string)=>s+'\nSTATUS: DONE',
  'conflicting status':(s:string)=>s+'\nSTATUS: BLOCKED',
  'historical context':(s:string)=>'Previous result:\n\n'+s,
  'copied section':(s:string)=>'Source example:\n\n'+s,
  'quoted section':(s:string)=>'> '+s.replaceAll('\n','\n> '),
  'duplicate section':(s:string)=>s+'\n## Review complete\nSTATUS: DONE',
  'unavailable report':(s:string)=>s.replace('now carries','is unavailable; would contain'),
  'proposed write':(s:string)=>s.replace('now carries','will contain'),
  'historical report':(s:string)=>s.replace('now carries','previously contained'),
  'wrong path':(s:string)=>s.replaceAll('gstack-test-plan-design.md','wrong-plan.md'),
  'ambiguous path':(s:string)=>s.replace('now carries','and `another-plan.md` now carry'),
  'different absolute directory':(s:string)=>s.replaceAll('gstack-test-plan-design.md','/elsewhere/gstack-test-plan-design.md'),
  'relative traversal':(s:string)=>s.replaceAll('gstack-test-plan-design.md','../gstack-test-plan-design.md'),
  'quoted artifact line':(s:string)=>s.replace('**What changed:**','> **What changed:**'),
  'literal artifact prose':(s:string)=>s.replace(/\*\*What changed:\*\* (.+)/,'**What changed:** "$1"'),
  'missing artifact field':(s:string)=>s.replace(/^\*\*What changed:\*\*.+\n/m,''),
  'withdrawn report':(s:string)=>s+'\nThe report is withdrawn.',
  'remaining decision':(s:string)=>s+'\nOne design decision is unresolved.',
})) test(`typed delivery rejects ${name}`, () => {const f=completion();try {f.final.text=change(f.final.text);expect(f.check()).toBe(false);}finally{f.cleanup();}});
test('typed delivery retains source session, answer chronology, fresh file and complete Design report checks', () => {
  const f=completion();try {
    const original=structuredClone(f.transcript);
    for (const change of [
      (t:PlanCountTranscript)=>{t.calls[1]!.answered=false;},
      (t:PlanCountTranscript)=>{t.calls[1]!.failed=true;},
      (t:PlanCountTranscript)=>{t.calls[1]!.sessionId='foreign';},
      (t:PlanCountTranscript)=>{t.calls[1]!.answeredAt=t.assistantMessages.at(-1)!.timestamp;},
      (t:PlanCountTranscript)=>{t.assistantMessages.at(-1)!.timestamp='2999-01-01T00:00:00Z';},
    ]) {Object.assign(f.transcript,structuredClone(original));change(f.transcript);expect(f.check()).toBe(false);}
    Object.assign(f.transcript,structuredClone(original));
    for (const body of ['# Draft',fixture.report+'\n## Implementation changes\n',fixture.report.replace('| 1 | clean |','| 1 | pending |'),fixture.report.replace('DESIGN CLEARED','NOT CLEARED'),fixture.report.replace('NO UNRESOLVED DECISIONS','**UNRESOLVED DECISIONS:**\n- Still open')]) {f.write(body);expect(f.check()).toBe(false);}
    f.write();fs.utimesSync(f.file,1,1);expect(f.check()).toBe(false);
    fs.rmSync(f.file);expect(f.check()).toBe(false);
    const alternate=path.join(f.dir,'alternate.md');fs.writeFileSync(alternate,fixture.report);fs.symlinkSync(alternate,f.file);expect(f.check()).toBe(false);
  }finally{f.cleanup();}
});
const cf74 = fixture.cf74Retry;

function cf74Completion() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'design-cf74-completion-'));
  const file=path.join(dir,path.basename(cf74.provenance.planPath));
  const transcript=structuredClone(cf74.transcript) as PlanCountTranscript;
  const final=transcript.assistantMessages.at(-1)!;
  final.text=final.text.replaceAll(cf74.provenance.planPath,file);
  const startedAt=Math.min(...transcript.calls.map(c=>Date.parse(c.answeredAt!)))-1000;
  const write=(body=cf74.report)=>{fs.writeFileSync(file,body);fs.utimesSync(file,cf74.provenance.reportMtimeMs/1000,cf74.provenance.reportMtimeMs/1000);};
  write();
  return {dir,file,transcript,final,startedAt,write,check:()=>hasNativePlanTerminal(transcript,file,startedAt,'completion_summary'),cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}

test('cf74 actual completed native report envelope binds the fresh owned Design report',()=>{
  const f=cf74Completion();try{expect(f.check()).toBe(true);}finally{f.cleanup();}
});
for(const heading of ['## Completion report','### Completion summary','## Completion'])for(const field of ['Plan written:','Plan saved:','Plan written to'])
  test(`cf74 complete typed delivery: ${heading}/${field}`,()=>{
    const f=cf74Completion();try{f.final.text=f.final.text.replace('## Completion report',heading).replace('Plan written:',field);expect(f.check()).toBe(true);}finally{f.cleanup();}
  });
for(const [name,change]of Object.entries({
  'pending status':(s:string)=>s.replace('STATUS: DONE','STATUS: PENDING'),
  'conditional status':(s:string)=>s.replace('STATUS: DONE','STATUS: DONE if approved'),
  'quoted status':(s:string)=>s.replace('**STATUS: DONE**','`STATUS: DONE`'),
  'duplicate status':(s:string)=>s+'\nSTATUS: DONE',
  'quoted whole report':(s:string)=>'> '+s.replaceAll('\n','\n> '),
  'historical report':(s:string)=>s.replace('## Completion report','Historical source:\n\n## Completion report'),
  'duplicate report':(s:string)=>s+'\n## Completion report\nSTATUS: DONE',
  'future write':(s:string)=>s.replace('Plan written:','Plan will be written:'),
  'conditional write':(s:string)=>s.replace('Plan written:', 'Plan written if approved:'),
  'quoted written field':(s:string)=>s.replace('- **Plan written:**','> **Plan written:**'),
  'ambiguous path':(s:string)=>s.replace(' — accepted behavior',' and another-report.md — accepted behavior'),
  'foreign path':(s:string)=>s.replaceAll('gstack-test-plan-design.md','foreign-report.md'),
  'withdrawn report':(s:string)=>s+'\nThe review report is withdrawn.',
  'unresolved decision':(s:string)=>s+'\nOne design decision is unresolved.',
  'quoted current unresolved status':(s:string)=>s+'\nOne design decision is "unresolved".',
}))test(`cf74 typed completion rejects ${name}`,()=>{const f=cf74Completion();try{f.final.text=change(f.final.text);expect(f.check()).toBe(false);}finally{f.cleanup();}});
test('cf74 typed envelope cannot bypass fresh own Design report and native chronology',()=>{
  const f=cf74Completion();try{
    const base=structuredClone(f.transcript);
    for(const change of [
      (t:PlanCountTranscript)=>{t.calls[0]!.answered=false;},(t:PlanCountTranscript)=>{t.calls[0]!.failed=true;},
      (t:PlanCountTranscript)=>{t.calls[0]!.answers={};},(t:PlanCountTranscript)=>{t.calls[0]!.unansweredQuestionIndices=[0];},
      (t:PlanCountTranscript)=>{t.calls[0]!.sessionId='foreign';},(t:PlanCountTranscript)=>{t.calls[0]!.answeredAt=t.assistantMessages.at(-1)!.timestamp;},
    ]){Object.assign(f.transcript,structuredClone(base));change(f.transcript);expect(f.check()).toBe(false);}
    Object.assign(f.transcript,structuredClone(base));
    for(const report of [cf74.report.replace('| 1 | clean |','| 1 | pending |'),cf74.report.replace('DESIGN CLEARED','DESIGN NOT CLEARED'),cf74.report.replace('NO UNRESOLVED DECISIONS','**UNRESOLVED DECISIONS:**\n- One pending'),cf74.report+'\n## Another section\n', '# Draft']){f.write(report);expect(f.check()).toBe(false);}
    f.write();fs.utimesSync(f.file,1,1);expect(f.check()).toBe(false);
    fs.rmSync(f.file);expect(f.check()).toBe(false);
    const target=path.join(f.dir,'other.md');fs.writeFileSync(target,cf74.report);fs.symlinkSync(target,f.file);expect(f.check()).toBe(false);
  }finally{f.cleanup();}
});
