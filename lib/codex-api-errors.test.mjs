import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
class CodexBridgeError extends Error {constructor(message,status){super(message);this.status=status;}}
const route=fs.readFileSync(new URL('../app/api/models/route.ts',import.meta.url),'utf8');
const getSource=route.slice(route.indexOf('export async function GET')).replace('export async function GET','async function GET').replace('await (await import("@/lib/execution-engines/codex-engine")).codexModels','await codexModels');
function load(codexModels){return vm.runInNewContext(stripTypeScriptTypes(getSource)+'\nGET',{URL,Response,Error,CodexBridgeError,codexModels,resolveExecutionEngine:()=> 'codex',readExecutionEngineSettings:async()=>({defaultEngine:'codex'})});}
test('model rejection returns structured JSON and native status',async()=>{
 const GET=load(async()=>{throw new CodexBridgeError('请选择 Codex 服务已配置的工作区',400)});
 const res=await GET(new Request('http://localhost/api/models?engine=codex&cwd=~'));
 assert.equal(res.status,400);assert.equal((await res.json()).error,'请选择 Codex 服务已配置的工作区');
});
test('model backend outage preserves status and does not fabricate an empty successful catalog',async()=>{
 const GET=load(async()=>{throw new CodexBridgeError('Codex 执行端暂时不可达',502)});
 const res=await GET(new Request('http://localhost/api/models?engine=codex'));
 assert.equal(res.status,502);assert.equal((await res.json()).error,'Codex 执行端暂时不可达');
});
test('successful model catalogs preserve their data',async()=>{
 const catalog={modelList:[{id:'test',provider:'codex'}]};
 const res=await load(async()=>catalog)(new Request('http://localhost/api/models?engine=codex'));
 assert.equal(res.status,200);assert.deepEqual(await res.json(),catalog);
});
