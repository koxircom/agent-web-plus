import test from 'node:test';import assert from 'node:assert/strict';import {createJiti} from 'jiti';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
const jiti=createJiti(import.meta.url,{jsx:{runtime:'automatic'},tsconfigPaths:true});const {SessionUsageSummary}=await jiti.import('./SessionUsageSummary.tsx');
const usage={contextUsage:{tokens:125000,contextWindow:500000,percent:25},tokens:{input:100000,cacheRead:800000,cacheWrite:0,output:100000,total:1000000}};
const render=props=>renderToStaticMarkup(React.createElement(SessionUsageSummary,{usage,...props}));
test('shared summary exposes both occupancy/window and authoritative token consumption at either width',()=>{for(const mobile of[true,false]){const html=render({mobile});assert.match(html,/上下文 125k \/ 500k/);assert.match(html,/Token 1M/);assert.match(html,/非缓存输入/);assert.match(html,/800,000/);assert.match(html,/会话信息/);assert.doesNotMatch(html,/cache read:|context:|in:|out:/)}});
test('unknown statistics are never shown as zero or an invented context window',()=>{const html=render({usage:{tokens:null,contextUsage:null}});assert.match(html,/上下文 — \/ —/);assert.match(html,/Token —/);assert.match(html,/待同步/);assert.doesNotMatch(html,/500k|Token 0/)});
test('zero remains a real measurement while mobile overlays keep the shared control inaccessible',()=>{const html=render({mobile:true,covered:true,usage:{tokens:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0},contextUsage:{tokens:0,contextWindow:500000,percent:0}}});assert.match(html,/Token 0/);assert.match(html,/上下文 0 \/ 500k/);assert.match(html,/aria-hidden="true"/);assert.match(html,/disabled/);assert.match(html,/tabindex="-1"/)});


test('statistics availability and message scope participate in top-bar invalidation even when counters stay zero',async()=>{
 const {readFileSync}=await import('node:fs');const s=readFileSync(new URL('./ChatWindow.tsx',import.meta.url),'utf8');const key=s.slice(s.indexOf('const statsKey ='),s.indexOf('const sessionStatsRef ='));assert.match(key,/sessionStats.tokenUsageAvailable/);assert.match(key,/sessionStats.messageCountsScope/);
});

test('shared details adapt columns to actual panel width instead of a desktop minimum wider than the content',async()=>{
 const {readFileSync}=await import('node:fs');const s=readFileSync(new URL('./AppShell.tsx',import.meta.url),'utf8');
 assert.match(s,/repeat\(auto-fit, minmax\(min\(100%, 240px\), 1fr\)\)/);
 assert.doesNotMatch(s,/minmax\(360px, 1\.7fr\)/);
});
