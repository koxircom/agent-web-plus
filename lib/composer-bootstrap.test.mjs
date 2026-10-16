import fs from 'node:fs';
import ts from 'typescript';
import test from 'node:test';
import assert from 'node:assert/strict';
const file=process.env.PI_QA_MODULE_BASELINE||new URL('../enhancements/modules/05-composer-and-input-workflow.js',import.meta.url);
const source=fs.readFileSync(file,'utf8'),parsed=ts.createSourceFile('module05.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const names=new Set(['pendingComposerNavOverride','lastTrackedModeUrlSessionId','lastTrackedModeNativeDraftKey','syntheticUrlSessionForNewDraft']);
const declarations=[],functions=[];let bootstrap;
function walk(node){
 if(ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>names.has(d.name.getText(parsed))))declarations.push(node);
 if(ts.isFunctionDeclaration(node)&&['getEffectiveQueueSessionId','getEffectiveComposerSessionId'].includes(node.name?.text))functions.push(node.getText(parsed));
 if(!bootstrap&&ts.isCallExpression(node)&&node.expression.getText(parsed)==='window.dispatchEvent'&&node.getText(parsed).includes('pi:native-queue-ready')&&ts.isExpressionStatement(node.parent)){
  const parent=node.parent.parent;
  if(ts.isSourceFile(parent))bootstrap=node.getStart(parsed);
 }
 ts.forEachChild(node,walk);
}walk(parsed);
test('queue bootstrap resolves a welcome-page owner only after all tracked mode state is initialized',()=>{
 assert.equal(functions.length,2);assert.equal(declarations.length,4);assert.ok(bootstrap,'actual top-level queue bootstrap must be located');
 const before=declarations.filter(n=>n.getStart(parsed)<bootstrap).map(n=>n.getText(parsed)).join('\n');
 const after=declarations.filter(n=>n.getStart(parsed)>bootstrap).map(n=>n.getText(parsed)).join('\n');
 const run=new Function('getCurrentSessionId','readComposerNativeDraftKey','isNewSessionWelcomeDomVisible','document',functions.join('\n')+'\n'+before+'\nconst owner=getEffectiveQueueSessionId();\n'+after+'\nreturn owner;');
 const execute=()=>run(()=>null,()=>null,()=>true,{querySelector:()=>null});
 if(process.env.PI_QA_MODULE_BASELINE)assert.throws(execute,/before initialization/);
 else assert.equal(execute(),null);
});
