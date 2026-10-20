import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { userMessageKey, preservePendingUserMessage, bindUserMessageIdentity, bindUserHistoryIdentities, reconcileDeliveredUserEntry, reconcileUserReceipt, preserveLiveUserMessages, userMessageRenderKey } = await createJiti(import.meta.url).import("./prompt-recovery.ts");

function textMessage(content) {
  return { role: "user", content, timestamp: 1 };
}

test("builds stable keys for matching optimistic text messages", () => {
  assert.equal(userMessageKey(textMessage("repeat this")), userMessageKey(textMessage("repeat this")));
  assert.notEqual(userMessageKey(textMessage("first")), userMessageKey(textMessage("second")));
});

test('history arriving before SSE replaces an image echo by request/entry identity despite SDK transformations',()=>{
 const echo={role:'user',content:[{type:'text',text:'inspect'},{type:'image',data:'original',mimeType:'image/png'}],timestamp:1};
 const history={role:'user',content:[{type:'text',text:'inspect\n[Image: original 1140x2616, displayed at 872x2000.]'},{type:'image',data:'resized',mimeType:'image/png'}],timestamp:2};
 const pending={sessionId:'s',message:echo,precedingEntryIds:[],requestId:'request-a'};
 bindUserMessageIdentity(echo,{requestId:'request-a'});bindUserHistoryIdentities([history],['entry-a'],{'request-a':'entry-a'});
 assert.notEqual(userMessageKey(echo),userMessageKey(history));
 const view=preservePendingUserMessage([history],['entry-a'],'s',pending);assert.deepEqual(view,[history]);
 const delivered={...history};bindUserMessageIdentity(delivered,{requestId:'request-a'});
 assert.equal(reconcileDeliveredUserEntry(view,delivered,pending),view);
});

test('SSE first consumes only its own echo and a replay cannot append across intervening assistant messages',()=>{
 const echo=textMessage('same'),pending={sessionId:'s',message:echo,precedingEntryIds:[],requestId:'request-a'};
 bindUserMessageIdentity(echo,{requestId:'request-a'});
 const first={...echo,timestamp:2};bindUserMessageIdentity(first,{requestId:'request-a'});
 const once=reconcileDeliveredUserEntry([echo],first,pending);assert.deepEqual(once,[first]);
 const assistant={role:'assistant',content:[],timestamp:3},replay={...first};bindUserMessageIdentity(replay,{requestId:'request-a'});
 const withAnswer=[...once,assistant];assert.equal(reconcileDeliveredUserEntry(withAnswer,replay,null),withAnswer);
});

test('distinct identical submissions remain distinct even at the same timestamp',()=>{
 const a=textMessage('same'),b=textMessage('same');bindUserMessageIdentity(a,{requestId:'a',entryId:'1'});bindUserMessageIdentity(b,{requestId:'b',entryId:'2'});
 assert.deepEqual(reconcileDeliveredUserEntry([a],b,null),[a,b]);
 assert.deepEqual(reconcileUserReceipt([a,b],'a','1'),[a,b]);
});

test('a committed receipt removes only the exact echo already present in authoritative history',()=>{
 const history=textMessage('same'),echo=textMessage('same'),other=textMessage('same');
 bindUserHistoryIdentities([history,other],['entry-a','entry-b']);bindUserMessageIdentity(echo,{requestId:'request-a'});
 const assistant={role:'assistant',content:[],timestamp:2};
 assert.deepEqual(reconcileUserReceipt([history,echo,other,assistant],'request-a','entry-a'),[history,other,assistant]);
});

test('another request cannot consume the local echo and unresolved history never certifies it by text',()=>{
 const echo=textMessage('same'),other=textMessage('same'),pending={sessionId:'s',message:echo,precedingEntryIds:[],requestId:'own'};
 bindUserMessageIdentity(echo,{requestId:'own'});bindUserHistoryIdentities([other],['entry-other'],{other:'entry-other'});
 assert.deepEqual(preservePendingUserMessage([other],['entry-other'],'s',pending),[other,echo]);
 assert.deepEqual(reconcileDeliveredUserEntry([echo],other,pending),[echo,other]);
});

test('identity annotations do not mutate frozen wire payloads or serialized cache bytes',()=>{
 const message=Object.freeze(textMessage('same')),before=JSON.stringify(message);
 bindUserMessageIdentity(message,{requestId:'a',entryId:'1'});assert.equal(JSON.stringify(message),before);
 const replay=textMessage('same');bindUserMessageIdentity(replay,{requestId:'a',entryId:'1'});
 const history=[message];assert.equal(reconcileDeliveredUserEntry(history,replay,null),history);
});

test("includes attached images in optimistic message keys", () => {
  const submitted = {
    role: "user",
    content: [
      { type: "text", text: "inspect" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ],
    timestamp: 1,
  };
  const differentImage = {
    ...submitted,
    content: [
      { type: "text", text: "inspect" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "BAUG" } },
    ],
  };
  assert.notEqual(userMessageKey(submitted), userMessageKey(differentImage));
});

test('unconfirmed text and image echoes survive old history without changing it',()=>{
 for(const message of [textMessage('same'),{role:'user',content:[{type:'image',data:'AQID',mimeType:'image/png'}],timestamp:1}]){
  const history=[{...message,timestamp:0}],pending={sessionId:'s',message,precedingEntryIds:['old']};
  const result=preservePendingUserMessage(history,['old'],'s',pending);
  assert.equal(result.length,2);assert.equal(result[1],message);assert.equal(history.length,1);
  assert.equal(preservePendingUserMessage(history,['new'],'s',pending),history);
  assert.equal(preservePendingUserMessage(history,['old'],'other',pending),history);
  assert.equal(preservePendingUserMessage(history,['old'],'s',null),history);
 }
});

 test('live user entries survive stale history until exact history identity takes over without remount',()=>{
 const live=textMessage('quote body');bindUserMessageIdentity(live,{sessionId:'s',requestId:'r',entryId:'e',awaitingHistory:true});
 const key=userMessageRenderKey(live);
 assert.deepEqual(preserveLiveUserMessages([], [live], 's'),[live]);
 assert.deepEqual(preserveLiveUserMessages([], [live], 'other'),[]);
 const saved=textMessage('quote body');bindUserHistoryIdentities([saved],['e'],{r:'e'});
 assert.deepEqual(preserveLiveUserMessages([saved],[live],'s'),[saved]);
 assert.equal(userMessageRenderKey(saved),key);
 assert.deepEqual(preserveLiveUserMessages([], [saved], 's'),[]);
 });
 test('optimistic to delivered identity preserves the rendered quote node',()=>{
 const echo=textMessage('same');bindUserMessageIdentity(echo,{requestId:'r'});const key=userMessageRenderKey(echo);
 const delivered=textMessage('same');bindUserMessageIdentity(delivered,{requestId:'r',entryId:'e'});
 reconcileDeliveredUserEntry([echo],delivered,{sessionId:'s',message:echo,requestId:'r',precedingEntryIds:[]});
 assert.equal(userMessageRenderKey(delivered),key);
 });
