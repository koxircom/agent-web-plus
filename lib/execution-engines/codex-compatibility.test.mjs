import test from 'node:test';import assert from 'node:assert/strict';import {createJiti}from'jiti';import fs from'node:fs';
const {inspectCodexCompatibility,CodexCompatibilityError}=await createJiti(import.meta.url).import('./codex-compatibility.ts');
const protocol=JSON.parse(fs.readFileSync(new URL('../../connectors/codex-bridge/protocol.json',import.meta.url)));
test('canonical protocol accepts extra capabilities and different product releases',()=>{
 const result=inspectCodexCompatibility({...protocol,version:1,release:'another-product-release',capabilities:[...protocol.capabilities,'future-optional']});assert.equal(result.status,'verified');assert.equal(result.protocolVersion,1);
});
test('missing declaration permits only confirmed legacy standalone service with explicit warning',()=>{
 assert.equal(inspectCodexCompatibility(undefined,{mode:'standalone',connected:false}).status,'legacy');
 for(const value of [null,{},false,{mode:'desktop'}])assert.throws(()=>inspectCodexCompatibility(undefined,value),CodexCompatibilityError);
});
test('unknown protocol, mismatched API major and malformed declarations cannot claim success',()=>{
 for(const value of [null,[],42,{...protocol,protocol:'desktop'},{...protocol,version:2},{...protocol,version:'1'},{...protocol,capabilities:{}},{...protocol,capabilities:[1]}])assert.throws(()=>inspectCodexCompatibility(value),CodexCompatibilityError);
});
test('missing required capability is explained in Chinese',()=>{
 assert.throws(()=>inspectCodexCompatibility({...protocol,capabilities:protocol.capabilities.filter(v=>v!=='queue-v2')}),/消息队列/);
});
