const {spawnSync}=require('node:child_process');
for(const args of [
 ['--test','components/SessionSidebar.variable-height.test.mjs','lib/enhancement-sidebar-bridge.test.mjs'],
 ['tests/sidebar-many-tags.pw.mjs'],
]){const r=spawnSync(process.execPath,args,{stdio:'inherit'});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status||1);}
