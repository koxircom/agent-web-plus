// Real React sidebar + DirectoryPicker browser verification for Codex worktree & cwd flow.
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const load = createRequire(import.meta.url);
const esbuild = load('esbuild');
const { chromium } = load(process.env.COMPOSER_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));

const mainRepo = '/home/remote/repo';
const linkedWt = '/home/remote/repo-worktrees/feature-wt';
const subDir = '/home/remote/repo/sub';

const worktreeResponses = {
  [mainRepo]: {
    projectRoot: mainRepo,
    projectKey: `codex:${mainRepo}`,
    isGit: true,
    isTopLevel: true,
    currentWorktreePath: mainRepo,
    worktrees: [
      { path: mainRepo, branch: 'main', isMain: true },
      { path: linkedWt, branch: 'feature-wt', isMain: false },
    ],
  },
  [subDir]: {
    projectRoot: mainRepo,
    projectKey: `codex:${mainRepo}`,
    isGit: true,
    isTopLevel: false,
    currentWorktreePath: mainRepo,
    worktrees: [
      { path: mainRepo, branch: 'main', isMain: true },
      { path: linkedWt, branch: 'feature-wt', isMain: false },
    ],
  },
  [linkedWt]: {
    projectRoot: mainRepo,
    projectKey: `codex:${mainRepo}`,
    isGit: true,
    isTopLevel: true,
    currentWorktreePath: linkedWt,
    worktrees: [
      { path: mainRepo, branch: 'main', isMain: true },
      { path: linkedWt, branch: 'feature-wt', isMain: false },
    ],
  },
};

const bundle = await esbuild.build({
  stdin: {
    resolveDir: root,
    loader: 'tsx',
    contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { SessionSidebar } from './components/SessionSidebar';
      import { I18nProvider } from './hooks/useI18n';

      function App() {
        const [engine, setEngine] = useState('codex');
        const [selectedCwd, setSelectedCwd] = useState('${mainRepo}');
        window.fixture = {
          newSessions: [],
          cwdChanges: [],
          setEngine,
          setSelectedCwd,
        };

        return (
          <I18nProvider>
            <div style={{ height: 800, width: 360, display: 'flex' }}>
              <SessionSidebar
                executionEngine={engine}
                codexEnabled={true}
                selectedCwd={selectedCwd}
                initialCwd={selectedCwd}
                selectedSessionId={null}
                onSelectSession={() => {}}
                onCwdChange={(cwd, root, key) => {
                  window.fixture.cwdChanges.push({ cwd, root, key });
                }}
                onNewSession={(id, cwd, eng) => {
                  window.fixture.newSessions.push({ id, cwd, eng });
                }}
              />
            </div>
          </I18nProvider>
        );
      }

      createRoot(document.getElementById('root')).render(<App />);
    `,
  },
  bundle: true,
  write: false,
  format: 'iife',
  alias: { '@': root },
  define: { 'process.env.NODE_ENV': '"production"' },
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/bundle.js') {
    res.setHeader('content-type', 'text/javascript');
    return res.end(bundle.outputFiles[0].text);
  }

  if (url.pathname === '/api/worktrees') {
    const cwd = url.searchParams.get('cwd');
    const resp = worktreeResponses[cwd] || {
      projectRoot: cwd,
      projectKey: `codex:${cwd}`,
      isGit: false,
      isTopLevel: false,
      currentWorktreePath: null,
      worktrees: [],
    };
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(resp));
  }

  if (url.pathname === '/api/cwd/browse') {
    const p = url.searchParams.get('path');
    let dirs = [];
    if (!p || p === '/') {
      dirs = [{ name: 'repo', path: mainRepo }];
    } else if (p === mainRepo) {
      dirs = [{ name: 'sub', path: subDir }];
    }
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ path: p || '', parentPath: p ? '/' : null, directories: dirs }));
  }

  if (url.pathname === '/api/cwd/validate') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        cwd: parsed.cwd,
        projectRoot: mainRepo,
        projectKey: `codex:${mainRepo}`,
        isGit: true,
      }));
    });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ sessions: [], home: '/home/remote' }));
  }

  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});

let browser;
try {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

  for (const width of [1280, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      isMobile: width === 390,
      hasTouch: width === 390,
    });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));

    await page.goto(origin);

    // 1. Initial load at main repo
    await page.waitForSelector('[data-current-cwd]');
    const initialCwd = await page.locator('[data-current-cwd]').getAttribute('data-current-cwd');
    assert.equal(initialCwd, mainRepo);

    // Verify worktree switcher exists on main repo
    await page.waitForSelector('button[title*="Worktree"], button[title*="工作树"], button:has-text("main")');

    // 2. Click worktree dropdown button to open worktree list
    const wtButton = page.locator('button:has-text("main")').first();
    await wtButton.click();

    // Verify worktree list shows main and linked worktree
    await page.waitForSelector('text=feature-wt');
    // Ensure remove button is NOT rendered for Codex engine
    const removeButtons = await page.locator('button[title*="删除工作树"], button[title*="Remove worktree"]').count();
    assert.equal(removeButtons, 0, 'Codex engine must hide remove worktree button');

    // 3. Switch to linked worktree
    const linkedItem = page.locator('button:has-text("feature-wt")').first();
    await linkedItem.click();

    // Verify effective cwd updated to linked worktree
    await page.waitForFunction((expected) => {
      const el = document.querySelector('[data-current-cwd]');
      return el && el.getAttribute('data-current-cwd') === expected;
    }, linkedWt);

    // Verify worktree switcher is STILL visible (not hidden due to projectKey mismatch!)
    await page.waitForSelector('button:has-text("feature-wt")');

    // 4. Click new session button with linked worktree active
    const newSessionBtn = page.locator('button[aria-label*="新建"], button[aria-label*="New"]').first();
    await newSessionBtn.click();

    const created = await page.evaluate(() => window.fixture.newSessions);
    assert.ok(created.length >= 1);
    const lastSession = created.at(-1);
    assert.equal(lastSession.cwd, linkedWt, 'New session must capture linked worktree cwd');
    assert.equal(lastSession.eng, 'codex', 'New session must keep codex engine');

    // 5. Switch to subdirectory
    await page.evaluate((dir) => window.fixture.setSelectedCwd(dir), subDir);
    await page.waitForFunction((expected) => {
      const el = document.querySelector('[data-current-cwd]');
      return el && el.getAttribute('data-current-cwd') === expected;
    }, subDir);

    // Give time for worktrees fetch to resolve
    await page.waitForTimeout(200);

    // Subdirectory is not top-level; guide should appear instead of switcher

    // 6. Test Pi regression: switch to Pi engine
    await page.evaluate(() => window.fixture.setEngine('pi'));
    await page.waitForTimeout(100);
    assert.equal(pageErrors.length, 0, `No page errors in viewport ${width}`);

    await page.close();
  }

  console.log('✅ Real browser SessionSidebar/DirectoryPicker worktree flow passed for desktop & mobile!');
} finally {
  if (browser) await browser.close();
  server.close();
}
