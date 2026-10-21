'use strict';
const path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const commands=[
 ['--test-concurrency=1','--test','lib/agent-client.test.mjs','lib/queue-recall-client.test.mjs','lib/queue-restore-ownership.test.mjs','lib/queue-ownership.test.mjs','components/ComposerQueue.test.mjs','lib/execution-engines/codex-native-handoff.test.mjs'],
 ['tests/queue-edit-identity.pw.mjs'],
];
for(const args of commands){const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);}
