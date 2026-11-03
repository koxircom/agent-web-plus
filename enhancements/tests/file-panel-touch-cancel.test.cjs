const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(process.env.TOUCH_CANCEL_SOURCE || path.join(__dirname,'../modules/05-composer-and-input-workflow.js'),'utf8');
function harness({open=false,tracking=false,eligible=false}={}){
 const writes=[];const panel={style:new Proxy({},{set(obj,k,v){writes.push([k,v]);obj[k]=v;return true}})};
 const ctx={mobileSwipeTracking:tracking,mobileSwipeEligible:eligible,mobileSwipeResetTimer:null,getFilePanelElement:()=>panel,isFilePanelOpen:()=>open,isPluginEnabled:()=>true,window:{getSelection:()=>({toString:()=>"selected message text"})},resetMobileSwipeStyles:()=>writes.push(['reset']),setTimeout:()=>1};vm.createContext(ctx);
 for(const name of ['handleMobileSwipeTouchStart','snapBackMobileSwipe','handleMobileSwipeTouchCancel']){const start=source.indexOf('  function '+name+'(');assert(start>=0);const end=source.indexOf('\n  function ',start+5);vm.runInContext(source.slice(start,end),ctx)}
 return {ctx,writes,cancel:()=>ctx.handleMobileSwipeTouchCancel({touches:[]})};
}
test('system cancellation outside the file panel never moves a closed panel into view',()=>{const h=harness();h.cancel();assert.deepEqual(h.writes,[])});
test('cancelling an owned open-panel drag restores it without closing',()=>{const h=harness({open:true,tracking:true,eligible:true});h.cancel();assert(h.writes.some(([k,v])=>k==='transform'&&v==='translateX(0)'));assert.equal(h.ctx.mobileSwipeTracking,false);assert.equal(h.ctx.mobileSwipeEligible,false)});
test('a panel closed during its drag is cleaned without a reopening animation',()=>{const h=harness({tracking:true,eligible:true});h.cancel();assert.deepEqual(h.writes,[['reset']])});

test('long-press selection cancellation on a closed chat surface never animates the file drawer',()=>{
 const h=harness();let prevented=0;
 h.ctx.handleMobileSwipeTouchStart({touches:[{clientX:320,clientY:240}],preventDefault:()=>prevented++});
 assert.equal(h.ctx.window.getSelection().toString(),'selected message text');
 h.cancel();
 assert.deepEqual(h.writes,[]);assert.equal(prevented,0);
});
