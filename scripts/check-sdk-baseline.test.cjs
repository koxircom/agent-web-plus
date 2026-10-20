const {test}=require('node:test');const assert=require('node:assert/strict');const {validateVersions}=require('./check-sdk-baseline.cjs');
const expected=Object.fromEntries(['pi-ai','pi-agent-core','pi-coding-agent','pi-tui'].map(n=>[n,'1.3.0']));
test('declared release versions cannot disguise stale local SDK dependencies',()=>{
 assert.throws(()=>validateVersions(expected,{...expected,'pi-coding-agent':'1.2.0'}),/拒绝构建/);
 assert.deepEqual(validateVersions(expected,{...expected}),expected);
});
