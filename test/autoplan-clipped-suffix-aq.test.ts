import {test,expect,afterEach} from 'bun:test';
import {E2E_TOUCHFILES} from './helpers/touchfiles-data';
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const f of cleanup.splice(0))f()});
test('new regression files register only the actual Autoplan owner',()=>{
 for(const p of ['test/autoplan-clipped-suffix-aq.test.ts','test/fixtures/autoplan-clipped-suffix-aq.json'])expect(Object.entries(E2E_TOUCHFILES).filter(([,files])=>files.includes(p)).map(([owner])=>owner)).toEqual(['autoplan-chain-pty']);
});
