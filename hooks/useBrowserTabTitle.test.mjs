import test from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_TAB_TITLE_MAX_CODEPOINTS,
  normalizeBrowserTabTitle,
  saveBrowserTabTitle,
  resetBrowserTabTitle,
  setBrowserTabTitle,
  subscribeBrowserTabTitle,
  getBrowserTabTitleSnapshot,
  _resetBrowserTabTitleStateForTesting,
  receiveBrowserTabTitleStatus,
} from "./useBrowserTabTitle.ts";

test("normalizeBrowserTabTitle: strips controls and truncates to 80 codepoints", () => {
  assert.equal(normalizeBrowserTabTitle(null), "");
  assert.equal(normalizeBrowserTabTitle("   "), "");
  assert.equal(normalizeBrowserTabTitle("Title\r\nWith\x00Controls\x7f"), "TitleWithControls");

  const emojis = "🌟".repeat(85);
  const normalized = normalizeBrowserTabTitle(emojis);
  assert.equal(Array.from(normalized).length, 80);
  assert.equal(normalized, "🌟".repeat(80));
});

test("subscribe lifecycle and initial fetch / EventSource handling", async () => {
  _resetBrowserTabTitleStateForTesting();

  let fetchCalls = 0;
  let esCreated = 0;
  let esClosed = 0;
  let esInstance = null;

  globalThis.window = {};

  globalThis.fetch = async (url, options) => {
    fetchCalls++;
    if (url === "/api/ui-settings/browser-title") {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            version: 1,
            revision: 5,
            title: "Server Loaded Title",
            customTitle: "Server Loaded Title",
          };
        },
      };
    }
    return { ok: false, status: 404 };
  };

  class MockEventSource {
    constructor(url) {
      esCreated++;
      esInstance = this;
      this.url = url;
    }
    close() {
      esClosed++;
    }
  }
  globalThis.EventSource = MockEventSource;

  try {
    let notifyCount = 0;
    const unsub1 = subscribeBrowserTabTitle(() => {
      notifyCount++;
    });

    assert.equal(fetchCalls, 1);
    assert.equal(esCreated, 0);

    // 第二个订阅者不应重复触发连接
    const unsub2 = subscribeBrowserTabTitle(() => {});
    assert.equal(fetchCalls, 1);
    assert.equal(esCreated, 0);

    // 等待 fetch 完成微任务
    await new Promise((resolve) => setTimeout(resolve, 10));

    const snapshot = getBrowserTabTitleSnapshot();
    assert.equal(snapshot.revision, 5);
    assert.equal(snapshot.rawTitle, "Server Loaded Title");
    assert.equal(snapshot.customTitle, "Server Loaded Title");

    // 模拟 SSE 推送新事件
    receiveBrowserTabTitleStatus({
        version: 1,
        revision: 6,
        title: "Pushed via SSE",
        customTitle: "Pushed via SSE",
    });

    const pushedSnapshot = getBrowserTabTitleSnapshot();
    assert.equal(pushedSnapshot.revision, 6);
    assert.equal(pushedSnapshot.customTitle, "Pushed via SSE");

    // 取消订阅第 1 个（还有第 2 个）：不触发 close
    unsub1();
    assert.equal(esClosed, 0);

    // 取消订阅第 2 个：触发 close 清理
    unsub2();
    assert.equal(esClosed, 0);
  } finally {
    _resetBrowserTabTitleStateForTesting();
    delete globalThis.window;
    delete globalThis.fetch;
    delete globalThis.EventSource;
  }
});

