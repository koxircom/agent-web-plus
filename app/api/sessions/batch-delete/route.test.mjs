import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, open as openFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createJiti } from 'jiti';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const jiti = createJiti(import.meta.url, { alias: { '@': process.cwd() }, interopDefault: true });
const { POST } = await jiti.import('./route.ts');
const { cacheSessionPath, invalidateSessionListCache, invalidateSessionPathCache } = await jiti.import('../../../../lib/session-reader.ts');
const { loadUsageDeleteGuard } = await jiti.import('../../../../lib/usage-delete-guard.ts');
const requestFor = ids => new Request('http://localhost/api/sessions/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) });
const post = ids => POST(requestFor(ids));
async function postWithFreshImports(ids) {
 const fresh=createJiti(import.meta.url,{alias:{'@':process.cwd()},interopDefault:true,moduleCache:false});
 const route=await fresh.import('./route.ts');return route.POST(requestFor(ids));
}
async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'pi-batch-delete-'));
 const dir = join(root,'sessions','fixture-workspace'); await mkdir(dir,{recursive:true});
 const keys = ['PI_CODING_AGENT_DIR','PI_SESSIONS_DIR','PI_USAGE_DATA_DIR'];
 const previous = keys.map(key => process.env[key]);
 process.env.PI_CODING_AGENT_DIR = root; process.env.PI_SESSIONS_DIR = join(root,"sessions"); delete process.env.PI_USAGE_DATA_DIR;
 const previousOptions = globalThis.__piUsageDeleteGuardDefaultOptions;
 globalThis.__piUsageDeleteGuardDefaultOptions = { stateFile: join(root,'usage-state.json'), outputFile: join(root,'usage-output.json'), sessionsRoot: join(root,'sessions') };
 invalidateSessionListCache();
 const paths = new Map();
 const add = async (id, parentId, subagent = false, padding = '') => {
  const path = join(dir,id+'.jsonl'); paths.set(id,path);
  const header = { type:'session', version:3, id, timestamp:'2026-01-01T00:00:00.000Z',cwd:dir, ...(parentId ? {parentSession:paths.get(parentId)} : {}) };
  const entries = [header];
  if(subagent) entries.push({type:'custom',id:'meta',parentId:null,timestamp:header.timestamp,customType:'pi-web:subagent',data:{version:1,parentSessionId:parentId,parentSessionPath:paths.get(parentId),profile:'Explore',description:'隔离验收'}});
  if(padding) entries.push({type:'message',id:'user',parentId:null,timestamp:header.timestamp,message:{role:'user',content:padding,timestamp:Date.now()}});
  await writeFile(path,entries.map(e=>JSON.stringify(e)).join('\n')+'\n'); cacheSessionPath(id,path); return path;
 };
 t.after(async()=>{
  for(let i=0;i<keys.length;i++) { if(previous[i]===undefined) delete process.env[keys[i]]; else process.env[keys[i]]=previous[i]; }
  globalThis.__piUsageDeleteGuardDefaultOptions=previousOptions;
  for(const id of paths.keys()) invalidateSessionPathCache(id);
  invalidateSessionListCache(); await rm(root,{recursive:true,force:true});
 });
 return {dir,paths,add};
}
test('six-session batch seals once, keeps unrelated long history, and missing/duplicate IDs are idempotent', async t => {
 const f=await fixture(t); for(let i=0;i<6;i++) await f.add('batch-'+i);
 const survivor=await f.add('survivor',undefined,false,'long history '.repeat(100000));
 const before=await readFile(survivor);
 const guard=loadUsageDeleteGuard(); const original=guard.sealAndDeleteSync; let calls=0;
 guard.sealAndDeleteSync=(targets,...args)=>{calls++;assert.equal(targets.size,6);return original(targets,...args)};
 t.after(()=>guard.sealAndDeleteSync=original);
 const started=performance.now(); const response=await post([...f.paths.keys()].slice(0,6).concat('batch-0','missing'));
 assert.equal(response.status,200); const payload=await response.json();
 assert.equal(payload.results.length,7);assert(payload.results.every(r=>r.ok),JSON.stringify(payload));assert.equal(calls,1);assert.equal(payload.deletedSessionIds.length,6);
 for(let i=0;i<6;i++) await assert.rejects(readFile(f.paths.get('batch-'+i)),{code:'ENOENT'});
 assert.deepEqual(await readFile(survivor),before);
 console.log(JSON.stringify({batchSize:6,sealWorkers:calls,elapsedMs:Math.round(performance.now()-started),survivorBytes:before.length}));
});
test('batch handles selected ancestors/descendants and reattaches surviving forks to closest surviving ancestor',async t=>{
 const f=await fixture(t);await f.add('grandparent');await f.add('parent','grandparent');await f.add('fork','parent');await f.add('leaf','fork');await f.add('agent','parent',true);await f.add('agent-child','agent',true);
 const payload=await (await post(['parent','fork','agent'])).json();assert(payload.results.every(r=>r.ok),JSON.stringify(payload));
 for(const id of ['parent','fork','agent','agent-child'])await assert.rejects(readFile(f.paths.get(id)),{code:'ENOENT'});
 const header=JSON.parse((await readFile(f.paths.get('leaf'),'utf8')).split('\n')[0]);assert.equal(header.parentSession,f.paths.get('grandparent'));
});
test('bounded session headers survive short reads across multiple chunks',async t=>{
 const f=await fixture(t);await f.add('grandparent');await f.add('parent','grandparent');await f.add('fork','parent');
 const probe=await openFile(f.paths.get('parent'),'r');const handlePrototype=Object.getPrototypeOf(probe);await probe.close();
 const originalRead=handlePrototype.read;
 handlePrototype.read=function(buffer,offset,length,position){return originalRead.call(this,buffer,offset,Math.min(length,3),position)};
 t.after(()=>{handlePrototype.read=originalRead});
 const payload=await(await post(['parent'])).json();assert(payload.results[0].ok,JSON.stringify(payload));
 const header=JSON.parse((await readFile(f.paths.get('fork'),'utf8')).split('\n')[0]);assert.equal(header.parentSession,f.paths.get('grandparent'));
});
test('an active surviving child blocks reparent and preserves the parent file',async t=>{
 const f=await fixture(t);await f.add('parent');await f.add('fork','parent');
 const previousRegistry=globalThis.__piSessions;const registry=new Map(previousRegistry??[]);
 registry.set('fork',{isAlive:()=>true,isRunning:()=>true});globalThis.__piSessions=registry;
 t.after(()=>globalThis.__piSessions=previousRegistry);
 const guard=loadUsageDeleteGuard(),original=guard.sealAndDeleteSync;let calls=0;
 guard.sealAndDeleteSync=(...args)=>{calls++;return original(...args)};t.after(()=>guard.sealAndDeleteSync=original);
 const payload=await(await post(['parent'])).json();assert.equal(payload.results.length,1);assert.equal(payload.results[0].ok,false);
 assert.equal(calls,0);assert((await readFile(f.paths.get('parent'))).length>0);
 const forkHeader=JSON.parse((await readFile(f.paths.get('fork'),'utf8')).split('\n')[0]);assert.equal(forkHeader.parentSession,f.paths.get('parent'));
});
test('sealing failure reports failure and preserves every target',async t=>{
 const f=await fixture(t);await f.add('keep-a');await f.add('keep-b');
 const guard=loadUsageDeleteGuard(),original=guard.sealAndDeleteSync;guard.sealAndDeleteSync=()=>{throw Error('isolated seal failure')};t.after(()=>guard.sealAndDeleteSync=original);
 const payload=await(await post(['keep-a','keep-b'])).json();assert(payload.results.every(r=>!r.ok));assert.deepEqual(payload.deletedSessionIds,[]);
 for(const path of f.paths.values())assert((await readFile(path)).length>0);
});
test('invalid batches are rejected before disk mutation',async()=>{
 for(const ids of [[],['../escape'],[null],Array(101).fill('a')])assert.equal((await post(ids)).status,400);
});

