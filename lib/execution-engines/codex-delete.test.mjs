import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createJiti} from 'jiti';

test('single DELETE proxies once to native owner, clears catalog only after acknowledgement, exposes refusal', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-delete-'));
  const priorDir = process.env.PI_CODING_AGENT_DIR, priorFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {globalThis.fetch = priorFetch; if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorDir; await rm(dir, {recursive:true, force:true});});
  const jiti = createJiti(import.meta.url, {alias:{'@':process.cwd(), 'server-only':'next/dist/compiled/server-only/empty.js'}});
  const {saveExecutionEngineSettings, codexConnectionIdentity} = await jiti.import('../execution-engine-settings.ts');
  const {DELETE} = await jiti.import('../../app/api/sessions/[id]/route.ts');
  await saveExecutionEngineSettings({codex:{enabled:true, url:'http://127.0.0.1:19876'}});
  const identity = await codexConnectionIdentity();
  let mode = 'refuse', posts = 0;
  const id = 'codex:01901234-5678-7000-8000-000000000001';
  globalThis.fetch = async (url, opts) => {
    if (url.endsWith('/api/login')) return new Response('{}', {headers:{'Set-Cookie':'test=owned'}});
    if (url.endsWith('/api/auth')) return Response.json({csrf:'owned', authenticated:true});
    assert.equal(url, 'http://127.0.0.1:19876/api/sessions/' + id.slice(6) + '/message-action');
    assert.equal(opts.method, 'POST'); assert.deepEqual(JSON.parse(opts.body), {action:'delete'}); posts++;
    return mode === 'refuse' ? Response.json({error:'会话还有待发送消息，请处理队列后再删除'}, {status:400}) : Response.json(mode === 'bad' ? {} : {ok:true});
  };
  const cacheKey = Symbol.for('pi-web.codex-catalog');
  const cache = {identity, rows:[{id:id.slice(6)}], loadedAt:Date.now(), version:1};
  globalThis[cacheKey] = cache;
  const invoke = () => DELETE(new Request('http://localhost/api/sessions/' + id, {method:'DELETE'}), {params:Promise.resolve({id})});
  const refused = await invoke(); assert.equal(refused.status,400); assert.match((await refused.json()).error,/处理队列/); assert.equal(globalThis[cacheKey],cache);
  mode = 'bad'; const unknown = await invoke(); assert.equal(unknown.status,502); assert.equal(globalThis[cacheKey],cache);
  mode = 'ok'; const accepted = await invoke(); assert.equal(accepted.status,200); assert.deepEqual(await accepted.json(),{ok:true}); assert.equal(globalThis[cacheKey],undefined);
  assert.equal(posts,3,'no automatic mutation retry');
});
