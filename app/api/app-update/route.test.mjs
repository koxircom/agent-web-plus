import assert from 'node:assert/strict';
import test from 'node:test';
import {createJiti} from 'jiti';

const jiti=createJiti(import.meta.url,{alias:{'@':process.cwd(),'server-only':'next/dist/compiled/server-only/empty.js'},moduleCache:false});
const {GET}=await jiti.import('./route.ts');
const latest='https://github.com/koxircom/agent-web-plus/releases/latest';

test('public release redirect supplies a stable version and caches it without the rate-limited API',async t=>{
  const original=globalThis.fetch;delete globalThis.__piWebAppUpdateCache;let requests=0;
  t.after(()=>{globalThis.fetch=original;delete globalThis.__piWebAppUpdateCache;});
  globalThis.fetch=async(url,options)=>{
    requests++;assert.equal(url,latest);assert.equal(options.method,'HEAD');assert.equal(options.redirect,'manual');
    return new Response(null,{status:302,headers:{Location:'https://github.com/koxircom/agent-web-plus/releases/tag/v9.8.7'}});
  };
  const response=await GET();assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.latestVersion,'9.8.7');assert.equal(body.releaseUrl,'https://github.com/koxircom/agent-web-plus/releases/tag/v9.8.7');
  assert.deepEqual(await (await GET()).json(),body);assert.equal(requests,1);
});

test('untrusted or unavailable release metadata remains an error rather than an up-to-date claim',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;delete globalThis.__piWebAppUpdateCache;});
  for(const value of [new Response(null,{status:403}),new Response(null,{status:302,headers:{Location:'https://example.com/releases/tag/v9.8.7'}})]){
    delete globalThis.__piWebAppUpdateCache;globalThis.fetch=async()=>value;
    const response=await GET();assert.equal(response.status,502);assert.equal((await response.json()).updateAvailable,undefined);
  }
});
