import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { assistantText, projectCodexRow, projectCodexUsage } from './codex-projection.ts';

// Execute the actual adapter with an isolated detail reader, never a real CLI.
const source=fs.readFileSync(new URL('./codex-engine.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('engine.ts',source,ts.ScriptTarget.Latest,true);
const declaration=ast.statements.find(s=>ts.isClassDeclaration(s)&&s.name?.text==='CodexRuntime');
const js=ts.transpileModule(declaration.getText(ast).replace('export ',''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const meta={id:'11111111-1111-4111-8111-111111111111',title:'合成完成批次',cwd:'/fixture',status:'active',connected:true};
const row=(key,role,text,extra={})=>({key,role,text,turnId:'turn',turnStatus:'completed',version:key+'-v1',order:0,...extra});
function fixture(reader){
 const Runtime=new Function('queue','projectCodexUsage','codexComposerStatuses','assistantText','projectCodexRow','rowText',js+';return CodexRuntime;')(
  ()=>({steering:[],followUp:[]}),projectCodexUsage,()=>[{text:''}],assistantText,projectCodexRow,reader);
 const runtime=new Runtime('codex:'+meta.id,'fixture',{epoch:'e',sequence:1,rows:[],meta});
 const events=[];runtime.listeners.add(e=>events.push(e));return {runtime,events};
}
test('a truncated tool result cannot block the final answer on its detail endpoint',async()=>{
 let detailReads=0;
 const {runtime,events}=fixture(async(_id,_epoch,item)=>{if(item.role==='activity'){detailReads++;throw Error('isolated tool detail outage');}return item.text;});
 const tool=row('tool','activity','工具输出预览',{kind:'commandExecution',status:'completed',truncated:true});
 const answer=row('answer','assistant','最终结果必须直接出现');
 await runtime.accept({epoch:'e',sequence:2,rows:[tool,answer],meta:{...meta,status:'idle'}});
 assert.equal(detailReads,0);
 const result=events.find(e=>e.type==='message_end'&&e.message?.role==='toolResult').message;
 assert.deepEqual(result.deferredResult,{entryId:'e.tool',revision:'tool-v1'});
 assert.equal(events.filter(e=>e.type==='message_end'&&e.message?.role==='assistant'&&e.message.content[0].text===answer.text).length,1);
 assert.equal(events.filter(e=>e.type==='agent_settled').length,1);
});
test('a failed long-answer read leaves the batch unconsumed and retries each message once',async()=>{
 let calls=0;
 const {runtime,events}=fixture(async(_id,_epoch,item)=>{if(item.key==='answer'&&calls++===0)throw Error('isolated answer detail outage');return item.text+'（完整）';});
 const tool=row('tool','activity','工具预览',{kind:'commandExecution',status:'completed',truncated:true});
 const answer=row('answer','assistant','长回复',{truncated:true});
 const next={epoch:'e',sequence:2,rows:[tool,answer],meta:{...meta,status:'idle'}};
 await assert.rejects(runtime.accept(next),/answer detail outage/);
 assert.equal(runtime.rows.has('answer'),false);
 assert.equal(runtime.page.sequence,1);
 assert.equal(runtime.publishedStreaming,true);
 assert.equal(events.length,0);
 await runtime.accept(next);
 assert.equal(events.filter(e=>e.type==='message_end'&&e.message?.role==='toolResult').length,1);
 assert.equal(events.filter(e=>e.type==='message_end'&&e.message?.role==='assistant'&&e.message.content.some(b=>b.type==='text'&&b.text==='长回复（完整）')).length,1);
 assert.equal(events.filter(e=>e.type==='agent_settled').length,1);
 assert.equal(runtime.page.sequence,2);
});
