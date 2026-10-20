import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AskUserTextPanel, AskUserPanel} from '@/components/AskUserPanel';
import {I18nProvider} from '@/hooks/useI18n';
import type {ExtensionUiRequest} from '@/lib/types';
function Fixture(){
 const [requests,setRequests]=useState<ExtensionUiRequest[]>([]);
 const [pi,setPi]=useState(location.search.includes('pi'));
 useEffect(()=>{if(!pi)void fetch('/requests').then(r=>r.json()).then(setRequests);},[pi]);
 const native=requests[0];
 const plain=location.search.includes('plain');
 const longQuestion=new URLSearchParams(location.search).get('long');
 return <main><h1>{pi?'Pi Agent':'Codex'} · 待回答</h1>
 {!pi && native?.method==='input' && <AskUserTextPanel key={native.id} request={plain ? {...native, askUser:undefined} : native} waitingCount={requests.length-1} onRespond={async(request,response)=>{
   const result=await fetch('/respond',{method:'POST',body:JSON.stringify({id:request.id,...response})});
   if(!result.ok)return false;
   setRequests(await result.json());return true;
 }}/>} 
 {pi && <AskUserPanel request={{type:'extension_ui_request',id:'pi-question',method:'custom',lines:[]}} question={{toolCallId:'pi-question',question:longQuestion || 'Pi 仍使用原提问卡片',options:[{title:'保持兼容'},{title:'自定义'}],allowFreeform:true,allowMultiple:false,allowComment:false}}
 onInput={async(_request,data)=>{await fetch('/pi-input',{method:'POST',body:JSON.stringify(data)});setPi(false);return true;}}/>}
 {!pi&&!requests.length&&<p role="status">回答已提交</p>}
 <textarea aria-label="消息输入框" placeholder="输入后续消息…" />
 </main>;
}
createRoot(document.getElementById('root')!).render(<I18nProvider><Fixture/></I18nProvider>);
