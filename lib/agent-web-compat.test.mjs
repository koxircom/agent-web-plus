import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url);
const { prepareAgentWebEnvironment }=require('../bin/agent-web-compat.js');
const root=fileURLToPath(new URL('../',import.meta.url));
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'agent-web-compat-'));
const isolatedEnv=()=>{const env={...process.env};for(const key of ['PI_CODING_AGENT_DIR','AGENT_WEB_DATA_DIR','PI_WEB_PORT'])delete env[key];return env;};

test('renamed entry defaults to the existing Pi directory without creating or moving files',()=>{
 const home=temp();try{const env={};assert.equal(prepareAgentWebEnvironment(env,{home,cwd:home}),path.join(home,'.pi','agent'));assert.equal(env.PI_CODING_AGENT_DIR,path.join(home,'.pi','agent'));assert.deepEqual(fs.readdirSync(home),[]);}finally{fs.rmSync(home,{recursive:true});}
});
test('the exact legacy override and other configuration remain unchanged',()=>{
 const env={PI_CODING_AGENT_DIR:'./custom data',PI_WEB_PASSWORD:'fixture-only',PORT:'30141'};
 assert.equal(prepareAgentWebEnvironment(env),env.PI_CODING_AGENT_DIR);assert.equal(env.PI_CODING_AGENT_DIR,'./custom data');assert.equal(env.PI_WEB_PASSWORD,'fixture-only');assert.equal(env.PORT,'30141');
});
test('the new directory alias maps to the same SDK environment before startup',()=>{
 const env={AGENT_WEB_DATA_DIR:'~/custom data'};assert.equal(prepareAgentWebEnvironment(env,{home:'/fixture',cwd:'/fixture'}),'/fixture/custom data');assert.equal(env.PI_CODING_AGENT_DIR,'/fixture/custom data');
});
test('same-directory aliases and symlinks are accepted without changing the legacy value',()=>{
 const home=temp();try{const dir=path.join(home,'original');fs.mkdirSync(dir);const alias=path.join(home,'alias');fs.symlinkSync(dir,alias,'dir');const env={PI_CODING_AGENT_DIR:dir,AGENT_WEB_DATA_DIR:alias};assert.equal(prepareAgentWebEnvironment(env),dir);}finally{fs.rmSync(home,{recursive:true});}
});
test('conflicting data locations refuse startup and never create a second store',()=>{
 const home=temp();try{const first=path.join(home,'original'),second=path.join(home,'empty');fs.mkdirSync(first);const env={PI_CODING_AGENT_DIR:first,AGENT_WEB_DATA_DIR:second};assert.throws(()=>prepareAgentWebEnvironment(env),/指向不同目录/);assert.equal(fs.existsSync(second),false);assert.equal(env.PI_CODING_AGENT_DIR,first);const result=spawnSync(process.execPath,[path.join(root,'bin/agent-web.js'),'--no-open'],{env:{...isolatedEnv(),...env},encoding:'utf8'});assert.equal(result.status,1);assert.match(result.stderr,/指向不同目录/);assert(!result.stderr.includes(first));assert(!result.stderr.includes(second));assert.equal(fs.existsSync(second),false);}finally{fs.rmSync(home,{recursive:true});}
});
test('the package keeps both launch commands and a single lifecycle implementation',()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));assert.equal(pkg.bin['pi-web'],'bin/pi-web.js');assert.equal(pkg.bin['agent-web'],'bin/agent-web.js');assert.match(fs.readFileSync(path.join(root,pkg.bin['agent-web']),'utf8'),/require\("\.\/pi-web\.js"\)/);assert(pkg.files.includes('docs/agent-web-compatibility.md'));
 for(const [name,pattern]of [['pi-web',/Usage: pi-web/],['agent-web',/用法：agent-web/]]){const result=spawnSync(process.execPath,[path.join(root,pkg.bin[name]),'--help'],{env:isolatedEnv(),encoding:'utf8'});assert.equal(result.status,0);assert.match(result.stdout,pattern);}
});
test('real SDK preload reads old settings using the new alias and preserves unknown fields',()=>{
 const home=temp();try{const dir=path.join(home,'original');fs.mkdirSync(dir);const file=path.join(dir,'settings.json');const body=JSON.stringify({theme:'dark',futureUnknown:{keep:true}});fs.writeFileSync(file,body);const bootstrap=new URL('../bin/pi-agent-runtime-bootstrap.mjs',import.meta.url).href;const script=`const s=await import('@earendil-works/pi-coding-agent');const fs=await import('node:fs');console.log(JSON.stringify({dir:s.getAgentDir(),settings:JSON.parse(fs.readFileSync(s.getAgentDir()+'/settings.json'))}))`;
 const result=spawnSync(process.execPath,['--import',bootstrap,'--input-type=module','-e',script],{cwd:root,env:{...isolatedEnv(),AGENT_WEB_DATA_DIR:dir},encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{dir,settings:JSON.parse(body)});assert.equal(fs.readFileSync(file,'utf8'),body);
 }finally{fs.rmSync(home,{recursive:true});}
});
