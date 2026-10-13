'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../modules/02-plugin-registry-and-settings-schema.js'),'utf8');
const start=source.indexOf('  let activeDurableStateSyncPromise = null;');
const end=source.indexOf('  let decorationOpSequence',start);
function harness({revision=10,localRevision=0,valid=true}={}){
 const calls={fetch:0,applied:[],saved:[],backups:0};
 const initial={ok:true,revision,state:{sessionTagsDefinitions:[{id:'s',name:'服务器标签'}],sessionTagMappings:{sid:['s']}}};
 const c={window:{__PI_ENH_NATIVE_STATE_API__:true,__PI_ENH_INITIAL_DURABLE_STATE__:initial},isDisposed:false,
 getDurableStateBaseUrl:()=>'/api',getDurableStateInstanceParam:()=>'',fetchModelsConfigBounded:async()=>{calls.fetch++;return{resp:{ok:true},json:initial};},
 isValidDurablePostResponse:()=>valid,getLocalDurableStateRevision:()=>localRevision,
 readSessionTagsDefinitions:()=>[],readSessionTagMappings:()=>({}),saveSessionTagsBackupSnapshotIfNeeded:()=>{calls.backups++;return{needed:false,ok:true}},
 applyDurableStateToLocal:state=>calls.applied.push(state),setLocalDurableStateRevision:rev=>calls.saved.push(rev),console:{warn(){},error(){}},document:{querySelector:()=>null}};
 vm.createContext(c);vm.runInContext(source.slice(start,end)+'\nglobalThis.sync=syncDurableState;',c);return{c,calls,initial};
}
test('bootstrap snapshot shares the existing single flight and is consumed once without a fetch',async()=>{
 const {c,calls,initial}=harness();await Promise.all([c.sync(),c.sync()]);assert.equal(calls.fetch,0);assert.equal(calls.applied.length,1);assert.equal(calls.applied[0],initial.state);assert.equal('__PI_ENH_INITIAL_DURABLE_STATE__' in c.window,false);await c.sync();assert.equal(calls.fetch,1);
});
test('bootstrap obeys the existing revision and validity gates, while force reads fresh state',async()=>{
 for(const config of [{revision:10,localRevision:11},{valid:false}]){const {c,calls}=harness(config);await c.sync();assert.equal(calls.applied.length,0);}
 const {c,calls}=harness();await c.sync(true);assert.equal(calls.fetch,1);assert.equal(calls.applied.length,1);assert.equal('__PI_ENH_INITIAL_DURABLE_STATE__' in c.window,false);
});
