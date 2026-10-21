"use strict";
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const commands=[
 {file:process.execPath,args:['--test','lib/execution-engines/codex-model-runtime.test.mjs','lib/execution-engines/codex-workspaces.test.mjs','components/codex-workspace-selection.test.mjs','app/api/sessions/subagents-route.test.mjs']},
 {file:'python3',args:['-m','unittest','test_standalone_model','test_completed_turn','test_project_scopes','test_standalone_workspace','test_subagents','-q'],cwd:path.join(root,'connectors/codex-bridge/tests')},
 {file:process.execPath,args:['tests/codex-subagents-panel.pw.mjs']},
 {file:process.execPath,args:['tests/codex-worktree-flow.pw.mjs']},
];
for(const c of commands){const result=spawnSync(c.file,c.args,{cwd:c.cwd||root,stdio:'inherit',shell:false});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);}
