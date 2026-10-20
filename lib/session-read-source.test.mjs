import test from 'node:test';import assert from 'node:assert/strict';import {selectSessionReadRuntime,isSessionReadStable} from './session-read-source.ts';
test('idle retained runtime reads stable disk, while starting or replacing a writer invalidates the read',()=>{
 let running=false;const idle={isAlive:()=>true,isRunning:()=>running};const other={isAlive:()=>true,isRunning:()=>false};
 assert.equal(selectSessionReadRuntime(idle),undefined);assert(isSessionReadStable(idle,idle));
 running=true;assert.equal(selectSessionReadRuntime(idle),idle);assert.equal(isSessionReadStable(idle,idle),false);
 running=false;assert.equal(isSessionReadStable(idle,other),false);assert.equal(isSessionReadStable(undefined,other),false);assert(isSessionReadStable(idle,undefined));
});
test('new idle SDK bootstrap reads memory until a transcript exists, then reads disk',()=>{
 let persisted=false;
 const fresh={isAlive:()=>true,isRunning:()=>false,hasUnpersistedSession:()=>!persisted};
 assert.equal(selectSessionReadRuntime(fresh),fresh);
 assert.equal(isSessionReadStable(fresh,fresh),false);
 persisted=true;
 assert.equal(selectSessionReadRuntime(fresh),undefined);
 assert.equal(isSessionReadStable(fresh,fresh),true);
});
test('closed bootstrap cannot resurrect missing history and a new runtime invalidates disk reads',()=>{
 const closed={isAlive:()=>false,isRunning:()=>false,hasUnpersistedSession:()=>true};
 const fresh={isAlive:()=>true,isRunning:()=>false,hasUnpersistedSession:()=>true};
 assert.equal(selectSessionReadRuntime(closed),undefined);
 assert.equal(isSessionReadStable(undefined,fresh),false);
});
