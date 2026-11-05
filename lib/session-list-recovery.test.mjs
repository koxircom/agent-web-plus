import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createJiti} from 'jiti';

const jiti = createJiti(import.meta.url);
const {listAllSessions, invalidateSessionListCache} = await jiti.import('./session-reader.ts');
const {listSessionsIncremental, resetSessionScanIndexForTests} = await jiti.import('./session-list-scanner.ts');
const timestamp = '2026-01-01T00:00:00.000Z';
const message = (role, content) => ({type:'message',id:'m1',parentId:null,timestamp,message:{role,content}});
function fixture(t) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const root = fs.mkdtempSync(join(tmpdir(), 'session-list-recovery-'));
  const dir = join(root, 'sessions', 'project');
  fs.mkdirSync(dir, {recursive:true});
  process.env.PI_CODING_AGENT_DIR = root;
  resetSessionScanIndexForTests(); invalidateSessionListCache();
  t.after(() => {
    resetSessionScanIndexForTests(); invalidateSessionListCache();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, {recursive:true,force:true});
  });
  const write = (id, entries=[], header={}) => {
    const file=join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, [{type:'session',version:3,id,cwd:root,timestamp,...header}, ...entries].map(row=>JSON.stringify(row)).join('\n')+'\n');
    return file;
  };
  write.root = root;
  return write;
}
test('invalid creation time does not break the catalogue', async (t) => {
  const write=fixture(t);
  const bad=write('invalid-time',[message('user','可读取')],{timestamp:'not-a-date'});
  write('valid-time',[message('user','正常')]);
  const summary=await listSessionsIncremental({deferDetails:true});
  assert.equal(summary.length,2);
  const fallback = new Date(fs.statSync(bad).mtimeMs).toISOString();
  assert.equal(summary.find(row=>row.id==='invalid-time').created.toISOString(),fallback);
  const sessions=await listAllSessions();
  assert.equal(sessions.length,2);
  const recovered=sessions.find(row=>row.id==='invalid-time');
  assert.equal(recovered.created,fallback);
  assert.equal(recovered.firstMessage,'可读取');
});
test('assistant-only sessions display their first message', async (t) => {
  const write=fixture(t);
  write('assistant-only',[message('assistant',[{type:'text',text:'已有助手回复'}])]);
  write('empty');
  const sessions=await listAllSessions();
  assert.equal(sessions.find(row=>row.id==='assistant-only').firstMessage,'已有助手回复');
  assert.equal(sessions.find(row=>row.id==='empty').firstMessage,'(no messages)');
});
test('old indexes with a false empty label are rescanned', async (t) => {
  const write=fixture(t);
  const file=write('old-label',[message('assistant',[{type:'text',text:'已有助手回复'}])]);
  const stat=fs.statSync(file);
  const info={path:file,id:'old-label',cwd:write.root,created:timestamp,modified:timestamp,messageCount:1,firstMessage:'(no messages)'};
  fs.writeFileSync(join(write.root,'pi-web-session-index.json'),JSON.stringify({version:1,entries:{[file]:{fp:{size:stat.size,mtimeMs:stat.mtimeMs},info}}}));
  resetSessionScanIndexForTests(); invalidateSessionListCache();
  assert.equal((await listAllSessions())[0].firstMessage,'已有助手回复');
});
test('a malformed session id is omitted without hiding valid sessions', async (t) => {
  const write=fixture(t);
  write('valid',[message('user','正常')]);
  write('missing-id',[message('user','缺少 ID')],{id:undefined});
  write('empty-id',[message('user','空 ID')],{id:'  '});
  assert.deepEqual((await listAllSessions()).map(row=>row.id),['valid']);
});
test('out-of-range message timestamps do not break the catalogue', async (t) => {
  const write=fixture(t);
  const entry=message('user','可读取');entry.message.timestamp=1e300;
  write('bad-activity',[entry]);
  const sessions=await listAllSessions();
  assert.equal(sessions.length,1);
  assert.equal(sessions[0].modified,timestamp);
});
