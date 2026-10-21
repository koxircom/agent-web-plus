import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';

test('Codex metadata sync: GET archived, PATCH message actions, and batch-delete error handling', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-metadata-sync-'));
  const priorDir = process.env.PI_CODING_AGENT_DIR, priorFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    globalThis.fetch = priorFetch;
    if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorDir;
    await rm(dir, { recursive: true, force: true });
  });

  const jiti = createJiti(import.meta.url, {
    alias: { '@': process.cwd(), 'server-only': 'next/dist/compiled/server-only/empty.js' },
  });
  const { saveExecutionEngineSettings } = await jiti.import('../execution-engine-settings.ts');
  const { GET: getSessions } = await jiti.import('../../app/api/sessions/route.ts');
  const { PATCH: patchSession } = await jiti.import('../../app/api/sessions/[id]/route.ts');
  const { POST: batchDelete } = await jiti.import('../../app/api/sessions/batch-delete/route.ts');

  await saveExecutionEngineSettings({ codex: { enabled: true, url: 'http://127.0.0.1:19877' } });

  const codexId1 = 'codex:01901234-0000-7000-8000-000000000001';
  const codexId2 = 'codex:01901234-0000-7000-8000-000000000002';
  const codexId3 = 'codex:01901234-0000-7000-8000-000000000003';

  let postActionPayload = null;

  globalThis.fetch = async (url, opts) => {
    if (url.endsWith('/api/login')) return new Response('{}', { headers: { 'Set-Cookie': 'test=owned' } });
    if (url.endsWith('/api/auth')) return Response.json({ csrf: 'owned', authenticated: true });

    // GET /api/sessions?archived=true
    if (url.includes('/api/sessions?archived=true')) {
      return Response.json({
        sessions: [
          {
            id: '01901234-0000-7000-8000-000000000001',
            title: '已归档线程',
            cwd: '/workspace/test',
            pinned: false,
            archived: true,
            nativeMetadata: { desktopShared: true, pinningSupported: true },
          },
        ],
      });
    }

    // POST message-action (pin, unpin, archive, unarchive, delete)
    if (url.includes('/message-action')) {
      const body = JSON.parse(opts.body);
      postActionPayload = { url, body };

      if (body.action === 'delete') {
        if (url.includes(codexId2.slice(6))) {
          // 模拟 codexId2 在 Codex 端真实 404 (不存在)
          return Response.json({ error: 'Thread not found' }, { status: 404 });
        }
        if (url.includes(codexId3.slice(6))) {
          // 模拟 codexId3 在 Codex 端报错 502/504
          return Response.json({ error: 'Codex 执行端连接失败' }, { status: 502 });
        }
        return Response.json({ ok: true });
      }

      if (body.action === 'pin') {
        return Response.json({
          ok: true,
          session: {
            id: '01901234-0000-7000-8000-000000000001',
            title: '测试线程',
            cwd: '/workspace/test',
            pinned: true,
            archived: false,
            nativeMetadata: { desktopShared: true, pinningSupported: true },
          },
        });
      }

      if (body.action === 'unpin') {
        return Response.json({
          ok: true,
          session: {
            id: '01901234-0000-7000-8000-000000000001',
            title: '测试线程',
            cwd: '/workspace/test',
            pinned: false,
            archived: false,
            nativeMetadata: { desktopShared: true, pinningSupported: true },
          },
        });
      }

      if (body.action === 'archive') {
        return Response.json({
          ok: true,
          session: {
            id: '01901234-0000-7000-8000-000000000001',
            title: '测试线程',
            cwd: '/workspace/test',
            pinned: false,
            archived: true,
            nativeMetadata: { desktopShared: true, pinningSupported: true },
          },
        });
      }

      if (body.action === 'unarchive') {
        return Response.json({
          ok: true,
          session: {
            id: '01901234-0000-7000-8000-000000000001',
            title: '测试线程',
            cwd: '/workspace/test',
            pinned: false,
            archived: false,
            nativeMetadata: { desktopShared: true, pinningSupported: true },
          },
        });
      }
    }

    return Response.json({});
  };

  // 1. 测试 GET /api/sessions?engine=codex&archived=true
  const getReq = new Request('http://localhost/api/sessions?engine=codex&archived=true');
  const getRes = await getSessions(getReq);
  assert.equal(getRes.status, 200);
  const getData = await getRes.json();
  assert.equal(getData.sessions.length, 1);
  assert.equal(getData.sessions[0].id, codexId1);
  assert.equal(getData.sessions[0].archived, true);
  assert.deepEqual(getData.sessions[0].nativeMetadata, { desktopShared: true, pinningSupported: true });

  // 2. 测试 PATCH /api/sessions/codex:...
  // 2.1 pin
  const patchReqPin = new Request('http://localhost/api/sessions/' + codexId1, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pin' }),
  });
  const patchResPin = await patchSession(patchReqPin, { params: Promise.resolve({ id: codexId1 }) });
  assert.equal(patchResPin.status, 200);
  const pinData = await patchResPin.json();
  assert.equal(pinData.ok, true);
  assert.equal(pinData.session.pinned, true);
  assert.equal(postActionPayload.body.action, 'pin');

  // 2.2 unpin
  const patchReqUnpin = new Request('http://localhost/api/sessions/' + codexId1, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'unpin' }),
  });
  const patchResUnpin = await patchSession(patchReqUnpin, { params: Promise.resolve({ id: codexId1 }) });
  assert.equal(patchResUnpin.status, 200);
  const unpinData = await patchResUnpin.json();
  assert.equal(unpinData.ok, true);
  assert.equal(unpinData.session.pinned, false);
  assert.equal(postActionPayload.body.action, 'unpin');

  // 2.3 archive
  const patchReqArchive = new Request('http://localhost/api/sessions/' + codexId1, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'archive' }),
  });
  const patchResArchive = await patchSession(patchReqArchive, { params: Promise.resolve({ id: codexId1 }) });
  assert.equal(patchResArchive.status, 200);
  const archiveData = await patchResArchive.json();
  assert.equal(archiveData.ok, true);
  assert.equal(archiveData.session.archived, true);
  assert.equal(postActionPayload.body.action, 'archive');

  // 2.4 unarchive
  const patchReqUnarchive = new Request('http://localhost/api/sessions/' + codexId1, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'unarchive' }),
  });
  const patchResUnarchive = await patchSession(patchReqUnarchive, { params: Promise.resolve({ id: codexId1 }) });
  assert.equal(patchResUnarchive.status, 200);
  const unarchiveData = await patchResUnarchive.json();
  assert.equal(unarchiveData.ok, true);
  assert.equal(unarchiveData.session.archived, false);
  assert.equal(postActionPayload.body.action, 'unarchive');

  // 3. 测试混合批删分流与真实 404 / 502 处理
  const batchReq = new Request('http://localhost/api/sessions/batch-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ids: [codexId1, codexId2, codexId3],
    }),
  });
  const batchRes = await batchDelete(batchReq);
  assert.equal(batchRes.status, 200);
  const batchData = await batchRes.json();
  assert.equal(batchData.results.length, 3);

  // codexId1 成功删除
  assert.equal(batchData.results[0].id, codexId1);
  assert.equal(batchData.results[0].ok, true);

  // codexId2 真实 404，幂等删除成功，标记 missing
  assert.equal(batchData.results[1].id, codexId2);
  assert.equal(batchData.results[1].ok, true);
  assert.equal(batchData.results[1].missing, true);

  // codexId3 真实 502 报错，绝不掩盖为成功！
  assert.equal(batchData.results[2].id, codexId3);
  assert.equal(batchData.results[2].ok, false);
  assert.match(batchData.results[2].error, /Codex 执行端连接失败/);

  // 4. 测试混合引擎批删（同时包含 Pi session 和 Codex session）
  const piBatchFixtureDir = await mkdtemp(join(tmpdir(), 'pi-batch-fixture-'));
  const prevSessionsDir = process.env.PI_SESSIONS_DIR;
  process.env.PI_SESSIONS_DIR = join(piBatchFixtureDir, 'sessions');
  const wsDir = join(piBatchFixtureDir, 'sessions', 'test-ws');
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(wsDir, { recursive: true });

  const piId1 = 'pi-test-session-001';
  const piPath1 = join(wsDir, piId1 + '.jsonl');
  await writeFile(
    piPath1,
    JSON.stringify({ type: 'session', version: 3, id: piId1, timestamp: new Date().toISOString(), cwd: wsDir }) + '\n'
  );

  const { cacheSessionPath, invalidateSessionListCache, invalidateSessionPathCache } = await jiti.import(
    '../session-reader.ts'
  );
  cacheSessionPath(piId1, piPath1);
  invalidateSessionListCache();

  try {
    const mixedBatchReq = new Request('http://localhost/api/sessions/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: [piId1, codexId1],
      }),
    });
    const mixedBatchRes = await batchDelete(mixedBatchReq);
    assert.equal(mixedBatchRes.status, 200);
    const mixedData = await mixedBatchRes.json();
    assert.equal(mixedData.results.length, 2);
    assert.equal(mixedData.results[0].id, piId1);
    assert.equal(mixedData.results[0].ok, true);
    assert.equal(mixedData.results[1].id, codexId1);
    assert.equal(mixedData.results[1].ok, true);
    assert(mixedData.deletedSessionIds.includes(piId1));
    assert(mixedData.deletedSessionIds.includes(codexId1));
  } finally {
    invalidateSessionPathCache(piId1);
    if (prevSessionsDir === undefined) delete process.env.PI_SESSIONS_DIR;
    else process.env.PI_SESSIONS_DIR = prevSessionsDir;
    await rm(piBatchFixtureDir, { recursive: true, force: true });
  }

  // 5. 测试 Pi 会话旧 PATCH 兼容性 (rename)
  const piRenameDir = await mkdtemp(join(tmpdir(), 'pi-rename-fixture-'));
  const piWsDir = join(piRenameDir, 'sessions', 'rename-ws');
  await mkdir(piWsDir, { recursive: true });
  const piRenameId = 'pi-rename-001';
  const piRenamePath = join(piWsDir, piRenameId + '.jsonl');
  await writeFile(
    piRenamePath,
    JSON.stringify({ type: 'session', version: 3, id: piRenameId, timestamp: new Date().toISOString(), cwd: piWsDir }) + '\n'
  );
  cacheSessionPath(piRenameId, piRenamePath);
  try {
    const renameReq = new Request('http://localhost/api/sessions/' + piRenameId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '新标题' }),
    });
    const renameRes = await patchSession(renameReq, { params: Promise.resolve({ id: piRenameId }) });
    assert.equal(renameRes.status, 200);
    assert.deepEqual(await renameRes.json(), { ok: true });
  } finally {
    invalidateSessionPathCache(piRenameId);
    await rm(piRenameDir, { recursive: true, force: true });
  }
});
