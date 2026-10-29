// Real Next file routes and browser-rendered PDF pixels, including phones without a native PDF plugin.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const root = fileURLToPath(new URL("..", import.meta.url));
/** Minimal multi-page PDF: every page prints its own number near the top edge. */
function buildFixturePdf(pageCount) {
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (text) => {
    chunks.push(text);
    length += Buffer.byteLength(text, "latin1");
  };
  const addObject = (body) => {
    offsets.push(length);
    push(body);
  };
  const pageObjectIds = [];
  for (let index = 0; index < pageCount; index += 1) pageObjectIds.push(4 + index * 2);

  push("%PDF-1.4\n");
  addObject("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  addObject(`2 0 obj\n<< /Type /Pages /Count ${pageCount} /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] >>\nendobj\n`);
  addObject("3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n");

  for (let index = 0; index < pageCount; index += 1) {
    const pageId = pageObjectIds[index];
    const contentId = pageId + 1;
    const stream = `BT /F1 108 Tf 40 690 Td (PAGE ${index + 1}) Tj ET\n`;
    addObject(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]`
      + ` /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`,
    );
    addObject(`${contentId} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`);
  }

  const xrefOffset = length;
  const size = offsets.length + 1;
  push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (const offset of offsets) push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(chunks.join(""), "latin1");
}


const output = process.env.PDF_ACCEPTANCE_OUTPUT || path.resolve(root, "../acceptance");
fs.mkdirSync(output, {recursive: true});
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "native-pdf-"));
const work = path.join(scratch, "work"), agent = path.join(scratch, "agent");
fs.mkdirSync(work); fs.mkdirSync(path.join(agent,"sessions","pdf"), {recursive:true});
const pdfPath=path.join(work,"report.pdf"), broken=path.join(work,"broken.pdf");
fs.writeFileSync(pdfPath,buildFixturePdf(200)); fs.writeFileSync(broken,"This is not a PDF");
const actual=process.env.PDF_ACCEPTANCE_FILE;
if(actual)fs.copyFileSync(actual,path.join(work,"contract.pdf"));
const timestamp=new Date().toISOString(), sid="11111111-1111-4111-8111-111111111111";
const body=`[PDF page 183](${pdfPath}#page=183) · [PDF page 1](${pdfPath}) · [Broken PDF](${broken})`+(actual?` · [Contract PDF](${path.join(work,"contract.pdf")})`:"");
fs.writeFileSync(path.join(agent,"sessions/pdf",timestamp.replaceAll(":","-")+"_"+sid+".jsonl"),[
 {type:"session",version:3,id:sid,timestamp,cwd:work},
 {type:"message",id:"entry0",parentId:null,timestamp,message:{role:"assistant",content:[{type:"text",text:body}]}},
].map(v=>JSON.stringify(v)).join("\n")+"\n");
const calls=[],errors=[],cases=[]; let browser,server,log="";
const meta={id:sid,title:"PDF 浏览验收",cwd:work,model:"gpt-6.1-sol",effort:"high",connected:true,status:"idle",sequence:1,requests:[],submissions:[]};
const bridge=http.createServer(async(req,res)=>{
 const u=new URL(req.url,"http://localhost"); calls.push({path:u.pathname,method:req.method,operation:u.searchParams.get("operation")});
 for await(const _ of req){}
 const json=(data,status=200)=>{res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(data));};
 if(u.pathname==="/api/login")return json({}); if(u.pathname==="/api/auth")return json({authenticated:true,csrf:"fixture"});
 if(u.pathname==="/api/projects")return json({projects:[{key:"pdf",name:"PDF",cwd:work}]});
 if(u.pathname==="/api/activity")return json({sessions:[{id:sid,status:"idle",hasPendingRequests:false}]});
 if(u.pathname==="/api/projects/catalog")return json({models:[{id:"gpt-6.1-sol",name:"Fixture",isDefault:true,efforts:["high"]}]});
 if(u.pathname==="/api/sessions")return json({sessions:u.searchParams.get("archived")==="true"?[]:[{...meta,recency:Date.now()}]});
 if(u.pathname===`/api/sessions/${sid}`)return json(meta);
 if(u.pathname===`/api/sessions/${sid}/timeline`||u.pathname===`/api/sessions/${sid}/changes`)return json({epoch:"fixture",sequence:1,meta,rows:[{key:"message",turnId:"turn",order:0,version:"1",role:"assistant",text:body,turnStatus:"completed"}]});
 if(u.pathname==="/api/projects/workspace"){
   const name=u.searchParams.get("path"),op=u.searchParams.get("operation");
   if(!["report.pdf","broken.pdf","contract.pdf"].includes(name))return json({error:"Missing fixture"},404);
   const bytes=fs.readFileSync(path.join(work,name));
   if(op==="info")return json({kind:"file",size:bytes.length,mtimeMs:fs.statSync(path.join(work,name)).mtimeMs});
   if(op==="preview")return json({kind:"binary",size:bytes.length,mime:"application/pdf"});
   if(op==="download")return json({data:bytes.toString("base64"),size:bytes.length});
 }
 return json({error:"Unexpected fixture request"},404);
});
const listen=s=>new Promise(r=>s.listen(0,"127.0.0.1",r));
try {
 await listen(bridge);
 fs.writeFileSync(path.join(agent,"execution-engines.json"),JSON.stringify({defaultEngine:"pi",codex:{enabled:true,url:"http://127.0.0.1:"+bridge.address().port,username:"fixture",password:"fixture-only"}}));
 const probe=http.createServer();await listen(probe);const port=probe.address().port;await new Promise(r=>probe.close(r));
 const origin="http://127.0.0.1:"+port,password=crypto.randomUUID();
 server=spawn(process.execPath,[path.join(root,"node_modules/next/dist/bin/next"),"start","-H","127.0.0.1","-p",String(port)],{cwd:root,env:{...process.env,PI_CODING_AGENT_DIR:agent,PI_AGENT_DIR:agent,PI_WEB_PASSWORD:password,NEXT_TELEMETRY_DISABLED:"1"},stdio:["ignore","pipe","pipe"]});
 server.stdout.on("data",v=>log+=v);server.stderr.on("data",v=>log+=v);
 const deadline=Date.now()+45000;while(true){assert.equal(server.exitCode,null);const r=await fetch(origin+"/api/web-auth").catch(()=>null);if(r?.ok)break;assert(Date.now()<deadline,"Next readiness");await new Promise(r=>setTimeout(r,150));}
 browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
 for(const engine of (process.env.PDF_ENGINES||"pi,codex").split(","))for(const width of (process.env.PDF_WIDTHS||"390,1280").split(",").map(Number)){
   const ctx=await browser.newContext({viewport:{width,height:900},hasTouch:width===390,locale:"zh-CN",serviceWorkers:"block"});
   const token="v1."+(Math.floor(Date.now()/1000)+3600)+"."+crypto.randomBytes(16).toString("hex");
   await ctx.addCookies([{name:"pi_web_session",value:token+"."+crypto.createHmac("sha256",password).update("pi-web-session:"+token).digest("hex"),url:origin}]);
   await ctx.addInitScript(()=>{localStorage.setItem("pi-locale","zh-CN");localStorage.setItem("pi-theme","dark");});
   await ctx.route("**/*",route=>{
     const u=new URL(route.request().url()),p=u.pathname;
     if(u.origin!==origin)return route.abort();
     if(!p.startsWith("/api/")||p.startsWith("/api/files/")||p==="/api/execution-engines"||p==="/api/models"||p.startsWith("/api/sessions")||p==="/api/agent/running")return route.continue();
     if(p.endsWith("/events"))return route.fulfill({status:204});
     if(p==="/api/worktrees")return route.fulfill({json:{projectRoot:work,projectKey:(engine==="codex"?"codex:":"")+work,isGit:false,isTopLevel:true,worktrees:[]}});
     if(p==="/api/cwd/validate")return route.fulfill({json:{valid:true,cwd:work}});
     if(p==="/api/home")return route.fulfill({json:{home:work}});
     if(p==="/api/enhancement-state")return route.fulfill({status:200,headers:{"x-pi-enhancement-state":"absent"}});
     return route.fulfill({json:{success:true,data:{},skills:[],sessions:[],projects:[],worktrees:[],isGit:false,projectRoot:work}});
   });
   const p=await ctx.newPage();p.setDefaultTimeout(25000);p.on("pageerror",e=>errors.push(e.message)); p.on("response",async r=>{if(new URL(r.url()).pathname.startsWith("/api/sessions/"))fs.appendFileSync(path.join(output,"session-debug.jsonl"),JSON.stringify({url:r.url(),status:r.status(),body:(await r.text()).slice(0,500)})+"\n");});
   await p.goto(origin+"/?engine="+engine+"&session="+encodeURIComponent((engine==="codex"?"codex:":"")+sid),{waitUntil:"domcontentloaded"});
   const jump=p.getByRole("link",{name:"PDF page 183",exact:true});await jump.click();
   const viewer=p.locator('[data-pdf-viewer="native"]');
   const waitPage=async n=>{await viewer.locator(`[data-rendered-page="${n}"]`).waitFor();assert.equal(await viewer.getByRole("alert").count(),0);};
   const pixels=async()=>viewer.locator("canvas").evaluate(canvas=>{const ctx=canvas.getContext("2d"),v=ctx.getImageData(0,0,canvas.width,canvas.height).data;let ink=0;for(let i=0;i<v.length;i+=4)if(v[i]<200&&v[i+1]<200&&v[i+2]<200&&v[i+3]>200)ink++;return {width:canvas.width,height:canvas.height,ink};});
   await waitPage(183);const pix=await pixels();assert(pix.ink>100,"Rendered page must have visible ink, not only a successful request");
   assert((await viewer.innerText()).includes("PAGE 183"),"PDF text selection layer must exist");
   assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await viewer.getByRole("button",{name:"下一页",exact:true}).click();await waitPage(184);
   const input=viewer.getByRole("textbox",{name:"PDF 页码",exact:true});await input.fill("2");await input.press("Enter");await waitPage(2);
   const fitWidth=await viewer.locator("canvas").evaluate(c=>parseFloat(c.style.width));
   await viewer.getByRole("combobox",{name:"PDF 缩放",exact:true}).selectOption("2");await waitPage(2);await p.waitForFunction(w=>parseFloat(document.querySelector('[data-pdf-viewer] canvas')?.style.width)>w,fitWidth*1.9);
   await viewer.getByRole("combobox",{name:"PDF 缩放",exact:true}).selectOption("1");
   // On phones the opened file hides the chat; return using the native chat tab.
   const openLink=async name=>{
     const link=p.getByRole("link",{name,exact:true});
     if(width===390)await p.locator("#file-panel").getByRole("button",{name:"隐藏文件面板",exact:true}).click();
     await link.click();
   };
   await openLink("PDF page 1");await waitPage(1);
   await openLink("PDF page 183");await waitPage(183);
   if(engine==="pi"&&width===390){
     fs.writeFileSync(pdfPath,Buffer.from(buildFixturePdf(200).toString("latin1").replaceAll("PAGE ","LIVE "),"latin1"));
     await viewer.getByText("LIVE 183",{exact:true}).waitFor(); await waitPage(183);
     fs.writeFileSync(pdfPath,buildFixturePdf(200)); await viewer.getByText("PAGE 183",{exact:true}).waitFor();
   }
   await viewer.screenshot({path:path.join(output,`pdf-${engine}-${width}.png`)});
   if(actual){await openLink("Contract PDF");await waitPage(1);const contract=await pixels();assert(contract.ink>100);await viewer.screenshot({path:path.join(output,`contract-${engine}-${width}.png`)});}
   await openLink("Broken PDF");await viewer.getByRole("alert").waitFor();await viewer.getByRole("link",{name:"打开原文件",exact:true}).waitFor();
   cases.push({engine,width,pageJump:true,pixels:pix,nextPage:true,zoom:true,resetToPage1:true,reopen:true,malformedFallback:true,actualContract:!!actual});
   await ctx.close();
 }
 assert.deepEqual(errors,[]);assert(calls.filter(c=>c.method==="POST").every(c=>["/api/login","/api/activity"].includes(c.path)),"No model or business calls");
 const result={status:"passed",cases,pageErrors:errors,productionWrites:0,modelCalls:0};
 fs.writeFileSync(path.join(output,"PDF_BROWSER.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} catch(e) {
 const p=browser?.contexts().flatMap(c=>c.pages()).at(-1);if(p){await p.screenshot({path:path.join(output,"pdf-failure.png")});fs.writeFileSync(path.join(output,"pdf-failure.txt"),await p.locator("body").innerText());}
 throw e;
} finally {
 await browser?.close();if(server&&server.exitCode===null){server.kill("SIGTERM");await new Promise(r=>server.once("exit",r));}
 await new Promise(r=>bridge.close(r));fs.rmSync(scratch,{recursive:true,force:true});fs.writeFileSync(path.join(output,"pdf-next.log"),log);
}
