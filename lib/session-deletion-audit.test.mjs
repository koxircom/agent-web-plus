import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createJiti} from 'jiti';
const {createSessionDeletionAudit}=await createJiti(import.meta.url).import('./session-deletion-audit.ts');

test('deletion journal records durable plan and outcome metadata without transcript',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-delete-audit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const audit=createSessionDeletionAudit(root),plan=audit.begin(['parent'],['parent','child'],'api-batch');
 const file=path.join(root,'state','session-deletions-v1.jsonl');
 let records=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(records[0].phase,'planned');assert.equal(records[0].origin,'api-batch');assert.deepEqual(records[0].resolvedIds,['parent','child']);
 audit.finish(plan,{deletedIds:['parent'],missingIds:[],failedIds:['child']});
 records=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(records[1].operationId,records[0].operationId);assert.equal(records[1].phase,'failed-or-partial');
 assert.deepEqual(Object.keys(records[0]).sort(),['schema','at','operationId','origin','requestedIds','resolvedIds','phase'].sort());
 if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o777,0o600);
});

test('unwritable audit storage fails before an operation can receive a plan',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-delete-audit-bad-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'state'),'blocked');assert.throws(()=>createSessionDeletionAudit(root).begin(['s'],['s'],'native'));
});
