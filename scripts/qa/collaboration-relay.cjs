const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const hasBuild = fs.existsSync(path.join(root, '.next/BUILD_ID'));
for(const args of [
 ['--experimental-strip-types','--test','lib/collaboration-store.test.mjs','lib/collaboration-runtime.test.mjs','lib/collaboration-extension.test.mjs','lib/collaboration-controller.test.mjs','app/api/collaboration/route.test.mjs','components/CollaborationSettings.test.mjs','lib/lock-handoff-dispatcher.test.mjs','lib/lock-handoff-sdk.test.mjs','enhancements/tests/release-ownership.test.cjs'],
 ...(hasBuild ? [['--experimental-strip-types','e2e/collaboration-center.mjs']] : []),
]){
 const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',env:process.env});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status||1);
}
