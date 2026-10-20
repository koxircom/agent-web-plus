import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const sidebar=read('components/SessionSidebar.tsx'),shell=read('components/AppShell.tsx'),css=read('app/globals.css'),legacy=read('enhancements/modules/05-composer-and-input-workflow.js');
test('both engines register the same session row identity, metadata and context menu',()=>{
 assert.match(sidebar,/data-pi-enh-session-id=\{session\.id\}/);assert.match(sidebar,/data-execution-engine=\{executionEngine\}/);
 assert.match(sidebar,/onContextMenu=\{renaming \? undefined : handleContextMenu\}/);
 const action=sidebar.slice(sidebar.indexOf('const openContextMenu'),sidebar.indexOf('const taskStatus'));
 assert(!action.includes('if (executionEngine === "codex") return'));
 assert.match(sidebar,/const tags = getEnhancementSessionTags\(session.id, initialDecorations\)/);
});
test('mobile sidebar width consumes the existing persisted native resizer',()=>{
 const mobile=css.slice(css.indexOf('/* Mobile sidebar: slide'));
 assert.match(mobile,/width: var\(--sidebar-width, 280px\)/);
 assert.match(mobile,/\.sidebar-container > \.sidebar-mobile-resize-handle \{\s*display: block/);
 assert.match(shell,/sidebarResizer.separatorProps[\s\S]*?sidebar-mobile-resize-handle/);
 assert.match(shell,/storageKey: "pi-sidebar-width"/);
});
test('native sidebar touch is single-owner, wide-touch aware and gated by the existing preference',()=>{
 assert.match(shell,/useMobileHorizontalSwipe\(\{[\s\S]*?allowWideTouch: true/);
 assert.match(shell,/allowOnButtons: true/);
 assert.match(shell,/isEnhancementPluginEnabled\("mobile-swipe-drawer"\)/);
 assert.match(shell,/data-pi-native-sidebar-gestures="true"/);
 const start=legacy.indexOf('  function handleMobileSwipeTouchStart('),end=legacy.indexOf('  function handleMobileSwipeTouchMove(',start);
 const ctx={isPluginEnabled:()=>true,getSessionSidebarElement:()=>({getAttribute:()=> 'true'}),isFilePanelOpen:()=>false,mobileSwipeTracking:true,mobileSwipeEligible:true};
 vm.runInNewContext(legacy.slice(start,end)+';handleMobileSwipeTouchStart({});',ctx);
 assert.equal(ctx.mobileSwipeTracking,false);assert.equal(ctx.mobileSwipeEligible,false);
});

test('touch hold shares the native context menu and cancels on movement or unmount',()=>{ const hook=read('hooks/useTouchContextMenu.ts');assert.match(sidebar,/useTouchContextMenu\(openContextMenu/);assert.match(hook,/Math\.hypot/);assert.match(hook,/onPointerCancel: cancel/);assert.match(hook,/useEffect\(\(\) => cancel, \[\]\)/);assert.match(hook,/onClickCapture/);});

test('external Codex tasks keep a real event source while dormant Pi histories stay lazy',()=>{
 const src=read('enhancements/modules/03-session-cache-and-sync-engine.js');
 const start=src.indexOf('      const EnhancedEventSource = function(url, options)'),end=src.indexOf('      EnhancedEventSource.prototype',start);
 let real=0;class NativeSource{constructor(){real++;this.readyState=1}addEventListener(){}}
 const ctx={OriginalEventSource:NativeSource,extractSessionIdFromUrl:url=>decodeURIComponent(url.split('/')[3]),isPluginEnabled:()=>true,knownSessionsMap:{has:()=>true},sessionMemoryCache:new Map(),isChatSessionRunning:()=>false,dormantSessionEventSources:new Map(),managedEventSources:new Map(),setTimeout:()=>0,handleSessionStreamEvent:()=>{}};
 vm.runInNewContext(src.slice(start,end)+';globalThis.TestES=EnhancedEventSource;',ctx);
 new ctx.TestES('/api/agent/pi-session/events');assert.equal(real,0);
 new ctx.TestES('/api/agent/codex%3Aoriginal/events');assert.equal(real,1);
 assert.equal(ctx.dormantSessionEventSources.has('codex:original'),false);
});
