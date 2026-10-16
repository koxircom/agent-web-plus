"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const home = process.env.USERPROFILE || process.env.HOME || "C:/Users/KOXIR";
const ENHANCEMENT_SOURCE = path.join(home, ".pi", "agent", "scripts", "pi-web-enhancements.js");
const LOCKS_SCRIPT_PATH = fs.existsSync(path.join(home, ".pi", "agent", "scripts", "pi-web-enhancement-locks.cjs"))
  ? path.join(home, ".pi", "agent", "scripts", "pi-web-enhancement-locks.cjs")
  : path.join(__dirname, "pi-web-enhancement-locks.cjs");
const { withGlobalBuildLock, inspectManifestModuleDiffs } = require(LOCKS_SCRIPT_PATH);
const {
  extractEnhancementMetadata,
  buildFastPluginReaderSnippet,
} = require("./pi-web-settings-prepaint.cjs");

function resolveSettingsModule02Path(customHome = home) {
  const consumerBundle = path.join(customHome, '.pi', 'agent', 'scripts', 'pi-web-enhancements.js');
  if (!fs.existsSync('/workspace/pi-web/components/SessionSidebar.tsx') && fs.existsSync(consumerBundle)) return consumerBundle;
  const directCandidate = path.join(__dirname, "enhancements", "modules", "02-plugin-registry-and-settings-schema.js");
  if (fs.existsSync(directCandidate)) return directCandidate;
  const homeCandidate = path.join(customHome, ".pi", "agent", "scripts", "enhancements", "modules", "02-plugin-registry-and-settings-schema.js");
  if (fs.existsSync(homeCandidate)) return homeCandidate;
  return directCandidate;
}
// Development source runs the browser gate; consumption-only targets validate the
// same deletion contract without acquiring build/test dependencies or user state.
function runSessionDeleteRegressionGate(options) {
  const gatePath = path.join(__dirname, "session-delete-regression-gate.cjs");
  const isDevelopmentSource = fs.existsSync('/workspace/pi-web/components/SessionSidebar.tsx');
  if (fs.existsSync(gatePath)) {
    if (isDevelopmentSource) return require(gatePath).runSessionDeleteRegressionGate(options);
  }
  if (isDevelopmentSource) {
    throw new Error("[session-delete-gate] Development browser gate missing; deployment refused");
  }
  const code = String(options.candidateBundleText || "");
  const section = (start, end) => {
    const a = code.indexOf(start), b = code.indexOf(end, a + start.length);
    return a >= 0 && b > a ? code.slice(a, b) : "";
  };
  const mark = section("function markSessionAsDeleted(", "function markSessionDeleteConfirmed(");
  const restore = section("function restoreSessionDeleteState(", "function cleanupDeletedSessionEverywhere(");
  const native = code.match(/try\s*\{\s*markSessionAsDeleted\(targetSessionId\);\s*deleteMarked\s*=\s*true;\s*await ensureSessionIngestedBeforeDelete\(targetSessionId\);\s*\}\s*catch\s*\(ensureErr\)/g) || [];
  const fast = section("function beginFastSessionDelete(", "window.__PI_ENH_BEGIN_FAST_SESSION_DELETE__");
  if (!mark.includes("__PI_ENH_RERENDER_SESSIONS__") || !restore.includes("__PI_ENH_RERENDER_SESSIONS__") || native.length < 2 || !fast.includes("__PI_ENH_FAST_SESSION_DELETE_IDS__")) {
    throw new Error("[session-delete-gate] Consumer deletion contract failed; static deployment refused");
  }
  console.log("[session-delete-gate] Consumer contract PASS (browser acceptance runs on development source).");
  return { passed: true, mode: "consumer-contract" };
}

function resolveScriptAssetPath(filename, customHome = home) {
  const homeCandidate = path.join(customHome, ".pi", "agent", "scripts", filename);
  if (fs.existsSync(homeCandidate)) return homeCandidate;
  const localCandidate = path.join(__dirname, filename);
  if (fs.existsSync(localCandidate)) return localCandidate;
  return homeCandidate;
}

function stripBundledEnhancementPreamble(rawCode) {
  if (typeof rawCode !== "string" || !rawCode) return "";
  if (!rawCode.includes("window.__PI_ENH_ASSET_BUILD__")) return rawCode;
  const bannerMarker = "\n;\n/**\n * Pi Web Enhancements";
  const bannerIdx = rawCode.indexOf(bannerMarker);
  if (bannerIdx !== -1) {
    return rawCode.slice(bannerIdx + 3);
  }
  const altMarker = "\n/**\n * Pi Web Enhancements";
  const altIdx = rawCode.indexOf(altMarker);
  if (altIdx !== -1) {
    return rawCode.slice(altIdx + 1);
  }
  return rawCode;
}

function resolvePatchLockConfig(options = {}) {
  const stateFile =
    options.stateFile ||
    process.env.PI_ENHANCEMENT_LOCKS_FILE ||
    path.join(home, ".pi", "agent", "state", "pi-web-enhancement-locks.json");
  const modulesDir =
    options.modulesDir ||
    process.env.PI_ENHANCEMENT_MODULES_DIR ||
    path.join(home, ".pi", "agent", "scripts", "enhancements", "modules");

  const isCertifiedSnapshot = Boolean(
    options.snapshotManifestPath && fs.existsSync(options.snapshotManifestPath)
  );

  const sdkOnly = Boolean(
    options.sdkOnly ||
    process.argv.includes("--sdk-only") ||
    process.argv.includes("--skip-builder-sync")
  );

  let hasModuleDiffs = false;
  if (!sdkOnly && !isCertifiedSnapshot && fs.existsSync(path.join(modulesDir, "manifest.json"))) {
    const diffReport = inspectManifestModuleDiffs({ modulesDir });
    hasModuleDiffs = Boolean(diffReport.hasManifest && diffReport.modifiedModules.length > 0);
  }

  const skipBuilderSync =
    isCertifiedSnapshot ||
    sdkOnly ||
    (Boolean(options.skipBuilderSync) && !hasModuleDiffs);
  const enforceUnlockedDiffCheck = !isCertifiedSnapshot && !sdkOnly && options.enforceUnlockedDiffCheck !== false;

  return {
    stateFile,
    modulesDir,
    hasModuleDiffs,
    skipBuilderSync,
    enforceUnlockedDiffCheck,
    isCertifiedSnapshot,
  };
}

function safeWriteFileSync(filePath, content, encoding = "utf8") {
  try {
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, encoding);
      if (existing === content) return false;
    }
    fs.writeFileSync(filePath, content, encoding);
    return true;
  } catch (e) {
    fs.writeFileSync(filePath, content, encoding);
    return true;
  }
}

