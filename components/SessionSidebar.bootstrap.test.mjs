import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import React from 'react';
import { renderToString } from 'react-dom/server';
const jiti = createJiti(import.meta.url, { jsx: { runtime: 'automatic' }, tsconfigPaths: true });
const {SessionSidebar} = await jiti.import('./SessionSidebar.tsx');
const {I18nProvider} = await jiti.import('../hooks/useI18n.tsx');
const {getEnhancementSessionTags} = await jiti.import('../lib/enhancement-sidebar-bridge.ts');
const state = {sessionTagsDefinitions:[{id:'done',name:'完成任务',color:'#34d399'}],sessionTagMappings:{s:['done','removed']},sessionColors:{},enhancementSettingsByClient:{}};
const bootstrap={renderedAt:Date.parse('2026-10-10T12:01:00Z'),sessions:[{id:'s',path:'/tmp/s.jsonl',cwd:'/workspace/work',name:'首屏验收',modified:'2026-10-10T12:00:00Z',created:'2026-10-10T12:00:00Z',messageCount:2,firstMessage:'首屏验收'}],sessionListVersion:1,runningSessionIds:[],completionNotificationSuppressedSessionIds:[],decorations:{ok:true,revision:42,state,storageVersion:1}};
test('initial directory and tag are in server HTML before client fetch or enhancement script',()=>{
 const html=renderToString(React.createElement(I18nProvider,null,React.createElement(SessionSidebar,{bootstrap,initialSessionId:'s',onSelectSession(){},onNewSession(){}})));
 assert.match(html,/\/workspace\/work/);
 assert.match(html,/完成任务/);
 assert.match(html,/pi-enh-session-tags-row/);
 assert.match(html,/height:72px/);
 assert.doesNotMatch(html,/正在加载/);
});
test('initial decoration snapshot yields to the active owner, including disable and deletion',()=>{
 assert.deepEqual(getEnhancementSessionTags('s',state,{}),[state.sessionTagsDefinitions[0]]);
 assert.deepEqual(getEnhancementSessionTags('s',state,{__PI_ENH_GET_SESSION_TAGS__:()=>[]}),[]);
 const changed=[{id:'new',name:'待跟进',color:'#facc15'}];
 assert.deepEqual(getEnhancementSessionTags('s',state,{__PI_ENH_GET_SESSION_TAGS__:()=>changed}),changed);
});

test('server HTML and initial browser render share the snapshot clock across a relative-time boundary',()=>{
 const OriginalDate=globalThis.Date;
 const snapshot={...bootstrap,renderedAt:Date.parse('2026-10-10T12:00:59Z')};
 const renderAt=now=>{
  globalThis.Date=class extends OriginalDate {
   constructor(...args){super(...(args.length?args:[now]));}
   static now(){return now;}
  };
  return renderToString(React.createElement(I18nProvider,null,React.createElement(SessionSidebar,{bootstrap:snapshot,initialSessionId:'s',onSelectSession(){},onNewSession(){}}))).match(/title="2026-10-10T12:00:00Z">([^<]+)</)[1];
 };
 try {assert.equal(renderAt(snapshot.renderedAt),renderAt(snapshot.renderedAt+2000));}
 finally {globalThis.Date=OriginalDate;}
});

test('browser unread persistence cannot change the first hydration tree',()=>{
 const before=globalThis.window;
 const render=()=>renderToString(React.createElement(I18nProvider,null,React.createElement(SessionSidebar,{bootstrap,initialSessionId:'s',onSelectSession(){},onNewSession(){}})));
 const server=render();
 globalThis.window={localStorage:{getItem:key=>key==='pi-web:unread-session-ids'?'["s"]':null}};
 try {assert.equal(render(),server);}
 finally {if(before===undefined)delete globalThis.window;else globalThis.window=before;}
});
