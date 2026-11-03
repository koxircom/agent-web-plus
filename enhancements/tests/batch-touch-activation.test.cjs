'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const code=fs.readFileSync(process.env.BATCH_ACTIVATION_SOURCE||path.join(__dirname,'../modules/05-composer-and-input-workflow.js'),'utf8');
const start=code.indexOf('  addManagedListener(document, "touchstart", (event) => {\n    if (!isSessionBatchMode) return;');
const end=code.indexOf('\n  addManagedListener(document, "touchmove"',start);assert(start>=0&&end>start);
function fixture({onCheckbox=true,touches=1}={}){
 let listener,options;const writes=[],row={getAttribute:()=> 's1'},wrap={};
 const target={closest(s){if(s==='.pi-enh-session-batch-checkbox-wrap')return onCheckbox?wrap:null;if(s.startsWith('.pi-enh-session-row-host'))return row;return null}};
 const event={target,touches:Array.from({length:touches},()=>({clientX:30,clientY:50})),cancelable:true,defaultPrevented:false,preventDefault(){this.defaultPrevented=true}};
 const ctx={document:{},isSessionBatchMode:true,isBatchTouchDragging:false,checkBatchWorkspaceChange(){},cleanBatchTouchState(){},getOrderedSessionBatchIds:()=>['s1','s2'],selectedSessionBatchIds:new Set(),computeBatchRangeSelection:(snapshot,ids,anchor,current,checked)=>checked?new Set([...snapshot,anchor]):new Set([...snapshot].filter(id=>id!==anchor)),withMutationGuard:fn=>fn(),updateSingleBatchRow(id,checked){writes.push({id,checked,defaultPrevented:event.defaultPrevented})},syncSessionBatchBar(){},addManagedListener(host,type,fn,opts){listener=fn;options=opts}};
 vm.createContext(ctx);vm.runInContext(code.slice(start,end),ctx);return{ctx,event,writes,options,run(){listener(event)}};
}
test('checkbox touch is consumed before updating selection, so native activation cannot toggle it again',()=>{const f=fixture();f.run();assert.equal(f.event.defaultPrevented,true);assert.equal(f.options.passive,false);assert.deepEqual(f.writes,[{id:'s1',checked:true,defaultPrevented:true}]);assert.deepEqual([...f.ctx.selectedSessionBatchIds],['s1'])});
test('touching the content leaves native scrolling and ordinary row click available',()=>{const f=fixture({onCheckbox:false});f.run();assert.equal(f.event.defaultPrevented,false);assert.equal(f.writes.length,0)});
test('a multi-finger gesture does not select a row or consume its touchstart',()=>{const f=fixture({touches:3});f.run();assert.equal(f.event.defaultPrevented,false);assert.equal(f.writes.length,0)});
