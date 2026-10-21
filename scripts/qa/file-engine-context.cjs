"use strict";
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
for(const args of [
 ['--test','components/ChatInput.test.mjs','tests/file-engine-context.test.mjs','components/file-tab-state.test.mjs','components/FileViewer.test.mjs','components/FileViewer.state.test.mjs','components/SessionSidebar.file-search.test.mjs','components/AppShell.engine-context.test.mjs','components/AppShell.file-viewer-state.test.mjs','app/api/engine-context.test.mjs'],
 ['tests/file-engine-context.pw.mjs'],
 ['tests/file-engine-page.pw.mjs'],
]){
 const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',shell:false});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status||1);
}
