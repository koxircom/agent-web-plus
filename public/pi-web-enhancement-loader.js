;(function(){
  if (typeof window === "undefined" || window.__PI_WEB_LOADER_INJECTED__) return;
  window.__PI_WEB_LOADER_INJECTED__ = true;
  window.__PI_ENH_ASSET_BUILD__ = window.__PI_ENH_ASSET_BUILD__ || "koxir-1.2.11";
  window.__PI_WEB_STANDALONE_EDITION__ = window.__PI_WEB_STANDALONE_EDITION__ || "koxir-standalone-1.4.46";
  window.__PI_WEB_STANDALONE_VERSION__ = window.__PI_WEB_STANDALONE_VERSION__ || "1.4.46";
  window.__PI_ENH_NATIVE_STATE_API__ = true;

  if (window.__PI_WEB_ENHANCEMENTS_LOADED__) return;

  function loadScript(forceBust) {
    if (window.__PI_WEB_ENHANCEMENTS_LOADED__) return;
    var doc = document;
    if (!doc) return;
    var s = doc.createElement("script");
    s.id = "pi-web-enhancements-script";
    s.src = "/pi-web-enhancements.js?v=koxir-1.2.11&t=" + Date.now();
    s.async = true;
    (doc.head || doc.documentElement || doc.body).appendChild(s);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function() { loadScript(false); }, { once: true });
  } else {
    loadScript(false);
  }

  window.__PI_ENH_RELOAD__ = function(forceBust) {
    loadScript(forceBust !== false);
  };
})();
