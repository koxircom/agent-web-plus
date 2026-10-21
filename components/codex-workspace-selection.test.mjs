import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {createJiti}from'jiti';
const j=createJiti(import.meta.url);const projection=await j.import('../lib/execution-engines/codex-projection.ts');
const route=fs.readFileSync(new URL('../app/api/cwd/validate/route.ts',import.meta.url),'utf8');
test('directory validation and session projection use identical workspace identity independent of alias',()=>{
 const expression=route.match(/projectKey:\s*([^}]+)\s*\}\)/)?.[1];assert(expression);
 for(const project of [{key:'local|original',cwd:'/home/demo/CODEX'},{key:'local|work',cwd:'/home/demo/Work'},{key:'local|odoo',cwd:'/home/demo/odoo'}]){
  const actual=vm.runInNewContext(expression,{project,cwd:project.cwd,codexProjectKey:projection.codexProjectKey});
  const session=projection.projectCodexSession({id:'original',title:'原会话',cwd:project.cwd});assert.equal(actual,session.projectKey);
 }
});
test('remote workspace selection cannot be replaced by NAS worktree identity',()=>{
 const source=fs.readFileSync(new URL('./SessionSidebar.tsx',import.meta.url),'utf8');
 assert.match(source,/fetch\(`\/api\/worktrees\?cwd=\$\{encodeURIComponent\(selectedCwd\)\}&engine=\$\{executionEngine\}`\)/);
 assert.match(source,/body: JSON.stringify\(\{ cwd: path, engine: executionEngine \}\)/);
 assert.match(source,/executionEngine=\{executionEngine\}[\s\S]*?initialPath=\{customPathValue\}/);
 assert.match(source,/fetch\(`\/api\/home\?engine=\$\{executionEngine\}`\)/);
});
test('Codex does not reserve an empty extension status row in loaded, loading or error states',()=>{
 const source=fs.readFileSync(new URL('./ChatWindow.tsx',import.meta.url),'utf8');
 assert.equal((source.match(/!isNew && !isCodexSession &&/g)||[]).length,2);
 assert.match(source,/!isEmptyNew && !isCodexSession && extensionStatuses.length === 0/);
 assert.match(source,/<ExtensionStatusBar statuses=\{extensionStatuses\} widgets=\{extensionWidgets\}/);
});
test('Agent uses the shared menu with branded labels, no model icon and a persistent chevron',()=>{
 const control=fs.readFileSync(new URL('./ExecutionEngineSwitcher.tsx',import.meta.url),'utf8');
 assert.match(control,/showIcon=\{false\}/);assert.match(control,/showChevron\s/);assert.match(control,/renderLabel=\{renderAgentName\}/);
 const shared=fs.readFileSync(new URL('./ModelSelector.tsx',import.meta.url),'utf8');assert.match(shared,/showIcon = true/);assert.match(shared,/showChevron = variant === "field"/);
});

test('remote directory picker opens a configured workspace and can return to its virtual root',()=>{
 const projects=[{name:'工作',cwd:'/remote/Work'}];
 const root=projection.projectCodexDirectories(projects,'/');assert.equal(root.directories[0].path,'/remote/Work');
 const selected=projection.projectCodexDirectories(projects,'/remote/Work');assert.equal(selected.path,'/remote/Work');assert.equal(selected.parentPath,'/');assert.deepEqual(selected.directories,[]);
 assert.equal(projection.projectCodexDirectories(projects,'/NAS-only').path,'');
});

test('native remote picker keeps sole ownership of directory actions',()=>{
 const picker=fs.readFileSync(new URL('./DirectoryPicker.tsx',import.meta.url),'utf8');
 assert.match(picker,/data-pi-native-directory-picker="true"/);
 assert.match(picker,/const canCreate = executionEngine !== "codex" && canSelect/);
 const legacy=fs.readFileSync(new URL('../enhancements/modules/06-chat-view-and-tool-cards.js',import.meta.url),'utf8');
 assert.match(legacy,/if \(!picker \|\| picker.hasAttribute\("data-pi-native-directory-picker"\)\) return/);
 const css=fs.readFileSync(new URL("../app/enhancements.css",import.meta.url),"utf8");
 assert.match(css,/\.directory-picker-panel:not\(\[data-pi-native-directory-picker\]\) \.directory-picker-footer button/);
});

test('SessionSidebar hides worktree remove button for Codex engine and tracks engine in closure deps',()=>{
 const sidebar=fs.readFileSync(new URL('./SessionSidebar.tsx',import.meta.url),'utf8');
 // Removal button hidden under Codex
 assert.match(sidebar,/!wt\.isMain && !isCodexEngine &&/);
 // Closure deps include executionEngine
 assert.match(sidebar,/handleCreateWorktree[\s\S]*?\[wtNewBranch, wtBusy, worktreeState, executionEngine\]/);
 assert.match(sidebar,/handleRemoveWorktree[\s\S]*?\[worktreeState, wtBusy, currentWorktreePath, executionEngine, isCodexEngine\]/);
 // projectFor resolves worktreeState before session search in codex mode
 assert.match(sidebar,/if \(isCodexEngine\) \{\s*if \(worktreeState && \(worktreeState\.forCwd === cwd \|\| worktreeState\.worktrees\.some/);
});
