const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../modules/02-plugin-registry-and-settings-schema.js'),'utf8');
const start=source.indexOf('  function cleanupDeletedSessionEverywhere('),end=source.indexOf('\n  latestKnownSessionGroups =',start);
assert(start>=0&&end>start);
for(const id of ['codex:01900000-0000-7000-8000-000000000001','fixture-pi-deleted'])test(`confirmed deletion cleans caches without a Codex unarchive mutation: ${id}`,()=>{
 const maps=Array.from({length:5},()=>new Map([[id,true]])),restored=[],tags=[],running=[];
 const context={sessionMemoryCache:maps[0],knownSessionsMap:maps[1],knownSessionTitles:maps[2],persistentSessionEpochs:maps[3],invalidatePersistentSession:key=>maps[4].delete(key),markSessionRunning:(...x)=>running.push(x),readStoredSessionIds:()=>new Set(),PINNED_SESSION_STORAGE_KEY:'pins',readStoredArchivedEntries:()=>[],restoreArchivedSession:async key=>restored.push(key),clearSessionTags:key=>tags.push(key),readUnreadSessionIds:()=>new Set(),window:{}};
 vm.runInNewContext(source.slice(start,end)+'\ncleanupDeletedSessionEverywhere('+JSON.stringify(id)+');',context);
 assert(maps.every(map=>!map.has(id)));assert.deepEqual(tags,[id]);assert.deepEqual(running,[[id,false]]);
 assert.deepEqual(restored,id.startsWith('codex:')?[]:[id]);
});
