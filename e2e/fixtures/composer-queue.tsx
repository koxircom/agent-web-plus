import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ComposerQueue} from '../../components/ComposerQueue';
const engine = new URLSearchParams(location.search).get('engine') === 'codex' ? 'codex' : 'pi';
const image={data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM3sAAAAASUVORK5CYII=',mimeType:'image/png',alt:'演示图片'};
let handleAction=(detail:any)=>{};
window.addEventListener('pi:native-queue-snapshot',((event:CustomEvent)=>{
 const {signature,entries}=event.detail;
 window.dispatchEvent(new CustomEvent('pi:native-queue-details',{detail:{signature,enabled:true,actionsEnabled:true,busy:false,reorder:true,images:entries.map((e:any)=>e.text.includes('图片')?[image]:[])}}));
}) as EventListener);
window.addEventListener('pi:native-queue-action',((event:CustomEvent)=>handleAction(event.detail)) as EventListener);
(window as any).__queueActions=[];
function Harness(){
 const [queue,setQueue]=useState({steering:[] as string[],followUp:['带图片的第一条排队消息','这是一条较长的普通文字排队消息，用于验证省略、按钮和拖动','带图片的第三条排队消息']});
 const [draft,setDraft]=useState('');
 handleAction=detail=>{
  (window as any).__queueActions.push(detail.action);
  setQueue(previous=>{
   const entries=[...previous.steering.map(text=>({kind:'steering' as const,text})),...previous.followUp.map(text=>({kind:'followUp' as const,text}))];
   const row=entries[detail.index];if(!row)return previous;
   if(detail.action==='gallery')return previous;
   if(detail.action==='reorder'){entries.splice(detail.index,1);entries.splice(detail.targetIndex,0,row)}
   if(detail.action==='promote')row.kind='steering';
   if(detail.action==='recall'||detail.action==='delete'){entries.splice(detail.index,1);if(detail.action==='recall')setDraft(row.text)}
   return {steering:entries.filter(x=>x.kind==='steering').map(x=>x.text),followUp:entries.filter(x=>x.kind==='followUp').map(x=>x.text)};
  });
 };
 return <main><h1>{engine==='codex'?'Codex':'Pi Agent'} 队列</h1><ComposerQueue sessionId="same-fixture" executionEngine={engine} queuedMessages={queue}/><div className="fixture-composer"><textarea aria-label="消息草稿" value={draft} readOnly/></div></main>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
