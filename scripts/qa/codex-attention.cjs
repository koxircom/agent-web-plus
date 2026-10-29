'use strict';
const {spawnSync}=require('node:child_process');
for(const args of [['--test','lib/execution-engines/codex-status.test.mjs','lib/execution-engines/codex-title-naming.test.mjs','lib/execution-engines/codex-projection.test.mjs','lib/codex-attention.test.mjs'],['tests/codex-attention.pw.mjs'],['tests/title-naming-feedback.pw.mjs']]){
 const result=spawnSync(process.execPath,args,{cwd:require('node:path').resolve(__dirname,'../..'),stdio:'inherit',shell:false});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);
}