function repairMalformedClientDurationCopy(content) {
  const malformed = /([A-Za-z_$][\w$]*)&&!t&&\(0,r\.jsxs\)\("button",\{onClick:\(\)=>\{([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\(0,r\.jsxs\)\("button",\{onClick:\(\)=>\{\2\(\3\)\.then\(\(\)=>\{([A-Za-z_$][\w$]*)\(!0\),setTimeout\(\(\)=>\4\(!1\),1500\)\}\)\},/;
  return content.replace(malformed, (_, condition, copyFn, copyArg, stateFn) =>
    `${condition}&&!t&&(0,r.jsxs)("button",{onClick:()=>{${copyFn}(${copyArg}).then(()=>{${stateFn}(!0),setTimeout(()=>${stateFn}(!1),1500)})},`);
}

function repairStreamingThinkingLevel(content) {
  // 官方构建产物在 isStreaming 时通过 !l&&S 卸载了思考深度按钮，并将其设为 disabled 与 not-allowed
  // 修复：移除 !isStreaming 限制，保持思考深度在任务运行与排队引导时始终可见且可正常点击配置
  const pattern = /!([a-zA-Z0-9_$]+)&&([a-zA-Z0-9_$]+)&&\((0,[a-zA-Z0-9_$]+(?:\.jsxs|\.jsx))\)\("div",\{ref:([a-zA-Z0-9_$]+),style:\{position:"relative"\},children:\[\((0,[a-zA-Z0-9_$]+(?:\.jsxs|\.jsx))\)\("button",\{onClick:\(\)=>!\1&&([a-zA-Z0-9_$]+)\(e=>!e\),disabled:\1,title:([a-zA-Z0-9_$]+)\("chat\.(?:changeReasoning|currentReasoning)",\{level:([a-zA-Z0-9_$]+)\}\),"aria-label":([a-zA-Z0-9_$]+)\("chat\.changeReasoningLabel"\),style:\{display:"flex",alignItems:"center",justifyContent:"center",gap:5,padding:([a-zA-Z0-9_$]+)\?"0 6px":"8px 12px",width:\10\?"auto":void 0,height:32,background:([a-zA-Z0-9_$]+)\?"var\(--bg-hover\)":"none",border:"none",borderRadius:9,color:"var\(--text-muted\)",cursor:\1\?"not-allowed":"pointer",fontSize:12,opacity:\1\?\.5:1,transition:"background 0\.12s, color 0\.12s"/g;

  return content.replace(pattern, (match, streamingVar, onThinkingVar, jsxs1, refVar, jsxs2, toggleDropdownVar, tVar, levelVar, tVar2, isMobileVar, bgHoverVar) => {
    return `${onThinkingVar}&&(${jsxs1})("div",{ref:${refVar},style:{position:"relative"},children:[(${jsxs2})("button",{onClick:()=>${toggleDropdownVar}(e=>!e),disabled:false,title:${tVar}("chat.changeReasoning",{level:${levelVar}}),"aria-label":${tVar2}("chat.changeReasoningLabel"),style:{display:"flex",alignItems:"center",justifyContent:"center",gap:5,padding:${isMobileVar}?"0 6px":"8px 12px",width:${isMobileVar}?"auto":void 0,height:32,background:${bgHoverVar}?"var(--bg-hover)":"none",border:"none",borderRadius:9,color:"var(--text-muted)",cursor:"pointer",fontSize:12,opacity:1,transition:"background 0.12s, color 0.12s"`;
  });
}

function repairStreamingSendShortcuts(content) {
  // 原生上游在 isStreaming 状态下默认将 Enter 发送为 "steer"（引导），仅在 Alt+Enter 时发送为 "followup"（后续消息）
  // 彻底固化修复：普通 Enter 100% 只能是加入队列（后续消息），Ctrl/Cmd+Enter 100% 才能触发立即引导
  const pattern = /tT\(e\.altKey&&[A-Za-z0-9_$]+\|\|![A-Za-z0-9_$]+\?"followup":"steer"\)/g;
  return content.replace(pattern, 'tT((e.ctrlKey||e.metaKey)&&n?"steer":"followup")');
}

function repairModelSelectorMobileAutoFocus(content) {
  if (typeof content !== "string" || !content) return content;
  // 原生上游在 ModelSelector 的筛选输入框硬编码了 autoFocus:!0，导致移动端点击切换模型时系统强制弹起软键盘并遮挡菜单
  // 彻底固化修复：将 autoFocus:!0 精准替换为 autoFocus:!1，杜绝移动端误弹虚拟键盘
  return content.replace(
    /("chat\.filterModels"\),["']aria-label["']:[A-Za-z0-9_$]+\("chat\.filterModels"\),)autoFocus:!0,/g,
    '$1autoFocus:!1,'
  );
}

function repairModelSelectorRetainKeyboard(content) {
  if (typeof content !== "string" || !content) return content;
  // 原生上游在 ModelSelector 按钮点击时强制调用 document.activeElement.blur()，导致移动端输入框失焦并强行收起虚拟键盘
  // 彻底固化修复：移除 activeElement.blur()，确保移动端打字时切换模型不中断软键盘与输入状态
  return content.replace(
    /"u">typeof document&&document\.activeElement instanceof HTMLElement&&document\.activeElement\.blur\(\);/g,
    ""
  );
}

function repairComposerCleanPlaceholder(content) {
  if (typeof content !== "string" || !content) return content;
  // 原生输入框占位符长达24个字符且在手机端容易折行显得难看；空闲状态直接清空提示词保持极简纯净
  const pattern = /placeholder:([a-zA-Z0-9_$]+)&&\(([a-zA-Z0-9_$]+)\|\|([a-zA-Z0-9_$]+)\)\?([a-zA-Z0-9_$]+)\("chat\.steerPlaceholder"\):\1\?([a-zA-Z0-9_$]+)\("chat\.agentPlaceholder"\):\4\("chat\.messagePlaceholder"\)/g;
  return content.replace(pattern, 'placeholder:$1&&($2||$3)?$4("chat.steerPlaceholder"):$1?$5("chat.agentPlaceholder"):""');
}

function patchDisableNativeAtFiles(content) {
  if (typeof content !== "string" || !content) return content;
  // 原生 ChatInput 在输入 @ 时通过 updateAtQuery(tx) 触发原生文件搜索并打开文件补全菜单：
  // (0,i.useCallback)((e,t)=>{if(!O)return void ew(null);let n=t??e.length;ew(tQ(e.slice(0,n)))},[O])
  // 注入 window.__PI_ENH_DISABLE_NATIVE_AT_FILES__ 开关守卫，开启时让原生 atQuery 恒为 null，彻底休眠原生文件菜单与网络扫描
  const pattern = /(\(0,\s*[a-zA-Z0-9_$]+\.useCallback\)\s*\(\s*\(([a-zA-Z0-9_$]+),\s*([a-zA-Z0-9_$]+)\)\s*=>\s*\{\s*if\(!([a-zA-Z0-9_$]+))(\)return void ([a-zA-Z0-9_$]+)\(null\);)/g;
  if (pattern.test(content)) {
    content = content.replace(pattern, '$1||(typeof window!=="undefined"&&window.__PI_ENH_DISABLE_NATIVE_AT_FILES__)$5');
  }
  return content;
}

function repairComposerInitialMount(content) {
  if (typeof content !== "string" || !content) return content;

  // Only touch the native composer prefix ending at its textarea. Similar
  // relative-position wrappers elsewhere in the app are not composer nodes.
  const composerPrefix = /(?:className:"pi-enh-cursor-composer(?: pi-enh-composer-model-pill)?",)*style:\{maxWidth:"var\(--chat-content-max-width, 820px\)",margin:"0 auto"\},children:\[[\s\S]{0,40000}?className:"chat-input-textarea"/g;
  return content.replace(composerPrefix, (content) => {
  // 1. 清洗并精准规范化 outerCard:
  // 匹配已知 composer 外层卡片结构，清洗可能存在的重复 className，注入终态一体化 className:"pi-enh-cursor-composer pi-enh-composer-model-pill"
  const outerCardPattern = /(?:className:"pi-enh-cursor-composer(?: pi-enh-composer-model-pill)?",)*style:\{maxWidth:"var\(--chat-content-max-width, 820px\)",margin:"0 auto"\},children:\[/g;
  content = content.replace(outerCardPattern, 'className:"pi-enh-cursor-composer pi-enh-composer-model-pill",style:{maxWidth:"var(--chat-content-max-width, 820px)",margin:"0 auto"},children:[');

  // 2. 清洗并精准规范化 innerContents:
  // 匹配已知 composer 内层相对定位容器，清洗可能存在的重复 className，注入单一且精准的 className:"pi-enh-cursor-contents"
  const innerContentsPattern = /(?:className:"pi-enh-cursor-contents",)*style:\{position:"relative",minWidth:0\},children:\[/g;
  content = content.replace(innerContentsPattern, 'className:"pi-enh-cursor-contents",style:{position:"relative",minWidth:0},children:[');

  // 3. 清洗并精准规范化 editorBox:
  // 修复之前将 className 错误注入到 style 对象内部的残留（如 style:{className:"pi-enh-cursor-contents",...}）
  const stylePollutionPattern = /style:\{(?:\s*className:"pi-enh-cursor-contents",\s*)+(minWidth:0,display:"flex",flexDirection:([a-zA-Z0-9_$]+)\?"column":"row",gap:8,alignItems:\2\?"stretch":"center",background:"var\(--bg\)")/g;
  content = content.replace(stylePollutionPattern, 'style:{$1');

  // 改为精准元素 props 注入，且支持清洗外层重复的 className，确保重复运行相同输出（幂等），只限定已知 composer 结构
  const editorBoxPattern = /(\("div",\s*\{)(?:className:"pi-enh-cursor-contents",)*(style:\{minWidth:0,display:"flex",flexDirection:([a-zA-Z0-9_$]+)\?"column":"row",gap:8,alignItems:\3\?"stretch":"center",background:"var\(--bg\)")/g;
  content = content.replace(editorBoxPattern, '$1className:"pi-enh-cursor-contents",$2');

  return content;
  });
}


function patchDirectToolbarControls(content) {
  let s_idx = -1;
  let e_idx = -1;
  let end_len = 0;

  const startMarker = "/* PI_PATCH_DIRECT_TOOLBAR */";
  const endMarker = "/* PI_PATCH_DIRECT_TOOLBAR_END */";

  if (content.includes(startMarker)) {
    s_idx = content.indexOf(startMarker);
    const endCommentIdx = content.indexOf(endMarker, s_idx);
    if (endCommentIdx !== -1) {
      e_idx = endCommentIdx;
      end_len = endMarker.length;
    } else {
      const legacyEnd = 'children:[(0,r.jsx)("svg",{width:"10",height:"10",viewBox:"0 0 10 10",fill:"none",children:(0,r.jsx)("rect",{x:"1.5",y:"1.5",width:"7",height:"7",rx:"1.5",fill:"currentColor"})}),X("chat.stop")]})]})]})';
      const legacyIdx = content.indexOf(legacyEnd, s_idx);
      if (legacyIdx !== -1) {
        e_idx = legacyIdx;
        end_len = legacyEnd.length;
      }
    }
  } else {
    const s_marker = "!U&&(0,r.jsxs)(\"div\",{style:{marginTop:8";
    const e_marker = "children:[(0,r.jsx)(\"line\",{x1:\"18\",y1:\"6\",x2:\"6\",y2:\"18\"}),(0,r.jsx)(\"line\",{x1:\"6\",y1:\"6\",x2:\"18\",y2:\"18\"})]})})]})]})]})";
    s_idx = content.indexOf(s_marker);
    const markerIdx = content.indexOf(e_marker, s_idx);
    if (markerIdx !== -1) {
      e_idx = markerIdx;
      end_len = e_marker.length;
    }
  }

  if (s_idx === -1 || e_idx === -1) return content;

  const end_idx = e_idx + end_len;

  const isWinBuild = content.includes("{t:Q}") || content.includes("page-5c5b1233");

  let newBlock = "";
  if (isWinBuild) {
    // Windows build (page-5c5b1233): adapt mangled variables accurately
    newBlock = `/* PI_PATCH_DIRECT_TOOLBAR */!U&&(0,r.jsxs)("div",{"data-pi-composer-toolbar":!0,className:"pi-enh-cursor-contents",style:{marginTop:8,display:"flex",alignItems:"center",justifyContent:"space-between",gap:4},children:[(0,r.jsxs)("div",{"data-pi-composer-left":!0,className:"pi-enh-cursor-left",style:{flex:"1 1 auto",minWidth:0,display:"flex",alignItems:"center",gap:2},children:[(0,r.jsx)("button",{type:"button",className:"pi-enh-composer-add-btn","data-pi-composer-add":!0,title:"添加或切换模式","aria-label":"添加或切换模式",style:{width:28,minWidth:28,height:28,padding:0,margin:0,borderRadius:8,border:"1px solid transparent",background:"none",color:"var(--text-muted)",cursor:"pointer",display:"inline-flex",alignItems:"center",justifyContent:"center",flexShrink:0},children:(0,r.jsxs)("svg",{width:"15",height:"15",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"1.8",strokeLinecap:"round",strokeLinejoin:"round",children:[(0,r.jsx)("line",{x1:"12",y1:"5",x2:"12",y2:"19"}),(0,r.jsx)("line",{x1:"5",y1:"12",x2:"19",y2:"12"})]})}),(0,r.jsx)("button",{"data-pi-attach-image":!0,onClick:()=>eX.current?.click(),title:Q("chat.attachImage"),"aria-label":Q("chat.attachImage"),style:{flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",width:32,height:32,padding:0,background:"none",border:"none",borderRadius:9,color:ec.length?"var(--accent)":"var(--text-muted)",cursor:"pointer",opacity:1,transition:"background 0.12s, color 0.12s"},onMouseEnter:e=>{e.currentTarget.style.background="var(--bg-hover)",e.currentTarget.style.color=ec.length?"var(--accent)":"var(--text)"},onMouseLeave:e=>{e.currentTarget.style.background="none",e.currentTarget.style.color=ec.length?"var(--accent)":"var(--text-muted)"},children:(0,r.jsxs)("svg",{width:"15",height:"15",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"1.8",strokeLinecap:"round",strokeLinejoin:"round",children:[(0,r.jsx)("rect",{x:"3",y:"3",width:"18",height:"18",rx:"2",ry:"2"}),(0,r.jsx)("circle",{cx:"8.5",cy:"8.5",r:"1.5"}),(0,r.jsx)("polyline",{points:"21 15 16 10 5 21"})]})}),(tN.length>0||a)&&g&&(0,r.jsx)(nj,{options:tN,value:a,onChange:g,disabled:!1,busy:f,isAutoSelection:d})]}),(0,r.jsx)("div",{className:"pi-enh-cursor-spacer",style:{flex:"0 0 auto",width:4}}),(0,r.jsxs)("div",{ref:eY,className:"pi-enh-cursor-right",style:{flex:"0 0 auto",display:"flex",alignItems:"center",justifyContent:"flex-end",position:"relative",gap:4},children:[l&&(0,r.jsxs)("button",{className:"pi-enh-cursor-stop",onClick:t,title:Q("chat.stopAgent"),style:{display:"flex",alignItems:"center",gap:6,padding:"8px 14px",height:32,background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:9,color:"#ef4444",cursor:"pointer",fontSize:12,fontWeight:600,whiteSpace:"nowrap",letterSpacing:"-0.01em",transition:"background 0.12s"},onMouseEnter:e=>{e.currentTarget.style.background="rgba(239,68,68,0.16)"},onMouseLeave:e=>{e.currentTarget.style.background="rgba(239,68,68,0.08)"},children:[(0,r.jsx)("svg",{width:"10",height:"10",viewBox:"0 0 10 10",fill:"none",children:(0,r.jsx)("rect",{x:"1.5",y:"1.5",width:"7",height:"7",rx:"1.5",fill:"currentColor"})}),Q("chat.stop")]}),S&&(0,r.jsxs)("div",{ref:eJ,"data-pi-thinking-control":!0,style:{position:"relative",flexShrink:0,display:"inline-flex",alignItems:"center"},children:[(0,r.jsxs)("button",{"data-pi-thinking-button":!0,onClick:()=>eo(e=>!e),disabled:!1,title:Q("chat.changeReasoning",{level:tP}),"aria-label":Q("chat.changeReasoningLabel"),style:{display:"flex",alignItems:"center",justifyContent:"center",gap:4,padding:ee?"0 6px":"6px 10px",height:32,background:ei?"var(--bg-hover)":"none",border:"none",borderRadius:9,color:"var(--text-muted)",cursor:"pointer",fontSize:12,opacity:1,whiteSpace:"nowrap",flexShrink:0,transition:"background 0.12s, color 0.12s"},onMouseEnter:e=>{e.currentTarget.style.background="var(--bg-hover)",e.currentTarget.style.color="var(--text)"},onMouseLeave:e=>{e.currentTarget.style.background=ei?"var(--bg-hover)":"none",e.currentTarget.style.color="var(--text-muted)"},children:[(0,r.jsxs)("svg",{width:"11",height:"11",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round",style:{flexShrink:0},children:[(0,r.jsx)("path",{d:"M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z"}),(0,r.jsx)("line",{x1:"7",y1:"18",x2:"12",y2:"18"}),(0,r.jsx)("line",{x1:"8",y1:"21",x2:"11",y2:"21"})]}),(0,r.jsx)("span",{style:{whiteSpace:"nowrap"},children:tP})]}),ei&&(0,r.jsx)("div",{style:{position:"absolute",bottom:"calc(100% + 6px)",right:0,zIndex:100,background:"var(--bg)",border:"1px solid var(--border)",borderRadius:8,boxShadow:"0 -4px 16px rgba(0,0,0,0.10)",overflow:"hidden",minWidth:180,maxWidth:"calc(100vw - 32px)"},children:(Array.isArray(E)&&E.length>0?E.filter(e=>e!=="auto"):["off","minimal","low","medium","high","xhigh","max"]).map(e=>{let t=((S??"auto")==="auto"?tP===e:S===e),n=Q(T?.[e]||e),i="auto"!==e&&T?T[e]:void 0,o=null!=i&&i!==e?i:e,l=null!=i&&i!==e;return(0,r.jsxs)("button",{onClick:()=>{eo(!1),t||(typeof C==="function"&&C(e))},style:{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"7px 12px",background:t?"var(--bg-selected)":"none",border:"none",color:t?"var(--text)":"var(--text-muted)",cursor:"pointer",fontSize:12,textAlign:"left",fontWeight:t?600:400,whiteSpace:"nowrap"},onMouseEnter:e=>{t||(e.currentTarget.style.background="var(--bg-hover)")},onMouseLeave:e=>{t||(e.currentTarget.style.background="none")},children:[t?(0,r.jsx)("svg",{width:"10",height:"10",viewBox:"0 0 10 10",fill:"none",stroke:"var(--accent)",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round",style:{flexShrink:0},children:(0,r.jsx)("polyline",{points:"1.5 5 4 7.5 8.5 2.5"})}):(0,r.jsx)("span",{style:{width:10,flexShrink:0}}),(0,r.jsxs)("span",{style:{flex:1},children:[o,l&&(0,r.jsxs)("span",{style:{fontSize:10,color:"var(--text-dim)",fontFamily:"var(--font-mono)",marginLeft:5},children:["(",e,")"]})]}),(0,r.jsx)("span",{style:{fontSize:11,color:"var(--text-dim)",marginLeft:8},children:n})]},e)})})]})]})]})/* PI_PATCH_DIRECT_TOOLBAR_END */`;
  } else {
    // Linux/default official build (page-d979ae06): mangled variables
    newBlock = `/* PI_PATCH_DIRECT_TOOLBAR */!U&&(0,r.jsxs)("div",{"data-pi-composer-toolbar":!0,className:"pi-enh-cursor-contents",style:{marginTop:8,display:"flex",alignItems:"center",justifyContent:"space-between",gap:4},children:[(0,r.jsxs)("div",{"data-pi-composer-left":!0,className:"pi-enh-cursor-left",style:{flex:"1 1 auto",minWidth:0,display:"flex",alignItems:"center",gap:2},children:[(0,r.jsx)("button",{type:"button",className:"pi-enh-composer-add-btn","data-pi-composer-add":!0,title:"添加或切换模式","aria-label":"添加或切换模式",style:{width:28,minWidth:28,height:28,padding:0,margin:0,borderRadius:8,border:"1px solid transparent",background:"none",color:"var(--text-muted)",cursor:"pointer",display:"inline-flex",alignItems:"center",justifyContent:"center",flexShrink:0},children:(0,r.jsxs)("svg",{width:"15",height:"15",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"1.8",strokeLinecap:"round",strokeLinejoin:"round",children:[(0,r.jsx)("line",{x1:"12",y1:"5",x2:"12",y2:"19"}),(0,r.jsx)("line",{x1:"5",y1:"12",x2:"19",y2:"12"})]})}),(0,r.jsx)("button",{"data-pi-attach-image":!0,onClick:()=>eG.current?.click(),title:X("chat.attachImage"),"aria-label":X("chat.attachImage"),style:{flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",width:32,height:32,padding:0,background:"none",border:"none",borderRadius:9,color:ed.length?"var(--accent)":"var(--text-muted)",cursor:"pointer",opacity:1,transition:"background 0.12s, color 0.12s"},onMouseEnter:e=>{e.currentTarget.style.background="var(--bg-hover)",e.currentTarget.style.color=ed.length?"var(--accent)":"var(--text)"},onMouseLeave:e=>{e.currentTarget.style.background="none",e.currentTarget.style.color=ed.length?"var(--accent)":"var(--text-muted)"},children:(0,r.jsxs)("svg",{width:"15",height:"15",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"1.8",strokeLinecap:"round",strokeLinejoin:"round",children:[(0,r.jsx)("rect",{x:"3",y:"3",width:"18",height:"18",rx:"2",ry:"2"}),(0,r.jsx)("circle",{cx:"8.5",cy:"8.5",r:"1.5"}),(0,r.jsx)("polyline",{points:"21 15 16 10 5 21"})]})}),(t$.length>0||s||u)&&h&&(0,r.jsx)(nb,{options:t$,value:s,onChange:h,disabled:!1,busy:g,isAutoSelection:a})]}),(0,r.jsx)("div",{className:"pi-enh-cursor-spacer",style:{flex:"0 0 auto",width:4}}),(0,r.jsxs)("div",{ref:eY,className:"pi-enh-cursor-right",style:{flex:"0 0 auto",display:"flex",alignItems:"center",justifyContent:"flex-end",position:"relative",gap:4},children:[l&&(0,r.jsxs)("button",{className:"pi-enh-cursor-stop",onClick:t,title:X("chat.stopAgent"),style:{display:"flex",alignItems:"center",gap:6,padding:"8px 14px",height:32,background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:9,color:"#ef4444",cursor:"pointer",fontSize:12,fontWeight:600,whiteSpace:"nowrap",letterSpacing:"-0.01em",transition:"background 0.12s"},onMouseEnter:e=>{e.currentTarget.style.background="rgba(239,68,68,0.16)"},onMouseLeave:e=>{e.currentTarget.style.background="rgba(239,68,68,0.08)"},children:[(0,r.jsx)("svg",{width:"10",height:"10",viewBox:"0 0 10 10",fill:"none",children:(0,r.jsx)("rect",{x:"1.5",y:"1.5",width:"7",height:"7",rx:"1.5",fill:"currentColor"})}),X("chat.stop")]}),S&&(0,r.jsxs)("div",{ref:eJ,"data-pi-thinking-control":!0,style:{position:"relative",flexShrink:0,display:"inline-flex",alignItems:"center"},children:[(0,r.jsxs)("button",{"data-pi-thinking-button":!0,onClick:()=>el(e=>!e),disabled:!1,title:X("chat.changeReasoning",{level:tz}),"aria-label":X("chat.changeReasoningLabel"),style:{display:"flex",alignItems:"center",justifyContent:"center",gap:4,padding:ee?"0 6px":"6px 10px",height:32,background:eo?"var(--bg-hover)":"none",border:"none",borderRadius:9,color:"var(--text-muted)",cursor:"pointer",fontSize:12,opacity:1,whiteSpace:"nowrap",flexShrink:0,transition:"background 0.12s, color 0.12s"},onMouseEnter:e=>{e.currentTarget.style.background="var(--bg-hover)",e.currentTarget.style.color="var(--text)"},onMouseLeave:e=>{e.currentTarget.style.background=eo?"var(--bg-hover)":"none",e.currentTarget.style.color="var(--text-muted)"},children:[(0,r.jsxs)("svg",{width:"11",height:"11",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round",style:{flexShrink:0},children:[(0,r.jsx)("path",{d:"M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z"}),(0,r.jsx)("line",{x1:"7",y1:"18",x2:"12",y2:"18"}),(0,r.jsx)("line",{x1:"8",y1:"21",x2:"11",y2:"21"})]}),(0,r.jsx)("span",{style:{whiteSpace:"nowrap"},children:tz})]}),eo&&(0,r.jsx)("div",{style:{position:"absolute",bottom:"calc(100% + 6px)",right:0,zIndex:100,background:"var(--bg)",border:"1px solid var(--border)",borderRadius:8,boxShadow:"0 -4px 16px rgba(0,0,0,0.10)",overflow:"hidden",minWidth:180,maxWidth:"calc(100vw - 32px)"},children:nT.filter(e=>e!=="auto"&&(!C||C.includes(e))).map(e=>{let t=((k??"auto")==="auto"?tz===e:k===e),n=X(nE[e]),i="auto"!==e&&M?M[e]:void 0,o=null!=i&&i!==e?i:e,l=null!=i&&i!==e;return(0,r.jsxs)("button",{onClick:()=>{el(!1),t||S(e)},style:{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"7px 12px",background:t?"var(--bg-selected)":"none",border:"none",color:t?"var(--text)":"var(--text-muted)",cursor:"pointer",fontSize:12,textAlign:"left",fontWeight:t?600:400,whiteSpace:"nowrap"},onMouseEnter:e=>{t||(e.currentTarget.style.background="var(--bg-hover)")},onMouseLeave:e=>{t||(e.currentTarget.style.background="none")},children:[t?(0,r.jsx)("svg",{width:"10",height:"10",viewBox:"0 0 10 10",fill:"none",stroke:"var(--accent)",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round",style:{flexShrink:0},children:(0,r.jsx)("polyline",{points:"1.5 5 4 7.5 8.5 2.5"})}):(0,r.jsx)("span",{style:{width:10,flexShrink:0}}),(0,r.jsxs)("span",{style:{flex:1},children:[o,l&&(0,r.jsxs)("span",{style:{fontSize:10,color:"var(--text-dim)",fontFamily:"var(--font-mono)",marginLeft:5},children:["(",e,")"]})]}),(0,r.jsx)("span",{style:{fontSize:11,color:"var(--text-dim)",marginLeft:8},children:n})]},e)})})]})]})]})/* PI_PATCH_DIRECT_TOOLBAR_END */`;
  }

  const existingBlock = content.slice(s_idx, end_idx);
  if (existingBlock === newBlock) return content;

  return content.slice(0, s_idx) + newBlock + content.slice(end_idx);
}

function patchSidebarBottomShortcuts(content) {
  if (typeof content !== "string" || !content) return content;
  if (content.includes("/* PI_PATCH_SIDEBAR_SHORTCUTS */")) return content;

  const targetStr = '{style:{padding:"8px",flexShrink:0,display:"flex",justifyContent:"space-between",gap:4},children:[[["models"';
  const idx = content.indexOf(targetStr);
  if (idx === -1) return content;

  const sub = content.slice(idx, idx + 400);
  const setterMatch = sub.match(/onClick:\(\)=>([a-zA-Z0-9_$]+)\(e\)/);
  const setterName = setterMatch ? setterMatch[1] : "ew";

  const replacement = `{/* PI_PATCH_SIDEBAR_SHORTCUTS */"data-pi-enh-shortcuts-host":!0,ref:e=>{if(e&&typeof window!=="undefined"){window.__PI_OPEN_SETTINGS__=${setterName}}},style:{padding:"8px",flexShrink:0,display:"flex",justifyContent:"space-between",gap:4},children:[[["models"`;

  return content.slice(0, idx) + replacement + content.slice(idx + targetStr.length);
}

function patchMarkdownFileImageSupport(content) {
  if (typeof content !== "string" || !content) return content;
  let next = content;

  // 1. Allow "file" protocol in rehype-sanitize protocols.src (so <img src="file:///..."> is not stripped before custom img component)
  next = next.replace(
    /protocols:\{\.\.\.([a-zA-Z0-9_$.]+)\.protocols,href:\[\.\.\.\1\.protocols\?\.href\?\?\[\],"file"\]\}/g,
    'protocols:{...$1.protocols,href:[...$1.protocols?.href??[],"file"],src:[...$1.protocols?.src??[],"file"]}'
  );

  // 2. Always enable file: protocol pass-through in react-markdown urlTransform
  next = next.replace(
    /urlTransform:([a-zA-Z0-9_$]+)\?([a-zA-Z0-9_$]+):void 0/g,
    "urlTransform:$2"
  );

  // 3. Append sessionId query param to /api/files/...?type=read in Markdown img renderer
  next = next.replace(
    /\?`\/api\/files\/\$\{([a-zA-Z0-9_$]+)\(([a-zA-Z0-9_$]+)\)\}\?type=read`/g,
    '?`/api/files/${$1($2)}?type=read${typeof window!=="undefined"&&window.location?.search?(()=>{const _s=new URLSearchParams(window.location.search).get("session");return _s?`&sessionId=${encodeURIComponent(_s)}`:""})():""}`'
  );

  return next;
}

function patchSessionStateRoute(pkgDir) {
  const stateRoute = path.join(
    pkgDir,
    ".next",
    "server",
    "app",
    "api",
    "sessions",
    "[id]",
    "state",
    "route.js",
  );
  if (!fs.existsSync(stateRoute)) return false;

  let content = fs.readFileSync(stateRoute, "utf8");
  const liveMetricsCall = /let tm=calcTurnMetrics\(b\.sessionFile\|\|getSFile\(c\)\);return e\.NextResponse\.json\(\{running:!0,state:\{\.\.\.b,turnMetrics:tm\}\}\)/;
  const idleMetricsCall = /let tm=calcTurnMetrics\(getSFile\(c\)\);return e\.NextResponse\.json\(\{running:!1,state:\{turnMetrics:tm\}\}\)/;
  const withoutLiveMetrics = "return e.NextResponse.json({running:!0,state:b})";
  const withoutIdleMetrics = "return e.NextResponse.json({running:!1})";
  const patched = content
    .replace(liveMetricsCall, withoutLiveMetrics)
    .replace(idleMetricsCall, withoutIdleMetrics);
  if (patched === content) return false;

  safeWriteFileSync(stateRoute, patched, "utf8");
  return true;
}

function patchOpenAIResponsesReasoningFile(targetFile) {
  if (!fs.existsSync(targetFile)) return false;
  let content = fs.readFileSync(targetFile, "utf8");
  if (content.includes("[PATCH] Codex single reasoning block reuse")) return false;

  const oldCreateSlot = `        if (item.type === "reasoning") {
            const block = { type: "thinking", thinking: "" };
            output.content.push(block);
            const slot = {
                type: "thinking",
                block,
                contentIndex: output.content.length - 1,
            };
            outputSlots.set(outputIndex, slot);
            stream.push({ type: "thinking_start", contentIndex: slot.contentIndex, partial: output });
            return slot;
        }`;

  const newCreateSlot = `        if (item.type === "reasoning") {
            // [PATCH] Codex single reasoning block reuse: prevent thousands of empty thinking blocks
            const lastBlock = output.content[output.content.length - 1];
            if (lastBlock && lastBlock.type === "thinking") {
                const slot = {
                    type: "thinking",
                    block: lastBlock,
                    contentIndex: output.content.length - 1,
                };
                outputSlots.set(outputIndex, slot);
                return slot;
            }
            const block = { type: "thinking", thinking: "" };
            output.content.push(block);
            const slot = {
                type: "thinking",
                block,
                contentIndex: output.content.length - 1,
            };
            outputSlots.set(outputIndex, slot);
            stream.push({ type: "thinking_start", contentIndex: slot.contentIndex, partial: output });
            return slot;
        }`;

  const oldDoneSlot = `            if (item.type === "reasoning" && slot?.type === "thinking") {
                const summaryText = item.summary?.map((s) => s.text).join("\\n\\n") || "";
                const contentText = item.content?.map((c) => c.text).join("\\n\\n") || "";
                slot.block.thinking = summaryText || contentText || slot.block.thinking;
                slot.block.thinkingSignature = JSON.stringify(item);
                reasoningBlocksById.set(item.id, slot.block);
                stream.push({
                    type: "thinking_end",
                    contentIndex: slot.contentIndex,
                    content: slot.block.thinking,
                    partial: output,
                });
                outputSlots.delete(event.output_index);
            }`;

  const newDoneSlot = `            if (item.type === "reasoning" && slot?.type === "thinking") {
                const summaryText = item.summary?.map((s) => s.text).join("\\n\\n") || "";
                const contentText = item.content?.map((c) => c.text).join("\\n\\n") || "";
                const newChunk = summaryText || contentText || "";
                if (newChunk) {
                    slot.block.thinking = slot.block.thinking ? (slot.block.thinking + "\\n\\n" + newChunk) : newChunk;
                }
                slot.block.thinkingSignature = JSON.stringify(item);
                reasoningBlocksById.set(item.id, slot.block);
                stream.push({
                    type: "thinking_end",
                    contentIndex: slot.contentIndex,
                    content: slot.block.thinking,
                    partial: output,
                });
                outputSlots.delete(event.output_index);
            }`;

  let patched = content;
  if (patched.includes(oldCreateSlot)) {
    patched = patched.replace(oldCreateSlot, newCreateSlot);
  }
  if (patched.includes(oldDoneSlot)) {
    patched = patched.replace(oldDoneSlot, newDoneSlot);
  }

  if (patched !== content) {
    safeWriteFileSync(targetFile, patched, "utf8");
    console.log("[patch-pi-web] Patched single reasoning block reuse in:", targetFile);
    return true;
  }
  return false;
}

function patchAllOpenAIResponsesReasoning(pkgDir) {
  const candidates = [
    path.join(pkgDir, "node_modules", "@earendil-works", "pi-ai", "dist", "api", "openai-responses-shared.js"),
    path.join(pkgDir, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "api", "openai-responses-shared.js"),
    path.join(home, "AppData", "Roaming", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "api", "openai-responses-shared.js"),
  ];
  for (const c of candidates) {
    try { patchOpenAIResponsesReasoningFile(c); } catch (e) {}
  }
}

const STANDALONE_EDITION = "koxir-standalone";
const STANDALONE_BASE_VERSION = "1.0.0";

function resolveOfficialPiAgentVersion(pkgDir) {
  const candidates = [
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json",
    path.join(home, "AppData", "Roaming", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    pkgDir ? path.join(pkgDir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json") : null,
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        const v = JSON.parse(fs.readFileSync(c, "utf8")).version;
        if (v) return String(v);
      }
    } catch (_) {}
  }
  return "0.87.1";
}

function patchWebAndOfficialPiVersionStrings(content, webVer, piVer) {
  if (typeof content !== "string" || !content) return content;
  return content
    .replace(
      /(children:\["web ",\([^)]+\)\("span",\{style:\{color:"var\(--text\)"\},children:\["v",")[0-9]+\.[0-9]+\.[0-9]+("\]\}\)\])/g,
      `$1${webVer}$2`
    )
    .replace(
      /(children:\["pi ",\([^)]+\)\("span",\{style:\{color:"var\(--text\)"\},children:\["v",")[0-9]+\.[0-9]+\.[0-9]+("\]\}\)\])/g,
      `$1${piVer}$2`
    )
    .replace(/"[0-9]+\.[0-9]+\.[0-9]+p[0-9]+\.[0-9]+\.[0-9]+"/g, `"${webVer}p${piVer}"`);
}

const LAYOUT_ENHANCEMENTS_START_MARKER_RE = /\n;\/\* PI_WEB_ENHANCEMENTS_START(?: [^*]*)? \*\//;
const LAYOUT_ENHANCEMENTS_INLINE_BUNDLE_MARKER = "\n;/* PI_WEB_ENHANCEMENTS_INLINE_BUNDLE */\n";

function replaceBoundedLayoutInlineTail(content, { loaderCode, validatedBundledEnhancement } = {}) {
  if (typeof content !== "string" || !content) {
    return { ok: false, reason: "empty-layout-content", content };
  }
  if (
    typeof loaderCode !== "string" ||
    !loaderCode ||
    typeof validatedBundledEnhancement !== "string" ||
    !validatedBundledEnhancement
  ) {
    return { ok: false, reason: "unvalidated-enhancement-bundle", content };
  }
  const markerMatch = LAYOUT_ENHANCEMENTS_START_MARKER_RE.exec(content);
  if (!markerMatch) {
    return { ok: false, reason: "missing-start-marker", content };
  }
  const prefix = content.slice(0, markerMatch.index);
  const markerToken = markerMatch[0];
  const nextTail = "\n" + loaderCode + LAYOUT_ENHANCEMENTS_INLINE_BUNDLE_MARKER + validatedBundledEnhancement;
  const nextContent = prefix + markerToken + nextTail;

  if (nextContent.slice(0, markerMatch.index) !== prefix) {
    return { ok: false, reason: "prefix-integrity-check-failed", content };
  }
  try {
    new (require("node:vm").Script)(nextContent, { filename: "layout-bounded-inline.js" });
  } catch (syntaxErr) {
    return {
      ok: false,
      reason: "layout-syntax-invalid",
      error: syntaxErr,
      content,
    };
  }
  return {
    ok: true,
    changed: nextContent !== content,
    prefix,
    marker: markerToken,
    content: nextContent,
  };
}

function atomicWriteValidatedFileSync(filePath, content, encoding = "utf8") {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, encoding);
    if (existing === content) return false;
  }
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, encoding);
    const verifyWritten = fs.readFileSync(tmpPath, encoding);
    if (verifyWritten !== content) {
      throw new Error(`Atomic write verification mismatch for ${filePath}`);
    }
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_) {}
    throw err;
  }
}

function syncBoundedLayoutInlineChunks(pkgDir, { loaderCode, validatedBundledEnhancement } = {}) {
  const chunksDir = path.join(pkgDir, ".next", "static", "chunks", "app");
  if (!fs.existsSync(chunksDir)) {
    return { updated: [], unchanged: [], rejected: [], reason: "chunks-dir-missing" };
  }
  const layoutFiles = fs
    .readdirSync(chunksDir)
    .filter((file) => file.startsWith("layout-") && file.endsWith(".js"))
    .sort();
  if (layoutFiles.length === 0) {
    return { updated: [], unchanged: [], rejected: [], reason: "no-layout-chunks" };
  }
  if (!validatedBundledEnhancement || !loaderCode) {
    console.warn(
      `[patch-pi-web] Fail-closed: refusing to update layout inline bundle in ${chunksDir} without validated enhancement bundle`
    );
    return {
      updated: [],
      unchanged: [],
      rejected: layoutFiles.map((file) => ({
        path: path.join(chunksDir, file),
        reason: "unvalidated-enhancement-bundle",
      })),
      reason: "unvalidated-enhancement-bundle",
    };
  }

  const updated = [];
  const unchanged = [];
  const rejected = [];
  for (const file of layoutFiles) {
    const layoutPath = path.join(chunksDir, file);
    const currentContent = fs.readFileSync(layoutPath, "utf8");
    const replaced = replaceBoundedLayoutInlineTail(currentContent, {
      loaderCode,
      validatedBundledEnhancement,
    });
    if (!replaced.ok) {
      console.warn(
        `[patch-pi-web] Fail-closed: refusing to modify ${layoutPath} (${replaced.reason})`
      );
      rejected.push({ path: layoutPath, reason: replaced.reason });
      continue;
    }
    if (!replaced.changed) {
      unchanged.push(layoutPath);
      continue;
    }
    atomicWriteValidatedFileSync(layoutPath, replaced.content, "utf8");
    updated.push(layoutPath);
  }
  return { updated, unchanged, rejected };
}

const NATIVE_TITLE_HEAD_OBSERVER_SOURCE_V3 =
  '(0,i.useEffect)(()=>{let e=()=>{document.title!==nP&&(document.title=nP)};e();let t=new MutationObserver(e);return t.observe(document.head,{childList:!0,subtree:!0,characterData:!0}),()=>t.disconnect()},[nP])';
const NATIVE_TITLE_SINGLE_OWNER_TARGET_V3 =
  '(0,i.useEffect)(()=>{document.title!==nP&&(document.title=nP)},[nP])';

function applyNativeTitleSingleOwnerBridge(content) {
  if (typeof content !== "string" || !content) return { content, modified: false };
  if (!content.includes(NATIVE_TITLE_HEAD_OBSERVER_SOURCE_V3)) {
    return { content, modified: false };
  }
  return {
    content: content.replace(NATIVE_TITLE_HEAD_OBSERVER_SOURCE_V3, NATIVE_TITLE_SINGLE_OWNER_TARGET_V3),
    modified: true,
  };
}

function applyPortablePageBridgesV3(content) {
  if (typeof content !== "string" || !content) return { content, modified: false };
  let modified = false;

  const titleBridge = applyNativeTitleSingleOwnerBridge(content);
  if (titleBridge.modified) {
    content = titleBridge.content;
    modified = true;
  }

  const minimapHistoryBridgeSourceV3 = 'nu=(0,i.useCallback)(()=>{tP(e=>Math.max(e,2*et.length))},[et.length]),np=';
  const legacyMinimapHistoryBridgeTargetV3 = 'nu=(0,i.useCallback)(()=>{tP(e=>Math.max(e,2*et.length))},[et.length]);window.__PI_ENH_GET_HISTORY_STATE__=()=>({sessionId:e?.id??e5.current??null,totalTurns:eN?.userMessages??0,hasEarlierMessages:!!eo,entryIds:er,oldestEntryId:ei});window.__PI_ENH_LOAD_EARLIER__=async a=>{if(tV.current||!eo||!ei)return!1;let n=e?.id??e5.current;if(!n)return!1;let r=Number(a),o=Number.isFinite(r)?Math.max(50,Math.min(500,Math.round(r))):250;tV.current=!0;let l=e6.current;l&&(tK.current=l.scrollHeight-l.scrollTop);try{return!!await tf(n,tx,ei,{tail:o})}finally{tV.current=!1}};let np=';
  const minimapHistoryBridgeTargetV3 = 'nu=(0,i.useCallback)(()=>{tP(e=>Math.max(e,2*et.length))},[et.length]);(0,i.useEffect)(()=>{tP(e=>Math.max(e,2*et.length+100))},[et.length]);window.__PI_ENH_GET_HISTORY_STATE__=()=>({sessionId:e?.id??e5.current??null,totalTurns:eN?.userMessages??0,hasEarlierMessages:Boolean(eo||(tO?.current>0)),hasRemoteEarlier:!!eo,hasLocalEarlier:Boolean(tO?.current>0),localEarlierCount:tO?.current||0,entryIds:er,oldestEntryId:ei});window.__PI_ENH_LOAD_EARLIER__=async a=>{if(tV.current)return!1;let s=Boolean(tO?.current>0);if(s){tP(e=>Math.max(e,2*et.length+100));if(!eo||!ei)return!0}if(!eo||!ei)return!1;let n=e?.id??e5.current;if(!n)return!1;let r=Number(a),o=Number.isFinite(r)?Math.max(50,Math.min(500,Math.round(r))):250;tV.current=!0;let l=e6.current;l&&(tK.current=l.scrollHeight-l.scrollTop);try{let res=await tf(n,tx,ei,{tail:o});if(res)tP(e=>Math.max(e,2*et.length+100));return Boolean(res||s)}finally{tV.current=!1}};let np=';
  if (content.includes(legacyMinimapHistoryBridgeTargetV3)) {
    content = content.replace(legacyMinimapHistoryBridgeTargetV3, minimapHistoryBridgeTargetV3);
    modified = true;
  } else if (content.includes(minimapHistoryBridgeSourceV3)) {
    content = content.replace(minimapHistoryBridgeSourceV3, minimapHistoryBridgeTargetV3);
    modified = true;
  }

  const sessionRefreshSuffixV3 = 'finally{r===W.current&&P(!1)}},[]),tw=(0,i.useRef)(!1);';
  const sessionRefreshHookV3 = 'finally{r===W.current&&P(!1)}},[]),tw=(window.__PI_ENH_REFRESH_SESSIONS__=(e=!1,t=!1)=>tb(e,t),window.__PI_ENH_GET_RAW_SESSIONS__=()=>L,window.__PI_ENH_RERENDER_SESSIONS__=()=>{try{$(prev=>Array.isArray(prev)?[...prev]:prev)}catch(e){}},window.__PI_ENH_SESSION_DELETED__=e=>{try{p?.(e)}catch{}},window.__PI_ENH_SET_UNREAD_SESSION__=(sId,isU)=>{try{e8(prev=>{let next=new Set(prev);if(isU)next.add(sId);else next.delete(sId);return next;})}catch(e){}},window.__PI_ENH_IS_SESSION_UNREAD__=(sId)=>Boolean(e4?.has?.(sId)),(0,i.useRef)(!1));';
  if (content.includes(sessionRefreshSuffixV3)) {
    content = content.replace(sessionRefreshSuffixV3, sessionRefreshHookV3);
    modified = true;
  }

  const sessionListHeadersSourceV3 = 'tY.length>0&&(0,r.jsx)("div",{style:{position:"relative",height:54*tY.length+(window.__PI_ENH_GET_SESSION_HEADERS_HEIGHT__?.(tY)||0)},children:tZ.map(t=>{let n=tY[t],i=[n.root,...n.subagents],o=n.latestModified===n.root.modified?n.root:{...n.root,modified:n.latestModified};return(0,r.jsx)("div",{onFocus:()=>tf(n.root.id),onBlur:()=>tf(null),style:{position:"absolute",top:window.__PI_ENH_GET_SESSION_ITEM_TOP__?.(t,tY)??54*t,left:0,right:0},children:(0,r.jsx)(ec,{session:o,isSelected:i.some(t=>t.id===e),isRunning:i.some(e=>e1.has(e.id)),isUnread:i.some(e=>e4.has(e.id)),onClick:()=>tP(n.root),onRenamed:tb,onDeleted:e=>{p?.(e),tb()}})},n.root.id)})})';
  const sessionListHeadersTargetV3 = 'tY.length>0&&(0,r.jsx)("div",{style:{position:"relative",height:54*tY.length+(window.__PI_ENH_GET_SESSION_HEADERS_HEIGHT__?.(tY)||0)},children:[...(window.__PI_ENH_GET_SESSION_HEADERS__?.(r,tY)||[]),...tZ.map(t=>{let n=tY[t],i=[n.root,...n.subagents],o=n.latestModified===n.root.modified?n.root:{...n.root,modified:n.latestModified};return(0,r.jsx)("div",{onFocus:()=>tf(n.root.id),onBlur:()=>tf(null),style:{position:"absolute",top:window.__PI_ENH_GET_SESSION_ITEM_TOP__?.(t,tY)??54*t,left:0,right:0},children:(0,r.jsx)(ec,{session:o,isSelected:i.some(t=>t.id===e),isRunning:i.some(e=>e1.has(e.id)),isUnread:i.some(e=>e4.has(e.id)),onClick:()=>tP(n.root),onRenamed:tb,onDeleted:e=>{p?.(e),tb()}})},n.root.id)})]})';
  if (content.includes(sessionListHeadersSourceV3)) {
    content = content.replace(sessionListHeadersSourceV3, sessionListHeadersTargetV3);
    modified = true;
  }

  const sessionReloadBridgeSourceV3 = 'finally{c()&&t&&!i&&b(!1)}})();return t$.current.set(d,g),g.finally(()=>{t$.current.get(d)===g&&t$.current.delete(d)}),await g},[tF,tV]),tX=';
  const sessionReloadBridgeTargetV3 = 'finally{c()&&t&&!i&&b(!1)}})();return t$.current.set(d,g),g.finally(()=>{t$.current.get(d)===g&&t$.current.delete(d)}),await g},[tF,tV]),tp_enh_reload=(typeof window!=="undefined"?(window.__PI_WEB_RELOAD_SESSION__=(...args)=>tG(...args),window.__PI_WEB_NATIVE_RELOAD_CURRENT_SESSION__=(t=!1)=>{let s=tr.current;if(s)return tG(s,t,!0,{force:!0})},window.__PI_ENH_RELOAD_CURRENT_SESSION__||(window.__PI_ENH_RELOAD_CURRENT_SESSION__=(t=!1)=>{let s=tr.current;if(s)return tG(s,t,!0,{force:!0})}),null):null),tX=';
  if (content.includes(sessionReloadBridgeSourceV3)) {
    content = content.replace(sessionReloadBridgeSourceV3, sessionReloadBridgeTargetV3);
    modified = true;
  }

  const nativeSessionActions = 'x&&!e.transient&&(0,r.jsxs)("div",{style:{display:"flex",gap:4,flexShrink:0},children:';
  const namedNativeSessionActions = '!e.transient&&(0,r.jsxs)("div",{className:"pi-enh-native-session-actions",style:{display:"flex",gap:4,flexShrink:0},children:';
  if (content.includes(nativeSessionActions)) {
    content = content.replace(nativeSessionActions, namedNativeSessionActions);
    modified = true;
  }

  return { content, modified };
}

function patchPublicServiceWorker(pkgDir, assetBuild) {
  const swPath = path.join(pkgDir, "public", "sw.js");
  if (!fs.existsSync(swPath)) return false;

  let sw = fs.readFileSync(swPath, "utf8");
  let swMod = false;

  if (sw.includes("&& key !== STATIC_CACHE")) {
    sw = sw.replace("&& key !== STATIC_CACHE", "");
    swMod = true;
  }

  // 1. 静态重载补丁标记与 cache: "reload"
  if (!sw.includes("/* PI_PATCH_SW_STATIC_RELOAD */")) {
    const oldCacheFirst = `async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetchWithTimeout(request, ASSET_TIMEOUT_MS);
  if (response.ok && response.type === "basic") {
    const cache = await caches.open(STATIC_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}`;
    const newCacheFirst = `/* PI_PATCH_SW_STATIC_RELOAD */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  // Uncached or updated build: use cache: "reload" to pierce browser HTTP immutable disk cache
  const reloadRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    mode: request.mode === "navigate" ? "same-origin" : request.mode,
    credentials: request.credentials,
    redirect: request.redirect,
    cache: "reload",
  });
  const response = await fetchWithTimeout(reloadRequest, ASSET_TIMEOUT_MS);
  if (response.ok && response.type === "basic") {
    const cache = await caches.open(STATIC_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}`;
    if (sw.includes(oldCacheFirst)) {
      sw = sw.replace(oldCacheFirst, newCacheFirst);
      swMod = true;
    }
  }

  // 2. 绑定当前构建哈希到 STATIC_CACHE
  if (assetBuild) {
    const cacheVersionRegex = /const STATIC_CACHE = `\${CACHE_PREFIX}-static-\${CACHE_VERSION}[^`]*`;/;
    const targetCacheDef = `const STATIC_CACHE = \`\${CACHE_PREFIX}-static-\${CACHE_VERSION}-${assetBuild}\`;`;
    if (cacheVersionRegex.test(sw)) {
      const cur = sw.match(cacheVersionRegex)[0];
      if (cur !== targetCacheDef) {
        sw = sw.replace(cacheVersionRegex, targetCacheDef);
        swMod = true;
      }
    }
  }

  // 3. activate 事件清理旧版本缓存并在存在旧缓存时刷新受控窗口
  const oldActivate = `self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(\`\${CACHE_PREFIX}-\`) && key !== STATIC_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});`;
  const newActivate = `self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const staleKeys = keys.filter(
        (key) => key.startsWith(\`\${CACHE_PREFIX}-\`) && key !== STATIC_CACHE
      );
      const hadStaleCache = staleKeys.length > 0;
      await Promise.all(staleKeys.map((key) => caches.delete(key)));
      await self.clients.claim();
      if (hadStaleCache) {
        const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const client of windowClients) {
          try {
            if (typeof client.navigate === "function" && client.url) {
              await client.navigate(client.url);
            }
          } catch (_) {}
        }
      }
    })()
  );
});`;
  if (sw.includes(oldActivate)) {
    sw = sw.replace(oldActivate, newActivate);
    swMod = true;
  }

  // 4. // no-esc-patch 标记
  if (!sw.includes("// no-esc-patch")) {
    sw = "// no-esc-patch\n" + sw;
    swMod = true;
  }

  // 5. 保留 navigate 302 重定向
  if (!sw.includes("event.respondWith(Response.redirect(redirectUrl.href, 302))")) {
    const navSearch = 'if (request.mode === "navigate") {';
    const navPatch = `if (request.mode === "navigate") {
    const rawPath = url.pathname.replace(/^\\/+|\\/+$/g, "");
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawPath)) {
      const redirectUrl = new URL("/", self.location.origin);
      redirectUrl.search = url.search;
      redirectUrl.searchParams.set("session", rawPath);
      event.respondWith(Response.redirect(redirectUrl.href, 302));
      return;
    }`;
    if (sw.includes(navSearch)) {
      sw = sw.replace(navSearch, navPatch);
      swMod = true;
    }
  }

  if (swMod) {
    safeWriteFileSync(swPath, sw, "utf8");
    return true;
  }
  return false;
}

function syncPortablePageBridgeChunks(pkgDir) {
  const chunksDir = path.join(pkgDir, ".next", "static", "chunks", "app");
  if (!fs.existsSync(chunksDir)) return;
  for (const file of fs.readdirSync(chunksDir)) {
    if (file.startsWith("page-") && file.endsWith(".js")) {
      const fullPath = path.join(chunksDir, file);
      const currentContent = fs.readFileSync(fullPath, "utf8");
      const { content: nextContent, modified } = applyPortablePageBridgesV3(currentContent);
      if (modified && nextContent !== currentContent) {
        try {
          new (require("node:vm").Script)(nextContent, { filename: file });
          atomicWriteValidatedFileSync(fullPath, nextContent, "utf8");
        } catch (err) {
          console.warn(`[patch-pi-web] Refusing to write syntax-invalid page chunk ${fullPath}: ${err.message}`);
        }
      }
    }
  }
}

function isNativeSessionBridgePkg(pkgDir) {
  if (!pkgDir || typeof pkgDir !== "string") return false;
  const pkgJsonPath = path.join(pkgDir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    return Boolean(
      pkg &&
      pkg.standalone === true &&
      pkg.capabilities &&
      pkg.capabilities.nativeSessionBridge === true
    );
  } catch {
    return false;
  }
}

function verifyNativeReleaseGate(pkgDir) {
  const pkgJsonPath = path.join(pkgDir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  } catch (err) {
    throw new Error(`[patch-pi-web] [NATIVE GATE] Failed to parse package.json in ${pkgDir}: ${err.message}`);
  }

  const gateScript = path.join(pkgDir, "scripts", "verify-session-native-gate.cjs");
  if (!fs.existsSync(gateScript)) {
    throw new Error(
      `[patch-pi-web] [NATIVE GATE FAIL-CLOSED] Target ${pkgDir} declares nativeSessionBridge capability but is missing verification gate script (${gateScript}). Legacy patching refused.`
    );
  }

  try {
    const stdout = execFileSync(
      process.execPath,
      [gateScript, "--packed"],
      {
        cwd: pkgDir,
        timeout: 15000,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          NODE_ENV: "production",
        },
        encoding: "utf8",
      }
    );
    return {
      nativeReleaseProtected: true,
      legacyPatchSkipped: true,
      pkgDir,
      version: pkg.version,
      edition: pkg.piWebEdition,
      capabilities: pkg.capabilities,
      gateScript,
      verifiedAt: new Date().toISOString(),
      output: stdout ? stdout.trim() : "",
    };
  } catch (execErr) {
    const stderr = execErr.stderr ? String(execErr.stderr).trim() : "";
    const stdout = execErr.stdout ? String(execErr.stdout).trim() : "";
    const details = stderr || stdout || execErr.message;
    throw new Error(
      `[patch-pi-web] [NATIVE GATE FAIL-CLOSED] Native session verification gate failed for ${pkgDir} (exit code ${execErr.status ?? "unknown"}): ${details}. Legacy patching refused.`
    );
  }
}

function collectDefaultCandidates() {
  const candidates = [
    process.env.PI_WEB_DIR,
    path.join(home, "AppData", "Roaming", "npm", "node_modules", "@agegr", "pi-web"),
    "/usr/local/lib/node_modules/@agegr/pi-web",
    "/usr/lib/node_modules/@agegr/pi-web",
    path.join(home, ".workbuddy", "binaries", "node", "versions", "22.22.2-3", "lib", "node_modules", "@agegr", "pi-web"),
    "/opt/homebrew/lib/node_modules/@agegr/pi-web",
  ].filter(Boolean);

  const found = [];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      found.push(candidate);
    }
  }

  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const npxBase = path.join(localAppData, "npm-cache", "_npx");
  if (fs.existsSync(npxBase)) {
    try {
      for (const hashDir of fs.readdirSync(npxBase)) {
        const candidate = path.join(npxBase, hashDir, "node_modules", "@agegr", "pi-web");
        if (fs.existsSync(candidate)) {
          found.push(candidate);
        }
      }
    } catch {}
  }
  return [...new Set(found)];
}

function patchPackage(pkgDir, options = {}) {
  if (!pkgDir || !fs.existsSync(pkgDir)) return null;

  if (isNativeSessionBridgePkg(pkgDir)) {
    const gateResult = verifyNativeReleaseGate(pkgDir);
    console.log(
      `[patch-pi-web] [NATIVE GATE] ${pkgDir} (v${gateResult.version}) native session bridge verified; legacy patching skipped.`
    );
    return gateResult;
  }

  // 快照发布模式安全守卫：仅允许 staticOnly=true
  if (options.snapshotManifestPath) {
    if (options.staticOnly !== true) {
      const err = new Error("[patch-pi-web] 快照发布模式仅允许 staticOnly=true，禁止执行服务端修改或重启！");
      err.code = "SNAPSHOT_STATIC_ONLY_REQUIRED";
      throw err;
    }
  }

  let verifiedSnapshotRawSha = null;
  if (options.snapshotManifestPath && fs.existsSync(options.snapshotManifestPath)) {
    try {
      const snapM = JSON.parse(fs.readFileSync(options.snapshotManifestPath, "utf8"));
      verifiedSnapshotRawSha = snapM.bundleSha256 || snapM.rawSha256;
    } catch (_) {}
  }

  const lockCfg = resolvePatchLockConfig(options);
  return withGlobalBuildLock(
    {
      sessionId: options.sessionId,
      operationToken: options.operationToken,
      stateFile: lockCfg.stateFile,
      modulesDir: lockCfg.modulesDir,
      canonicalModulesDir: options.canonicalModulesDir,
      snapshotManifestPath: options.snapshotManifestPath,
      isPidAlive: options.isPidAlive,
      waitTimeoutMs: options.waitTimeoutMs,
      enforceUnlockedDiffCheck: lockCfg.enforceUnlockedDiffCheck,
      operation: options.operation || "patch-package",
    },
    ({ operationToken }) => {
      try {
        if (!fs.existsSync(pkgDir)) return;

        const explicitPublicOnly = options.publicOnly === true;
        const explicitSyncLayoutInline =
          options.syncLayoutInline === true || options.layoutInline === true;
        const isSnapshotStatic = Boolean(options.snapshotManifestPath && options.staticOnly === true);
        const allowBoundedLayoutInlineSync =
          (!explicitPublicOnly || isSnapshotStatic) &&
          (explicitSyncLayoutInline || options.staticOnly === true);
        if (explicitSyncLayoutInline && !options.staticOnly) {
          options = { ...options, publicOnly: true };
        }

    // 【Koxir Standalone Edition (1.0.0+) 自有独立发行版守卫与自动升级】
    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
        const isStandalonePkg = pkgJson.standalone === true || pkgJson.piWebEdition === STANDALONE_EDITION;
        const verStr = String(pkgJson.version || "");
        const releaseParts = verStr.split(".").map(Number);
        if (isStandalonePkg && releaseParts.length === 3 && releaseParts.every(Number.isInteger) &&
            (releaseParts[0] > 1 || (releaseParts[0] === 1 && (releaseParts[1] > 0 || releaseParts[2] >= 2)))) {
          // GitHub Release 1.0.2+ owns the server routes and compiled client chunks.
          // Legacy patching may only sync private public assets; never downgrade a release to 1.0.0.
          options = { ...options, publicOnly: true };
          console.log(
            `[patch-pi-web] Portable release ${verStr}: ${
              allowBoundedLayoutInlineSync ? "public assets + bounded layout inline sync" : "public assets only"
            }`
          );
        }
        const isUnauthorizedUpstream = !isStandalonePkg && verStr !== "0.9.1" && !verStr.startsWith("1.");
        if (isUnauthorizedUpstream) {
          console.error(`[patch-pi-web] [STANDALONE GUARD] 检测到 ${pkgDir} 被外部原版 (${verStr}) 覆盖！正在恢复为 Koxir Standalone ${STANDALONE_BASE_VERSION} 独立发行版...`);
          const goldenBackup = path.join(path.dirname(pkgDir), "pi-web-0.9.1-golden-backup");
          if (fs.existsSync(path.join(goldenBackup, "package.json"))) {
            for (const item of ["package.json", "next.config.ts", "bin", "public", ".next"]) {
              const s = path.join(goldenBackup, item);
              const d = path.join(pkgDir, item);
              if (fs.existsSync(s)) {
                if (item === ".next" && fs.existsSync(d)) {
                  fs.rmSync(d, { recursive: true, force: true });
                }
                fs.cpSync(s, d, { recursive: true, force: true });
              }
            }
            console.log(`[patch-pi-web] 已成功将 ${pkgDir} 恢复至 Koxir Standalone ${STANDALONE_BASE_VERSION} 独立版！`);
          }
        }
        const latestPkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
        const isSnapshotMode = Boolean(options.snapshotManifestPath || options.isCertifiedSnapshot);
        if (!isSnapshotMode) {
          const targetVer = (!latestPkgJson.version || latestPkgJson.version === "0.9.1" || latestPkgJson.version === "0.9.3")
            ? STANDALONE_BASE_VERSION
            : latestPkgJson.version;
          if (
            latestPkgJson.version !== targetVer ||
            latestPkgJson.piWebEdition !== STANDALONE_EDITION ||
            latestPkgJson.standalone !== true
          ) {
            latestPkgJson.version = targetVer;
            latestPkgJson.piWebEdition = STANDALONE_EDITION;
            latestPkgJson.standalone = true;
            safeWriteFileSync(pkgJsonPath, JSON.stringify(latestPkgJson, null, 2) + "\n", "utf8");
          }
        }
      } catch (verErr) {
        console.warn(`[patch-pi-web] 独立版版本校验警告: ${verErr.message}`);
      }
    }

    // Fail closed before changing any assets: code updates must never replace user-state archives.
    require(fs.existsSync(path.join(home, ".pi", "agent", "scripts", "pi-enhancement-state-archive.cjs")) ? path.join(home, ".pi", "agent", "scripts", "pi-enhancement-state-archive.cjs") : path.join(__dirname, "pi-enhancement-state-archive.cjs"))
      .archiveEnhancementState({ agentDir: path.join(home, ".pi", "agent"), reason: "before-plugin-update" });

    // Apply server-side usage delete guard route patch safely if pi-web is completely stopped.
    // Must be positioned before "if (staticOnly) return" so entrypoint --static-only can invoke it,
    // while options.publicOnly continues to bypass all server/route changes.
    if (!options.publicOnly) {
      try {
        const usageDeletePatch = require("./pi-usage-delete-patch.cjs");
        const patchRes = usageDeletePatch.applyIfStopped(pkgDir);
        if (patchRes.applied) {
          console.log(`[patch-pi-web] Applied usage delete guard route patch to ${pkgDir}`);
        }
      } catch (patchErr) {
        console.warn(`[patch-pi-web] Failed to evaluate usage delete guard route patch: ${patchErr.message}`);
      }

      try {
        const sessionSyncPatch = require("./pi-session-sync-patch.cjs");
        const patchRes = sessionSyncPatch.applyIfStopped(pkgDir);
        if (patchRes.applied) {
          console.log(`[patch-pi-web] Applied session sync route patch to ${pkgDir}`);
        }
      } catch (patchErr) {
        console.warn(`[patch-pi-web] Failed to evaluate session sync route patch: ${patchErr.message}`);
      }
    }

    const publicOnly = options.publicOnly === true;
    const staticOnly = options.staticOnly === true || publicOnly;
    const officialPiVersion = resolveOfficialPiAgentVersion(pkgDir);
    const installedWebVersion = (() => {
      try {
        const installed = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
        return installed.piWebEdition === STANDALONE_EDITION && /^1\.\d+\.\d+$/.test(installed.version)
          ? installed.version : STANDALONE_BASE_VERSION;
      } catch (_) { return STANDALONE_BASE_VERSION; }
    })();
    if (!staticOnly) patchAllOpenAIResponsesReasoning(pkgDir);

    // 按需单模块独立编辑与热构建联动：若 enhancements/modules/*.js 有改动，自动先合成 pi-web-enhancements.js (fail-closed)
    const homeBuilderPath = path.join(home, ".pi", "agent", "scripts", "build-pi-web-enhancements.cjs");
    const builderPath =
      options.builderPath ||
      (fs.existsSync(homeBuilderPath)
        ? homeBuilderPath
        : fs.existsSync(path.join(lockCfg.modulesDir, "manifest.json"))
          ? path.join(__dirname, "build-pi-web-enhancements.cjs")
          : homeBuilderPath);
    const shouldSkipBuilderSync = Boolean(lockCfg.skipBuilderSync);
    if (!shouldSkipBuilderSync) {
      if (fs.existsSync(builderPath)) {
        require(builderPath).ensureSynced({
          ...options,
          primaryBundlePath: options.primaryBundlePath || options.enhancementSource || ENHANCEMENT_SOURCE,
          mirrorBundlePath:
            options.mirrorBundlePath !== undefined
              ? options.mirrorBundlePath
              : lockCfg.modulesDir === "/root/.pi/agent/scripts/enhancements/modules"
                ? undefined
                : null,
          stateFile: lockCfg.stateFile,
          modulesDir: lockCfg.modulesDir,
          enforceUnlockedDiffCheck: true,
          operationToken,
        });
      } else if (lockCfg.hasModuleDiffs) {
        const err = new Error(
          `[patch-pi-web] Fail-closed: module modifications detected in ${lockCfg.modulesDir} but builder script not found at ${builderPath}`
        );
        err.code = "ENHANCEMENT_BUILDER_MISSING";
        throw err;
      }
    }

    let enhCode = "";
    let enhancementCandidatePath = null;
    let snapshotBundleCandidate = null;
    if (options.snapshotManifestPath) {
      const snapDir = path.dirname(options.snapshotManifestPath);
      const candidates = [
        path.join(snapDir, "pi-web-enhancements.js"),
        path.join(path.dirname(snapDir), "pi-web-enhancements.js"),
      ];
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          snapshotBundleCandidate = cand;
          break;
        }
      }
    }
    const enhancementCandidates = [
      options.enhancementSource,
      snapshotBundleCandidate,
      options.primaryBundlePath,
      ENHANCEMENT_SOURCE,
      path.join(pkgDir, "public", "pi-web-enhancements.js"),
      resolveScriptAssetPath("pi-web-enhancements.js", home),
    ].filter(Boolean);
    for (const candidatePath of enhancementCandidates) {
      if (fs.existsSync(candidatePath)) {
        enhCode = stripBundledEnhancementPreamble(fs.readFileSync(candidatePath, "utf8"));
        if (enhCode) {
          enhancementCandidatePath = candidatePath;
          break;
        }
      }
    }

    if (!enhCode) {
      const err = new Error("[patch-pi-web] Fail-closed: enhancement candidate bundle is missing; static patch refused.");
      err.code = "ENHANCEMENT_CANDIDATE_MISSING";
      throw err;
    }

    // 绑定 enhancementSource/raw 到认证 snapshot 严格相等（拒传不同 bundle）
    if (verifiedSnapshotRawSha) {
      const candidateRawSha = require("node:crypto").createHash("sha256").update(enhCode).digest("hex");
      if (candidateRawSha !== verifiedSnapshotRawSha) {
        const err = new Error(
          `[patch-pi-web] 拒绝发布不同 bundle：传入 bundle SHA (${candidateRawSha}) 与认证快照 SHA (${verifiedSnapshotRawSha}) 不一致！`
        );
        err.code = "SNAPSHOT_BUNDLE_MISMATCH";
        throw err;
      }
    }

    runSessionDeleteRegressionGate({
      modulesDir: options.modulesDir || lockCfg.modulesDir,
      candidateBundleText: enhCode,
      candidateBundlePath: enhancementCandidatePath,
      stateFile: lockCfg.stateFile,
      pkgDir,
      enforceUnlockedDiffCheck: options.enforceUnlockedDiffCheck,
      nonProductionFixture: options.nonProductionFixture,
      forceProduction: options.forceProduction,
      snapshotManifestPath: options.snapshotManifestPath,
      operation: "patch-candidate",
    });

    // A passive, bounded recorder loads before the app/enhancement runtime.
    const diagnosticsPath = options.diagnosticsPath || resolveScriptAssetPath("pi-web-crash-diagnostics.js", home);
    const diagnosticsCode = fs.existsSync(diagnosticsPath) ? fs.readFileSync(diagnosticsPath, "utf8") : "";
    const usageModules = ["usage-ledger-core.js", "pi-usage-panel.js"].map(file => {
      const source = resolveScriptAssetPath(file, home);
      return fs.existsSync(source) ? fs.readFileSync(source, "utf8") : "";
    }).join("\n;\n");
    const assetBuild = require("node:crypto").createHash("sha256").update(enhCode + diagnosticsCode + usageModules + officialPiVersion).digest("hex").slice(0, 16);
    const stateDir = path.join(home, ".pi", "agent", "state", "enhancement-state");
    const durableStateEnabled = ["journal.jsonl", "current.json"].some(file => fs.existsSync(path.join(stateDir, file)));
    const nativeStateApi = fs.existsSync(path.join(pkgDir, ".next", "server", "app", "api", "enhancement-state", "route.js"));
    const diagnosticBootstrap = `window.__PI_ENH_NATIVE_STATE_API__ = ${JSON.stringify(nativeStateApi)};\nwindow.__PI_ENH_DURABLE_STATE_ENABLED__ = ${JSON.stringify(durableStateEnabled)};\nwindow.__PI_OFFICIAL_AGENT_VERSION__ = ${JSON.stringify(officialPiVersion)};\nwindow.__PI_ENH_ASSET_BUILD__ = ${JSON.stringify(assetBuild)};\n${diagnosticsCode}\n`;

    // 1. Copy enhancements script to public/. Next's production server only
    // serves public files known at build time, so a newly added JSON manifest
    // can 404 even though the existing enhancement script remains available.
    // Bundle the canonical archive manifest into that served script instead.
    const publicDir = path.join(pkgDir, "public");
    const manifestSource = path.join(home, ".pi", "agent", "scripts", "pi-archived-manifest.json");
    const webmanifestSource = path.join(home, ".pi", "agent", "scripts", "manifest.webmanifest");
    if (fs.existsSync(publicDir) && fs.existsSync(webmanifestSource)) {
      const destWebmanifest = path.join(publicDir, "manifest.webmanifest");
      safeWriteFileSync(destWebmanifest, fs.readFileSync(webmanifestSource, "utf8"), "utf8");
    }
    let archivedManifest = [];
    if (fs.existsSync(manifestSource)) {
      try {
        const parsedManifest = JSON.parse(fs.readFileSync(manifestSource, "utf8"));
        if (Array.isArray(parsedManifest)) archivedManifest = parsedManifest;
      } catch (e) {}
    }

    const shortcutsSource = path.join(home, ".pi", "agent", "scripts", "pi-shortcuts-manifest.json");
    let shortcutsManifest = [
      { id: "enhancements", label: "增强插件" },
      { id: "archived", label: "已归档" },
      { id: "usage", label: "用量大盘" },
      { id: "settings", label: "设置" }
    ];
    if (fs.existsSync(shortcutsSource)) {
      try {
        const parsedShortcuts = JSON.parse(fs.readFileSync(shortcutsSource, "utf8"));
        if (Array.isArray(parsedShortcuts) && parsedShortcuts.length > 0) shortcutsManifest = parsedShortcuts;
      } catch (e) {}
    }

    const pinnedSource = path.join(home, ".pi", "agent", "scripts", "pi-pinned-manifest.json");
    let pinnedManifest = [];
    if (fs.existsSync(pinnedSource)) {
      try {
        const parsedPinned = JSON.parse(fs.readFileSync(pinnedSource, "utf8"));
        if (Array.isArray(parsedPinned)) pinnedManifest = parsedPinned;
        else if (parsedPinned && typeof parsedPinned === "object") {
          if (Array.isArray(parsedPinned.pinned)) pinnedManifest = parsedPinned.pinned;
          else if (Array.isArray(parsedPinned.sessions)) pinnedManifest = parsedPinned.sessions;
        }
      } catch (e) {}
    }

    let isUsageConfigured = false;
    let usageLedgerSource = path.join(home, ".pi", "agent", "scripts", "pi-usage-ledger.json");
    try {
      const { resolveUsageStorage } = require("./usage-storage-paths.cjs");
      const storage = resolveUsageStorage({ source: "nas" });
      if (storage.enabled && storage.globalLedgerFile) {
        usageLedgerSource = storage.globalLedgerFile;
        isUsageConfigured = true;
      }
    } catch (e) {
      if (process.env.PI_USAGE_DATA_DIR && process.env.PI_USAGE_DATA_DIR.trim()) {
        throw e;
      }
    }
    let usageLedger = null;
    if (fs.existsSync(usageLedgerSource)) {
      try {
        usageLedger = JSON.parse(fs.readFileSync(usageLedgerSource, "utf8"));
      } catch (e) {
        if (isUsageConfigured || (process.env.PI_USAGE_DATA_DIR && process.env.PI_USAGE_DATA_DIR.trim())) {
          throw new Error(`[patch-pi-web] Failed to parse global usage ledger JSON from '${usageLedgerSource}': ${e.message}`);
        }
      }
    }

    const odooAddonsSource = path.join(home, ".pi", "agent", "scripts", "pi-odoo-addons-manifest.json");
    let odooAddonsManifest = null;
    if (fs.existsSync(odooAddonsSource)) {
      try {
        odooAddonsManifest = JSON.parse(fs.readFileSync(odooAddonsSource, "utf8"));
      } catch (e) {}
    }

    const tagsSource = path.join(home, ".pi", "agent", "scripts", "pi-tags-manifest.json");
    let tagsManifest = null;
    if (fs.existsSync(tagsSource)) {
      try {
        tagsManifest = JSON.parse(fs.readFileSync(tagsSource, "utf8"));
      } catch (e) {}
    }
    // 兜底从 models.json 提取标签配置
    if (!tagsManifest || !Array.isArray(tagsManifest.definitions) || tagsManifest.definitions.length === 0) {
      const modelsJsonPath = path.join(home, ".pi", "agent", "models.json");
      if (fs.existsSync(modelsJsonPath)) {
        try {
          const modelsCfg = JSON.parse(fs.readFileSync(modelsJsonPath, "utf8"));
          if (Array.isArray(modelsCfg.sessionTagsDefinitions) && modelsCfg.sessionTagsDefinitions.length > 0) {
            tagsManifest = {
              definitions: modelsCfg.sessionTagsDefinitions,
              mappings: modelsCfg.sessionTagMappings || {},
              revision: Number(modelsCfg.sessionTagsRevision) || Date.now()
            };
            safeWriteFileSync(tagsSource, JSON.stringify(tagsManifest, null, 2), "utf8");
          }
        } catch (e) {}
      }
    }

    let validatedBundledEnhancement = "";
    if (
      enhCode &&
      enhCode.length >= 500000 &&
      enhCode.includes("window.__PI_WEB_ENHANCEMENTS_LOADED__") &&
      diagnosticsCode.includes("__PI_ENH_CRASH_DIAGNOSTICS__")
    ) {
      const manifestBootstrap = `window.__PI_ENH_ARCHIVED_MANIFEST__ = ${JSON.stringify(archivedManifest)};\nwindow.__PI_ENH_PINNED_MANIFEST__ = ${JSON.stringify(pinnedManifest)};\nwindow.__PI_ENH_SHORTCUTS_MANIFEST__ = ${JSON.stringify(shortcutsManifest)};\nwindow.__PI_ENH_USAGE_LEDGER__ = window.__PI_ENH_USAGE_LEDGER__ || null;\nwindow.__PI_ENH_ODOO_ADDONS_MANIFEST__ = ${JSON.stringify(odooAddonsManifest)};\nwindow.__PI_ENH_TAGS_MANIFEST__ = ${JSON.stringify(tagsManifest)};\n`;
      const bundledEnhancement = diagnosticBootstrap + manifestBootstrap + usageModules + "\n;\n" + enhCode;
      try {
        new (require("node:vm").Script)(bundledEnhancement, { filename: "pi-web-enhancements.bundle.js" });
        validatedBundledEnhancement = bundledEnhancement;
      } catch (vmErr) {
        console.warn(`[patch-pi-web] Refusing to deploy syntax-invalid enhancement bundle: ${vmErr.message}`);
      }
    }

    if (fs.existsSync(publicDir) && enhCode) {
      if (!validatedBundledEnhancement) {
        console.warn(`[patch-pi-web] Refusing to deploy truncated or malformed script (${enhCode.length} bytes) to ${publicDir}`);
        return;
      }
      const destEnhancement = path.join(publicDir, "pi-web-enhancements.js");
      safeWriteFileSync(destEnhancement, validatedBundledEnhancement, "utf8");
    }

    if (fs.existsSync(publicDir) && fs.existsSync(manifestSource)) {
      const destManifest = path.join(publicDir, "pi-archived-manifest.json");
      safeWriteFileSync(destManifest, fs.readFileSync(manifestSource, "utf8"), "utf8");
    }

    if (fs.existsSync(publicDir) && fs.existsSync(pinnedSource)) {
      const destPinned = path.join(publicDir, "pi-pinned-manifest.json");
      safeWriteFileSync(destPinned, fs.readFileSync(pinnedSource, "utf8"), "utf8");
    }

    if (fs.existsSync(publicDir) && fs.existsSync(shortcutsSource)) {
      const destShortcuts = path.join(publicDir, "pi-shortcuts-manifest.json");
      safeWriteFileSync(destShortcuts, fs.readFileSync(shortcutsSource, "utf8"), "utf8");
    }

    if (fs.existsSync(publicDir) && fs.existsSync(usageLedgerSource)) {
      const destUsageLedger = path.join(publicDir, "pi-usage-ledger.json");
      let linked = false;
      if (process.platform !== "win32") {
        try {
          const resolvedSource = path.resolve(usageLedgerSource);
          try {
            const st = fs.lstatSync(destUsageLedger);
            if (st.isSymbolicLink() && path.resolve(path.dirname(destUsageLedger), fs.readlinkSync(destUsageLedger)) === resolvedSource) {
              linked = true;
            }
          } catch (_) {}
          if (!linked) {
            const tmpLink = `${destUsageLedger}.${process.pid}.${Date.now()}.lnk`;
            try { fs.unlinkSync(tmpLink); } catch (_) {}
            fs.symlinkSync(resolvedSource, tmpLink);
            fs.renameSync(tmpLink, destUsageLedger);
            linked = true;
          }
        } catch (_) {
          linked = false;
        }
      }
      if (!linked) {
        safeWriteFileSync(destUsageLedger, fs.readFileSync(usageLedgerSource, "utf8"), "utf8");
      }
    }

    if (fs.existsSync(publicDir) && fs.existsSync(odooAddonsSource)) {
      const destOdooAddons = path.join(publicDir, "pi-odoo-addons-manifest.json");
      safeWriteFileSync(destOdooAddons, fs.readFileSync(odooAddonsSource, "utf8"), "utf8");
    }

    if (fs.existsSync(publicDir) && fs.existsSync(tagsSource)) {
      const destTags = path.join(publicDir, "pi-tags-manifest.json");
      safeWriteFileSync(destTags, fs.readFileSync(tagsSource, "utf8"), "utf8");
    }

    // Lightweight dynamic hot-loader definition with retry & watchdog
    // 同源数据缺失时拒绝发布，不能悄悄退回另一套旧配置/旧布局。
    const settingsModule02 = options.snapshotManifestPath
      ? path.join(lockCfg.modulesDir, "02-plugin-registry-and-settings-schema.js")
      : resolveSettingsModule02Path(home);
    const metadata = extractEnhancementMetadata(settingsModule02);
    const fastPluginReaderCode = buildFastPluginReaderSnippet(metadata);

    const loaderCode = `${diagnosticBootstrap};(function(){
  if (typeof window === "undefined" || window.__PI_WEB_LOADER_INJECTED__) return;
  window.__PI_WEB_LOADER_INJECTED__ = true;

  window.__PI_ENH_ARCHIVED_MANIFEST__ = window.__PI_ENH_ARCHIVED_MANIFEST__ || ${JSON.stringify(archivedManifest || null)};
  window.__PI_ENH_PINNED_MANIFEST__ = window.__PI_ENH_PINNED_MANIFEST__ || ${JSON.stringify(pinnedManifest || null)};
  window.__PI_ENH_SHORTCUTS_MANIFEST__ = window.__PI_ENH_SHORTCUTS_MANIFEST__ || ${JSON.stringify(shortcutsManifest || null)};
  window.__PI_ENH_ODOO_ADDONS_MANIFEST__ = window.__PI_ENH_ODOO_ADDONS_MANIFEST__ || ${JSON.stringify(odooAddonsManifest || null)};
  window.__PI_ENH_TAGS_MANIFEST__ = window.__PI_ENH_TAGS_MANIFEST__ || ${JSON.stringify(tagsManifest || null)};

${fastPluginReaderCode ? fastPluginReaderCode + "\n\n" : ""}` +
`  // 1. Zero-FOUC Pre-Hydration: DOM 绘制前瞬间应用深色主题与背景色，100% 杜绝白屏闪烁
  var isDark = true;
  try {
    var mode = localStorage.getItem("pi-web-theme-mode") || localStorage.getItem("theme") || "system";
    isDark = mode === "dark" || (mode === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var root = document.documentElement;
    if (isDark) {
      root.classList.add("dark");
      root.style.backgroundColor = "#09090b";
      root.style.colorScheme = "dark";
    } else {
      root.classList.remove("dark");
      root.style.backgroundColor = "#ffffff";
      root.style.colorScheme = "light";
    }
  } catch(e) {}

  // 1.1 Zero-FOUC Shortcuts Style & Fast Pre-Mount: 100% 杜绝侧边栏左下角原生按钮闪现，直接呈现增强快捷入口
  try {
    if (!document.getElementById('pi-zero-fouc-shortcuts-style')) {
      var sStyle = document.createElement('style');
      sStyle.id = 'pi-zero-fouc-shortcuts-style';
      sStyle.textContent = [
        '[data-pi-enh-shortcuts-host]:not([data-pi-enh-shortcuts-disabled]) > button:not(.pi-enh-shortcut-btn),',
        '.sidebar-container > div:last-child:not([data-pi-enh-shortcuts-disabled]) > button:not(.pi-enh-shortcut-btn) {',
        '  display: none !important;',
        '}',
        '.pi-enh-shortcuts-bar {',
        '  display: flex !important;',
        '  align-items: center;',
        '  gap: 2px;',
        '  width: 100%;',
        '  flex-wrap: nowrap !important;',
        '}',
        '.pi-enh-shortcut-btn {',
        '  flex: 1 1 0%;',
        '  display: flex;',
        '  align-items: center;',
        '  justify-content: center;',
        '  gap: 2px;',
        '  height: 32px;',
        '  padding: 0 1px;',
        '  background: none;',
        '  border: none;',
        '  border-radius: 8px;',
        '  color: var(--text-muted);',
        '  cursor: pointer;',
        '  font-size: 11px;',
        '  letter-spacing: -0.02em;',
        '  transition: background 0.12s, color 0.12s;',
        '  min-width: 0;',
        '  white-space: nowrap;',
        '  user-select: none;',
        '}',
        '.pi-enh-shortcut-btn:hover {',
        '  background: var(--bg-hover);',
        '  color: var(--text);',
        '}',
        '.pi-enh-shortcut-btn svg {',
        '  width: 13px;',
        '  height: 13px;',
        '  flex-shrink: 0;',
        '}',
        '.pi-enh-shortcut-btn span {',
        '  display: inline-block;',
        '  line-height: 1.4;',
        '  overflow: hidden;',
        '  text-overflow: ellipsis;',
        '  white-space: nowrap;',
        '  font-size: 10.5px;',
        '}',
        '.pi-enh-session-row-host {',
        '  touch-action: pan-y manipulation !important;',
        '  -webkit-tap-highlight-color: transparent;',
        '  box-sizing: border-box !important;',
        '}',
        '.pi-enh-session-row-host[data-pi-enh-has-odoo-addons="true"] {',
        '  display: grid !important;',
        '  grid-template-columns: minmax(0, 1fr) repeat(3, max-content);',
        '  align-content: center;',
        '  column-gap: 6px !important;',
        '  row-gap: 0 !important;',
        '  padding-top: 6px !important;',
        '  padding-bottom: 6px !important;',
        '  box-sizing: border-box !important;',
        '}',
        '.pi-enh-session-row-host[data-pi-enh-has-odoo-addons="true"][hidden],',
        '.pi-enh-session-row-host[data-pi-enh-has-odoo-addons="true"][style*="display: none"] {',
        '  display: none !important;',
        '}',
        '.pi-enh-session-row-host[data-pi-enh-has-odoo-addons="true"] > :not(.pi-enh-session-odoo-addons) {',
        '  grid-row: 1;',
        '}',
        '.pi-enh-session-row-host[data-pi-enh-has-odoo-addons="true"] > .pi-enh-session-odoo-addons {',
        '  grid-row: 2;',
        '  grid-column: 1 / -1;',
        '}',
        '.pi-enh-session-odoo-addons {',
        '  display: flex !important;',
        '  flex-direction: column !important;',
        '  gap: 4px;',
        '  margin-top: 4px;',
        '  margin-bottom: 4px;',
        '  padding: 0;',
        '  width: 100%;',
        '  min-width: 0;',
        '  line-height: normal;',
        '  box-sizing: border-box;',
        '}',
        '.pi-enh-odoo-addon-row {',
        '  flex: 0 0 20px;',
        '  display: flex;',
        '  align-items: center;',
        '  width: 100%;',
        '  min-width: 0;',
        '  height: 20px;',
        '  box-sizing: border-box;',
        '}',
        '.pi-enh-odoo-addon-pill {',
        '  height: 20px;',
        '  line-height: 18px;',
        '  display: inline-flex;',
        '  align-items: center;',
        '  gap: 5px;',
        '  padding: 0 7px;',
        '  border-radius: 9999px;',
        '  border: 1px solid rgba(255, 255, 255, 0.75);',
        '  color: #ffffff;',
        '  font-size: 11px;',
        '  font-weight: 500;',
        '  white-space: nowrap;',
        '  max-width: 100%;',
        '  box-sizing: border-box;',
        '  user-select: none;',
        '  background: radial-gradient(ellipse at 50% 50%, rgba(255, 255, 255, 0.16) 0%, rgba(255, 255, 255, 0.05) 100%);',
        '  background-color: #343943;',
        '  box-shadow: 0 0 8px rgba(255, 255, 255, 0.18), inset 0 0 5px rgba(255, 255, 255, 0.12);',
        '  text-shadow: 0 0 4px rgba(255, 255, 255, 0.45);',
        '  backdrop-filter: blur(4px);',
        '  cursor: default;',
        '}',
        '.pi-enh-odoo-addon-dot {',
        '  width: 5px;',
        '  height: 5px;',
        '  border-radius: 50%;',
        '  background-color: #ffffff;',
        '  box-shadow: 0 0 5px #ffffff, 0 0 8px rgba(255, 255, 255, 0.6);',
        '  flex-shrink: 0;',
        '}',
        '.pi-enh-odoo-addon-name {',
        '  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;',
        '  font-size: 10.5px;',
        '  font-weight: 500;',
        '  color: #ffffff;',
        '  overflow: hidden;',
        '  text-overflow: ellipsis;',
        '  white-space: nowrap;',
        '  letter-spacing: 0;',
        '}',
        '.pi-enh-session-model-badge {',
        '  display: inline-block;',
        '  vertical-align: middle;',
        '  max-width: 100%;',
        '  min-width: 0;',
        '  overflow: hidden;',
        '  text-overflow: ellipsis;',
        '  white-space: nowrap;',
        '  padding: 0;',
        '  border: 0;',
        '  background: transparent;',
        '  color: inherit;',
        '  font: inherit;',
        '  line-height: inherit;',
        '  flex: 0 1 auto;',
        '  margin-left: 0 !important;',
        '}',
        '.pi-enh-session-row-host > div:not(.pi-enh-native-session-actions):not(.pi-enh-session-overflow):not(.pi-enh-session-pinned-indicator):not(.pi-enh-session-model-badge),',
        '.pi-enh-session-row-host > input {',
        '  order: 1 !important;',
        '  flex: 1 1 0 !important;',
        '  min-width: 0 !important;',
        '}',
        'html.pi-enh-session-compact-active .pi-enh-session-row-host {',
        '  overflow: hidden !important;',
        '}',
        'html.pi-enh-session-compact-active .pi-enh-session-title,',
        'html.pi-enh-session-compact-active .pi-enh-session-row-host > div:not(.pi-enh-native-session-actions):not(.pi-enh-session-odoo-addons) > div:first-child {',
        '  min-width: 0 !important;',
        '  max-width: 100% !important;',
        '  overflow: hidden !important;',
        '  text-overflow: ellipsis !important;',
        '  white-space: nowrap !important;',
        '  line-height: 20px !important;',
        '}',
        'html.pi-enh-session-compact-active .pi-enh-session-meta,',
        'html.pi-enh-session-compact-active .pi-enh-session-row-host:not([data-pi-enh-has-tags="true"]) > div:not(.pi-enh-native-session-actions):not(.pi-enh-session-odoo-addons) > div:last-child:not(.pi-enh-session-odoo-addons) {',
        '  display: flex !important;',
        '  align-items: center !important;',
        '  min-width: 0 !important;',
        '  max-width: 100% !important;',
        '  max-height: 18px !important;',
        '  line-height: 18px !important;',
        '  overflow: hidden !important;',
        '  white-space: nowrap !important;',
        '  gap: 6px !important;',
        '  margin-top: 2px !important;',
        '}',
        'html.pi-enh-session-compact-active .pi-enh-session-meta > * {',
        '  white-space: nowrap !important;',
        '}',
        'html.pi-enh-session-compact-active .pi-enh-session-time,',
        'html.pi-enh-session-compact-active .pi-enh-session-meta > span:first-child,',
        'html.pi-enh-session-compact-active .pi-enh-session-msg-count {',
        '  white-space: nowrap !important;',
        '  flex-shrink: 0 !important;',
        '}',
        'html.pi-enh-session-pin-archive-active .pi-enh-native-session-actions,',
        'html:not(.pi-enh-session-pin-archive-active) .pi-enh-session-row-host:not(:hover):not(:focus-within) .pi-enh-native-session-actions {',
        '  display: none !important;',
        '}',
        '.pi-enh-session-overflow {',
        '  order: 2147483647;',
        '  display: inline-flex;',
        '  flex: 0 0 auto;',
        '  align-items: center;',
        '  justify-content: center;',
        '  width: 26px;',
        '  height: 26px;',
        '  padding: 0;',
        '  border: 0;',
        '  border-radius: 5px;',
        '  background: transparent;',
        '  color: var(--text-muted, #a1a1aa);',
        '  cursor: pointer;',
        '  opacity: 0;',
        '  pointer-events: none;',
        '}',
        '.pi-enh-session-row-host:hover .pi-enh-session-overflow,',
        '.pi-enh-session-row-host:focus-within .pi-enh-session-overflow {',
        '  opacity: 1;',
        '  pointer-events: auto;',
        '}',
        '.pi-enh-session-batch-trigger {',
        '  display: inline-flex;',
        '  align-items: center;',
        '  justify-content: center;',
        '  width: 32px;',
        '  height: 32px;',
        '  flex-shrink: 0;',
        '  background: var(--bg-hover);',
        '  border: 1px solid var(--border);',
        '  border-radius: 7px;',
        '  color: var(--text-muted);',
        '  cursor: pointer;',
        '}',
        'html.pi-enh-mobile .pi-enh-session-msg-count,',
        'html.pi-enh-mobile .pi-enh-session-row-host .pi-enh-native-session-actions {',
        '  display: none !important;',
        '}',
        'html.pi-enh-mobile .pi-enh-session-overflow {',
        '  opacity: 0.72 !important;',
        '  pointer-events: auto !important;',
        '}',
        '@media (max-width: 768px), (pointer: coarse) {',
        '  .pi-enh-session-msg-count,',
        '  .pi-enh-native-session-actions {',
        '    display: none !important;',
        '  }',
        '  .pi-enh-session-overflow {',
        '    opacity: 0.72 !important;',
        '    pointer-events: auto !important;',
        '    width: 22px !important;',
        '    height: 22px !important;',
        '  }',
        '}'
      ].join(String.fromCharCode(10));
      (document.head || document.documentElement).appendChild(sStyle);
    }
  } catch(e) {}

  // 1.2 Fast Pre-Mount: 在首帧绘制前同步嗅探并挂载增强快捷入口
  try {
    var SHORTCUT_ICONS_MIN = {
      usage: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="settings-section-icon"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>',
      enhancements: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="settings-section-icon"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></path></svg>',
      archived: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="settings-section-icon"><path d="M21 8v13H3V8"></path><path d="M1 3h22v5H1z"></path><path d="M10 12h4"></path></svg>',
      settings: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7h-9M14 17H5"></path><circle cx="7" cy="7" r="3"></circle><circle cx="17" cy="17" r="3"></circle></svg>'
    };

    function getFastShortcutList() {
      try {
        var raw = localStorage.getItem('pi-web-quick-shortcuts');
        if (raw) {
          var parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
      } catch(e) {}
      if (Array.isArray(window.__PI_ENH_SHORTCUTS_MANIFEST__) && window.__PI_ENH_SHORTCUTS_MANIFEST__.length > 0) {
        return window.__PI_ENH_SHORTCUTS_MANIFEST__;
      }
      return [
        { id: 'usage', label: 'Usage' },
        { id: 'enhancements', label: '增强插件' },
        { id: 'archived', label: '已归档' },
        { id: 'settings', label: '设置' }
      ];
    }

    function mountFastShortcuts(host) {
      if (!host || host.hasAttribute('data-pi-enh-shortcuts-disabled') || (typeof window.__PI_ENH_IS_PLUGIN_ENABLED__ === 'function' && !window.__PI_ENH_IS_PLUGIN_ENABLED__('settings-tab-shortcuts')) || host.querySelector('.pi-enh-shortcuts-bar')) return;
      host.setAttribute('data-pi-enh-shortcuts-host', 'true');
      var list = getFastShortcutList();
      var bar = document.createElement('div');
      bar.className = 'pi-enh-shortcuts-bar';
      bar.setAttribute('data-signature', JSON.stringify(list));
      bar.setAttribute('data-count', String(list.length));
      bar.innerHTML = list.map(function(item) {
        var icon = item.iconHtml || SHORTCUT_ICONS_MIN[item.id] || SHORTCUT_ICONS_MIN.settings;
        return '<button type="button" class="pi-enh-shortcut-btn" data-shortcut-id="' + item.id + '" title="' + item.label + ' (点击直达，双击可移除)">' +
          icon + '<span>' + item.label + '</span></button>';
      }).join('');

      bar.addEventListener('click', function(e) {
        var btn = e.target && e.target.closest ? e.target.closest('.pi-enh-shortcut-btn') : null;
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        var id = btn.getAttribute('data-shortcut-id');
        if (typeof window.__PI_ENH_TRIGGER_SHORTCUT__ === 'function') {
          window.__PI_ENH_TRIGGER_SHORTCUT__(id);
        } else {
          window.__PI_PENDING_SHORTCUT_TARGET__ = id;
          if (typeof window.__PI_OPEN_SETTINGS__ === 'function') {
            window.__PI_OPEN_SETTINGS__(id === 'settings' ? 'general' : id);
          }
        }
      });
      host.appendChild(bar);
    }

    // [Canonical Fast Reader] isPluginFastActive 已由 helper 编译注入在顶部

    try {
      var docRoot = document.documentElement;
      if (docRoot) {
        if (isPluginFastActive("session-pin-archive")) docRoot.classList.add("pi-enh-session-pin-archive-active");
        if (isPluginFastActive("session-item-compact")) docRoot.classList.add("pi-enh-session-compact-active");
        var isMob = window.innerWidth <= 768 || (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
        if (isMob) docRoot.classList.add("pi-enh-mobile");
      }
    } catch(e) {}

    function getFastPinnedSet() {
      var set = new Set();
      try {
        var raw = localStorage.getItem("pi-enh-session-pinned");
        if (raw) {
          var arr = JSON.parse(raw);
          if (Array.isArray(arr)) arr.forEach(function(id) { if (id) set.add(id); });
        }
      } catch(e) {}
      if (set.size === 0 && Array.isArray(window.__PI_ENH_PINNED_MANIFEST__)) {
        window.__PI_ENH_PINNED_MANIFEST__.forEach(function(item) {
          var id = typeof item === "string" ? item : item && item.id;
          if (id) set.add(id);
        });
      }
      return set;
    }

    function getFastArchivedSet() {
      var set = new Set();
      try {
        var raw = localStorage.getItem("pi-enh-session-archived");
        if (raw) {
          var arr = JSON.parse(raw);
          if (Array.isArray(arr)) arr.forEach(function(item) {
            var id = typeof item === "string" ? item : item && item.id;
            if (id) set.add(id);
          });
        }
      } catch(e) {}
      if (set.size === 0 && Array.isArray(window.__PI_ENH_ARCHIVED_MANIFEST__)) {
        window.__PI_ENH_ARCHIVED_MANIFEST__.forEach(function(item) {
          var id = typeof item === "string" ? item : item && item.id;
          if (id) set.add(id);
        });
      }
      return set;
    }

    function getFastSessionItemHeight(sessionId) {
      if (!sessionId) return 54;
      var h = 54;
      if (isPluginFastActive("session-tags")) {
        try {
          var rawM = localStorage.getItem("pi-enh-session-tag-mappings-v1");
          var mappings = rawM ? JSON.parse(rawM) : (window.__PI_ENH_TAGS_MANIFEST__ && window.__PI_ENH_TAGS_MANIFEST__.mappings);
          if (mappings && Array.isArray(mappings[sessionId]) && mappings[sessionId].length > 0) {
            h += 18;
          }
        } catch(e) {}
      }
      if (isPluginFastActive("session-odoo-addons")) {
        try {
          var addons = window.__PI_ENH_ODOO_ADDONS_MANIFEST__ && window.__PI_ENH_ODOO_ADDONS_MANIFEST__.sessions && window.__PI_ENH_ODOO_ADDONS_MANIFEST__.sessions[sessionId];
          if (Array.isArray(addons) && addons.length > 0) {
            h += (4 + addons.length * 24);
          }
        } catch(e) {}
      }
      return h;
    }

    function getFastPinnedCount(groups) {
      if (!Array.isArray(groups) || groups.length === 0) return 0;
      if (!isPluginFastActive("session-pin-archive") || !isPluginFastActive("session-section-headers")) return 0;
      var pinnedSet = getFastPinnedSet();
      if (!pinnedSet || pinnedSet.size === 0) return 0;
      var count = 0;
      for (var i = 0; i < groups.length; i++) {
        var rootId = groups[i] && groups[i].root && groups[i].root.id;
        if (rootId && pinnedSet.has(rootId)) {
          count++;
        } else {
          break;
        }
      }
      return count;
    }

    function fastProcessSessionGroups(groups) {
      if (!Array.isArray(groups)) return groups;
      var pinArchiveEnabled = isPluginFastActive("session-pin-archive");
      var pinnedSet = pinArchiveEnabled ? getFastPinnedSet() : new Set();
      var archivedSet = pinArchiveEnabled ? getFastArchivedSet() : new Set();

      var filtered = [];
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        var rootId = g && g.root && g.root.id;
        if (!rootId || archivedSet.has(rootId)) continue;
        filtered.push(g);
      }
      var result = !pinArchiveEnabled ? filtered : filtered.sort(function(left, right) {
        var lPinned = Number(pinnedSet.has(left && left.root && left.root.id));
        var rPinned = Number(pinnedSet.has(right && right.root && right.root.id));
        return rPinned - lPinned;
      });
      window.__PI_ENH_EARLY_SESSION_GROUPS__ = result;
      return result;
    }

    function fastGetSessionItemTop(index, groups) {
      var pinnedCount = getFastPinnedCount(groups);
      var top = 0;
      if (Array.isArray(groups)) {
        if (pinnedCount > 0) {
          top += 28;
        }
        for (var i = 0; i < index && i < groups.length; i++) {
          var rootId = groups[i] && groups[i].root && groups[i].root.id;
          top += getFastSessionItemHeight(rootId);
          if (pinnedCount > 0 && i === pinnedCount - 1 && pinnedCount < groups.length) {
            top += 34;
          }
        }
      } else {
        var defaultTop = 54 * index;
        if (pinnedCount <= 0) return defaultTop;
        if (index < pinnedCount) return 28 + defaultTop;
        return 28 + 34 + defaultTop;
      }
      return top;
    }

    function fastGetSessionHeadersHeight(groups) {
      var pinnedCount = getFastPinnedCount(groups);
      var baseHeadersHeight = 0;
      if (pinnedCount > 0) {
        var total = Array.isArray(groups) ? groups.length : 0;
        baseHeadersHeight = (pinnedCount < total) ? (28 + 34) : 28;
      }
      var extraHeight = 0;
      if (Array.isArray(groups)) {
        for (var i = 0; i < groups.length; i++) {
          var rootId = groups[i] && groups[i].root && groups[i].root.id;
          var itemH = getFastSessionItemHeight(rootId);
          if (itemH > 54) {
            extraHeight += (itemH - 54);
          }
        }
      }
      return baseHeadersHeight + extraHeight;
    }

    window.__PI_WEB_STANDALONE_EDITION__ = ${JSON.stringify(`koxir-standalone-${installedWebVersion}`)};
    window.__PI_WEB_STANDALONE_VERSION__ = ${JSON.stringify(installedWebVersion)};
    window.__PI_OFFICIAL_AGENT_VERSION__ = ${JSON.stringify(officialPiVersion)};
    if (!window.__PI_WEB_ENHANCEMENTS_LOADED__) {
      window.__PI_ENH_IS_PLUGIN_ENABLED__ = window.__PI_ENH_IS_PLUGIN_ENABLED__ || isPluginFastActive;
      window.__PI_ENH_PROCESS_SESSION_GROUPS__ = window.__PI_ENH_PROCESS_SESSION_GROUPS__ || fastProcessSessionGroups;
      window.__PI_ENH_GET_SESSION_ITEM_HEIGHT__ = window.__PI_ENH_GET_SESSION_ITEM_HEIGHT__ || getFastSessionItemHeight;
      window.__PI_ENH_GET_SESSION_ITEM_TOP__ = window.__PI_ENH_GET_SESSION_ITEM_TOP__ || fastGetSessionItemTop;
      window.__PI_ENH_GET_SESSION_HEADERS_HEIGHT__ = window.__PI_ENH_GET_SESSION_HEADERS_HEIGHT__ || fastGetSessionHeadersHeight;
    }

    function mountFastBatchButton() {
      if (window.__PI_WEB_ENHANCEMENTS_LOADED__ || !isPluginFastActive("session-batch-actions")) return;
      if (document.getElementById("pi-enh-session-batch-btn")) return;
      var searchBtn = document.querySelector('button[aria-controls="session-search-input"]');
      var targetContainer = searchBtn && searchBtn.parentElement;
      if (!targetContainer) return;
      var btn = document.createElement("button");
      btn.id = "pi-enh-session-batch-btn";
      btn.type = "button";
      btn.className = "pi-enh-session-batch-trigger";
      btn.setAttribute("aria-label", "批量管理会话");
      btn.title = "批量管理会话 (多选/删除)";
      btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect><line x1="14" y1="4" x2="21" y2="4"></line><line x1="14" y1="9" x2="19" y2="9"></line><line x1="14" y1="15" x2="21" y2="15"></line><line x1="14" y1="20" x2="19" y2="20"></line></svg>';
      if (searchBtn.nextSibling) {
        targetContainer.insertBefore(btn, searchBtn.nextSibling);
      } else {
        targetContainer.appendChild(btn);
      }
    }

    function mountFastSessionRows() {
      if (window.__PI_WEB_ENHANCEMENTS_LOADED__) return;
      mountFastBatchButton();
      var rows = document.querySelectorAll(".pi-enh-session-row-host[data-pi-enh-session-id]");
      if (!rows || rows.length === 0) return;

      var modelMetaCache = null;
      try {
        var rawMeta = localStorage.getItem("pi-enh-session-model-meta-v1");
        if (rawMeta) modelMetaCache = JSON.parse(rawMeta);
      } catch(e) {}

      var odooManifest = window.__PI_ENH_ODOO_ADDONS_MANIFEST__;
      var groups = window.__PI_ENH_EARLY_SESSION_GROUPS__;
      var groupIndexMap = null;
      if (Array.isArray(groups)) {
        groupIndexMap = new Map();
        for (var gi = 0; gi < groups.length; gi++) {
          var gid = groups[gi] && groups[gi].root && groups[gi].root.id;
          if (gid) groupIndexMap.set(gid, gi);
        }
      }

      for (var rIdx = 0; rIdx < rows.length; rIdx++) {
        var row = rows[rIdx];
        var sid = row.getAttribute("data-pi-enh-session-id");
        if (!sid) continue;

        var contentHost = row.querySelector("div[style*='flex: 1'], div[style*='flex:1']") || row.firstElementChild;
        if (contentHost && contentHost.children && contentHost.children.length >= 2) {
          var titleDiv = contentHost.children[0];
          var metaDiv = contentHost.children[1];
          if (titleDiv && !titleDiv.classList.contains("pi-enh-session-title")) {
            titleDiv.classList.add("pi-enh-session-title");
          }
          if (metaDiv && !metaDiv.classList.contains("pi-enh-session-meta")) {
            metaDiv.classList.add("pi-enh-session-meta");
          }
        }

        var allEls = row.querySelectorAll("*");
        var msgCountEl = null;
        for (var k = allEls.length - 1; k >= 0; k--) {
          var t = allEls[k].textContent || "";
          if (/^\\s*[\\d,.]+\\s*(?:条消息|messages?|msgs?)\\s*$/i.test(t)) {
            msgCountEl = allEls[k];
            msgCountEl.classList.add("pi-enh-session-msg-count");
            break;
          }
        }

        if (modelMetaCache && modelMetaCache[sid] && modelMetaCache[sid].modelId && !row.querySelector(".pi-enh-session-model-badge")) {
          var itemMeta = modelMetaCache[sid];
          var badge = document.createElement("span");
          badge.className = "pi-enh-session-model-badge";
          var thLevel = itemMeta.thinkingLevel || "off";
          badge.textContent = itemMeta.modelId + " · " + thLevel;
          badge.setAttribute("title", (itemMeta.provider || "未知 Provider") + " / " + itemMeta.modelId + " · 思考深度：" + thLevel);
          badge.setAttribute("aria-label", "模型 " + itemMeta.modelId + "，思考深度 " + thLevel);

          if (msgCountEl && msgCountEl.parentElement) {
            msgCountEl.after(badge);
          } else {
            var metaContainer = row.querySelector(".pi-enh-session-meta") ||
              row.querySelector("div[style*='flex: 1'] > div:last-child") ||
              row.querySelector("div[style*='flex:1'] > div:last-child");
            if (metaContainer) metaContainer.appendChild(badge);
          }
        }

        var addons = odooManifest && odooManifest.sessions && odooManifest.sessions[sid];
        if (Array.isArray(addons) && addons.length > 0 && isPluginFastActive("session-odoo-addons")) {
          row.setAttribute("data-pi-enh-has-odoo-addons", "true");
          if (!row.querySelector(".pi-enh-session-odoo-addons")) {
            var addonHost = document.createElement("div");
            addonHost.className = "pi-enh-session-odoo-addons";
            var aHtml = "";
            for (var ai = 0; ai < addons.length; ai++) {
              var ad = addons[ai];
              var tech = typeof ad === "string" ? ad : ad && ad.technical;
              if (!tech) continue;
              var tooltip = (ad && ad.status) ? (tech + " · " + ad.status) : tech;
              aHtml += '<div class="pi-enh-odoo-addon-row">' +
                '<span class="pi-enh-odoo-addon-pill" title="' + tooltip + '">' +
                '<span class="pi-enh-odoo-addon-dot"></span>' +
                '<span class="pi-enh-odoo-addon-name">' + tech + '</span>' +
                '</span></div>';
            }
            addonHost.innerHTML = aHtml;
            row.appendChild(addonHost);
          }
        }

        if (isPluginFastActive("session-pin-archive") && !row.querySelector(".pi-enh-session-overflow")) {
          var ovBtn = document.createElement("button");
          ovBtn.type = "button";
          ovBtn.className = "pi-enh-session-overflow";
          ovBtn.setAttribute("aria-label", "会话更多操作");
          ovBtn.setAttribute("title", "更多操作");
          ovBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle></svg>';
          row.appendChild(ovBtn);
        }

        var itemH = getFastSessionItemHeight(sid);
        var heightPx = itemH + "px";
        if (row.style.height !== heightPx) row.style.height = heightPx;
        var wrapper = row.parentElement;
        if (wrapper && wrapper.style.position === "absolute") {
          if (wrapper.style.height !== heightPx) wrapper.style.height = heightPx;
          if (groupIndexMap && groupIndexMap.has(sid)) {
            var gIdx = groupIndexMap.get(sid);
            var topPx = fastGetSessionItemTop(gIdx, groups) + "px";
            if (wrapper.style.top !== topPx) wrapper.style.top = topPx;
          }
        }
      }
    }

    var shortcutsObserver = new MutationObserver(function() {
      var host = document.querySelector('[data-pi-enh-shortcuts-host]');
      if (!host) {
        var sidebar = document.querySelector('.sidebar-container');
        if (sidebar) {
          var last = sidebar.lastElementChild;
          if (last && last.querySelector('button')) host = last;
        }
      }
      if (host) {
        mountFastShortcuts(host);
      }
      if (!window.__PI_WEB_ENHANCEMENTS_LOADED__) {
        mountFastSessionRows();
      }
    });

    if (document.documentElement) {
      shortcutsObserver.observe(document.documentElement, { childList: true, subtree: true });
      mountFastSessionRows();
    }
  } catch(e) {}

    // 2. PWA Manifest & Meta 自动注入
  try {
    if (!document.querySelector('link[rel="manifest"]')) {
      var link = document.createElement("link");
      link.rel = "manifest";
      link.href = "/manifest.webmanifest";
      (document.head || document.documentElement).appendChild(link);
    }
    if (!document.querySelector('meta[name="theme-color"]')) {
      var metaTheme = document.createElement("meta");
      metaTheme.name = "theme-color";
      metaTheme.content = isDark ? "#09090b" : "#ffffff";
      (document.head || document.documentElement).appendChild(metaTheme);
    }
    if (!document.querySelector('link[rel="apple-touch-icon"]')) {
      var appleIcon = document.createElement("link");
      appleIcon.rel = "apple-touch-icon";
      appleIcon.href = "/icons/apple-touch-icon.png";
      (document.head || document.documentElement).appendChild(appleIcon);
    }
  } catch(e) {}

  // 3. 注册 Service Worker (离线与后台通知，使用固定路径，由标准 HTTP 缓存与 SW 字节比对触发更新，彻底杜绝多版本抢占死锁)
  try {
    if ("serviceWorker" in navigator && window.location.protocol.startsWith("http")) {
      navigator.serviceWorker.register("/sw.js").catch(function() {});
    }
  } catch(e) {}

  var retryCount = 0;
  var maxRetries = 3;
  var assetBuildHash = window.__PI_ENH_ASSET_BUILD__ || ${JSON.stringify(assetBuild)};
  function loadScript(forceBust) {
    if (!forceBust && window.__PI_WEB_ENHANCEMENTS_LOADED__) return;
    var existing = document.getElementById("pi-web-enhancements-script");
    if (existing) existing.remove();
    var script = document.createElement("script");
    script.id = "pi-web-enhancements-script";
    script.src = "/pi-web-enhancements.js?v=" + encodeURIComponent(assetBuildHash) + (forceBust ? ("&t=" + Date.now()) : "");
    script.async = true;
    script.onerror = function() {
      if (retryCount < maxRetries) {
        retryCount++;
        setTimeout(function() { loadScript(true); }, 1000 * retryCount);
      }
    };
    (document.head || document.documentElement).appendChild(script);
  }
  var scheduleFallbackLoad = function() {
    if (window.__PI_WEB_ENHANCEMENTS_LOADED__) return;
    if (document.head || document.documentElement) {
      loadScript(false);
    } else if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function() { loadScript(false); }, { once: true });
    } else {
      loadScript(false);
    }
  };
  if (typeof queueMicrotask === "function") {
    queueMicrotask(scheduleFallbackLoad);
  } else {
    setTimeout(scheduleFallbackLoad, 0);
  }
  setTimeout(function() {
    if (!window.__PI_WEB_ENHANCEMENTS_LOADED__ && retryCount < maxRetries) {
      retryCount++;
      loadScript(true);
    }
  }, 6000);
  try {
    document.addEventListener("visibilitychange", function() {
      if (document.visibilityState === "visible" && !window.__PI_WEB_ENHANCEMENTS_LOADED__) {
        loadScript(false);
      }
    });
  } catch(e) {}
  window.__PI_ENH_RELOAD__ = function(forceBust) {
    loadScript(forceBust !== false);
  };

  // 若当前页面加载到了浏览器 HTTP 磁盘 immutable 缓存中的旧内联 bundle，延迟 1.2s 对比并自动热更新
  setTimeout(function() {
    try {
      if (typeof window === "undefined" || !window.fetch || window.location.pathname.indexOf("/login") >= 0) return;
      window.fetch("/pi-web-enhancement-loader.js?t=" + Date.now(), { cache: "no-store" })
        .then(function(r) { return r && r.ok ? r.text() : ""; })
        .then(function(txt) {
          if (!txt) return;
          var m = txt.match(/window\\.__PI_ENH_ASSET_BUILD__\\s*=\\s*"([a-f0-9]{16})"/);
          if (m && m[1] && m[1] !== assetBuildHash) {
            console.warn("[Pi Enh Loader] Immutable chunk mismatch (cached: " + assetBuildHash + ", remote: " + m[1] + "). Hot reloading latest script...");
            try {
              var scs = document.querySelectorAll("script[src]");
              for (var i = 0; i < scs.length; i++) {
                var s = scs[i].getAttribute("src");
                if (s && (s.indexOf("/chunks/app/layout-") >= 0 || s.indexOf("/chunks/app/page-") >= 0)) {
                  window.fetch(s, { cache: "reload" }).catch(function() {});
                }
              }
            } catch(_) {}
            if (typeof window.__PI_WEB_ENHANCEMENTS_CLEANUP__ === "function") {
              try { window.__PI_WEB_ENHANCEMENTS_CLEANUP__(); } catch(_) {}
            }
            loadScript(true);
          }
        }).catch(function() {});
    } catch(_) {}
  }, 1200);
})();`;

    if (fs.existsSync(publicDir)) {
      const destLoader = path.join(publicDir, "pi-web-enhancement-loader.js");
      safeWriteFileSync(destLoader, loaderCode, "utf8");
    }

    if (allowBoundedLayoutInlineSync && options.publicOnly) {
      const inlineSync = syncBoundedLayoutInlineChunks(pkgDir, {
        loaderCode,
        validatedBundledEnhancement,
      });
      if (options.syncLayoutInline === true && inlineSync.updated.length + inlineSync.unchanged.length === 0) {
        throw new Error(`[patch-pi-web] Fail-closed: no validated layout inline bundle was deployed (${inlineSync.reason || inlineSync.rejected.map(item => item.reason).join(", ")})`);
      }
      syncPortablePageBridgeChunks(pkgDir);
    }

    // The standalone native bootstrap does not execute the public hot-loader.
    // Compile the same plugin prepaint into its bounded prefix; preserve native bytes.
    if (options.syncPrepaintInline !== false) {
      try {
        const prepaint = require("./pi-web-prepaint-inline.cjs").syncPrepaintInline(pkgDir, {
          modulesDir: lockCfg.modulesDir,
          bundlePath: fs.existsSync('/workspace/pi-web/components/SessionSidebar.tsx') ? undefined : (options.enhancementSource || ENHANCEMENT_SOURCE),
          required: options.syncPrepaintInline === true,
        });
        if (prepaint && prepaint.updated && prepaint.updated.length) console.log("[patch-pi-web] native prepaint prefix:", JSON.stringify(prepaint));
      } catch (prepaintErr) {
        if (options.syncPrepaintInline === true) throw prepaintErr;
      }
    }

    // 无论是否 publicOnly，public/sw.js 均属于 public 目录核心静态资源，必须在返回前完成修补
    patchPublicServiceWorker(pkgDir, assetBuild);

    // Explicit live mode: no running server/SDK or native body rewrites (bounded prepaint only).
    if (options.publicOnly === true) return;

    // If an optional source-owned loader bridge is present in public/,
    // keep it, but always continue patching layout/page chunks so guardian
    // health checks, tail throttling, and client runtime hooks stay consistent.

    // 2. Patch layout chunks (static/chunks/app/layout-*.js) with compile-time inline bundle + loader
    const chunksDir = path.join(pkgDir, ".next", "static", "chunks", "app");
    if (fs.existsSync(chunksDir)) {

      for (const file of fs.readdirSync(chunksDir)) {
        if (file.startsWith("layout-") && file.endsWith(".js")) {
          const layoutPath = path.join(chunksDir, file);
          let content = fs.readFileSync(layoutPath, "utf8");
          const splitMarker = "\n;/* PI_WEB_ENHANCEMENTS_START */";
          if (content.includes(splitMarker)) {
            content = content.split(splitMarker)[0];
          } else if (content.includes("__PI_WEB_ENHANCEMENTS_LOADED__")) {
            // older format without marker
            const idx = content.indexOf("\n;/**\n * Pi Web Enhancements:");
            if (idx !== -1) {
              content = content.slice(0, idx);
            }
          }
          content = content.replace(
            /encodeURIComponent\("[0-9]+\.[0-9]+\.[0-9]+"\)(?=\}`;navigator\.serviceWorker\.register)/g,
            `encodeURIComponent("${STANDALONE_BASE_VERSION}")`
          );
          content = content + splitMarker + "\n" + loaderCode + (validatedBundledEnhancement ? ("\n;/* PI_WEB_ENHANCEMENTS_INLINE_BUNDLE */\n" + validatedBundledEnhancement) : "");
          safeWriteFileSync(layoutPath, content, "utf8");
        }
      }
    }

    // 3. Patch client-side static page chunks (Escape key & Standalone version)
    if (fs.existsSync(chunksDir)) {
      for (const file of fs.readdirSync(chunksDir)) {
        if (file.startsWith("page-") && file.endsWith(".js")) {
          const fullPath = path.join(chunksDir, file);
          let content = fs.readFileSync(fullPath, "utf8");
          let modified = false;

          const verPatched = patchWebAndOfficialPiVersionStrings(content, STANDALONE_BASE_VERSION, officialPiVersion);
          if (verPatched !== content) {
            content = verPatched;
            modified = true;
          }

          const splitMarker = "\n;/* PI_WEB_ENHANCEMENTS_START */";
          if (content.includes(splitMarker)) {
            content = content.split(splitMarker)[0] + splitMarker + "\n" + loaderCode;
            modified = true;
          }

          const repairedDurationCopy = repairMalformedClientDurationCopy(content);
          if (repairedDurationCopy !== content) {
            content = repairedDurationCopy;
            modified = true;
          }

          const repairedThinking = repairStreamingThinkingLevel(content);
          if (repairedThinking !== content) {
            content = repairedThinking;
            modified = true;
          }

          const repairedShortcuts = repairStreamingSendShortcuts(content);
          if (repairedShortcuts !== content) {
            content = repairedShortcuts;
            modified = true;
          }

          const repairedMount = repairComposerInitialMount(content);
          if (repairedMount !== content) {
            content = repairedMount;
            modified = true;
          }

          const repairedModelAutoFocus = repairModelSelectorMobileAutoFocus(content);
          if (repairedModelAutoFocus !== content) {
            content = repairedModelAutoFocus;
            modified = true;
          }

          const repairedModelRetainKeyboard = repairModelSelectorRetainKeyboard(content);
          if (repairedModelRetainKeyboard !== content) {
            content = repairedModelRetainKeyboard;
            modified = true;
          }

          const repairedCleanPlaceholder = repairComposerCleanPlaceholder(content);
          if (repairedCleanPlaceholder !== content) {
            content = repairedCleanPlaceholder;
            modified = true;
          }

          const repairedDisableNativeAtFiles = patchDisableNativeAtFiles(content);
          if (repairedDisableNativeAtFiles !== content) {
            content = repairedDisableNativeAtFiles;
            modified = true;
          }

          // 确保新会话与草稿态下始终提供思考深度、工具预设与压缩功能，绝不漏掉
          const draftThinkingRegex = /onToolPresetChange:e\|\|[A-Za-z0-9_$]+\?([A-Za-z0-9_$]+):void 0,thinkingLevel:([A-Za-z0-9_$]+),onThinkingLevelChange:e\|\|[A-Za-z0-9_$]+\?([A-Za-z0-9_$]+):void 0/g;
          if (draftThinkingRegex.test(content)) {
            content = content.replace(draftThinkingRegex, 'onToolPresetChange:$1,thinkingLevel:$2,onThinkingLevelChange:$3');
            modified = true;
          }
          const draftCompactRegex = /onCompact:e\|\|[A-Za-z0-9_$]+\?([A-Za-z0-9_$]+):void 0/g;
          if (draftCompactRegex.test(content)) {
            content = content.replace(draftCompactRegex, 'onCompact:$1');
            modified = true;
          }

          // 彻底从原生标签页中剥离 - Pi Web 标识
          const titlePattern = /`\$\{([A-Za-z0-9_$]+)\}\s*-\s*Pi\s*Web`:\s*["']Pi\s*Web["']/g;
          if (titlePattern.test(content)) {
            content = content.replace(titlePattern, '`\${$1}`:"work"');
            modified = true;
          }

          const repairedToolbar = patchDirectToolbarControls(content);
          if (repairedToolbar !== content) {
            content = repairedToolbar;
            modified = true;
          }

          const repairedSidebarShortcuts = patchSidebarBottomShortcuts(content);
          if (repairedSidebarShortcuts !== content) {
            content = repairedSidebarShortcuts;
            modified = true;
          }

          const repairedMarkdownImages = patchMarkdownFileImageSupport(content);
          if (repairedMarkdownImages !== content) {
            content = repairedMarkdownImages;
            modified = true;
          }

          // Browser GET caching can resurrect an old empty queue after the
          // selected session is remounted. SSE does not replay queue_update,
          // so every state snapshot must bypass the HTTP cache.
          const noStoreStateReads = (value) => value
            .replace(/fetch\((`\/api\/sessions\/\$\{encodeURIComponent\([^)]*\)\}\/state`)\)(?!,\{cache:"no-store"\})/g, 'fetch($1,{cache:"no-store"})')
            .replace(/fetch\((`\/api\/agent\/\$\{encodeURIComponent\([^)]*\)\}`)\)(?!,\{cache:"no-store"\})/g, 'fetch($1,{cache:"no-store"})');
          const stateReadsPatched = noStoreStateReads(content);
          if (stateReadsPatched !== content) {
            content = stateReadsPatched;
            modified = true;
          }

          const p1 = 'if("Escape"===e.key&&!a&&l&&t){e.preventDefault(),t();return}';
          const r1 = 'if(false&&"Escape"===e.key&&!a&&l&&t){e.preventDefault(),t();return}';
          if (content.includes(p1)) {
            content = content.replace(p1, r1);
            modified = true;
          }

          const p2 = 'if("Escape"===e.key){if(!l)return;let t=e.target?.tagName;if("TEXTAREA"===t||"INPUT"===t)return;e.preventDefault(),l();return}';
          const r2 = 'if(false&&"Escape"===e.key){if(!l)return;let t=e.target?.tagName;if("TEXTAREA"===t||"INPUT"===t)return;e.preventDefault(),l();return}';
          if (content.includes(p2)) {
            content = content.replace(p2, r2);
            modified = true;
          }

          // Remove the legacy total-duration injection from core chunks. The
          // durable enhancement script is the only renderer of this value.
          const pDur = ',K&&!t&&(0,r.jsxs)("button",{onClick:()=>{tn(K)';
          const rDur = ',e.turnSec&&!t&&(0,r.jsx)("div",{style:{fontSize:11,color:"#38bdf8",display:"flex",alignItems:"center",gap:3,marginLeft:e.usage?4:0,cursor:"pointer",fontWeight:500},title:"任务执行总耗时","data-total-sec":e.turnSec,"data-queue-sec":e.turnMetrics?.queueSec||0,"data-tools":JSON.stringify(e.turnMetrics?.toolCounts||{}),children:[(e.usage?"· ⏱️ ":"⏱️ "),e.turnSec<60?e.turnSec+"s":Math.floor(e.turnSec/60)+"m "+(e.turnSec%60)+"s"]})' + pDur;
          if (content.includes(rDur)) {
            content = content.replace(rDur, pDur);
            modified = true;
          }

          const turnSecCalc = 'let turnMetrics=null;if("assistant"===i.role&&u&&i.timestamp){let uIdx=-1;for(let m=t-1;m>=0;m--){if("user"===ee[m]?.role&&ee[m]?.timestamp){uIdx=m;break}}if(uIdx!==-1){let uMsg=ee[uIdx],firstAMsg=ee[uIdx+1]||i,totalSec=Math.max(1,Math.round((i.timestamp-uMsg.timestamp)/1e3)),queueSec=Math.max(0,Math.round(((firstAMsg.timestamp||i.timestamp)-uMsg.timestamp)/1e3)),toolCounts={};for(let j=uIdx+1;j<=t;j++){let cList=ee[j]?.content||[];for(let b of cList)if("toolCall"===b.type){let name=b.toolName||b.name||"tool";toolCounts[name]=(toolCounts[name]||0)+1}}turnMetrics={totalSec,queueSec,toolCounts}}}if(turnMetrics)i={...i,turnMetrics,turnSec:turnMetrics.totalSec};';
          if (content.includes(turnSecCalc)) {
            content = content.replace(turnSecCalc, "");
            modified = true;
          }

          // Older releases used slightly different JSX attributes. Match the
          // injected title and surrounding original copy-button marker rather
          // than assuming a particular minified style-object layout.
          const legacyDurationRenderer = /,e\.turnSec&&!t&&\(0,r\.jsx\)\("div",\{style:\{[^}]*\},title:"任务执行总耗时",[\s\S]*?\}\),K&&!t&&/;
          if (legacyDurationRenderer.test(content)) {
            content = content.replace(legacyDurationRenderer, ",K&&!t&&");
            modified = true;
          }
          const legacyTurnMetrics = /let turnMetrics=null;if\("assistant"===i\.role&&u&&i\.timestamp\)\{[\s\S]*?if\(turnMetrics\)i=\{\.\.\.i,turnMetrics,turnSec:turnMetrics\.totalSec\};/;
          if (legacyTurnMetrics.test(content)) {
            content = content.replace(legacyTurnMetrics, "");
            modified = true;
          }

          // Restore scrollbar on chat scroll container
          if (content.includes("[scrollbar-width:none]")) {
            content = content.replaceAll("[scrollbar-width:none]", "");
            modified = true;
          }

          // Request full history (tail 1000) on initial session load
          const pDeferClient = 'new URLSearchParams({deferThinking:"1",deferMedia:"1"})';
          const rDeferClient = 'new URLSearchParams({deferThinking:"1",deferMedia:"1",tail:"1000"})';
          if (content.includes(pDeferClient)) {
            content = content.replace(pDeferClient, rDeferClient);
            modified = true;
          }

          // Format minimap turn numbers without leading zeros (1, 2, 3... instead of 01, 02)
          const pPadClient = 'String(e.index+1).padStart(2,"0")';
          const rPadClient = 'String(e.index+1)';
          if (content.includes(pPadClient)) {
            content = content.replace(pPadClient, rPadClient);
            modified = true;
          }

          // Keep the React model selector operable while streaming. The independently
          // toggleable running-model-switch plugin owns visibility, styling and the
          // disabled-state guard; this narrow bridge only prevents React's streaming
          // prop from swallowing the native click before the plugin can handle it.
          const runningModelDisabledSource = '(t$.length>0||s||u)&&h&&(0,r.jsx)(nb,{options:t$,value:s,onChange:h,disabled:l,busy:g,isAutoSelection:a})';
          const runningModelInteractiveBridge = '(t$.length>0||s||u)&&h&&(0,r.jsx)(nb,{options:t$,value:s,onChange:h,disabled:!1,busy:g,isAutoSelection:a})';
          if (content.includes(runningModelDisabledSource)) {
            content = content.replace(runningModelDisabledSource, runningModelInteractiveBridge);
            modified = true;
          }

          // Expose a narrow client-only bridge to Pi Web's native paginated
          // context loader. The standalone minimap plugin controls when this
          // is called; keeping the React state update native preserves scroll
          // anchoring and avoids rebuilding the full session in parallel DOM.
          const minimapHistoryStateBridgeSource = 'window.__PI_ENH_GET_HISTORY_STATE__=()=>({sessionId:e?.id??eV.current??null,totalTurns:e$?.userMessages??0,hasEarlierMessages:!!ei});';
          const minimapHistoryStateBridgeTarget = 'window.__PI_ENH_GET_HISTORY_STATE__=()=>({sessionId:e?.id??eV.current??null,totalTurns:e$?.userMessages??0,hasEarlierMessages:!!ei,entryIds:en,oldestEntryId:er});';
          if (content.includes(minimapHistoryStateBridgeSource)) {
            content = content.replace(minimapHistoryStateBridgeSource, minimapHistoryStateBridgeTarget);
            modified = true;
          }

          const minimapHistoryBridgeSource = 't1=(0,i.useCallback)(()=>{tC(e=>Math.max(e,2*ee.length))},[ee.length]),t2=';
          const minimapHistoryBridgeTarget = 't1=(0,i.useCallback)(()=>{tC(e=>Math.max(e,2*ee.length))},[ee.length]);window.__PI_ENH_GET_HISTORY_STATE__=()=>({sessionId:e?.id??eV.current??null,totalTurns:e$?.userMessages??0,hasEarlierMessages:!!ei,entryIds:en,oldestEntryId:er});window.__PI_ENH_LOAD_EARLIER__=async a=>{if(tI.current||!ei||!er)return!1;let n=e?.id??eV.current;if(!n)return!1;let r=Number(a),o=Number.isFinite(r)?Math.max(50,Math.min(500,Math.round(r))):250;tI.current=!0;let l=eJ.current;l&&(tE.current=l.scrollHeight-l.scrollTop);try{return!!await tr(n,ti,er,{tail:o})}finally{tI.current=!1}};let t2=';
          const minimapHistoryBridgeSourceV3 = 'nu=(0,i.useCallback)(()=>{tP(e=>Math.max(e,2*et.length))},[et.length]),np=';
          const legacyMinimapHistoryBridgeTargetV3 = 'nu=(0,i.useCallback)(()=>{tP(e=>Math.max(e,2*et.length))},[et.length]);window.__PI_ENH_GET_HISTORY_STATE__=()=>({sessionId:e?.id??e5.current??null,totalTurns:eN?.userMessages??0,hasEarlierMessages:!!eo,entryIds:er,oldestEntryId:ei});window.__PI_ENH_LOAD_EARLIER__=async a=>{if(tV.current||!eo||!ei)return!1;let n=e?.id??e5.current;if(!n)return!1;let r=Number(a),o=Number.isFinite(r)?Math.max(50,Math.min(500,Math.round(r))):250;tV.current=!0;let l=e6.current;l&&(tK.current=l.scrollHeight-l.scrollTop);try{return!!await tf(n,tx,ei,{tail:o})}finally{tV.current=!1}};let np=';
          const minimapHistoryBridgeTargetV3 = 'nu=(0,i.useCallback)(()=>{tP(e=>Math.max(e,2*et.length))},[et.length]);(0,i.useEffect)(()=>{tP(e=>Math.max(e,2*et.length+100))},[et.length]);window.__PI_ENH_GET_HISTORY_STATE__=()=>({sessionId:e?.id??e5.current??null,totalTurns:eN?.userMessages??0,hasEarlierMessages:Boolean(eo||(tO?.current>0)),hasRemoteEarlier:!!eo,hasLocalEarlier:Boolean(tO?.current>0),localEarlierCount:tO?.current||0,entryIds:er,oldestEntryId:ei});window.__PI_ENH_LOAD_EARLIER__=async a=>{if(tV.current)return!1;let s=Boolean(tO?.current>0);if(s){tP(e=>Math.max(e,2*et.length+100));if(!eo||!ei)return!0}if(!eo||!ei)return!1;let n=e?.id??e5.current;if(!n)return!1;let r=Number(a),o=Number.isFinite(r)?Math.max(50,Math.min(500,Math.round(r))):250;tV.current=!0;let l=e6.current;l&&(tK.current=l.scrollHeight-l.scrollTop);try{let res=await tf(n,tx,ei,{tail:o});if(res)tP(e=>Math.max(e,2*et.length+100));return Boolean(res||s)}finally{tV.current=!1}};let np=';
          if (content.includes(minimapHistoryBridgeSource)) {
            content = content.replace(minimapHistoryBridgeSource, minimapHistoryBridgeTarget);
            modified = true;
          } else if (content.includes(legacyMinimapHistoryBridgeTargetV3)) {
            content = content.replace(legacyMinimapHistoryBridgeTargetV3, minimapHistoryBridgeTargetV3);
            modified = true;
          } else if (content.includes(minimapHistoryBridgeSourceV3)) {
            content = content.replace(minimapHistoryBridgeSourceV3, minimapHistoryBridgeTargetV3);
            modified = true;
          }

          // Native chat rendering splits each turn into up to 2 DOM entries in `c`
          // (ProcessDetailsGroup + answer), so the visible count floor effect must
          // grow to 2*ee.length; also upgrades chunks where the bridge is already injected.
          const historyVisibleCountEffectSource = '(0,i.useEffect)(()=>{tC(e=>Math.max(e,ee.length))},[ee.length])';
          const historyVisibleCountEffectTarget = '(0,i.useEffect)(()=>{tC(e=>Math.max(e,2*ee.length))},[ee.length])';
          if (content.includes(historyVisibleCountEffectSource)) {
            content = content.replace(historyVisibleCountEffectSource, historyVisibleCountEffectTarget);
            modified = true;
          }

          // Expose a native minimap preview close & open bridge and allow clicking
          // the currently active dot on the rail to toggle/close the preview drawer.
          const minimapCloseBridgeSource = ';(0,o.useEffect)(()=>()=>U(),[U]);';
          const minimapCloseBridgeSourceNew = ';(0,i.useEffect)(()=>()=>_(),[_]);';
          const legacyCloseBridge = ';(0,o.useEffect)(()=>{window.__PI_ENH_CLOSE_MINIMAP__=()=>{try{U();m(!1);y(null)}catch(e){}};return()=>{delete window.__PI_ENH_CLOSE_MINIMAP__;U()}},[U,m,y]);';
          const minimapCloseBridgeTarget = ';(0,o.useEffect)(()=>{window.__PI_ENH_CLOSE_MINIMAP__=()=>{try{U();m(!1);y(null)}catch(e){}};window.__PI_ENH_OPEN_MINIMAP__=(r)=>{try{U();m(!0);if(typeof r==="number")y(Math.max(0,Math.min(1,r)))}catch(e){}};window.__PI_ENH_IS_MINIMAP_OPEN__=()=>Boolean(x);return()=>{delete window.__PI_ENH_CLOSE_MINIMAP__;delete window.__PI_ENH_OPEN_MINIMAP__;delete window.__PI_ENH_IS_MINIMAP_OPEN__;U()}},[U,m,y,x]);';
          const minimapCloseBridgeTargetNew = ';(0,i.useEffect)(()=>{window.__PI_ENH_CLOSE_MINIMAP__=()=>{try{_();m(!1);b(null)}catch(e){}};window.__PI_ENH_OPEN_MINIMAP__=(r)=>{try{_();m(!0);if(typeof r==="number")b(Math.max(0,Math.min(1,r)))}catch(e){}};window.__PI_ENH_IS_MINIMAP_OPEN__=()=>Boolean(x);return()=>{delete window.__PI_ENH_CLOSE_MINIMAP__;delete window.__PI_ENH_OPEN_MINIMAP__;delete window.__PI_ENH_IS_MINIMAP_OPEN__;_()}},[_,m,b,x]);';
          if (content.includes(legacyCloseBridge)) {
            content = content.replace(legacyCloseBridge, minimapCloseBridgeTarget);
            modified = true;
          } else if (content.includes(minimapCloseBridgeSource)) {
            content = content.replace(minimapCloseBridgeSource, minimapCloseBridgeTarget);
            modified = true;
          } else if (content.includes(minimapCloseBridgeSourceNew)) {
            content = content.replace(minimapCloseBridgeSourceNew, minimapCloseBridgeTargetNew);
            modified = true;
          }

          const minimapActiveDotSource = 'let V=(0,o.useCallback)(e=>{if(!a)return;b.current=!0,q();let t=e.currentTarget.getBoundingClientRect();y(Math.max(0,Math.min(1,(e.clientY-t.top)/t.height)));let n=(e,n)=>{let r=H(Math.max(0,Math.min(1,(e-t.top)/t.height)));r&&_(r,n)};n(e.clientY,"smooth");let r=e=>{b.current&&n(e.clientY,"auto")},i=()=>{b.current=!1,window.removeEventListener("mousemove",r),window.removeEventListener("mouseup",i)};window.addEventListener("mousemove",r),window.addEventListener("mouseup",i)},[H,_,q,a])';
          const minimapActiveDotTarget = 'let V=(0,o.useCallback)(e=>{if(!a)return;let t=e.currentTarget.getBoundingClientRect(),trgt=H(Math.max(0,Math.min(1,(e.clientY-t.top)/t.height)));if(x&&trgt&&trgt.index===p){U();m(!1);y(null);return}b.current=!0,q();y(Math.max(0,Math.min(1,(e.clientY-t.top)/t.height)));let n=(e,n)=>{let r=H(Math.max(0,Math.min(1,(e-t.top)/t.height)));r&&_(r,n)};n(e.clientY,"smooth");let r=e=>{b.current&&n(e.clientY,"auto")},i=()=>{b.current=!1,window.removeEventListener("mousemove",r),window.removeEventListener("mouseup",i)};window.addEventListener("mousemove",r),window.addEventListener("mouseup",i)},[H,_,q,a,x,p,U,m,y])';
          if (content.includes(minimapActiveDotSource)) {
            content = content.replace(minimapActiveDotSource, minimapActiveDotTarget);
            modified = true;
          }

          // Route the native session-group list through the standalone
          // enhancement runtime. This preserves the original grouping and
          // recency sort while allowing the plugin to filter archives and
          // raise pinned groups without changing agent session files.
          const sessionGroupSort = 'return[...n.values()].sort((e,t)=>t.latestModified.localeCompare(e.latestModified))}';
          const sessionGroupSortHook = 'let a=[...n.values()].sort((e,t)=>t.latestModified.localeCompare(e.latestModified));try{let e=window.__PI_ENH_PROCESS_SESSION_GROUPS__;return"function"==typeof e?e(a):a}catch{return a}}';
          if (content.includes(sessionGroupSort)) {
            content = content.replace(sessionGroupSort, sessionGroupSortHook);
            modified = true;
          }

          // The enhancement runtime needs the native React refresh callback
          // so an archive or pin action takes effect immediately, without a
          // page reload or a Pi Web service restart.
          const sessionRefreshSuffix = 'finally{n===z.current&&A(!1)}},[]),tp=(0,i.useRef)(!1);';
          const sessionRefreshHook = 'finally{n===z.current&&A(!1)}},[]),tp=(window.__PI_ENH_REFRESH_SESSIONS__=(e=!1,t=!1)=>tu(e,t),window.__PI_ENH_GET_RAW_SESSIONS__=()=>R,window.__PI_ENH_RERENDER_SESSIONS__=()=>{try{L(prev=>Array.isArray(prev)?[...prev]:prev)}catch(e){}},window.__PI_ENH_SESSION_DELETED__=e=>{try{p?.(e)}catch{}},window.__PI_ENH_SET_UNREAD_SESSION__=(sId,isU)=>{try{e5(prev=>{let next=new Set(prev);if(isU)next.add(sId);else next.delete(sId);return next;})}catch(e){}},window.__PI_ENH_IS_SESSION_UNREAD__=(sId)=>Boolean(e8?.has?.(sId)),(0,i.useRef)(!1));';
          const sessionRefreshSuffixV3 = 'finally{r===W.current&&P(!1)}},[]),tw=(0,i.useRef)(!1);';
          const sessionRefreshHookV3 = 'finally{r===W.current&&P(!1)}},[]),tw=(window.__PI_ENH_REFRESH_SESSIONS__=(e=!1,t=!1)=>tb(e,t),window.__PI_ENH_GET_RAW_SESSIONS__=()=>L,window.__PI_ENH_RERENDER_SESSIONS__=()=>{try{$(prev=>Array.isArray(prev)?[...prev]:prev)}catch(e){}},window.__PI_ENH_SESSION_DELETED__=e=>{try{p?.(e)}catch{}},window.__PI_ENH_SET_UNREAD_SESSION__=(sId,isU)=>{try{e8(prev=>{let next=new Set(prev);if(isU)next.add(sId);else next.delete(sId);return next;})}catch(e){}},window.__PI_ENH_IS_SESSION_UNREAD__=(sId)=>Boolean(e4?.has?.(sId)),(0,i.useRef)(!1));';
          const previousSessionRefreshHook4 = 'finally{n===z.current&&A(!1)}},[]),tp=(window.__PI_ENH_REFRESH_SESSIONS__=(e=!1,t=!1)=>tu(e,t),window.__PI_ENH_SESSION_DELETED__=e=>{try{p?.(e)}catch{}},window.__PI_ENH_SET_UNREAD_SESSION__=(sId,isU)=>{try{e5(prev=>{let next=new Set(prev);if(isU)next.add(sId);else next.delete(sId);return next;})}catch(e){}},window.__PI_ENH_IS_SESSION_UNREAD__=(sId)=>Boolean(e8?.has?.(sId)),(0,i.useRef)(!1));';
          const previousSessionRefreshHook3 = 'finally{n===z.current&&A(!1)}},[]),tp=(window.__PI_ENH_REFRESH_SESSIONS__=(e=!1,t=!1)=>tu(e,t),window.__PI_ENH_SESSION_DELETED__=e=>{try{p?.(e)}catch{}},(0,i.useRef)(!1));';
          const previousSessionRefreshHook = 'finally{n===z.current&&A(!1)}},[]),tp=(window.__PI_ENH_REFRESH_SESSIONS__=()=>tu(),(0,i.useRef)(!1));';
          const previousSessionRefreshHook2 = 'finally{n===z.current&&A(!1)}},[]),tp=(window.__PI_ENH_REFRESH_SESSIONS__=()=>tu(),window.__PI_ENH_SESSION_DELETED__=e=>{try{p?.(e)}catch{}},(0,i.useRef)(!1));';
          const currentSessionRefreshHook = 'window.__PI_ENH_REFRESH_SESSIONS__=e,()=>{window.__PI_ENH_REFRESH_SESSIONS__===e&&delete window.__PI_ENH_REFRESH_SESSIONS__}}';
          const currentSessionRefreshTarget = 'window.__PI_ENH_REFRESH_SESSIONS__=e,window.__PI_ENH_SESSION_DELETED__=r=>{try{p?.(r)}catch{}},()=>{window.__PI_ENH_REFRESH_SESSIONS__===e&&delete window.__PI_ENH_REFRESH_SESSIONS__;delete window.__PI_ENH_SESSION_DELETED__}}';
          const legacyEffectRefreshFn = 'let e=()=>{tu()};';
          const parameterizedEffectRefreshFn = 'let e=(e=!1,t=!1)=>{tu(e,t)};';
          if (content.includes(sessionRefreshSuffix)) {
            content = content.replace(sessionRefreshSuffix, sessionRefreshHook);
            modified = true;
          } else if (content.includes(sessionRefreshSuffixV3)) {
            content = content.replace(sessionRefreshSuffixV3, sessionRefreshHookV3);
            modified = true;
          } else if (content.includes(previousSessionRefreshHook4)) {
            content = content.replace(previousSessionRefreshHook4, sessionRefreshHook);
            modified = true;
          } else if (content.includes(previousSessionRefreshHook3)) {
            content = content.replace(previousSessionRefreshHook3, sessionRefreshHook);
            modified = true;
          } else if (content.includes(previousSessionRefreshHook2)) {
            content = content.replace(previousSessionRefreshHook2, sessionRefreshHook);
            modified = true;
          } else if (content.includes(previousSessionRefreshHook)) {
            content = content.replace(previousSessionRefreshHook, sessionRefreshHook);
            modified = true;
          } else if (content.includes(currentSessionRefreshHook)) {
            content = content.replace(currentSessionRefreshHook, currentSessionRefreshTarget);
            modified = true;
          }
          if (content.includes(legacyEffectRefreshFn)) {
            content = content.replace(legacyEffectRefreshFn, parameterizedEffectRefreshFn);
            modified = true;
          }

          // Give the plugin stable, scoped DOM anchors for a Codex-style
          // overflow menu. The original edit/delete actions remain available
          // programmatically through this named container.
          const sessionRowPrefix = 'return(0,r.jsx)("div",{onClick:S||b?void 0:l,onContextMenu:S||b?void 0:A,';
          const sessionRowHook = 'return(0,r.jsx)("div",{"data-pi-enh-session-id":e.id,className:"pi-enh-session-row-host",onClick:S||b?void 0:l,onContextMenu:S||b?void 0:A,';
          if (content.includes(sessionRowPrefix)) {
            content = content.replace(sessionRowPrefix, sessionRowHook);
            modified = true;
          }

          // Render visual section headers (Pinned & Recents) in the sidebar
          // virtual session list with precise offset heights when pinned sessions exist.
          const sessionListHeadersSource = 'tD.length>0&&(0,r.jsx)("div",{style:{position:"relative",height:54*tD.length},children:tH.map(t=>{let n=tD[t],i=[n.root,...n.subagents],o=n.latestModified===n.root.modified?n.root:{...n.root,modified:n.latestModified};return(0,r.jsx)("div",{onFocus:()=>ta(n.root.id),onBlur:()=>ta(null),style:{position:"absolute",top:54*t,left:0,right:0},children:(0,r.jsx)(el,{session:o,isSelected:i.some(t=>t.id===e),isRunning:i.some(e=>e2.has(e.id)),isUnread:i.some(e=>e8.has(e.id)),onClick:()=>tT(n.root),onRenamed:tu,onDeleted:e=>{p?.(e),tu()}})},n.root.id)})})';
          const sessionListHeadersTarget = 'tD.length>0&&(0,r.jsx)("div",{style:{position:"relative",height:54*tD.length+(window.__PI_ENH_GET_SESSION_HEADERS_HEIGHT__?.(tD)||0)},children:[...(window.__PI_ENH_GET_SESSION_HEADERS__?.(r,tD)||[]),...tH.map(t=>{let n=tD[t],i=[n.root,...n.subagents],o=n.latestModified===n.root.modified?n.root:{...n.root,modified:n.latestModified};return(0,r.jsx)("div",{onFocus:()=>ta(n.root.id),onBlur:()=>ta(null),style:{position:"absolute",top:(window.__PI_ENH_GET_SESSION_ITEM_TOP__?.(t,tD)??54*t),left:0,right:0},children:(0,r.jsx)(el,{session:o,isSelected:i.some(t=>t.id===e),isRunning:i.some(e=>e2.has(e.id)),isUnread:i.some(e=>e8.has(e.id)),onClick:()=>tT(n.root),onRenamed:tu,onDeleted:e=>{p?.(e),tu()}})},n.root.id)})]})';
          const sessionListHeadersMalformed = 'tD.length>0&&(0,r.jsx)("div",{style:{position:"relative",height:54*tD.length+(window.__PI_ENH_GET_SESSION_HEADERS_HEIGHT__?.(tD)||0)},children:[...(window.__PI_ENH_GET_SESSION_HEADERS__?.(r,tD)||[]),...tH.map(t=>{let n=tD[t],i=[n.root,...n.subagents],o=n.latestModified===n.root.modified?n.root:{...n.root,modified:n.latestModified};return(0,r.jsx)("div",{onFocus:()=>ta(n.root.id),onBlur:()=>ta(null),style:{position:"absolute",top:(window.__PI_ENH_GET_SESSION_ITEM_TOP__?.(t,tD)??54*t),left:0,right:0},children:(0,r.jsx)(el,{session:o,isSelected:i.some(t=>t.id===e),isRunning:i.some(e=>e2.has(e.id)),isUnread:i.some(e=>e8.has(e.id)),onClick:()=>tT(n.root),onRenamed:tu,onDeleted:e=>{p?.(e),tu()}})},n.root.id)})})';
          const winSessionListHeadersSource = 't_.length>0&&(0,r.jsx)("div",{style:{position:"relative",height:54*t_.length},children:tD.map(t=>{let n=t_[t],i=[n.root,...n.subagents],o=n.latestModified===n.root.modified?n.root:{...n.root,modified:n.latestModified};return(0,r.jsx)("div",{onFocus:()=>ta(n.root.id),onBlur:()=>ta(null),style:{position:"absolute",top:54*t,left:0,right:0},children:(0,r.jsx)(ea,{session:o,isSelected:i.some(t=>t.id===e),isRunning:i.some(e=>e2.has(e.id)),isUnread:i.some(e=>e8.has(e.id)),onClick:()=>tT(n.root),onRenamed:tu,onDeleted:e=>{p?.(e),tu()}})},n.root.id)})})';
          const winSessionListHeadersTarget = 't_.length>0&&(0,r.jsx)("div",{style:{position:"relative",height:54*t_.length+(window.__PI_ENH_GET_SESSION_HEADERS_HEIGHT__?.(t_)||0)},children:[...(window.__PI_ENH_GET_SESSION_HEADERS__?.(r,t_)||[]),...tD.map(t=>{let n=t_[t],i=[n.root,...n.subagents],o=n.latestModified===n.root.modified?n.root:{...n.root,modified:n.latestModified};return(0,r.jsx)("div",{onFocus:()=>ta(n.root.id),onBlur:()=>ta(null),style:{position:"absolute",top:(window.__PI_ENH_GET_SESSION_ITEM_TOP__?.(t,t_)??54*t),left:0,right:0},children:(0,r.jsx)(ea,{session:o,isSelected:i.some(t=>t.id===e),isRunning:i.some(e=>e2.has(e.id)),isUnread:i.some(e=>e8.has(e.id)),onClick:()=>tT(n.root),onRenamed:tu,onDeleted:e=>{p?.(e),tu()}})},n.root.id)})]})';
          const sessionListHeadersSourceV3 = 'tY.length>0&&(0,r.jsx)("div",{style:{position:"relative",height:54*tY.length+(window.__PI_ENH_GET_SESSION_HEADERS_HEIGHT__?.(tY)||0)},children:tZ.map(t=>{let n=tY[t],i=[n.root,...n.subagents],o=n.latestModified===n.root.modified?n.root:{...n.root,modified:n.latestModified};return(0,r.jsx)("div",{onFocus:()=>tf(n.root.id),onBlur:()=>tf(null),style:{position:"absolute",top:window.__PI_ENH_GET_SESSION_ITEM_TOP__?.(t,tY)??54*t,left:0,right:0},children:(0,r.jsx)(ec,{session:o,isSelected:i.some(t=>t.id===e),isRunning:i.some(e=>e1.has(e.id)),isUnread:i.some(e=>e4.has(e.id)),onClick:()=>tP(n.root),onRenamed:tb,onDeleted:e=>{p?.(e),tb()}})},n.root.id)})})';
          const sessionListHeadersTargetV3 = 'tY.length>0&&(0,r.jsx)("div",{style:{position:"relative",height:54*tY.length+(window.__PI_ENH_GET_SESSION_HEADERS_HEIGHT__?.(tY)||0)},children:[...(window.__PI_ENH_GET_SESSION_HEADERS__?.(r,tY)||[]),...tZ.map(t=>{let n=tY[t],i=[n.root,...n.subagents],o=n.latestModified===n.root.modified?n.root:{...n.root,modified:n.latestModified};return(0,r.jsx)("div",{onFocus:()=>tf(n.root.id),onBlur:()=>tf(null),style:{position:"absolute",top:window.__PI_ENH_GET_SESSION_ITEM_TOP__?.(t,tY)??54*t,left:0,right:0},children:(0,r.jsx)(ec,{session:o,isSelected:i.some(t=>t.id===e),isRunning:i.some(e=>e1.has(e.id)),isUnread:i.some(e=>e4.has(e.id)),onClick:()=>tP(n.root),onRenamed:tb,onDeleted:e=>{p?.(e),tb()}})},n.root.id)})]})';
          if (content.includes(sessionListHeadersMalformed)) {
            content = content.replace(sessionListHeadersMalformed, sessionListHeadersTarget);
            modified = true;
          } else if (content.includes(sessionListHeadersSource)) {
            content = content.replace(sessionListHeadersSource, sessionListHeadersTarget);
            modified = true;
          } else if (content.includes(winSessionListHeadersSource)) {
            content = content.replace(winSessionListHeadersSource, winSessionListHeadersTarget);
            modified = true;
          } else if (content.includes(sessionListHeadersSourceV3)) {
            content = content.replace(sessionListHeadersSourceV3, sessionListHeadersTargetV3);
            modified = true;
          }

          // 彻底根除 Next.js 路由的 S.replace，直接替换为原生的 window.history.replaceState
          // 彻底杜绝 Next.js 16.3.1 的 RSC 请求与 Minified React error #412 ("Connection closed") 崩溃
          // 同时杜绝嵌套问题：替换后不再包含 S.replace 模式，保证 100% 幂等
          const navRegex = /([a-zA-Z0-9_$]+)\.replace\(`\?session=\$\{encodeURIComponent\(([a-zA-Z0-9_$]+(?:\.id)?)\)\}`,\{scroll:!1\}\)/g;
          if (navRegex.test(content)) {
            content = content.replace(navRegex, '(typeof window!=="undefined"?(window.__PI_ENH_SESSION_MEMORY_NAV__?.($2),window.history.replaceState(null,"",`?session=${encodeURIComponent($2)}`)):void 0)');
            modified = true;
          }

          // 彻底根除 S.replace(window.location.pathname,{scroll:!1})，替换为纯客户端安全重置 window.history.replaceState(null,"","/")
          // 杜绝切换工作区 (onCwdChange)、新建会话 (onNewSession)、删除会话 (onSessionDeleted) 时触发的破坏性 RSC 请求与 404 错误
          const pathnameNavRegex = /([a-zA-Z0-9_$]+)\.replace\(\s*(?:window\.)?location\.pathname\s*,\s*\{\s*scroll:\s*!1\s*\}\s*\)/g;
          if (pathnameNavRegex.test(content)) {
            content = content.replace(pathnameNavRegex, '(typeof window!=="undefined"?window.history.replaceState(null,"","/"):void 0)');
            modified = true;
          }

          // Expose a native session reload bridge so background cache revalidation
          // can transparently stream the latest completed messages into React state
          // without requiring a full manual browser refresh.
          const sessionReloadBridgeSource = 'finally{t&&!r&&w(!1)}},[tb,tE]),tL=';
          const sessionReloadBridgeTarget = 'finally{t&&!r&&w(!1)}},[tb,tE]),tp_enh_reload=(typeof window!=="undefined"?(window.__PI_ENH_RELOAD_CURRENT_SESSION__=(t=!1)=>{let s=e8.current;if(s)return tR(s,t,!0)},null):null),tL=';
          if (content.includes(sessionReloadBridgeSource)) {
            content = content.replace(sessionReloadBridgeSource, sessionReloadBridgeTarget);
            modified = true;
          }

          const sessionReloadBridgeSourceV2 = 'finally{t&&!r&&b(!1)}},[ty,tC]),tR=';
          const sessionReloadBridgeLegacyV2 = 'finally{t&&!r&&b(!1)}},[ty,tC]),tp_enh_reload=(typeof window!=="undefined"?(window.__PI_WEB_RELOAD_SESSION__=(...args)=>tI(...args),window.__PI_ENH_RELOAD_CURRENT_SESSION__=(t=!1)=>{let s=e4.current;if(s)return tI(s,t,!0)},null):null),tR=';
          const sessionReloadBridgeTargetV2 = 'finally{t&&!r&&b(!1)}},[ty,tC]),tp_enh_reload=(typeof window!=="undefined"?(window.__PI_WEB_RELOAD_SESSION__=(...args)=>tI(...args),window.__PI_WEB_NATIVE_RELOAD_CURRENT_SESSION__=(t=!1)=>{let s=e4.current;if(s)return tI(s,t,!0)},window.__PI_ENH_RELOAD_CURRENT_SESSION__||(window.__PI_ENH_RELOAD_CURRENT_SESSION__=(t=!1)=>{let s=e4.current;if(s)return tI(s,t,!0)}),null):null),tR=';
          const sessionReloadBridgeSourceV3 = 'finally{c()&&t&&!i&&b(!1)}})();return t$.current.set(d,g),g.finally(()=>{t$.current.get(d)===g&&t$.current.delete(d)}),await g},[tF,tV]),tX=';
          const sessionReloadBridgeTargetV3 = 'finally{c()&&t&&!i&&b(!1)}})();return t$.current.set(d,g),g.finally(()=>{t$.current.get(d)===g&&t$.current.delete(d)}),await g},[tF,tV]),tp_enh_reload=(typeof window!=="undefined"?(window.__PI_WEB_RELOAD_SESSION__=(...args)=>tG(...args),window.__PI_WEB_NATIVE_RELOAD_CURRENT_SESSION__=(t=!1)=>{let s=tr.current;if(s)return tG(s,t,!0,{force:!0})},window.__PI_ENH_RELOAD_CURRENT_SESSION__||(window.__PI_ENH_RELOAD_CURRENT_SESSION__=(t=!1)=>{let s=tr.current;if(s)return tG(s,t,!0,{force:!0})}),null):null),tX=';
          if (content.includes(sessionReloadBridgeLegacyV2)) {
            content = content.replace(sessionReloadBridgeLegacyV2, sessionReloadBridgeTargetV2);
            modified = true;
          } else if (content.includes(sessionReloadBridgeSourceV2)) {
            content = content.replace(sessionReloadBridgeSourceV2, sessionReloadBridgeTargetV2);
            modified = true;
          } else if (content.includes(sessionReloadBridgeSourceV3)) {
            content = content.replace(sessionReloadBridgeSourceV3, sessionReloadBridgeTargetV3);
            modified = true;
          }

          const nativeSessionActions = 'x&&!e.transient&&(0,r.jsxs)("div",{style:{display:"flex",gap:4,flexShrink:0},children:';
          const legacyNamedNativeSessionActions = 'x&&!e.transient&&(0,r.jsxs)("div",{className:"pi-enh-native-session-actions",style:{display:"flex",gap:4,flexShrink:0},children:';
          const namedNativeSessionActions = '!e.transient&&(0,r.jsxs)("div",{className:"pi-enh-native-session-actions",style:{display:"flex",gap:4,flexShrink:0},children:';
          if (content.includes(legacyNamedNativeSessionActions)) {
            content = content.replace(legacyNamedNativeSessionActions, namedNativeSessionActions);
            modified = true;
          } else if (content.includes(nativeSessionActions)) {
            content = content.replace(nativeSessionActions, namedNativeSessionActions);
            modified = true;
          }

          const searchResultsMap = 'h?.results.map(({session:e,entryId:t,blockIndex:n,before:i,match:o,after:a})=>(0,r.jsxs)("button",{';
          const legacySearchResultsHook = '(typeof window!=="undefined"&&window.__PI_ENH_PROCESS_SEARCH_RESULTS__?window.__PI_ENH_PROCESS_SEARCH_RESULTS__(h?.results):h?.results)?.map(({session:e,entryId:t,blockIndex:n,before:i,match:o,after:a})=>(0,r.jsxs)("button",{"data-search-session-id":e.id,';
          const legacySearchResultsHook2 = '(typeof window!=="undefined"&&window.__PI_ENH_PROCESS_SEARCH_RESULTS__?window.__PI_ENH_PROCESS_SEARCH_RESULTS__(h?.results):h?.results)?.map(({session:e,entryId:t,blockIndex:n,before:i,match:o,after:a,isArchived:d,isFirstArchived:c,archivedSearchCount:u})=>(0,r.jsxs)("button",{"data-search-session-id":e.id,"data-search-archived":d?"true":void 0,"data-search-archived-first":c?"true":void 0,"data-search-archive-divider":c?`已归档会话 · ${u} 个匹配`:void 0,';
          const legacySearchResultsHook3 = '(typeof window!=="undefined"&&window.__PI_ENH_PROCESS_SEARCH_RESULTS__?window.__PI_ENH_PROCESS_SEARCH_RESULTS__(h?.results):h?.results)?.map(({session:e,entryId:t,blockIndex:n,before:i,match:o,after:a,isArchived:d,isFirstArchived:c,archivedSearchCount:u,searchGroup:g,isOtherProject:p,isFirstOther:f,otherSearchCount:k})=>(0,r.jsxs)("button",{"data-search-session-id":e.id,"data-search-group":g||(d?"archived":"current"),"data-search-archived":d?"true":void 0,"data-search-archived-first":c?"true":void 0,"data-search-archive-divider":c?`已归档会话 · ${u} 个匹配`:void 0,"data-search-other":p?"true":void 0,"data-search-other-first":f?"true":void 0,"data-search-other-count":f?k:void 0,';
          // Keep the grouping marker in React's element props. Unlike a
          // post-render sibling insertion, React will reconcile it on every
          // keystroke and cannot leave duplicate archived dividers behind.
          const searchResultsHook = '(typeof window!=="undefined"&&window.__PI_ENH_PROCESS_SEARCH_RESULTS__?window.__PI_ENH_PROCESS_SEARCH_RESULTS__(h?.results):h?.results)?.map(({session:e,entryId:t,blockIndex:n,before:i,match:o,after:a,isArchived:d,isFirstArchived:c,archivedSearchCount:u,searchGroup:g,isOtherProject:p,isFirstOther:f,otherSearchCount:k,searchProjectKey:w,searchProjectTitle:j})=>(0,r.jsxs)("button",{"data-search-session-id":e.id,"data-search-group":g||(d?"archived":"current"),"data-search-project-key":w||void 0,"data-search-project-title":j||void 0,"data-search-archived":d?"true":void 0,"data-search-archived-first":c?"true":void 0,"data-search-archive-divider":c?`已归档会话 · ${u} 个匹配`:void 0,"data-search-other":p?"true":void 0,"data-search-other-first":f?"true":void 0,"data-search-other-count":f?k:void 0,';
          if (content.includes(searchResultsMap)) {
            content = content.replace(searchResultsMap, searchResultsHook);
            modified = true;
          } else if (content.includes(legacySearchResultsHook)) {
            content = content.replace(legacySearchResultsHook, searchResultsHook);
            modified = true;
          } else if (content.includes(legacySearchResultsHook2)) {
            content = content.replace(legacySearchResultsHook2, searchResultsHook);
            modified = true;
          } else if (content.includes(legacySearchResultsHook3)) {
            content = content.replace(legacySearchResultsHook3, searchResultsHook);
            modified = true;
          }

          // 将搜索输入防抖从 300ms 优化为 120ms，且将依赖严格收敛为 [e,p]（仅在 open 与 query 改变时触发）
          // 彻底阻断后台普通会话版本 bump (n / sessionListVersion) 导致的搜索死循环、清空与无限跳动
          const searchDebounceSource = 'catch{t.signal.aborted||u({query:p,failed:!0})}},300);return()=>{clearTimeout(n),t.abort()}},[e,p,n])';
          const searchDebounceLegacyTarget = 'catch{t.signal.aborted||u({query:p,failed:!0})}},120);return()=>{clearTimeout(n),t.abort()}},[e,p,n])';
          const searchDebounceTarget = 'catch{t.signal.aborted||u({query:p,failed:!0})}},120);return()=>{clearTimeout(n),t.abort()}},[e,p])';
          if (content.includes(searchDebounceLegacyTarget)) {
            content = content.replace(searchDebounceLegacyTarget, searchDebounceTarget);
            modified = true;
          } else if (content.includes(searchDebounceSource)) {
            content = content.replace(searchDebounceSource, searchDebounceTarget);
            modified = true;
          }

          // Default process details groups (ProcessDetailsGroup / rM) to
          // collapsed on mount when the task-tool-auto-collapse plugin is active.
          const rMInternalSource = 'function rM({messageCount:e,toolCallCount:t,defaultExpanded:n=!1,reveal:o=!1,children:l,t:s}){let[a,d]=(0,i.useState)(n);(0,i.useLayoutEffect)(()=>{o&&d(!0)},[o]);';
          const rMInternalTarget = 'function rM({messageCount:e,toolCallCount:t,defaultExpanded:n=!1,reveal:o=!1,children:l,t:s}){let[a,d]=(0,i.useState)((typeof window!=="undefined"&&window.__PI_ENH_IS_PLUGIN_ENABLED__&&window.__PI_ENH_IS_PLUGIN_ENABLED__("task-tool-auto-collapse"))?!1:n);(0,i.useLayoutEffect)(()=>{if(typeof window!=="undefined"&&window.__PI_ENH_IS_PLUGIN_ENABLED__&&window.__PI_ENH_IS_PLUGIN_ENABLED__("task-tool-auto-collapse"))return;o&&d(!0)},[o]);';
          if (content.includes(rMInternalSource)) {
            content = content.replace(rMInternalSource, rMInternalTarget);
            modified = true;
          }

          const processDetailsGroupSource = '(0,r.jsx)(rM,{messageCount:f.length,toolCallCount:x,defaultExpanded:!p,reveal:m,t:F,children:f})';
          const processDetailsGroupTarget = '(0,r.jsx)(rM,{messageCount:f.length,toolCallCount:x,defaultExpanded:(typeof window!=="undefined"&&window.__PI_ENH_IS_PLUGIN_ENABLED__&&window.__PI_ENH_IS_PLUGIN_ENABLED__("task-tool-auto-collapse")?!1:!p),reveal:(typeof window!=="undefined"&&window.__PI_ENH_IS_PLUGIN_ENABLED__&&window.__PI_ENH_IS_PLUGIN_ENABLED__("task-tool-auto-collapse")?!1:m),t:F,children:f})';
          if (content.includes(processDetailsGroupSource)) {
            content = content.replace(processDetailsGroupSource, processDetailsGroupTarget);
            modified = true;
          }

          // Force client-side session reload (tI) to fetch authoritative non-cached data
          // and expose window.__PI_WEB_RELOAD_SESSION__ for instant guaranteed sync on task finish
          const sessionFetchOld = 'let i=new URLSearchParams({deferThinking:"1",deferMedia:"1",tail:"1000"}),o=await fetch(`/api/sessions/${encodeURIComponent(e)}?${i}`);';
          const sessionFetchNew = 'let i=new URLSearchParams({deferThinking:"1",deferMedia:"1",tail:"1000"}),o=await fetch(`/api/sessions/${encodeURIComponent(e)}?${i}`,{cache:"no-store"});';
          if (content.includes(sessionFetchOld)) {
            content = content.replace(sessionFetchOld, sessionFetchNew);
            modified = true;
          }

          const tiEndMatch = /(finally\{t&&!r&&b\(!1\)\}\},\[[\w$,]+\]),/.exec(content);
          if (tiEndMatch && !content.includes("window.__PI_WEB_RELOAD_SESSION__")) {
            content = content.replace(tiEndMatch[0], `${tiEndMatch[1]},(typeof window!=="undefined"&&(window.__PI_WEB_RELOAD_SESSION__=tI)),`);
            modified = true;
          }

          const nativeCollapse = require("./pi-web-native-collapse-patch.js").patchNativeProcessCollapse(content);
          if (nativeCollapse.code !== content) {
            content = nativeCollapse.code;
            modified = true;
          }

          if (modified) {
            safeWriteFileSync(fullPath, content, "utf8");
          }
        }
      }
    }

    // 3.5 Patch public/sw.js to prevent stale immutable static caching
    patchPublicServiceWorker(pkgDir, assetBuild);

    // Static-only live deployment may update public assets and .next/static client chunks,
    // but must return before touching any running .next/server files.
    if (staticOnly) return;

    // 3.6 Stamp ?v=<version>-<assetBuild> onto layout-*.js and page-*.js in pre-rendered HTML & RSC manifests
    // so browsers with cached immutable /_next/static/chunks/app/*.js immediately fetch the v1.0.0 bundle.
    const cacheBustQuery = `?v=${STANDALONE_BASE_VERSION}-${assetBuild}`;
    for (const htmlRel of [
      ["server", "app", "index.html"],
      ["server", "app", "login.html"],
      ["server", "pages", "404.html"],
      ["server", "app", "page_client-reference-manifest.js"],
      ["server", "app", "login", "page_client-reference-manifest.js"],
      ["server", "app", "index.rsc"],
      ["server", "app", "login.rsc"],
    ]) {
      const htmlPath = path.join(pkgDir, ".next", ...htmlRel);
      if (fs.existsSync(htmlPath)) {
        let html = fs.readFileSync(htmlPath, "utf8");
        const stamped = html
          .replace(/(static\/chunks\/app\/layout-[a-f0-9]+\.js)(?:\?v=[A-Za-z0-9._-]+)?/g, `$1${cacheBustQuery}`)
          .replace(/(static\/chunks\/app\/page-[a-f0-9]+\.js)(?:\?v=[A-Za-z0-9._-]+)?/g, `$1${cacheBustQuery}`);
        if (stamped !== html) {
          safeWriteFileSync(htmlPath, stamped, "utf8");
        }
      }
    }

    // Always keep server-rendered version strings aligned: web = STANDALONE_BASE_VERSION (1.0.0), pi = officialPiVersion
    const serverPageForVer = path.join(pkgDir, ".next", "server", "app", "page.js");
    if (fs.existsSync(serverPageForVer)) {
      let spContent = fs.readFileSync(serverPageForVer, "utf8");
      const spPatched = patchWebAndOfficialPiVersionStrings(spContent, STANDALONE_BASE_VERSION, officialPiVersion);
      if (spPatched !== spContent) {
        safeWriteFileSync(serverPageForVer, spPatched, "utf8");
      }
    }

    const appUpdateRouteForVer = path.join(pkgDir, ".next", "server", "app", "api", "app-update", "route.js");
    if (fs.existsSync(appUpdateRouteForVer)) {
      let auContent = fs.readFileSync(appUpdateRouteForVer, "utf8");
      const auPatched = auContent.replace(
        /let g="force-dynamic",h="[0-9]+\.[0-9]+\.[0-9]+",i=(?:"1"===process\.env\.PI_WEB_SKIP_VERSION_CHECK|!0)/g,
        `let g="force-dynamic",h="${STANDALONE_BASE_VERSION}",i=!0`
      );
      if (auPatched !== auContent) {
        safeWriteFileSync(appUpdateRouteForVer, auPatched, "utf8");
      }
    }

    // 4. Remove the retired server-HTML runtime. It can remain cached by a
    // running Next server and prevent the current layout chunk from loading.
    const indexHtmlPath = path.join(pkgDir, ".next", "server", "app", "index.html");
    if (fs.existsSync(indexHtmlPath)) {
      let html = fs.readFileSync(indexHtmlPath, "utf8");
      const tagStart = '<script id="pi-web-enhancements">';
      const tagEnd = "</script>";
      let start = html.indexOf(tagStart);
      while (start !== -1) {
        const end = html.indexOf(tagEnd, start);
        if (end === -1) break;
        html = html.slice(0, start) + html.slice(end + tagEnd.length);
        start = html.indexOf(tagStart);
      }
      safeWriteFileSync(indexHtmlPath, html, "utf8");
    }

    // 5. Patch server-side page.js (Escape key)
    const serverPage = path.join(pkgDir, ".next", "server", "app", "page.js");
    if (fs.existsSync(serverPage)) {
      let content = fs.readFileSync(serverPage, "utf8");

      // Keep server-rendered state reads consistent with the client bundle;
      // otherwise a remounted session can receive a cached empty queue.
      const stateReadsPatched = content
        .replace(/fetch\((`\/api\/sessions\/\$\{encodeURIComponent\([^)]*\)\}\/state`)\)(?!,\{cache:"no-store"\})/g, 'fetch($1,{cache:"no-store"})')
        .replace(/fetch\((`\/api\/agent\/\$\{encodeURIComponent\([^)]*\)\}`)\)(?!,\{cache:"no-store"\})/g, 'fetch($1,{cache:"no-store"})');
      if (stateReadsPatched !== content) {
        content = stateReadsPatched;
      }

      const p3 = 'if("Escape"===a.key&&!i&&e&&b){a.preventDefault(),b();return}';
      const r3 = 'if(false&&"Escape"===a.key&&!i&&e&&b){a.preventDefault(),b();return}';
      if (content.includes(p3)) {
        content = content.replace(p3, r3);
      }

      // Remove the old core-bundle duration renderer and calculation. It was
      // a duplicate, brittle injection path that could disagree with API data.
      const pDurS = ',Q&&!b&&(0,r.jsxs)("button",{onClick:()=>{pq(Q)';
      const rDurS = ',a.turnSec&&!b&&(0,r.jsx)("div",{style:{fontSize:11,color:"#38bdf8",display:"flex",alignItems:"center",gap:3,marginLeft:a.usage?4:0,cursor:"pointer",fontWeight:500},title:"任务执行总耗时","data-total-sec":a.turnSec,"data-queue-sec":a.turnMetrics?.queueSec||0,"data-tools":JSON.stringify(a.turnMetrics?.toolCounts||{}),"data-u-time":a.turnMetrics?.uTime||0,"data-a-time":a.turnMetrics?.aTime||0,children:[(a.usage?"· ⏱️ ":"⏱️ "),a.turnSec<60?a.turnSec+"s":Math.floor(a.turnSec/60)+"m "+(a.turnSec%60)+"s"]})' + pDurS;
      if (content.includes(rDurS)) {
        content = content.replace(rDurS, pDurS);
      }

      const turnSecCalcS = 'let turnMetrics=null;if("assistant"===d.role&&k&&d.timestamp){let uIdx=-1;for(let m=b-1;m>=0;m--){if("user"===$[m]?.role&&$[m]?.timestamp){uIdx=m;break}}if(uIdx!==-1){let uMsg=$[uIdx],firstAMsg=$[uIdx+1]||d,totalSec=Math.max(1,Math.round((d.timestamp-uMsg.timestamp)/1e3)),queueSec=Math.max(0,Math.round(((firstAMsg.timestamp||d.timestamp)-uMsg.timestamp)/1e3)),toolCounts={};for(let j=uIdx+1;j<=b;j++){let cList=$[j]?.content||[];for(let b of cList)if("toolCall"===b.type){let name=b.toolName||b.name||"tool";toolCounts[name]=(toolCounts[name]||0)+1}}turnMetrics={totalSec,queueSec,toolCounts,uTime:uMsg.timestamp,aTime:d.timestamp}}}if(turnMetrics)d={...d,turnMetrics,turnSec:turnMetrics.totalSec};';
      if (content.includes(turnSecCalcS)) {
        content = content.replace(turnSecCalcS, "");
      }

      const legacyServerDurationRenderer = /,a\.turnSec&&!b&&\(0,r\.jsx\)\("div",\{style:\{[^}]*\},title:"任务执行总耗时",[\s\S]*?\}\),Q&&!b&&/;
      if (legacyServerDurationRenderer.test(content)) {
        content = content.replace(legacyServerDurationRenderer, ",Q&&!b&&");
      }
      const legacyServerTurnMetrics = /let turnMetrics=null;if\("assistant"===d\.role&&k&&d\.timestamp\)\{[\s\S]*?if\(turnMetrics\)d=\{\.\.\.d,turnMetrics,turnSec:turnMetrics\.totalSec\};/;
      if (legacyServerTurnMetrics.test(content)) {
        content = content.replace(legacyServerTurnMetrics, "");
      }

      if (content.includes("[scrollbar-width:none]")) {
        content = content.replaceAll("[scrollbar-width:none]", "");
      }

      const pDeferServer = 'new URLSearchParams({deferThinking:"1",deferMedia:"1"})';
      const rDeferServer = 'new URLSearchParams({deferThinking:"1",deferMedia:"1",tail:"1000"})';
      if (content.includes(pDeferServer)) {
        content = content.replace(pDeferServer, rDeferServer);
      }

      const pPadServer = 'String(a.index+1).padStart(2,"0")';
      const rPadServer = 'String(a.index+1)';
      if (content.includes(pPadServer)) {
        content = content.replace(pPadServer, rPadServer);
      }

      content = patchWebAndOfficialPiVersionStrings(content, STANDALONE_BASE_VERSION, officialPiVersion);

      safeWriteFileSync(serverPage, content, "utf8");
    }

    const appUpdateRoute = path.join(pkgDir, ".next", "server", "app", "api", "app-update", "route.js");
    if (fs.existsSync(appUpdateRoute)) {
      let auContent = fs.readFileSync(appUpdateRoute, "utf8");
      const auPatched = auContent.replace(
        /let g="force-dynamic",h="[0-9]+\.[0-9]+\.[0-9]+",i=(?:"1"===process\.env\.PI_WEB_SKIP_VERSION_CHECK|!0)/g,
        `let g="force-dynamic",h="${STANDALONE_BASE_VERSION}",i=!0`
      );
      if (auPatched !== auContent) {
        safeWriteFileSync(appUpdateRoute, auPatched, "utf8");
      }
    }

    // 6. Repair the state route if an older duration patch left undefined
    // calcTurnMetrics/getSFile calls in the compiled handler. The client uses
    // this snapshot to hydrate queuedMessages after switching sessions.
    patchSessionStateRoute(pkgDir);

    // 7. Patch sessions/[id]/route.js to increase default tail from 50 to 1000
    const apiSessionRoute = path.join(pkgDir, ".next", "server", "app", "api", "sessions", "[id]", "route.js");
    if (fs.existsSync(apiSessionRoute)) {
      let apiContent = fs.readFileSync(apiSessionRoute, "utf8");
      const pApiTail = 'A=Number.isFinite(z)&&z>0?Math.min(z,1e3):50';
      const rApiTail = 'A=Number.isFinite(z)&&z>0?Math.min(z,1e4):1e3';
      if (apiContent.includes(pApiTail)) {
        apiContent = apiContent.replace(pApiTail, rApiTail);
        safeWriteFileSync(apiSessionRoute, apiContent, "utf8");
      }
    }

    // 8. Sync bin/patch-no-escape.js inside the package
    const binPatch = path.join(pkgDir, "bin", "patch-no-escape.js");
    if (fs.existsSync(binPatch)) {
      try {
        const ownScript = fs.readFileSync(__filename, "utf8");
        safeWriteFileSync(binPatch, ownScript, "utf8");
        // Keep the client render patch available to the package's self-healer.
        const nativePatchSource = path.join(__dirname, "pi-web-native-collapse-patch.js");
        safeWriteFileSync(path.join(pkgDir, "bin", "pi-web-native-collapse-patch.js"), fs.readFileSync(nativePatchSource, "utf8"), "utf8");
      } catch {}
    }
      } catch (err) {
        console.error("[patch-pi-web] error:", err);
        process.exitCode = 1;
        throw err;
      }
    }
  );
}

function run(options = {}) {
  const isExplicitCandidates = Array.isArray(options.candidates);
  const targetCandidates = isExplicitCandidates
    ? [...new Set(options.candidates.filter(c => c && fs.existsSync(c)))]
    : collectDefaultCandidates();

  const nativeProtectedResults = [];
  const legacyCandidates = [];

  for (const candidate of targetCandidates) {
    if (isNativeSessionBridgePkg(candidate)) {
      const gateResult = verifyNativeReleaseGate(candidate);
      console.log(
        `[patch-pi-web] [NATIVE GATE] ${candidate} (v${gateResult.version}) native session bridge verified; legacy patching skipped.`
      );
      nativeProtectedResults.push(gateResult);
    } else {
      legacyCandidates.push(candidate);
    }
  }

  // 若明确检测到候选且所有候选均为已验证的 native 版本，在 resolvePatchLockConfig / build lock 前直接返回
  if (targetCandidates.length > 0 && legacyCandidates.length === 0) {
    return {
      operationToken: options.operationToken || null,
      nativeReleaseProtected: true,
      legacyPatchSkipped: true,
      protectedCandidates: nativeProtectedResults,
      legacyCandidates: [],
    };
  }

  if (options.snapshotManifestPath && options.staticOnly !== true) {
    const err = new Error("[patch-pi-web] 快照发布模式仅允许 staticOnly=true");
    err.code = "SNAPSHOT_STATIC_ONLY_REQUIRED";
    throw err;
  }

  const syncLayoutInline =
    options.syncLayoutInline ??
    (process.argv.includes("--sync-layout-inline") || process.argv.includes("--layout-inline"));
  const staticOnly = options.staticOnly ?? (process.argv.includes("--static-only") || syncLayoutInline);
  const publicOnly = options.publicOnly ?? process.argv.includes("--public-only");
  const sdkOnly = options.sdkOnly ?? (process.argv.includes("--sdk-only") || process.argv.includes("--skip-builder-sync"));
  const lockCfg = resolvePatchLockConfig({ ...options, staticOnly, publicOnly, syncLayoutInline, sdkOnly });

  return withGlobalBuildLock(
    {
      sessionId: options.sessionId,
      operationToken: options.operationToken,
      stateFile: lockCfg.stateFile,
      modulesDir: lockCfg.modulesDir,
      canonicalModulesDir: options.canonicalModulesDir,
      isPidAlive: options.isPidAlive,
      waitTimeoutMs: options.waitTimeoutMs,
      enforceUnlockedDiffCheck: lockCfg.enforceUnlockedDiffCheck,
      snapshotManifestPath: options.snapshotManifestPath,
      operation: options.operation || (sdkOnly ? "patch-sdk-update" : (staticOnly ? "patch-static-deploy" : "patch-run")),
    },
    ({ operationToken }) => {
      const patchOptions = {
        ...options,
        staticOnly,
        publicOnly,
        syncLayoutInline,
        sdkOnly,
        stateFile: lockCfg.stateFile,
        modulesDir: options.modulesDir || lockCfg.modulesDir,
        canonicalModulesDir: options.canonicalModulesDir,
        skipBuilderSync: lockCfg.skipBuilderSync,
        enforceUnlockedDiffCheck: lockCfg.enforceUnlockedDiffCheck,
        snapshotManifestPath: options.snapshotManifestPath,
        operationToken,
      };

      let patchedCount = 0;
      for (const candidate of legacyCandidates) {
        if (candidate && fs.existsSync(candidate)) {
          patchPackage(candidate, patchOptions);
          patchedCount++;
        }
      }
      if (patchedCount === 0 && options.snapshotManifestPath) {
        const err = new Error("[patch-pi-web] 没有匹配的目标 package 候选目录，拒绝宣称部署");
        err.code = "ENHANCEMENT_PATCH_NO_TARGET_MATCHED";
        throw err;
      }

      return {
        operationToken,
        nativeProtectedResults,
        legacyCandidates,
      };
    }
  );
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error(`[patch-pi-web] ERROR: ${err?.stack || err?.message || err}`);
    process.exitCode = 1;
  }
}

module.exports = {
  run,
  patchPackage,
  patchNoEscape: run,
  isNativeSessionBridgePkg,
  verifyNativeReleaseGate,
  collectDefaultCandidates,
  replaceBoundedLayoutInlineTail,
  syncBoundedLayoutInlineChunks,
  repairStreamingThinkingLevel,
  patchDirectToolbarControls,
  patchSidebarBottomShortcuts,
  patchMarkdownFileImageSupport,
  repairStreamingSendShortcuts,
  repairComposerInitialMount,
  patchUserMessageReconcile,
  repairModelSelectorMobileAutoFocus,
  repairModelSelectorRetainKeyboard,
  repairComposerCleanPlaceholder,
  patchDisableNativeAtFiles,
  applyPortablePageBridgesV3,
  applyNativeTitleSingleOwnerBridge,
  NATIVE_TITLE_HEAD_OBSERVER_SOURCE_V3,
  NATIVE_TITLE_SINGLE_OWNER_TARGET_V3,
};
