'use strict';
const {spawnSync}=require('node:child_process');const path=require('node:path');
const root=path.resolve(__dirname,'../..');
for(const args of [['--test','hooks/useAgentSession.test.mjs','lib/execution-engines/codex-first-model.test.mjs','lib/execution-engines/codex-model-runtime.test.mjs'],['tests/codex-first-model.pw.mjs'],['tests/codex-first-model.pw.mjs','--full-page']]){
 const r=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',shell:false,env:{...process.env,...(args.includes('--full-page')?{FIRST_MODEL_FULL_PAGE:'1'}:{})}});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status||1);
}
