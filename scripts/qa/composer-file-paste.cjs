'use strict';
const {spawnSync}=require('node:child_process'),path=require('node:path'),root=path.resolve(__dirname,'../..');
for(const args of [['--test','enhancements/composer-file-upload.test.mjs','enhancements/composer-attachment-restore.test.mjs'],['tests/composer-file-paste.pw.mjs']]){const p=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',env:process.env});if(p.error)throw p.error;if(p.status!==0)process.exit(p.status||1)}
