import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{alias:{'@':process.cwd()}});
const {POST}=await jiti.import('../app/api/sessions/batch-delete/route.ts');
const {loadUsageDeleteGuard}=await jiti.import('./usage-delete-guard.ts');
const {cacheSessionPath,invalidateSessionListCache}=await jiti.import('./session-reader.ts');
const {resetSessionScanIndexForTests}=await jiti.import('./session-list-scanner.ts');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-delete-audit-api-')),dir=path.join(root,'sessions','p');fs.mkdirSync(dir,{recursive:true});
 const before=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=root;resetSessionScanIndexForTests();invalidateSessionListCache();
 const id='audit-target',file=path.join(dir,id+'.jsonl');fs.writeFileSync(file,JSON.stringify({type:'session',version:3,id,cwd:dir,timestamp:'2026-10-14T00:00:00Z'})+'\n');cacheSessionPath(id,file);
 const guard=loadUsageDeleteGuard(),original=guard.sealAndDeleteSync;let calls=0;
 const auditFile=path.join(root,'state','session-deletions-v1.jsonl');
 guard.sealAndDeleteSync=(targets,onDeleted)=>{calls++;const plan=JSON.parse(fs.readFileSync(auditFile,'utf8').trim().split('\n')[0]);assert.equal(plan.phase,'planned');for(const[sid,p]of targets){fs.unlinkSync(p);onDeleted?.(sid,p);}return{ok:true,deletedCount:targets.size};};
 t.after(()=>{guard.sealAndDeleteSync=original;if(before===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=before;resetSessionScanIndexForTests();invalidateSessionListCache();globalThis.__piSessionPathCache=undefined;globalThis.__piPathToSessionIdCache=undefined;fs.rmSync(root,{recursive:true,force:true});});
 return{root,id,file,auditFile,calls:()=>calls};
}
const request=id=>new Request('http://fixture/api/sessions/batch-delete',{method:'POST',body:JSON.stringify({ids:[id]})});
test('API audit precedes the mutator and completed deletion remains attributable',async t=>{
 const f=fixture(t),response=await POST(request(f.id)),body=await response.json();assert.equal(response.status,200);assert.equal(body.results[0].ok,true);assert.equal(f.calls(),1);assert.equal(fs.existsSync(f.file),false);
 const rows=fs.readFileSync(f.auditFile,'utf8').trim().split('\n').map(JSON.parse);assert.equal(rows.length,2);assert.equal(rows[1].phase,'completed');assert.equal(rows[1].origin,'api-batch');assert.deepEqual(rows[1].deletedIds,[f.id]);
});
test('audit-plan failure prevents every destructive call and preserves original data',async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.root,'state'),'blocked');const body=await(await POST(request(f.id))).json();assert.equal(body.results[0].ok,false);assert.equal(f.calls(),0);assert.equal(fs.existsSync(f.file),true);
});
