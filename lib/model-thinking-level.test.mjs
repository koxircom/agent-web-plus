import test from 'node:test';import assert from 'node:assert/strict';
import {clampThinkingLevel,getSupportedThinkingLevels} from '@earendil-works/pi-ai';
import {clampModelThinkingLevel} from './model-thinking-level.ts';
test('Flash maximum fallback preserves supported effort and automatic/unknown capability',()=>{
const supported=['low','medium','high'];for(const invalid of['max','xhigh'])assert.equal(clampModelThinkingLevel(invalid,supported),'high');for(const level of supported)assert.equal(clampModelThinkingLevel(level,supported),level);assert.equal(clampModelThinkingLevel(null,supported),null);assert.equal(clampModelThinkingLevel('max',null),'max');
});
test('capability fallback matches installed SDK for every concrete level',()=>{
for(const model of[{reasoning:false},{reasoning:true},{reasoning:true,thinkingLevelMap:{off:null,minimal:null,xhigh:null,max:null}},{reasoning:true,thinkingLevelMap:{xhigh:'xhigh',max:'max'}}])for(const level of['off','minimal','low','medium','high','xhigh','max'])assert.equal(clampModelThinkingLevel(level,getSupportedThinkingLevels(model)),clampThinkingLevel(model,level));
});