test("saveBrowserTabTitle handles success, 409 conflict, and error without losing old title in memory", async () => {
  _resetBrowserTabTitleStateForTesting();

  globalThis.window = {};

  let currentServerRevision = 0;
  let serverTitle = "Initial";

  globalThis.fetch = async (url, options) => {
    if (options?.method === "PUT") {
      const body = JSON.parse(options.body);
      if (body.revision !== currentServerRevision) {
        return {
          ok: false,
          status: 409,
          async json() {
            return {
              error: "Conflict: revision mismatch",
              currentRevision: currentServerRevision,
              requestedRevision: body.revision,
            };
          },
        };
      }

      if (body.title.includes("FAIL_ERROR")) {
        return {
          ok: false,
          status: 500,
          async json() {
            return { error: "Database disk I/O error" };
          },
        };
      }

      currentServerRevision++;
      serverTitle = body.title;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            version: 1,
            revision: currentServerRevision,
            title: serverTitle,
            customTitle: serverTitle.trim(),
          };
        },
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return { version: 1, revision: currentServerRevision, title: serverTitle };
      },
    };
  };

  try {
    const unsub = subscribeBrowserTabTitle(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 1. 成功保存
    const res1 = await saveBrowserTabTitle("New Tab Title");
    assert.equal(res1.success, true);
    assert.equal(getBrowserTabTitleSnapshot().revision, 1);
    assert.equal(getBrowserTabTitleSnapshot().customTitle, "New Tab Title");

    // 2. 模拟外部修改导致 revision 错配 (409 Conflict)
    currentServerRevision = 99; // 外部变了
    const resConflict = await saveBrowserTabTitle("Will Conflict");
    assert.equal(resConflict.success, false);
    assert.equal(resConflict.conflict, true);
    assert.equal(getBrowserTabTitleSnapshot().isConflict, true);

    // 3. 模拟服务端保存报错 (500)
    assert.equal(getBrowserTabTitleSnapshot().revision, 99, "409 refreshes server revision while preserving conflict");
    currentServerRevision = 99; // 与冲突后重新读取的权威版本匹配
    const resError = await saveBrowserTabTitle("FAIL_ERROR_TITLE");
    assert.equal(resError.success, false);
    assert.equal(getBrowserTabTitleSnapshot().error, "Database disk I/O error");
    // 旧标题留在 memory 中，不被清空或覆盖成非法值
    assert.equal(getBrowserTabTitleSnapshot().customTitle, "New Tab Title");

    unsub();
  } finally {
    _resetBrowserTabTitleStateForTesting();
    delete globalThis.window;
    delete globalThis.fetch;
  }
});

test("monotonic revision & out-of-order SSE vs GET: delayed initial GET never overwrites fresher SSE", async () => {
  _resetBrowserTabTitleStateForTesting();

  globalThis.window = {};

  let delayedGetResolve;
  const delayedGetPromise = new Promise((resolve) => {
    delayedGetResolve = resolve;
  });

  let esInstance = null;
  class MockEventSource {
    constructor() {
      esInstance = this;
    }
    close() {}
  }
  globalThis.EventSource = MockEventSource;

  globalThis.fetch = async (url) => {
    if (url === "/api/ui-settings/browser-title") {
      await delayedGetPromise;
      return {
        ok: true,
        status: 200,
        async json() {
          // 迟到的旧 GET：revision 5
          return { version: 1, revision: 5, title: "Old Stale GET Title" };
        },
      };
    }
    return { ok: false, status: 404 };
  };

  try {
    const unsub = subscribeBrowserTabTitle(() => {});

    // 1. SSE 快速到达权威新 revision 10
    receiveBrowserTabTitleStatus({
        version: 1,
        revision: 10,
        title: "Fresh SSE Title 🚀",
    });

    const sseSnapshot = getBrowserTabTitleSnapshot();
    assert.equal(sseSnapshot.revision, 10);
    assert.equal(sseSnapshot.customTitle, "Fresh SSE Title 🚀");

    // 2. 释放迟到的慢速 GET (revision 5)
    delayedGetResolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 验证：慢速旧 GET 严禁覆盖更新的 SSE 数据（monotonic revision noInitialGET 覆新 SSE）
    const afterGetSnapshot = getBrowserTabTitleSnapshot();
    assert.equal(afterGetSnapshot.revision, 10);
    assert.equal(afterGetSnapshot.customTitle, "Fresh SSE Title 🚀");

    // 3. 非法 payload 必须被忽略
    receiveBrowserTabTitleStatus({ version: 2, revision: 99, title: "Bad Version" });
    assert.equal(getBrowserTabTitleSnapshot().revision, 10);

    receiveBrowserTabTitleStatus({ version: 1, revision: "bad_rev", title: "Bad Rev" });
    assert.equal(getBrowserTabTitleSnapshot().revision, 10);

    // 4. onerror 显示同步中断但保持现有 title
    // No separate title transport can fail or consume a connection slot.
    const errorSnapshot = getBrowserTabTitleSnapshot();
    assert.equal(errorSnapshot.error, null);
    assert.equal(errorSnapshot.customTitle, "Fresh SSE Title 🚀");

    unsub();
  } finally {
    _resetBrowserTabTitleStateForTesting();
    delete globalThis.window;
    delete globalThis.fetch;
    delete globalThis.EventSource;
  }
});

