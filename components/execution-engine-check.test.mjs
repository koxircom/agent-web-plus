import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes}from'node:module';import{createJiti}from'jiti';
const {inspectCodexCompatibility,CodexCompatibilityError}=await createJiti(import.meta.url).import('../lib/execution-engines/codex-compatibility.ts');
const protocol=JSON.parse(fs.readFileSync(new URL('../connectors/codex-bridge/protocol.json',import.meta.url)));
const source=fs.readFileSync(new URL('../app/api/execution-engines/check/route.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export const dynamic','const dynamic').replace('export async function POST','async function POST');
function harness(projects={projects:[{key:'p',name:'我的项目',cwd:'/project'}],compatibility:protocol},runtime={mode:'standalone'}){
 const paths=[],ctx={URL,URLSearchParams,Response,inspectCodexCompatibility,CodexCompatibilityError,isApiRequestAllowed:()=>true,codexConnectionIdentity:async()=>'fixed-identity',codexBridgeJson:async(path,_body,options)=>{assert.equal(options.connectionIdentity,'fixed-identity');assert.equal(_body,undefined);paths.push(path);if(path==='/api/projects'){if(projects instanceof Error)throw projects;return projects;}return path==='/api/runtime'?runtime:{models:[]};}};
 vm.runInNewContext(stripTypeScriptTypes(source)+';globalThis.post=POST;',ctx);return{...ctx,paths,post:ctx.post};
}
test('modern quick switching checks protocol with the existing projects read only',async()=>{
 const h=harness(),response=await h.post({url:'http://localhost/api/execution-engines/check?catalog=0'});const body=await response.json();assert.equal(response.status,200);assert.equal(body.compatibility.status,'verified');assert.deepEqual(h.paths,['/api/projects']);
});
test('full check also checks model discovery after protocol validation',async()=>{
 const h=harness(),response=await h.post({url:'http://localhost/api/execution-engines/check'});assert.equal(response.status,502);assert.match((await response.json()).error,/未返回可用模型/);assert.equal(h.paths.length,2);assert(h.paths[1].includes('/catalog?'));
});
test('legacy standalone remains usable with visible unverified-version warning',async()=>{
 const h=harness({projects:[{key:'p',cwd:'/project'}]});const response=await h.post({url:'http://localhost/api/execution-engines/check?catalog=0'});assert.equal(response.status,200);assert.equal((await response.json()).compatibility.status,'legacy');assert.deepEqual(h.paths,['/api/projects','/api/runtime']);
});
test('desktop legacy or wrong API major is rejected before model or session access',async()=>{
 for(const h of [harness({projects:[{}]},{mode:'desktop'}),harness({projects:[{}],compatibility:{...protocol,version:2}})]){const response=await h.post({url:'http://localhost/api/execution-engines/check'});assert.equal(response.status,409);assert.equal((await response.json()).code,'codex_incompatible');assert(!h.paths.some(path=>path.includes('catalog')));}
});
test('missing project API explains the old Bridge mismatch',async()=>{
 const h=harness(Object.assign(new Error('404'),{status:404}));const response=await h.post({url:'http://localhost/api/execution-engines/check?catalog=0'});const body=await response.json();assert.equal(response.status,409);assert.match(body.error,/旧版桌面 Bridge/);
});
