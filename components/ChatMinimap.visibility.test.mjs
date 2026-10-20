import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const source=readFileSync(new URL('./ChatMinimap.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('minimap.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let effect,loader,visibility;
function visit(node){
 if(ts.isFunctionDeclaration(node)&&node.name?.text==='shouldShowMinimap')visibility=node.getText(ast).replace('export ','');
 if(ts.isCallExpression(node)&&node.expression.getText(ast)==='useEffect'&&node.getText(ast).includes('const initial = getMinimapHistorySettings().initialTurns'))effect=node.getText(ast);
 if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='runContinuousLoad')loader='const '+node.getText(ast);
 ts.forEachChild(node,visit);
}visit(ast);assert(effect&&loader);
const js=code=>ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
test('a short latest tail still exposes older history without fetching it',()=>{
 const c={};vm.runInNewContext(js(visibility)+';this.show=shouldShowMinimap;',c);
 assert.equal(c.show(false,0,true),true);
 assert.equal(c.show(false,0,false),false);
 assert.equal(c.show(false,200,false),true);
 assert.equal(c.show(true,0,false),true);
});
for(const engine of ['pi','codex'])for(const [name,overlay,minimapHovered,expected]of [['hidden rail',false,false,0],['open desktop preview',false,true,1],['mobile overlay',true,false,1]]){
 test(`${engine}: ${name} starts ${expected} automatic history load`,()=>{
  let calls=0;const sessionId=engine==='codex'?'codex:fixture':'fixture';
  vm.runInNewContext(js(effect),{navigation:{value:null},overlay,minimapHovered,useEffect:fn=>fn(),getMinimapHistorySettings:()=>({initialTurns:5}),targetTurnsRef:{current:5},setTargetTurns(){},allMessagesRef:{current:[{role:'user'}]},readMinimapHistoryState:()=>({sessionId,hasEarlierMessages:true}),sessionId,sessionGenerationRef:{current:1},initialLoadAttemptRef:{current:null},runContinuousLoad:()=>{calls++;return true},allNodes:[],messages:[],targetTurns:5});
  assert.equal(calls,expected);
 });
}
test('closing an automatic navigation load lets the current page finish without starting another',async()=>{
 let reads=0;const visible={current:true},messages={current:[{role:'user'}]},context={window:{__PI_ENH_LOAD_EARLIER__:async()=>{reads++;messages.current.push({role:'assistant'});visible.current=false;return true}},initialLoadVisibleRef:visible,isLoadingEarlierRef:{current:false},setIsLoadingEarlier(){},setLoadError(){},preservePreviewScroll(){},sessionGenerationRef:{current:1},allMessagesRef:messages,readMinimapHistoryState:()=>({sessionId:'codex:fixture',hasEarlierMessages:true,oldestEntryId:'cursor-'+reads}),waitForCommitFrames:async()=>{},useCallback:fn=>fn};
 vm.runInNewContext(js(loader)+';this.startLoad=runContinuousLoad;',context);context.startLoad(5,'initial');
 for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(reads,1);assert.equal(context.isLoadingEarlierRef.current,false);
});
