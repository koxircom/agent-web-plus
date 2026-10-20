// Run against an explicitly owned loopback fixture, never a user's sessions.
import assert from 'node:assert/strict';
import {readFile, writeFile, access} from 'node:fs/promises';
import {chromium} from 'playwright';

const origin = process.env.AGENT_DELETE_TEST_ORIGIN;
const fixturePath = process.env.AGENT_DELETE_TEST_FIXTURE;
const output = process.env.AGENT_DELETE_TEST_OUTPUT;
if (!origin || !fixturePath || !output) throw Error('请提供隔离测试地址、会话元数据和证据目录');
const target = new URL(origin);
assert.ok(['127.0.0.1','localhost'].includes(target.hostname) && !['','80','443','30141','30142','30143'].includes(target.port), '禁止生产测试删除');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
assert.ok(fixture.cwd.includes('/isolated-browser') && fixture.agentDir.startsWith(fixture.cwd.replace(/workspace$/, '')));
assert.ok(fixture.piFile.startsWith(fixture.agentDir + '/'));
const browser = await chromium.launch({headless:true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {})});
const context = await browser.newContext({viewport:{width:390,height:844}, locale:'zh-CN', serviceWorkers:'block'});
const page = await context.newPage(), errors = [], mutations = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', req => {if (req.method() === 'DELETE') mutations.push(new URL(req.url()).pathname);});
const row = id => page.locator(`[data-pi-enh-session-id="${id}"]`).filter({has:page.getByRole('button',{name:'会话更多操作',exact:true})}).first();
async function sidebar() {
  const box = await page.getByRole('button',{name:'切换 Agent',exact:true}).boundingBox();
  if (!box || box.x < 0) await page.getByRole('button',{name:'显示侧边栏',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="切换 Agent"]')?.getBoundingClientRect().left >= 0);
}
async function menu(id) {
  await sidebar();
  await row(id).getByRole('button',{name:'会话更多操作',exact:true}).click();
  const item = page.locator('.pi-enh-session-menu [data-session-action="delete"]');
  assert.notEqual(await item.getAttribute('aria-disabled'),'true');
  await item.click();
  await item.getByText('确认删除',{exact:true}).waitFor();
  return item;
}
const result = {viewport:{width:390,height:844}, checks:[]};
try {
  await page.goto(origin,{waitUntil:'domcontentloaded'});
  await page.locator('[data-pi-native-composer-host]').waitFor();
  await sidebar(); await row(fixture.first).waitFor();
  const confirm = await menu(fixture.first);
  assert.equal(mutations.length,0,'第一次点击不能删除');
  await page.screenshot({path:output+'/MOBILE_CONFIRM.png'});
  const response = page.waitForResponse(r => r.request().method() === 'DELETE');
  await confirm.click(); assert.equal((await response).status(),200);
  await row(fixture.first).waitFor({state:'detached'});
  const native = await (await context.request.get(`http://127.0.0.1:${fixture.controlPort}/`)).json();
  assert.equal(native.firstInRegistry,false); assert.equal(native.firstRolloutPresent,false);
  assert.equal(native.secondInRegistry,true);
  result.checks.push('原位二次确认后，原生记录与网页索引均删除');
  await page.reload({waitUntil:'domcontentloaded'}); await sidebar(); await row(fixture.second).waitFor();
  assert.equal(await row(fixture.first).count(),0);
  result.checks.push('重新打开页面后，已删除记录不再出现');
  const reject = await menu(fixture.second), refusal = page.waitForResponse(r => r.request().method() === 'DELETE');
  await reject.click(); assert.equal((await refusal).status(),400);
  await page.getByText(/删除会话失败，已恢复会话:.*处理队列/).waitFor();
  await row(fixture.second).waitFor();
  await page.screenshot({path:output+'/MOBILE_REFUSED.png'});
  result.checks.push('未确认消息阻止删除，列表恢复并显示具体操作说明');
  await page.getByRole('button',{name:'切换 Agent',exact:true}).click();
  await page.getByText('Pi Agent',{exact:true}).click();
  await row(fixture.pi).waitFor();
  const pi = await menu(fixture.pi), piReply = page.waitForResponse(r => r.request().method() === 'DELETE');
  await pi.click(); assert.equal((await piReply).status(),200);
  await row(fixture.pi).waitFor({state:'detached'});
  await assert.rejects(access(fixture.piFile),{code:'ENOENT'});
  result.checks.push('Pi 会话共用同一菜单，原有删除路径仍可用');
  assert.equal(mutations.length,3); assert.deepEqual(errors,[]);
  result.status='passed';
} catch(error) {result.status='failed'; result.failure=error.stack; process.exitCode=1;}
finally {result.errors=errors;result.deleteRequests=mutations;await writeFile(output+'/BROWSER.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));await context.close();await browser.close();}
