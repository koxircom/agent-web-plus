'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/../modules/05-composer-and-input-workflow.js','utf8');
const start=source.indexOf('  function getBatchDeleteJobStorage()'),end=source.indexOf('\n  function createBatchDeleteJobId()',start);
assert(start>=0&&end>start);
test('finished job preview titles survive reload and old pointers remain valid',()=>{
 const data=new Map(),storage={setItem:(k,v)=>data.set(k,v),getItem:k=>data.get(k)||null,removeItem:k=>data.delete(k)};
 const c={window:{localStorage:storage},batchDeleteJobStorageKey:'job'};
 vm.runInNewContext(source.slice(start,end)+'\nthis.save=saveBatchDeleteJobPointer;this.read=readBatchDeleteJobPointer;',c);
 c.save({id:'job-1',ids:['a','b'],titles:{a:'客户订单',b:'另一个会话'}});
 const restored=c.read();assert.equal(restored.titles.a,'客户订单');assert.equal(restored.titles.b,'另一个会话');
 data.set('job',JSON.stringify({id:'job-2',ids:['a']}));
 assert.equal(c.read().id,'job-2');assert.equal(c.read().titles.a,undefined);
});
