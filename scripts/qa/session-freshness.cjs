'use strict';
const {spawnSync}=require('node:child_process'),path=require('node:path'),cwd=path.resolve(__dirname,'../..');
for(const args of [
 ['--test','components/AppShell.navigation-race.test.mjs','components/AppShell.workspace-memory.test.mjs'],
 ['tests/session-freshness.pw.mjs'],
]){
 const result=spawnSync(process.execPath,args,{cwd,env:process.env,stdio:'inherit'});
 if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);
}
