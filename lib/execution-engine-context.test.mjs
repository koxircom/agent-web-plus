import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveExecutionEngine} from './execution-engine-context.ts';
for(const engine of ['pi','codex'])for(const fallback of ['pi','codex'])test(`explicit ${engine} overrides default ${fallback}`,()=>assert.equal(resolveExecutionEngine(engine,fallback),engine));
test('session identity outranks defaults and mismatched hints',()=>{
 assert.equal(resolveExecutionEngine('codex','codex','pi-history'),'pi');
 assert.equal(resolveExecutionEngine('pi','pi','codex:history'),'codex');
 assert.equal(resolveExecutionEngine(null,'codex'),'codex');
 assert.equal(resolveExecutionEngine(undefined,'pi'),'pi');
});
test('invalid engines never silently choose a host',()=>{
 for(const value of ['',false,{},'Codex','other'])assert.throws(()=>resolveExecutionEngine(value,'pi'),RangeError);
});
