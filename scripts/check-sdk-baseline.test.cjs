const {test}=require('node:test');const assert=require('node:assert/strict');const {validateVersions}=require('./check-sdk-baseline.cjs');
const expected=Object.fromEntries(['pi-ai','pi-agent-core','pi-coding-agent','pi-tui'].map(n=>[n,'1.3.0']));
test('declared release versions cannot disguise stale local SDK dependencies',()=>{
 assert.throws(()=>validateVersions(expected,{...expected,'pi-coding-agent':'1.2.0'}),/拒绝构建/);
 assert.deepEqual(validateVersions(expected,{...expected}),expected);
});

const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {validatePackageLayout}=require('./check-sdk-baseline.cjs');
test('package-level links remain valid but per-file links are rejected before building',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sdk-layout-'));
 try{
  const original=path.join(root,'original'),partial=path.join(root,'partial'),linked=path.join(root,'linked');
  fs.mkdirSync(original);fs.mkdirSync(partial);fs.writeFileSync(path.join(original,'package.json'),'{}');
  fs.symlinkSync(original,linked,'dir');fs.symlinkSync(path.join(original,'package.json'),path.join(partial,'package.json'));
  assert.doesNotThrow(()=>validatePackageLayout(original));assert.doesNotThrow(()=>validatePackageLayout(linked));
  assert.throws(()=>validatePackageLayout(partial),/external.*拒绝构建/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
