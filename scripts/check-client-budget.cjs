'use strict';
// Exact static initial-script bytes, separate from variable session/API data.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const root=path.resolve(__dirname,'..'),htmlPath=root+'/.next/server/app/index.html';
let scripts,styles,source;
if(fs.existsSync(htmlPath)){
  const html=fs.readFileSync(htmlPath,'utf8');
  scripts=[...new Set([...html.matchAll(/src="([^" ]+\.js)"/g)].map(m=>m[1]).filter(p=>p.startsWith('/_next/static/')))];
  styles=[...new Set([...html.matchAll(/href="([^" ]+\.css)"/g)].map(m=>m[1]).filter(p=>p.startsWith('/_next/static/')))];
  source='static initial HTML';
}else{
  // Dynamic pages have no index.html. Their root runtime and client-reference
  // manifest describe the same initial assets without rendering user data.
  const vm=require('node:vm'),context={};
  vm.runInNewContext(fs.readFileSync(root+'/.next/server/app/page_client-reference-manifest.js','utf8'),context);
  const page=context.__RSC_MANIFEST?.['/page'];
  if(!page?.clientModules||!page.entryCSSFiles)throw Error('缺少主页面客户端资源清单');
  const build=JSON.parse(fs.readFileSync(root+'/.next/build-manifest.json','utf8'));
  scripts=[...new Set([...(build.rootMainFiles||[]),...Object.values(page.clientModules).flatMap(v=>v.chunks||[]).filter(v=>typeof v==='string'&&v.endsWith('.js'))])].map(p=>'/_next/'+p);
  styles=[...new Set(Object.values(page.entryCSSFiles).flat().map(v=>typeof v==='string'?v:v.path))].map(p=>'/_next/'+p);
  source='dynamic main-page client-reference manifest';
}
if(!scripts.some(p=>p.includes('/app/page-')))throw Error('缺少主入口脚本，不能以登录页计算预算');
const initialNextGzipBytes=scripts.reduce((total,p)=>total+zlib.gzipSync(fs.readFileSync(path.join(root,'.next',p.slice('/_next/'.length)))).length,0);
const initialCssGzipBytes=styles.reduce((total,p)=>total+zlib.gzipSync(fs.readFileSync(path.join(root,'.next',p.slice('/_next/'.length)))).length,0);
const manifest=JSON.parse(fs.readFileSync(root+'/enhancements/modules/manifest.json','utf8'));
if(!manifest.runtimeAsset?.path?.match(/^\/pi-web-assets\/enhancements-[a-f0-9]{16}\.js$/))throw Error('缺少实际首屏增强资源指纹');
const enhancement=fs.readFileSync(root+'/public'+manifest.runtimeAsset.path),enhancementGzipBytes=zlib.gzipSync(enhancement).length;
const limits={initialNextGzipBytes:750000,enhancementGzipBytes:600000,initialStaticJsGzipBytes:1350000,initialCssGzipBytes:150000,initialStaticJsCssGzipBytes:1450000};
const measured={initialNextGzipBytes,enhancementGzipBytes,initialCssGzipBytes,initialStaticJsGzipBytes:initialNextGzipBytes+enhancementGzipBytes,initialStaticJsCssGzipBytes:initialNextGzipBytes+enhancementGzipBytes+initialCssGzipBytes};
for(const [key,max]of Object.entries(limits))if(measured[key]>max)throw Error(`首屏包体超预算：${key}=${measured[key]} > ${max}；检查完整库/被替代实现是否重新进入主包`);
console.log(JSON.stringify({status:'passed',buildId:fs.readFileSync(root+'/.next/BUILD_ID','utf8').trim(),source,gzip:'node:zlib default level, unique main-page scripts + enhancement; variable data excluded',limits,enhancementAsset:manifest.runtimeAsset,...measured}));
