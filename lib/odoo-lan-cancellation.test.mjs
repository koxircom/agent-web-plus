import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {markOdooStopFence,readOdooStopFences,isOdooStopped} from './odoo-lan-cancellation.ts';
import {cancelOdooLanWakeups,prepareOdooLanReacquire,createOdooLanDispatcher} from './odoo-lan-runtime.ts';
import {setOdooLanClientStub} from './odoo-lan-service.ts';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'odoo-stop-guards-'));
const keys=['PI_CODING_AGENT_DIR','PI_AGENT_DIR','AGENT_WEB_DATA_DIR'];
const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));for(const key of keys)process.env[key]=root;
after(()=>{setOdooLanClientStub(null);for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}fs.rmSync(root,{recursive:true,force:true});});
function clientFor(sid){
  let snapshot={protocol:'odoo-addon-lan-v1',version:1,revision:1,updatedAt:new Date().toISOString(),resources:[{resource:'qa_addon',status:'held',owner:{sessionId:'owner-elsewhere',instanceId:'synology:30141'},queue:[{sessionId:sid,instanceId:'synology:30142',queueId:'old-queue',sequence:1,resumeTask:'继续原任务'}]}]};
  const commands=[];
  const client={instanceId:'synology:30142',instanceLabel:'群晖30142',isConfigured:()=>true,getCachedSnapshot:()=>snapshot,status:async()=>snapshot,subscribe:()=>()=>{},close:async()=>{},request:async command=>{commands.push(command);assert.equal(command.action,'cancel');assert.equal(command.queueId,'old-queue');snapshot={...snapshot,revision:2,resources:[{...snapshot.resources[0],queue:[]}]};return{status:'cancelled',snapshot};}};
  return {client,commands};
}

test('offline Stop is durable across a fresh process; restarting dispatcher cancels only the wait without waking or releasing held work',async()=>{
  const sid='offline-stopped-original';const {client,commands}=clientFor(sid);
  let observed;const contacted=new Promise(resolve=>{observed=resolve;});const onlineStatus=client.status;
  client.status=async()=>{observed();throw new Error('isolated authority disconnected');};
  setOdooLanClientStub(client);cancelOdooLanWakeups(sid);await contacted;assert.ok(isOdooStopped(sid));
  const moduleUrl=new URL('./odoo-lan-cancellation.ts',import.meta.url).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {isOdooStopped} from ${JSON.stringify(moduleUrl)};process.exit(isOdooStopped(${JSON.stringify(sid)})?0:9);`],{env:process.env,encoding:'utf8',timeout:5000});
  assert.equal(child.status,0,child.stderr);
  client.status=onlineStatus;let restores=0;
  const dispatcher=createOdooLanDispatcher({client,getConsumers:()=>new Map(),restoreSession:async()=>{restores++;}});
  await dispatcher.triggerScan();assert.equal(restores,0);assert.equal(commands.length,1);
  assert.equal(client.getCachedSnapshot().resources[0].owner.sessionId,'owner-elsewhere');assert.ok(isOdooStopped(sid));await dispatcher.stop();
  await prepareOdooLanReacquire(sid,client);assert.equal(isOdooStopped(sid),false);
});

test('a newer Stop arriving during asynchronous reacquire survives clearing captured old epochs',async()=>{
  const sid='stop-during-reacquire';markOdooStopFence(sid);const {client}=clientFor(sid);const cancel=client.request;
  let newer;
  client.request=async command=>{newer=markOdooStopFence(sid);return cancel(command);};
  await assert.rejects(prepareOdooLanReacquire(sid,client),/较新的停止/);
  assert.deepEqual(readOdooStopFences(sid),[newer]);
});

test('unknown cancellation or an unchanged queue cannot clear persisted Stop or authorize a new acquire',async()=>{
  const sid='unconfirmed-old-wait';markOdooStopFence(sid);const {client,commands}=clientFor(sid);
  client.request=async command=>{commands.push(command);return{status:'acknowledged',snapshot:client.getCachedSnapshot()};};
  await assert.rejects(prepareOdooLanReacquire(sid,client),/旧排队或交接仍待确认/);
  assert.ok(isOdooStopped(sid));assert.deepEqual(commands.map(command=>command.action),['cancel']);
});
