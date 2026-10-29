const {spawnSync}=require('node:child_process');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
for(const [program,args] of [
 ['python3',['bin/odoo-addon-lock.test.py']],
 ['python3',['bin/odoo-lan-controller-guards.test.py']],
 [process.execPath,['--test','lib/odoo-lan-client.test.mjs','lib/odoo-lan-integration.test.mjs','lib/odoo-lan-cancellation.test.mjs','lib/odoo-lan-sdk.test.mjs']],
 [process.execPath,['tests/odoo-lan-waiting-badge.pw.mjs']],
]){
 const result=spawnSync(program,args,{cwd:root,stdio:'inherit',env:process.env});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status||1);
}