test("save serialization queue: multiple clicks serialize properly without conflicting", async () => {
  _resetBrowserTabTitleStateForTesting();

  globalThis.window = {};

  let serverRevision = 0;
  let serverTitle = "";
  const saveLog = [];

  globalThis.fetch = async (url, options) => {
    if (options?.method === "PUT") {
      const body = JSON.parse(options.body);
      saveLog.push({ sentRevision: body.revision, title: body.title });
      if (body.revision !== serverRevision) {
        return {
          ok: false,
          status: 409,
          async json() {
            return { error: "Conflict", currentRevision: serverRevision };
          },
        };
      }
      // 模拟微小网络耗时
      await new Promise((r) => setTimeout(r, 15));
      serverRevision++;
      serverTitle = body.title;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            version: 1,
            revision: serverRevision,
            title: serverTitle,
          };
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { version: 1, revision: serverRevision, title: serverTitle };
      },
    };
  };

  try {
    const unsub = subscribeBrowserTabTitle(() => {});
    await new Promise((r) => setTimeout(r, 10));

    // 并发连点两次保存
    const p1 = saveBrowserTabTitle("First Click");
    const p2 = saveBrowserTabTitle("Second Click");

    const [r1, r2] = await Promise.all([p1, p2]);

    assert.equal(r1.success, true);
    assert.equal(r2.success, true);
    assert.equal(getBrowserTabTitleSnapshot().revision, 2);
    assert.equal(getBrowserTabTitleSnapshot().customTitle, "Second Click");

    // 验证第二次排队在第一次完成后执行，读取了第一次递增后的最新 revision
    assert.equal(saveLog[0].sentRevision, 0);
    assert.equal(saveLog[1].sentRevision, 1);

    unsub();
  } finally {
    _resetBrowserTabTitleStateForTesting();
    delete globalThis.window;
    delete globalThis.fetch;
  }
});

test("late PUT acknowledgement cannot overwrite a newer external SSE revision", async () => {
  _resetBrowserTabTitleStateForTesting();
  globalThis.window = {};
  let es;
  globalThis.EventSource = class { constructor() { es = this; } close() {} };
  let resolvePut;
  globalThis.fetch = async (_url, options) => {
    if (options?.method === "PUT") return await new Promise(resolve => { resolvePut = resolve; });
    return {ok:true,status:200,json:async()=>({version:1,revision:0,title:""})};
  };
  try {
    const unsub = subscribeBrowserTabTitle(() => {});
    await new Promise(r=>setTimeout(r,0));
    const pending = saveBrowserTabTitle("Mine");
    await new Promise(r=>setTimeout(r,0));
    receiveBrowserTabTitleStatus({version:1,revision:2,title:"Newer external title"});
    resolvePut({ok:true,status:200,json:async()=>({version:1,revision:1,title:"Mine"})});
    assert.equal((await pending).success,true);
    assert.equal(getBrowserTabTitleSnapshot().revision,2);
    assert.equal(getBrowserTabTitleSnapshot().rawTitle,"Newer external title");
    unsub();
  } finally {
    _resetBrowserTabTitleStateForTesting();
    delete globalThis.window; delete globalThis.fetch; delete globalThis.EventSource;
  }
});


