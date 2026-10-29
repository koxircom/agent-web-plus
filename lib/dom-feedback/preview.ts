import { collectDomFeedbackTarget } from './target';
import { captureBoundedElement } from './capture';
import { getDomSourceHint } from './source';

export function buildAnnotatedPreview(content: string, token: string, filePath: string, assetOrigin: string): string {
  const config = JSON.stringify({ token, filePath, assetUrl: assetOrigin + '/dom-feedback/html-to-image-1.11.13.js' }).replace(/</g, '\\u003c');
  const script = `(()=>{const config=${config},collect=${collectDomFeedbackTarget.toString()},capture=${captureBoundedElement.toString()},sourceHint=${getDomSourceHint.toString()};
let enabled=false,selected=null,frame=0,hover=null,box=null;
const remove=()=>{if(box)box.remove();box=null;cancelAnimationFrame(frame);frame=0;};
const move=e=>{hover=e.target;if(frame)return;frame=requestAnimationFrame(()=>{frame=0;if(!(hover instanceof Element))return;const r=hover.getBoundingClientRect();if(!box){box=document.createElement('div');box.setAttribute('data-dom-feedback-ignore','');box.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #60a5fa;background:#60a5fa18';document.documentElement.append(box)}Object.assign(box.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'})})};
const click=e=>{if(!(e.target instanceof Element))return;e.preventDefault();e.stopImmediatePropagation();const target=collect(e.target,{filePath:config.filePath});if(!target){e.target.blur?.();return}selected=e.target;parent.postMessage({type:'pi-dom-feedback-target',token:config.token,target,hint:sourceHint(e.target)},'*')};
const key=e=>{if(e.key==='Escape'&&!e.isComposing&&e.keyCode!==229){e.preventDefault();e.stopImmediatePropagation();parent.postMessage({type:'pi-dom-feedback-cancel',token:config.token},'*')}};
const toggle=value=>{if(enabled===value)return;enabled=value;if(value){document.addEventListener('pointermove',move);window.addEventListener('click',click,true);window.addEventListener('keydown',key,true)}else{document.removeEventListener('pointermove',move);window.removeEventListener('click',click,true);window.removeEventListener('keydown',key,true);remove()}};
let library,captureController,captureRequest;
const load=()=>library||(library=new Promise((resolve,reject)=>{const s=document.createElement('script'),timer=setTimeout(()=>{s.remove();reject(Error('capture library timeout'))},6000);s.src=config.assetUrl;s.onload=()=>{clearTimeout(timer);resolve(window.htmlToImage)};s.onerror=e=>{clearTimeout(timer);s.remove();reject(e)};document.head.append(s)}).catch(e=>{library=null;throw e}));
addEventListener('message',async e=>{const d=e.data;if(e.source!==parent||d?.token!==config.token||d?.type!=='pi-dom-feedback-control')return;if(d.action==='enable')toggle(true);else if(d.action==='disable')toggle(false);else if(d.action==='cancel-capture'&&d.requestId===captureRequest){captureController?.abort()}else if(d.action==='capture'&&typeof d.requestId==='string'&&d.requestId.length<100){captureController?.abort();const controller=new AbortController();captureController=controller;captureRequest=d.requestId;try{if(!selected||!selected.isConnected)throw Error();const lib=await load();if(controller.signal.aborted)throw Error();const blob=await capture(selected,lib.toBlob,controller.signal),bytes=await blob.arrayBuffer();parent.postMessage({type:'pi-dom-feedback-capture',token:config.token,requestId:d.requestId,bytes},'*',[bytes])}catch{parent.postMessage({type:'pi-dom-feedback-capture',token:config.token,requestId:d.requestId},'*')}finally{if(captureRequest===d.requestId){captureRequest=null;captureController=null}}}});
})();`;
  return content + '<script>' + script.replace(/<\/script/gi, '<\\/script') + '</script>';
}
