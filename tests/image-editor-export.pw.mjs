import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';

const asset = await readFile('enhancements/assets/image-editor.js', 'utf8');
const css = await readFile('app/enhancements.css', 'utf8');
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>
  body{margin:0;background:#181818;color:#eee;font-family:system-ui}dialog{width:96vw;height:96dvh;max-width:96vw;max-height:96dvh;box-sizing:border-box;border:0;padding:0;background:#181818;color:#eee}
  ${css}</style></head><body><script>${asset}</script></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const evidence = process.env.IMAGE_EDITOR_EVIDENCE;

test('mobile image editor exports committed shapes only after pointer interruption', async () => {
  browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  const context = await browser.newContext({viewport:{width:390,height:844}, hasTouch:true, locale:'zh-CN'});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const open = async () => {
    await page.evaluate(() => {
      const original = document.createElement('canvas');
      original.width = 1000; original.height = 650;
      const ctx = original.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,1000,650);
      window.__saved = null;
      const deps = {closeComposerImageZoomModal(){deps.activeZoomDialog?.__piEnhCleanup?.();},
        isMobileEnvironment:()=>true, showToast(){},
        readNativeComposerDraft:()=>null};
      window.PiImageEditor.create(deps)(original.toDataURL(), '合成验收图片', {replace(value){window.__saved = value; return true;}});
    });
    await page.waitForFunction(() => document.querySelector('canvas.pi-enh-annotation-canvas')?.width === 1000);
  };
  const pointer = async (type, x, y, extra = {}) => page.locator('canvas.pi-enh-annotation-canvas').evaluate((canvas, {type,x,y,extra}) => {
    const bounds = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent(type, {bubbles:true, pointerId:9, pointerType:'touch', isPrimary:true,
      button:0, buttons:type === 'pointerup' ? 0 : 1, clientX:bounds.left + x*bounds.width/1000,
      clientY:bounds.top + y*bounds.height/650, ...extra}));
  }, {type,x,y,extra});
  const rect = async () => {await pointer('pointerdown',100,100); await pointer('pointermove',400,280); await pointer('pointerup',400,280);};
  const redPixels = async (saved = false) => page.evaluate(async saved => {
    let canvas = document.querySelector('canvas.pi-enh-annotation-canvas');
    if(saved){const img = new Image(); img.src = window.__saved.previewUrl; await img.decode(); canvas = document.createElement('canvas'); canvas.width=img.width;canvas.height=img.height;canvas.getContext('2d').drawImage(img,0,0);}
    const ctx=canvas.getContext('2d');
    const count=(x,y,w,h)=>{const data=ctx.getImageData(x,y,w,h).data;let n=0;for(let i=0;i<data.length;i+=4)if(data[i]>180&&data[i+1]<130&&data[i+2]<130)n++;return n;};
    return {intended:count(50,50,410,290), unwanted:count(600,360,400,290)};
  }, saved);
  const save = async () => {await page.getByRole('button',{name:'保存并替换原附件',exact:true}).click(); await page.waitForFunction(()=>Boolean(window.__saved)); return redPixels(true);};

  const results = [];
  // Lost capture can occur without pointercancel; a later move must not leave a phantom frame.
  for(const interruption of ['lostpointercapture','pointercancel','blur','released-buttons','save-during-drag']){
    await open(); await rect();
    assert((await redPixels()).intended>0);
    await pointer('pointerdown',650,420); await pointer('pointermove',970,620);
    if(interruption === 'blur') await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    else if(interruption === 'released-buttons') await pointer('pointermove',990,640,{pointerType:'mouse',buttons:0});
    else if(interruption !== 'save-during-drag') await pointer(interruption,970,620);
    const preview = await redPixels();
    const pixels = await save();
    assert(pixels.intended>0,interruption+' keeps completed annotation');
    results.push({interruption,previewUnwanted:preview.unwanted,...pixels});
    if(evidence && interruption === 'save-during-drag'){
      await mkdir(evidence,{recursive:true});
      await writeFile(resolve(evidence,'exported.png'), Buffer.from(await page.evaluate(()=>window.__saved.data),'base64'));
    }
  }
  // Real mouse input verifies capture/release still commits the normal drawing gesture.
  await open();const box=await page.locator('canvas.pi-enh-annotation-canvas').boundingBox();
  await page.mouse.move(box.x+box.width*.1,box.y+box.height*.15);await page.mouse.down();
  await page.mouse.move(box.x+box.width*.4,box.y+box.height*.43,{steps:5});await page.mouse.up();
  assert((await save()).intended>0);
  assert.deepEqual(errors,[]);
  if(evidence) await writeFile(resolve(evidence,'BROWSER_ACCEPTANCE.json'),JSON.stringify({environment:'isolated actual editor asset',viewport:{width:390,height:844},results,normalMouse:'passed',errors},null,2));
  assert.deepEqual(results.filter(row=>row.unwanted || (row.interruption !== 'save-during-drag' && row.previewUnwanted)), [], 'no interrupted rectangle in preview or exported PNG');
});
test.after(async()=>{await browser?.close();await new Promise(resolve=>server.close(resolve));});