test("title subscription opens no SSE and resumes authoritative reads after hide/show", async () => {
  _resetBrowserTabTitleStateForTesting();
  const doc = {}, win = {}; let reads = 0, revision = 1;
  globalThis.document = { visibilityState: "visible", addEventListener(k,f){doc[k]=f}, removeEventListener(k){delete doc[k]} };
  globalThis.window = { addEventListener(k,f){win[k]=f}, removeEventListener(k){delete win[k]} };
  globalThis.EventSource = class { constructor(){throw new Error("title SSE must not open")} };
  globalThis.fetch = async()=>({ok:true,status:200,json:async()=>({version:1,revision:++reads,title:"Title"})});
  try {
    const off=subscribeBrowserTabTitle(()=>{}); await new Promise(r=>setTimeout(r,0));
    receiveBrowserTabTitleStatus({version:1,revision:10,title:"Status title"});
    assert.equal(getBrowserTabTitleSnapshot().rawTitle,"Status title");
    document.visibilityState="hidden";doc.visibilitychange();
    receiveBrowserTabTitleStatus({version:1,revision:11,title:"Ignored hidden"});
    assert.equal(getBrowserTabTitleSnapshot().revision,10);
    document.visibilityState="visible";doc.visibilitychange();await new Promise(r=>setTimeout(r,0));
    assert.equal(reads,2);assert.equal(getBrowserTabTitleSnapshot().revision,10);
    win.pageshow();assert.equal(reads,2,"no duplicate subscription");
    win['pi-web-project-status']({detail:{payload:{browserTitle:{version:1,revision:12,title:"Shared status"}}}});
    assert.equal(getBrowserTabTitleSnapshot().rawTitle,"Shared status");
    off();assert.equal(Object.keys(doc).length,0);assert.equal(Object.keys(win).length,0);
  } finally { _resetBrowserTabTitleStateForTesting();delete globalThis.document;delete globalThis.window;delete globalThis.fetch;delete globalThis.EventSource; }
});

test("appearance sync/save/reset shares revision protection and invalid acknowledgements keep prior state", async()=>{
 _resetBrowserTabTitleStateForTesting();globalThis.window={};let revision=0,title="",appearance=null,badAck=false;
 globalThis.fetch=async(url,options)=>{if(options?.method==='PUT'){const body=JSON.parse(options.body);revision++;title=body.title;if('appearance'in body)appearance=body.appearance;return{ok:true,status:200,json:async()=>({version:1,revision,title,appearance:badAck?{...appearance,logoColor:'#000000'}:appearance})}}return{ok:true,status:200,json:async()=>({version:1,revision,title,appearance})}};
 try{const off=subscribeBrowserTabTitle(()=>{});await new Promise(r=>setTimeout(r,0));const a={titleTemplate:'{project} · {agent}',logoColor:'#123456',themeColor:'#654321'};
 assert((await saveBrowserTabTitle('正式',a)).success);assert.deepEqual(getBrowserTabTitleSnapshot().appearance,a);
 receiveBrowserTabTitleStatus({version:1,revision:2,title:'同步',appearance:{...a,logoColor:'#ff6600'}});assert.equal(getBrowserTabTitleSnapshot().appearance.logoColor,'#ff6600');
 revision=2;badAck=true;assert.equal((await saveBrowserTabTitle('bad',a)).success,false);assert.equal(getBrowserTabTitleSnapshot().rawTitle,'同步');
 badAck=false;revision=2;assert((await resetBrowserTabTitle()).success);assert.equal(getBrowserTabTitleSnapshot().appearance,null);off();
 }finally{_resetBrowserTabTitleStateForTesting();delete globalThis.window;delete globalThis.fetch;}
});
