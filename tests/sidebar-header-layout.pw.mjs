// Component/CSS fixture only. Production acceptance separately checks the real sidebar.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = process.env.PI_HEADER_SOURCE_ROOT || fileURLToPath(new URL("..", import.meta.url));
const load = createRequire(path.join(root, "package.json"));
const htmlOnly = process.argv.indexOf("--html-only");
const artifact = process.argv.indexOf("--artifact-html");
let html;
if (artifact >= 0) html = fs.readFileSync(process.argv[artifact + 1], "utf8");
else {
  const legacy = process.env.PI_HEADER_BASELINE === "1";
  const esbuild = load("esbuild");
  const postcss = load("postcss");
  const tailwind = load("@tailwindcss/postcss");
  const css = await postcss([tailwind({ base: root })]).process('@import "./app/globals.css";\n@import "./app/enhancements.css";', { from: path.join(root, "header-fixture.css") });
  const bundle = await esbuild.build({stdin:{resolveDir:root,loader:"tsx",contents:`
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {ExecutionEngineSwitcher} from './components/ExecutionEngineSwitcher';
    import {I18nProvider} from './hooks/useI18n';
    const p=new URLSearchParams(location.search);const actions=<div className="pi-native-sidebar-header-actions">{['New','Search','批量管理会话'].map(name=><button key={name} aria-label={name} style={{width:32,height:32,flexShrink:0,border:'1px solid var(--border)',borderRadius:7}}>+</button>)}</div>;
    function App(){const [engine,setEngine]=React.useState(p.get('engine')||'codex');return <section style={{boxSizing:'border-box',padding:10,width:Number(p.get('width')||220)}}><div className="pi-native-sidebar-header-toolbar"><ExecutionEngineSwitcher engine={engine} connected={p.get('connected')!=='false'} codexEnabled version="1.4.88" actions={${legacy ? 'undefined' : 'actions'}} onChange={async e=>setEngine(e)}/>${legacy ? '{actions}' : ''}</div></section>}
    createRoot(document.getElementById('root')).render(<I18nProvider initialLocale="zh-CN"><App/></I18nProvider>);
  `},bundle:true,write:false,format:"iife",jsx:"automatic",alias:{"@":root},define:{"process.env.NODE_ENV":'"production"',"process.env.NEXT_PUBLIC_APP_VERSION":'"1.4.88"'}});
  const fonts = css.css.replace(/url\(["']?\/fonts\/([^"')]+)["']?\)/g, (url, name) => {
    const file = path.join(root,"public/fonts",name);
    return fs.existsSync(file) ? `url(data:font/woff2;base64,${fs.readFileSync(file).toString("base64")})` : url;
  });
  html = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}</style></head><body style="margin:0"><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;
}
if (htmlOnly >= 0) { fs.writeFileSync(process.argv[htmlOnly+1],html); process.exit(0); }

const {chromium}=load(process.env.COMPOSER_PLAYWRIGHT_MODULE || "playwright");
const server=http.createServer((_req,res)=>{res.setHeader("Content-Type","text/html");res.end(html);});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
const page=await browser.newPage({viewport:{width:1040,height:800}});
const cases=[];page.on('pageerror',error=>console.error('Fixture render error:',error.message));
try {
  for(const width of [200,220,280])for(const scale of [1,1.5])for(const engine of ['pi','codex'])for(const connected of [true,false]){
    await page.goto(`${origin}/?width=${width}&engine=${engine}&connected=${connected}`);
    await page.locator('[role="status"]').waitFor({timeout:5000});await page.evaluate(()=>document.fonts.ready);
    if(scale>1)await page.evaluate(scale=>{
      const rows=[...document.querySelectorAll('.agent-engine-label,[role="status"],.pi-enh-header-version')].map(el=>[el,parseFloat(getComputedStyle(el).fontSize)]);
      rows.forEach(([el,size])=>el.style.fontSize=`${size*scale}px`);
    },scale);
    const metrics=await page.evaluate(()=>{
      const header=document.querySelector('.pi-native-sidebar-header-toolbar');const state=document.querySelector('[role="status"]');const label=state.children[1];const version=state.querySelector('.pi-enh-header-version');
      const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      const range=document.createRange();range.selectNodeContents(label);
      return {header:rect(header),state:rect(state),label:rect(label),version:version?rect(version):null,textLines:range.getClientRects().length,buttons:[...document.querySelectorAll('.pi-native-sidebar-header-actions button')].map(rect),selector:rect(document.querySelector('[aria-label="切换 Agent"]')),documentOverflow:document.documentElement.scrollWidth>innerWidth};
    });
    const context=JSON.stringify({width,scale,engine,connected,metrics});
    assert.equal(metrics.textLines,1,context);assert.equal(metrics.buttons.length,3,context);assert.equal(metrics.documentOverflow,false,context);
    assert.ok(metrics.state.top>=Math.max(metrics.selector.bottom,...metrics.buttons.map(b=>b.bottom))-.5,context);
    for(const rect of [metrics.label,...metrics.buttons,...(metrics.version?[metrics.version]:[])])assert.ok(rect.left>=metrics.header.left-.5&&rect.right<=metrics.header.right+.5,context);
    cases.push({width,scale,engine,connected,textLines:metrics.textLines});
  }
  await page.goto(`${origin}/?width=220&engine=codex&connected=true`);await page.getByRole('button',{name:'切换 Agent',exact:true}).click();await page.getByRole('option').filter({hasText:'Pi Agent'}).click();await page.locator('.agent-engine-label-pi').waitFor();
  console.log(JSON.stringify({status:"passed",cases:cases.length,engineSwitch:true,scope:"native shared component and real compiled CSS; fixture actions"}));
}finally{await browser.close();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
