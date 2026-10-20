import test from 'node:test';import assert from 'node:assert/strict';import {createJiti} from 'jiti';
const {getInlineSuggestion,isSuggestionDoubleTap}=await createJiti(import.meta.url).import('./inline-suggestion.ts');
const assistant=text=>({role:'assistant',model:'fixture',provider:'fixture',stopReason:'stop',content:[{type:'text',text}]});
const user={role:'user',content:'question'};
for(const heading of ['优化建议：','### 优化建议：','**优化建议：**','**优化建议**：','下一步建议：'])test(`explicit suggestion heading: ${heading}`,()=>{
 const suggestion=getInlineSuggestion([user,assistant('done\n\n'+heading+'\n\n建议检查模型配置文件的写入冲突。')],['u','a'],'sid');assert.deepEqual(suggestion,{id:'a',sessionId:'sid',text:'帮我检查模型配置文件的写入冲突。'});
});
test('suggestions ignore old turns, errors, code examples, quotes and long material',()=>{
 for(const messages of [[assistant('优化建议：检查服务。'),user],[user,{...assistant('优化建议：检查服务。'),stopReason:'error'}],[user,assistant('```text\n优化建议：不要选择代码例子\n```')],[user,assistant('> 优化建议：不要选择引用例子')],[user,assistant('优化建议：\n'+ 'a'.repeat(600))],[user,assistant('下一步我会检查文件。')]])assert.equal(getInlineSuggestion(messages,messages.map((_,i)=>String(i)),'sid'),null);
});
test('only first explicit step is offered, with Markdown rendered as plain text',()=>{
 const x=getInlineSuggestion([user,assistant('### 下一步\n- 检查 **模型配置** 的[写入路径](http://fixture/path)。\n- 更新其他服务。')],['u','a'],'sid');assert.equal(x.text,'帮我检查 模型配置 的写入路径。');
});
test('native ready actions are reused; non-actionable records cannot hide the explicit current suggestion',()=>{
 const a=assistant('优化建议：\n检查文件。');const details={schemaVersion:1,sessionId:'sid',assistantEntryId:'a',status:'ready',action:{enabled:true,message:'帮我完成下一步验证。'}};const custom=details=>({role:'custom',customType:'pi-quick-action-analysis',content:'',display:false,details});
 assert.equal(getInlineSuggestion([user,a,custom(details)],['u','a','c'],'sid').text,details.action.message);
 for(const changed of [{status:'none'},{status:'pending'},{status:'error'},{sessionId:'other'},{assistantEntryId:'old'},{action:{enabled:false,message:'bad'}}])assert.equal(getInlineSuggestion([user,a,custom({...details,...changed})],['u','a','c'],'sid').text,'帮我检查文件。');
});
test('touch double-tap has bounded time, distance and suggestion scope',()=>{
 const previous={time:100,x:10,y:20,key:'sid:a'};assert.equal(isSuggestionDoubleTap(previous,{...previous,time:400,x:34}),true);
 for(const next of [{...previous,time:401},{...previous,x:35},{...previous,time:99},{...previous,key:'sid:b'}])assert.equal(isSuggestionDoubleTap(previous,next),false);assert.equal(isSuggestionDoubleTap(null,previous),false);
});
