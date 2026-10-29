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
test('windows desktop native protocol passes inspection and reports constrained queueing',()=>{
 const descriptor={
  protocol: 'agent-web-codex-windows-desktop',
  version: 1,
  platform: 'win32',
  capabilities: ['timeline-v1', 'prompt-identity-v1', 'desktop-owner-v1', 'workspace-files-v1']
 };
 const result=inspectCodexCompatibility(descriptor);
 assert.equal(result.status, 'verified');
 assert.equal(result.protocolVersion, 1);
 assert.match(result.message, /Windows 原生桌面/);
 assert.match(result.message, /不显示与操作原生桌面队列/);
 assert.match(result.message, /仅已有且已加载会话可直接发送/);
});
test('windows desktop native protocol requires win32 platform and rejects other platforms',()=>{
 for (const badPlatform of [undefined, null, 'linux', 'darwin', 'unknown', 123]) {
  const descriptor={
   protocol: 'agent-web-codex-windows-desktop',
   version: 1,
   platform: badPlatform,
   capabilities: ['timeline-v1', 'prompt-identity-v1', 'desktop-owner-v1']
  };
  assert.throws(()=>inspectCodexCompatibility(descriptor), CodexCompatibilityError);
 }
});
test('windows desktop native protocol requires timeline-v1, prompt-identity-v1 and desktop-owner-v1, rejecting missing capabilities in Chinese',()=>{
 const base={
  protocol: 'agent-web-codex-windows-desktop',
  version: 1,
  platform: 'win32'
 };
 assert.throws(()=>inspectCodexCompatibility({...base, capabilities: ['prompt-identity-v1', 'desktop-owner-v1']}), /会话历史/);
 assert.throws(()=>inspectCodexCompatibility({...base, capabilities: ['timeline-v1', 'desktop-owner-v1']}), /消息身份确认/);
 assert.throws(()=>inspectCodexCompatibility({...base, capabilities: ['timeline-v1', 'prompt-identity-v1']}), /桌面实例所有权/);
});
test('windows desktop native protocol rejects mismatched version',()=>{
 const descriptor={
  protocol: 'agent-web-codex-windows-desktop',
  version: 2,
  platform: 'win32',
  capabilities: ['timeline-v1', 'prompt-identity-v1', 'desktop-owner-v1']
 };
 assert.throws(()=>inspectCodexCompatibility(descriptor), CodexCompatibilityError);
});
