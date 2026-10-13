'use strict';
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../modules/08-settings-panels-and-lifecycle.js'),'utf8');
const condition=source.match(/if \((panel.isConnected &&[^\n]+)\) \{\n        renderUsagePanel/)[1];
test('deferred usage render completes for hidden hosts and skips replaced, detached, or disabled hosts',()=>{
 const view={};for(const state of [{connected:true,hidden:false,same:true,enabled:true,expected:true},{connected:true,hidden:true,same:true,enabled:true,expected:true},{connected:false,hidden:true,same:true,enabled:true,expected:false},{connected:true,hidden:false,same:false,enabled:true,expected:false},{connected:true,hidden:false,same:true,enabled:false,expected:false}]){
 const panel={isConnected:state.connected,firstElementChild:state.same?view:{},closest:()=>state.hidden?{}:null};
 assert.equal(vm.runInNewContext(condition,{panel,loadingView:view,isPluginEnabled:()=>state.enabled}),state.expected);
 }
});
