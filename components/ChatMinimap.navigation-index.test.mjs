import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
const source=readFileSync(new URL("./ChatMinimap.tsx",import.meta.url),"utf8");
const ast=ts.createSourceFile("m.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const js=code=>ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const functions=new Map(); let effect,scroll,trigger;
function visit(node){
 if(ts.isFunctionDeclaration(node))functions.set(node.name?.text,node.getText(ast).replace("export ",""));
 if(ts.isCallExpression(node)&&node.expression.getText(ast)==="useEffect"&&node.getText(ast).includes("const initial = getMinimapHistorySettings().initialTurns"))effect=node.getText(ast);
 if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==="scrollToNode")scroll="const "+node.getText(ast);
 if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==="triggerLoadEarlier")trigger="const "+node.getText(ast);
 ts.forEachChild(node,visit);
}visit(ast);
test("index previews preserve repeated text as separate global turns and never replace actual body/identity",()=>{
 const c={};vm.runInNewContext(js(functions.get("mergeNavigationTurns"))+";this.merge=mergeNavigationTurns",c);
 const loaded=[{userTurnNumber:100,userMessage:{role:"user",content:"actual full input"},entryId:"native:0",scrollTop:20}];
 const index={totalTurns:100,turns:[{number:98,preview:"same"},{number:99,preview:"same"},{number:100,preview:"preview"}]};
 const result=c.merge(loaded,index);assert.equal(result.length,3);assert.equal(result[2],loaded[0]);assert.equal(result[0].indexed,true);assert.equal(result[0].scrollTop,null);assert.notEqual(result[0].entryId,result[1].entryId);assert.equal(c.merge(loaded,null),loaded);
});
for(const value of [undefined,{totalTurns:104,turns:[]}])test(`available/pending directory does not fetch old bodies (${value?'available':'pending'})`,()=>{
 let reads=0;vm.runInNewContext(js(effect),{useEffect:fn=>fn(),overlay:true,minimapHovered:false,navigation:{value},allNodes:[],messages:[],sessionId:"codex:fixture",targetTurns:5,runContinuousLoad:()=>reads++});assert.equal(reads,0);
});
test("selecting indexed turn requests only on selection, keeps transcript untouched, and uses global offset",()=>{
 let count, reveal=0;const messages=[{role:"user",content:"latest"}];
 const c={useCallback:fn=>fn,overlay:false,onClose(){},lockActiveNode(){},onRevealHistory:()=>reveal++,scrollContainer:{current:{dispatchEvent(){}}},CustomEvent:class {},setMouseYRatio(){},pendingNavigationNodeIndexRef:{current:null},pendingNavigationOrdinalRef:{current:null},navigationIndexRef:{current:{totalTurns:104}},loadSelectedHistoryRef:{current:n=>count=n}};
 vm.runInNewContext(js(scroll)+";this.scroll=scrollToNode",c);c.scroll({index:0,targetTurn:{indexed:true,userTurnNumber:99,scrollTop:null}},"smooth");assert.equal(count,6);assert.equal(c.pendingNavigationOrdinalRef.current,99);assert.equal(reveal,1);assert.equal(messages.length,1);
});
const hook=readFileSync(new URL("../hooks/useNavigationIndex.ts",import.meta.url),"utf8");
const hookAst=ts.createSourceFile("hook.ts",hook,ts.ScriptTarget.Latest,true);const parser=hookAst.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==="parseNavigationIndex").getText(hookAst).replace("export ","");
test("index parser rejects invalid/out-of-order ordinals and supports unavailable capability",()=>{
 const c={};vm.runInNewContext(js(parser)+";this.parse=parseNavigationIndex",c);assert.equal(c.parse({available:false}),null);
 for(const data of [{totalTurns:2,turns:[{number:3,preview:"x"}]},{totalTurns:2,turns:[{number:2,preview:"x"},{number:1,preview:"x"}]},{totalTurns:2,turns:[{number:1,preview:"x".repeat(513)}]}])assert.throws(()=>c.parse(data));
 assert.equal(c.parse({available:true,totalTurns:2,turns:[{number:1,preview:"x"},{number:2,preview:"x"}]}).turns.length,2);
});

let hookEffect;
function findEffect(node){if(ts.isCallExpression(node)&&node.expression.getText(hookAst)==="useEffect")hookEffect=node.getText(hookAst);ts.forEachChild(node,findEffect)}findEffect(hookAst);
for(const reason of ["closed","switched"])test(`late index response discarded when ${reason}`,async()=>{
 let finish,cleanup,commits=0;const id={current:"one"};
 const c={sessionId:"one",visible:true,value:undefined,totalTurns:100,attempt:0,currentId:id,AbortController,setError(){},setSnapshot(){commits++},parseNavigationIndex:d=>d,fetch:()=>new Promise(resolve=>finish=resolve),useEffect:fn=>cleanup=fn()};
 vm.runInNewContext(js(hookEffect),c);
 if(reason==="closed")cleanup();else id.current="two";
 finish({ok:true,status:200,json:async()=>({totalTurns:100,turns:[]})});
 for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(commits,0);
});

test("pending title discovery cannot start transcript loading through the button",()=>{
 let reads=0;const c={useCallback:fn=>fn,navigation:{value:undefined,error:false},loadError:false,preservePreviewScroll(){},runContinuousLoad:()=>reads++};vm.runInNewContext(js(trigger)+";this.trigger=triggerLoadEarlier",c);assert.equal(c.trigger(),false);assert.equal(reads,0);
});
