import fs from 'node:fs';import assert from 'node:assert/strict';
const [beforePath,afterPath]=process.argv.slice(2);assert.ok(beforePath&&afterPath,'Usage: node scripts/compare-performance-replays.mjs before.json after.json');
const before=JSON.parse(fs.readFileSync(beforePath)),after=JSON.parse(fs.readFileSync(afterPath));
assert.equal(before.fixtureVersion,after.fixtureVersion);assert.equal(before.environment,after.environment);assert.equal(before.inputProbe,after.inputProbe);
const median=values=>{const v=[...values].sort((a,b)=>a-b);return v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2};
const widths=[...new Set(before.results.map(r=>r.width))];assert.deepEqual(widths,[...new Set(after.results.map(r=>r.width))]);
const comparison=widths.map(width=>{
 const b=before.results.filter(r=>r.width===width),a=after.results.filter(r=>r.width===width);assert.equal(a.length,b.length);assert.ok(a.length>=3,'Use at least three samples per viewport');
 const fields=['commits','renderMs','cpuMs','elapsedMs','inputP95Ms','askMs','terminalMs'];
 const values=Object.fromEntries(fields.map(key=>{assert.ok([...b,...a].every(r=>Number.isFinite(r[key])));const bv=median(b.map(r=>r[key])),av=median(a.map(r=>r[key]));return [key,{before:+bv.toFixed(2),after:+av.toFixed(2),changePercent:+((av/bv-1)*100).toFixed(2)}]}));
 // Timing is noisy on a shared NAS. Reject material regression, report all values.
 const regressions=['cpuMs','renderMs','elapsedMs'].filter(k=>values[k].after>values[k].before*1.1);
 if(values.inputP95Ms.after>values.inputP95Ms.before*1.1+8)regressions.push('inputP95Ms');
 if(a.some(r=>r.askMs>=1000||r.terminalMs>=1000))regressions.push('interaction boundary');
 return {width,samples:a.length,values,regressions};
});
assert.deepEqual(before.errors,[]);assert.deepEqual(after.errors,[]);assert.equal(after.productionRequests,0);
console.log(JSON.stringify({fixtureVersion:after.fixtureVersion,statistic:'median of three independent page runs per viewport',comparison},null,2));
if(comparison.some(r=>r.regressions.length))process.exitCode=1;
