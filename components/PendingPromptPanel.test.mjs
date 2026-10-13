import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import React from 'react';
import { renderToString } from 'react-dom/server';
const jiti = createJiti(import.meta.url, { jsx: { runtime: 'automatic' }, tsconfigPaths: true });
const { PendingPromptPanel } = await jiti.import('./PendingPromptPanel.tsx');
const { I18nProvider } = await jiti.import('../hooks/useI18n.tsx');
const store = await jiti.import('../lib/prompt-submissions.ts');
const client = await jiti.import('../lib/agent-client.ts');
const render = (submissions, onConfirm) => renderToString(React.createElement(I18nProvider, null,
  React.createElement(PendingPromptPanel, { submissions, onConfirm })));

test('ambiguous dispatch remains readable after old history is loaded and after refresh, without resending', async t => {
  const oldWindow = globalThis.window, oldFetch = globalThis.fetch;
  const saved = new Map();
  globalThis.window = { sessionStorage: { getItem: k => saved.get(k) ?? null, setItem: (k,v) => saved.set(k,v), removeItem: k => saved.delete(k) } };
  t.after(() => {
    for (const row of store.getPendingPromptSubmissions()) store.releasePromptSubmission(row.requestId);
    globalThis.fetch = oldFetch;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  });
  let posts = 0, checks = 0;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') { posts++; throw TypeError('lost transport'); }
    return new Response(JSON.stringify({status: 'unknown'}));
  };
  await assert.rejects(client.sendAgentCommand('S', {type:'prompt', message:'查询固态硬盘写入情况 <script>bad()</script>', images:[{data:'eA==',mimeType:'image/png'}]}), /lost transport/);
  const confirm = async () => { checks++; };
  const html = render(store.getPendingPromptSubmissions(), confirm);
  assert.match(html, /消息发送结果待确认/);
  assert.match(html, /查询固态硬盘写入情况 &lt;script&gt;/);
  assert.match(html, /已保留 1 张图片/);
  assert.match(html, /核对发送状态/);
  assert.doesNotMatch(html, /<script>/);
  const fresh = await createJiti(import.meta.url, {moduleCache:false}).import('../lib/prompt-submissions.ts');
  assert.match(render(fresh.getPendingPromptSubmissions(), confirm), /查询固态硬盘写入情况/);
  assert.equal(posts, 1);
  assert.equal(checks, 0, 'rendering never executes a command or receipt check');
});

test('confirmed or still-sending submissions do not produce an uncertain delivery panel', () => {
  assert.equal(render([], async () => {}), '');
  assert.equal(render([{requestId:'R',sessionId:'S',status:'sending',message:'optimistic echo',createdAt:1}], async () => {}), '');
});

test('admitted but uncommitted messages remain visible with an accurate save status',()=>{
 const html=render([{requestId:'saved-original',sessionId:'S',status:'accepted',message:'不能静默消失',createdAt:1}],async()=>{});
 assert.match(html,/消息已接收，正在确认保存/);assert.match(html,/不能静默消失/);assert.match(html,/确认写入会话记录后/);
});

test('recalled messages offer explicit draft recovery without suggesting model activity',()=>{
 const row={requestId:'recall-original',sessionId:'S',status:'recalled',message:'撤回时丢失响应的原文',createdAt:1};
 const html=render([row],async()=>{});assert.match(html,/消息已撤回，原文已保留/);assert.match(html,/恢复到输入框/);assert.doesNotMatch(html,/正在确认保存/);
 assert.match(render([{...row,recallRestored:true}],async()=>{}),/确认草稿保存/);
});
