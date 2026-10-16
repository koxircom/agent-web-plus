'use strict';
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),read=(key)=>{const index=args.indexOf(key);if(index<0||!args[index+1])throw Error('Missing '+key);return args[index+1];};
(async()=>{const origin=read('--origin'),output=read('--output'),auth=require(path.resolve(read('--auth-module')));
const get=async route=>{const r=await fetch(origin+route,{headers:auth.headers(),cache:'no-store',signal:AbortSignal.timeout(15000)});if(r.status!==200)throw Error(route+' returned '+r.status);return r.json();};
const catalog=await get('/api/sessions'),running=await get('/api/agent/running');for(const key of['runningSessionIds','completionNotificationSuppressedSessionIds'])if(!Array.isArray(running[key]))throw Error('Missing gate '+key);
const result={schema:1,at:new Date().toISOString(),origin,readOnly:true,sessions:catalog.sessions.map(row=>({id:row.id,path:row.path,transient:row.transient,submissionPending:row.submissionPending})),runningCount:running.runningSessionIds.length,suppressedCount:running.completionNotificationSuppressedSessionIds.length};
fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});fs.writeFileSync(output,JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({status:'passed',readOnly:true,catalogCount:result.sessions.length,runningCount:result.runningCount,output}));})().catch(error=>{console.error(error.message);process.exitCode=1});
