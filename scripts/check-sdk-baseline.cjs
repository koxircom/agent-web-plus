#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const SDK_PACKAGES=['pi-ai','pi-agent-core','pi-coding-agent','pi-tui'];
function validateVersions(expected,actual){
 const errors=SDK_PACKAGES.filter(name=>expected[name]!==actual[name]).map(name=>`${name}：要求 ${expected[name]}，实际 ${actual[name]||'未安装'}`);
 if(errors.length)throw Error('实际 Pi SDK 与发布依赖不一致，拒绝构建：'+errors.join('；'));
 return actual;
}
function validatePackageLayout(directory){
 const packageRoot=fs.realpathSync(directory);
 const manifestRoot=path.dirname(fs.realpathSync(path.join(directory,'package.json')));
 if(packageRoot!==manifestRoot)throw Error('依赖文件逐个软链接会破坏 Next 服务端 external 解析，拒绝构建：'+path.basename(directory));
}
function check(root=path.resolve(__dirname,'..')){
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 const expected=Object.fromEntries(SDK_PACKAGES.map(name=>[name,pkg.dependencies['@earendil-works/'+name]]));
 for(const name of SDK_PACKAGES)validatePackageLayout(path.join(root,'node_modules/@earendil-works',name));
 const actual=Object.fromEntries(SDK_PACKAGES.map(name=>[name,JSON.parse(fs.readFileSync(path.join(root,'node_modules/@earendil-works',name,'package.json'),'utf8')).version]));
 return validateVersions(expected,actual);
}
module.exports={validateVersions,validatePackageLayout,check};
if(require.main===module){try{console.log(JSON.stringify({status:'passed',actualSdk:check()}))}catch(error){console.error(error.message);process.exitCode=1}}
