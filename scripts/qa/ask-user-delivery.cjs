'use strict';
const {spawnSync}=require('node:child_process'),path=require('node:path');const cwd=path.resolve(__dirname,'../..');
for(const args of [['--test','lib/extension-ui-delivery-guards.test.mjs','lib/extension-ui-transport.test.mjs','lib/agent-client.test.mjs','lib/rpc-manager-extension-ui.test.mjs','app/api/agent/state-route.test.mjs','components/AppShell.workspace-recovery.test.mjs'],['tests/ask-user-delivery.pw.mjs']]){const r=spawnSync(process.execPath,args,{cwd,stdio:'inherit',shell:false});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status||1);}
