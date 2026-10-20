import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const root = new URL('../',import.meta.url);
const sidebar = fs.readFileSync(new URL('components/SessionSidebar.tsx',root),'utf8');
const shell = fs.readFileSync(new URL('components/AppShell.tsx',root),'utf8');
test('catalogue requests always carry their pane engine independently of new-chat default',()=>{
 const node=ts.createSourceFile('sidebar.tsx',sidebar,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX).statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='sessionListUrl');
 const js=ts.transpileModule(node.getText(),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const ctx={};vm.runInNewContext(js+';this.url=sessionListUrl;',ctx);
 for(const engine of ['pi','codex'])for(const summary of [true,false])for(const force of [true,false]){
  const u=new URL(ctx.url(summary,force,engine),'http://localhost');assert.equal(u.searchParams.get('engine'),engine);
  assert.equal(u.searchParams.get('summary'),summary?'1':null);
 }
 assert.match(sidebar,/pi-web-native-status-v1:\$\{executionEngine\}/);
 assert.match(sidebar,/api\/agent\/running\?engine=\$\{executionEngine\}/);
});
test('explicit session links select their own catalogue during initial restoration',()=>{
 const expression=shell.match(/const catalogEngine = ([\s\S]*?);\n/)[1];
 const evaluate=(id,restored=false,selectedSession=null)=>vm.runInNewContext(expression,{selectedSession,activeExecutionEngine:'pi',initialSessionId:id,initialSessionRestored:restored,executionEngine:'codex'});
 assert.equal(evaluate('pi-history'),'pi');assert.equal(evaluate('codex:history'),'codex');assert.equal(evaluate('pi-history',true),'codex');
 assert.equal(evaluate('codex:history',true,{id:'pi-history'}),'pi');
});

test('the sidebar cannot restore a URL from a different engine bootstrap before settings resolve',()=>{
 const ast=ts.createSourceFile('shell.tsx',shell,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const sidebars=[];function walk(n){if(ts.isJsxSelfClosingElement(n)&&n.tagName.getText(ast)==='SessionSidebar')sidebars.push(n);ts.forEachChild(n,walk)}walk(ast);
 assert.equal(sidebars.length,1);const n=sidebars[0];const gate=n.parent;
 assert(ts.isBinaryExpression(gate));assert.equal(gate.operatorToken.kind,ts.SyntaxKind.AmpersandAmpersandToken);
 assert.equal(gate.left.getText(ast),'executionEngineReady');
 assert(!n.attributes.properties.some(p=>p.name?.getText(ast)==='bootstrap'),'Pi bootstrap must not enter a Codex pane');
});
