const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../enhancements/modules/05-composer-and-input-workflow.js'),'utf8');
const start=source.indexOf('  const handleNativeQueueSnapshot =');const end=source.indexOf('  const handleNativeQueueAction =',start);assert(start>=0&&end>start);
for(const same of [false,true])test('ready queue without tokens requests actions, unchanged text='+same,()=>{
 const sid='codex:fixture',entries=[{kind:'follow-up',text:'不能永久禁用'}],signature=JSON.stringify([sid,entries]),calls=[];
 const context={getEffectiveQueueSessionId:x=>x,composerQueueActionsEnabled:false,composerQueuePanel:null,composerQueueCurrentEntries:entries,composerQueueLastEntriesSignature:same?signature:'old',composerQueueActionsState:null,syncComposerQueuePanel:(attachmentsOnly)=>calls.push(attachmentsOnly),triggerSessionHydration(){},clearQueueDetailCache(){},publishNativeQueueDetails(){}};
 vm.createContext(context);vm.runInContext(source.slice(start,end)+';globalThis.receive=handleNativeQueueSnapshot',context);
 context.receive({detail:{sessionId:sid,entries,actionsEnabled:true,host:{}}});assert.deepEqual(calls,[false]);
 context.composerQueueActionsState={signature};context.receive({detail:{sessionId:sid,entries,actionsEnabled:true,host:{}}});assert.deepEqual(calls,[false,true],'valid tokens do not cause repeated reads');
});
