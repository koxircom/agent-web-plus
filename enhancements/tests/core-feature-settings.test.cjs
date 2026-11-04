const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const prepaint = require('../pi-web-settings-prepaint.cjs');

const source = fs.readFileSync(path.join(__dirname, '../modules/02-plugin-registry-and-settings-schema.js'), 'utf8');
const registry = source.slice(0, source.indexOf('  function onPluginStateChanged('));
const metadata = prepaint.extractEnhancementMetadata(source);

function setup(saved) {
  const data = new Map(Object.entries(saved));
  const localStorage = {getItem:key=>data.get(key)??null, setItem:(key,value)=>data.set(key,String(value)), removeItem:key=>data.delete(key)};
  const sandbox = {window:{},localStorage,Map,Set,Object,JSON,Number,String,Boolean,
    syncEnhancementPanelControls(){},onPluginStateChanged(){}};
  const runtime = vm.runInNewContext(`(()=>{${registry}\nreturn {ENHANCEMENT_PLUGINS,ENHANCEMENT_MODULES,getEnhancementConfig,getVisibleModuleFeatures,getVisibleEnhancementModules,getModuleState,isPluginEnabled,setPluginEnabled,setModuleEnabled,getPluginSetting};})()`,sandbox);
  return {runtime,data,fast:prepaint.createFastPluginReader(key=>localStorage.getItem(key),metadata)};
}

test('core features ignore legacy feature and module switches while choices remain intact',()=>{
  const old = {modules:{'task-insights':{enabled:false},'conversation-navigation':{enabled:false},'background-attention':{enabled:false}},
    features:{'turn-number-indicator':{enabled:false},'live-stopwatch':{enabled:false},'task-tool-auto-collapse':{enabled:false},'subagent-dispatch-cards':{enabled:false},'session-attention-desktop':{enabled:false},'ask-user-batch-prototype':{enabled:true}},
    settings:{'minimap-full-nav':{initialTurns:12,stepTurns:7}},unknown:{preserved:true}};
  const {runtime,data,fast}=setup({'pi-enh-settings-v1':JSON.stringify(old),'pi-enh-plugin-turn-number-indicator':'false'});
  const fixed=runtime.ENHANCEMENT_PLUGINS.filter(p=>p.alwaysOn);
  assert.equal(fixed.length,47);
  for(const feature of fixed){assert.equal(runtime.isPluginEnabled(feature.id),true,feature.id);assert.equal(fast(feature.id),true,feature.id);}
  assert.equal(runtime.isPluginEnabled('session-attention-desktop'),false);
  assert.equal(fast('session-attention-desktop'),false);
  assert.equal(runtime.isPluginEnabled('ask-user-batch-prototype'),false);
  assert.equal(fast('ask-user-batch-prototype'),false);
  assert.equal(runtime.getPluginSetting('minimap-full-nav','initialTurns'),12);
  assert.equal(runtime.getPluginSetting('minimap-full-nav','stepTurns'),7);
  assert.equal(data.get('pi-enh-settings-v1'),JSON.stringify(old),'reading does not rewrite existing preferences');
  runtime.setPluginEnabled('turn-number-indicator',false);
  runtime.setModuleEnabled('task-insights',false);
  assert.equal(runtime.isPluginEnabled('turn-number-indicator'),true);
  assert.equal(fast('turn-number-indicator'),true);
});

test('panel exposes only real choices and still allows toggling them',()=>{
  const {runtime,fast}=setup({});
  const rows=runtime.getVisibleEnhancementModules().flatMap(module=>runtime.getVisibleModuleFeatures(module));
  assert.equal(rows.length,32);
  assert(!rows.some(feature=>feature.alwaysOn||feature.id==='ask-user-batch-prototype'));
  assert(!runtime.getVisibleEnhancementModules().some(module=>module.id==='task-insights'));
  assert(runtime.getVisibleEnhancementModules().some(module=>module.id==='conversation-navigation'),'navigation parameters remain available');
  assert.equal(runtime.getModuleState('task-insights').total,0);
  runtime.setPluginEnabled('session-attention-desktop',true);
  assert.equal(runtime.isPluginEnabled('session-attention-desktop'),true);
  assert.equal(fast('session-attention-desktop'),true);
  runtime.setModuleEnabled('background-attention',false);
  assert.equal(runtime.isPluginEnabled('session-attention-desktop'),false);
  assert.equal(fast('session-attention-desktop'),false);
  assert.equal(runtime.isPluginEnabled('project-status-indicator'),true);
  assert.equal(runtime.isPluginEnabled('ask-user-batch-prototype'),false);
});