test('partial temporary write fails closed and leaves original child and parent intact',async t=>{
 const f=await fixture(t);await f.add('grandparent');await f.add('parent','grandparent');const child=await f.add('fork','parent');
 const before=await readFile(child);const probe=await openFile(child,'r');const proto=Object.getPrototypeOf(probe);await probe.close();
 const original=proto.writeFile;
 proto.writeFile=async function(contents,...args){await original.call(this,contents.slice(0,17),...args);throw Object.assign(Error('isolated partial write'),{code:'EIO'});};
 t.after(()=>proto.writeFile=original);
 const payload=await(await post(['parent'])).json();assert.equal(payload.results[0].ok,false);assert.deepEqual(payload.deletedSessionIds,[]);
 assert.deepEqual(await readFile(child),before);assert((await readFile(f.paths.get('parent'))).length>0);
 assert(!(await fsPromises.readdir(f.dir)).some(name=>name.endsWith('.tmp')),'temporary partial file cleaned');
});
test('directory permission failure cannot skip child checks and delete the parent',async t=>{
 const f=await fixture(t);await f.add('parent');const child=await f.add('fork','parent');const before=await readFile(child);
 const original=fsPromises.readdir;let injectedCalls=0;
 fsPromises.readdir=async function(dir,...args){if(String(dir)===f.dir){injectedCalls++;throw Object.assign(Error('isolated directory denied'),{code:'EACCES'});}return original.call(this,dir,...args);};syncBuiltinESMExports();
 t.after(()=>{fsPromises.readdir=original;syncBuiltinESMExports();});
 const payload=await(await postWithFreshImports(['parent'])).json();assert(injectedCalls>0,'directory fault reached backend');assert.equal(payload.results[0].ok,false);assert.deepEqual(payload.deletedSessionIds,[]);
 assert.deepEqual(await readFile(child),before);assert((await readFile(f.paths.get('parent'))).length>0);
});
test('rename failure cannot truncate a surviving child or remove its parent',async t=>{
 const f=await fixture(t);await f.add('grandparent');await f.add('parent','grandparent');const child=await f.add('fork','parent');const before=await readFile(child);
 const original=fsPromises.rename;let injectedCalls=0;
 fsPromises.rename=async function(src,dest){if(String(dest)===child){injectedCalls++;throw Object.assign(Error('isolated rename failure'),{code:'EIO'});}return original.call(this,src,dest);};syncBuiltinESMExports();
 t.after(()=>{fsPromises.rename=original;syncBuiltinESMExports();});
 const payload=await(await postWithFreshImports(['parent'])).json();assert(injectedCalls>0,'rename fault reached backend');assert.equal(payload.results[0].ok,false);assert.deepEqual(payload.deletedSessionIds,[]);
 assert.deepEqual(await readFile(child),before);assert((await readFile(f.paths.get('parent'))).length>0);
 assert(!(await fsPromises.readdir(f.dir)).some(name=>name.endsWith('.tmp')));
});
test('a missing grandparent does not leave surviving forks linked to a nonexistent file',async t=>{
 const f=await fixture(t);await f.add('grandparent');await f.add('parent','grandparent');const child=await f.add('fork','parent');
 await rm(f.paths.get('grandparent'));invalidateSessionListCache();
 const payload=await(await post(['parent'])).json();assert.equal(payload.results[0].ok,true,JSON.stringify(payload));
 const header=JSON.parse((await readFile(child,'utf8')).split('\n')[0]);assert.equal(header.parentSession,undefined);
});

test('successful deletion forgets the execution receipt as well as the session file', async t=>{
 const f=await fixture(t);await f.add('status-delete');
 const {ProjectStatusLedger}=await jiti.import('../../../../lib/project-status-ledger.ts');
 const previous=globalThis.__piProjectStatusLedger;const ledger=new ProjectStatusLedger();globalThis.__piProjectStatusLedger=ledger;t.after(()=>globalThis.__piProjectStatusLedger=previous);
 ledger.begin('status-delete');ledger.finish('status-delete','error');
 assert.equal(ledger.snapshot([],[]).statusSnapshot.executions.length,1);
 const payload=await(await post(['status-delete'])).json();assert(payload.results[0].ok,JSON.stringify(payload));
 assert.equal(ledger.snapshot([],[]).statusSnapshot.executions.length,0);
});
