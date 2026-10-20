import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createJiti} from 'jiti';
const dir=await mkdtemp(join(tmpdir(),'pi-codex-settings-'));
process.env.PI_CODING_AGENT_DIR=dir;
after(()=>rm(dir,{recursive:true,force:true}));
const jiti=createJiti(import.meta.url,{alias:{'server-only':'next/dist/compiled/server-only/empty.js'}});
const api=await jiti.import('./execution-engine-settings.ts');
test('opt-in settings remain private, masked and do not connect to any backend',async()=>{
 const savedFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('must not connect')};
 try {
  const initial=await api.readExecutionEngineSettings();assert.equal(initial.defaultEngine,'pi');assert.equal(initial.codex.enabled,false);
  const saved=await api.saveExecutionEngineSettings({defaultEngine:'codex',codex:{enabled:true,url:'http://127.0.0.1:19097/',username:'operator',password:'private-password'}});
  assert.equal(saved.codex.hasPassword,true);assert(!JSON.stringify(saved).includes('private-password'));
  assert.equal((await stat(join(dir,'execution-engines.json'))).mode&0o777,0o600);
  await api.saveExecutionEngineSettings({codex:{password:''}});assert.equal((await api.readExecutionEngineSettings()).codex.password,'private-password');
  await assert.rejects(()=>api.saveExecutionEngineSettings({codex:{url:'http://user:password@localhost/'}}));
  await assert.rejects(()=>api.saveExecutionEngineSettings({codex:{clearPassword:'yes'}}));
  assert.equal(calls,0);assert.equal(api.isCodexSessionId('codex:'+'-'.repeat(36)),false);
  assert.equal(JSON.parse(await readFile(join(dir,'execution-engines.json'))).defaultEngine,'codex');
 } finally {globalThis.fetch=savedFetch;await rm(dir,{recursive:true,force:true})}
});
