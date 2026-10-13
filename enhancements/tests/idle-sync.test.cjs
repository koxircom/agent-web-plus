const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=process.env.PI_PERF_SOURCE_ROOT?path.resolve(process.env.PI_PERF_SOURCE_ROOT):path.resolve(__dirname,'../..');
const src=fs.readFileSync(path.join(root,'enhancements/modules/06-chat-view-and-tool-cards.js'),'utf8');
const start=src.indexOf('  let lastRecordedRunningState = false;');
const end=src.indexOf('  addManagedListener(window, "pi-native-session-data-change"',start);
test('unchanged foreground does not force scans; session/run transitions and drafts still reconcile',()=>{
 let now=0,running=false,sid='first',tick,full=0,drafts=0,metrics=0,terminal=0;
 const context={performance:{now:()=>now},document:{visibilityState:'visible'},lastFullDomSyncTime:0,observedSessionId:sid,autoLoadEarlierTriggered:false,
  addManagedInterval:fn=>{tick=fn},isLoginPage:()=>false,isChatSessionRunning:()=>running,scheduleCurrentSessionMetrics:()=>metrics++,getCurrentSessionId:()=>sid,
  handleSessionSwitchLiveCleanup(){},captureSessionPanelState(){},applySessionPanelState(){},isPluginEnabled:()=>false,syncAllTaskToolAutoCollapse(){},syncComposerMarkdownFormat(){},syncComposerModes(){},syncComposerQueuePanel(){},scheduleTerminalSyncCheck:()=>terminal++,syncComposerDraftSessionContext(){},scheduleDomSync:()=>{full++;context.lastFullDomSyncTime=now},hasPendingComposerDraftRestore:()=>false,attemptComposerDraftRestore(){},syncComposerDraftOnInterval:()=>drafts++};
 vm.runInNewContext(src.slice(start,end),context);
 for(let i=0;i<38;i++){now+=800;tick()}
 const idleFull=full;
 if(!process.env.PI_PERF_BASELINE)assert.equal(idleFull,0);
 assert.equal(drafts,38);
 running=true;tick();assert.equal(full,idleFull+1);
 running=false;tick();assert.equal(full,idleFull+2);assert.equal(metrics,2);
 sid='second';tick();assert.equal(full,idleFull+3);assert.equal(terminal,1);
 console.log(JSON.stringify({idleWindowMs:30400,idleFullScans:idleFull,draftTicks:38,lifecycleScans:full-idleFull,terminalChecks:terminal}));
});
