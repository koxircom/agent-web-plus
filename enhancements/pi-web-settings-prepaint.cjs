"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * 解码反引号纯模板字面量的转义字符，并拒绝未转义的动态插值 ${...}。
 */
function decodeTemplateLiteralEscapes(rawTemplate) {
  let hasUnescapedInterpolation = false;
  for (let i = 0; i < rawTemplate.length; i++) {
    if (rawTemplate[i] === "\\") {
      i++; // 跳过转义字符
      continue;
    }
    if (rawTemplate[i] === "$" && rawTemplate[i + 1] === "{") {
      hasUnescapedInterpolation = true;
      break;
    }
  }
  if (hasUnescapedInterpolation) {
    throw new Error("[pi-web-settings-prepaint] 模板字面量包含未转义的动态插值，契约禁止动态插值！");
  }

  let res = "";
  for (let i = 0; i < rawTemplate.length; i++) {
    if (rawTemplate[i] === "\\") {
      i++;
      if (i >= rawTemplate.length) break;
      const c = rawTemplate[i];
      if (c === "n") res += "\n";
      else if (c === "r") res += "\r";
      else if (c === "t") res += "\t";
      else if (c === "b") res += "\b";
      else if (c === "f") res += "\f";
      else if (c === "v") res += "\v";
      else if (c === "0") res += "\0";
      else if (c === "\\") res += "\\";
      else if (c === "`") res += "`";
      else if (c === "$") res += "$";
      else res += c;
    } else {
      res += rawTemplate[i];
    }
  }
  return res;
}

/**
 * 纯字面量安全 Tokenizer 和 Parser，用于从 02 模块提取纯数据字面量数组。
 * 仅支持 string, boolean, number, array, object, comments 与标识符 key，reject 任何未知表达式。
 */
function extractArrayLiteral(src, varName) {
  const marker = "const " + varName + " = [";
  const idx = src.indexOf(marker);
  if (idx === -1) throw new Error("[pi-web-settings-prepaint] 未找到数组常量: " + varName);
  const start = src.indexOf("[", idx);
  let depth = 0;
  let inStr = null;
  let end = -1;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "\"" || c === "'") { inStr = c; continue; }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error("[pi-web-settings-prepaint] 数组未正确闭合: " + varName);
  return src.slice(start, end);
}

function parseLiteralTokenStream(src) {
  let i = 0;
  function skipWsAndComments() {
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === "/" && src[i + 1] === "/") {
        i += 2;
        while (i < src.length && src[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        i += 2;
        while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      break;
    }
  }

  function parseString() {
    const q = src[i++];
    let res = "";
    while (i < src.length) {
      const c = src[i++];
      if (c === "\\") {
        const esc = src[i++];
        if (esc === "n") res += "\n";
        else if (esc === "r") res += "\r";
        else if (esc === "t") res += "\t";
        else res += esc;
      } else if (c === q) {
        return res;
      } else {
        res += c;
      }
    }
    throw new Error("[pi-web-settings-prepaint] 字符串未闭合");
  }

  function parseVal() {
    skipWsAndComments();
    const c = src[i];
    if (c === "\"" || c === "'") return parseString();
    if (c === "[") {
      i++;
      const arr = [];
      skipWsAndComments();
      if (src[i] === "]") { i++; return arr; }
      while (i < src.length) {
        arr.push(parseVal());
        skipWsAndComments();
        if (src[i] === ",") {
          i++;
          skipWsAndComments();
          if (src[i] === "]") { i++; return arr; }
        } else if (src[i] === "]") {
          i++;
          return arr;
        } else {
          throw new Error("[pi-web-settings-prepaint] 语法错误，期待逗号或中括号，位置: " + i);
        }
      }
      throw new Error("[pi-web-settings-prepaint] 数组未闭合");
    }
    if (c === "{") {
      i++;
      const obj = {};
      skipWsAndComments();
      if (src[i] === "}") { i++; return obj; }
      while (i < src.length) {
        skipWsAndComments();
        let key = "";
        if (src[i] === "\"" || src[i] === "'") {
          key = parseString();
        } else {
          const match = src.slice(i).match(/^[a-zA-Z0-9_\-]+/);
          if (!match) throw new Error("[pi-web-settings-prepaint] 非法对象键，位置: " + i);
          key = match[0];
          i += key.length;
        }
        skipWsAndComments();
        if (src[i] !== ":") throw new Error("[pi-web-settings-prepaint] 期待冒号，位置: " + i);
        i++;
        obj[key] = parseVal();
        skipWsAndComments();
        if (src[i] === ",") {
          i++;
          skipWsAndComments();
          if (src[i] === "}") { i++; return obj; }
        } else if (src[i] === "}") {
          i++;
          return obj;
        } else {
          throw new Error("[pi-web-settings-prepaint] 语法错误，期待逗号或大括号，位置: " + i);
        }
      }
      throw new Error("[pi-web-settings-prepaint] 对象未闭合");
    }
    const identMatch = src.slice(i).match(/^[a-zA-Z0-9_\-]+/);
    if (identMatch) {
      const id = identMatch[0];
      i += id.length;
      if (id === "true") return true;
      if (id === "false") return false;
      if (/^\d+(\.\d+)?$/.test(id)) return Number(id);
      throw new Error("[pi-web-settings-prepaint] 未知标识符: " + id);
    }
    throw new Error("[pi-web-settings-prepaint] 未知 Token，位置: " + i);
  }

  return parseVal();
}

/**
 * 从 02 模块提取纯数据元数据映射表（包含所有插件默认值和模块归属）
 */
function extractEnhancementMetadata(sourceCodeOrPath) {
  let source = sourceCodeOrPath;
  if (!source) {
    const default02Path = path.join(__dirname, "enhancements", "modules", "02-plugin-registry-and-settings-schema.js");
    if (fs.existsSync(default02Path)) {
      source = fs.readFileSync(default02Path, "utf8");
    }
  } else if (typeof source === "string" && (source.endsWith(".js") || source.includes("/") || source.includes("\\"))) {
    if (fs.existsSync(source)) {
      source = fs.readFileSync(source, "utf8");
    }
  }
  if (typeof source !== "string" || !source) {
    throw new Error("[pi-web-settings-prepaint] 无法获取 02 模块源码");
  }

  const pluginsRaw = extractArrayLiteral(source, "ENHANCEMENT_PLUGINS");
  const modulesRaw = extractArrayLiteral(source, "ENHANCEMENT_MODULES");
  const plugins = parseLiteralTokenStream(pluginsRaw);
  const modules = parseLiteralTokenStream(modulesRaw);

  const featureToModule = {};
  if (Array.isArray(modules)) {
    for (const mod of modules) {
      if (mod && Array.isArray(mod.features)) {
        for (const feat of mod.features) {
          featureToModule[feat] = {
            moduleId: mod.id,
            moduleDefaultEnabled: mod.defaultEnabled !== false,
          };
        }
      }
    }
  }

  const metadata = {};
  if (Array.isArray(plugins)) {
    for (const plug of plugins) {
      if (!plug || !plug.id) continue;
      const modInfo = featureToModule[plug.id] || null;
      metadata[plug.id] = {
        defaultEnabled: plug.defaultEnabled !== false,
        alwaysOn: plug.alwaysOn === true,
        alwaysOff: plug.alwaysOff === true,
        moduleId: modInfo ? modInfo.moduleId : null,
        moduleDefaultEnabled: modInfo ? modInfo.moduleDefaultEnabled : true,
      };
    }
  }

  return metadata;
}

let cachedMetadata = null;
function getMetadata(optionalMetadata) {
  if (optionalMetadata && typeof optionalMetadata === "object") return optionalMetadata;
  // 编译失败必须暴露；不维护另一套猜测模块归属的后备表。
  return cachedMetadata || (cachedMetadata = extractEnhancementMetadata());
}

// 唯一只读算法；Node 定向校验和 loader 编译直接使用同一函数源码。
function createFastPluginReader(storageGetter, metadata) {
  let lastRaw;
  let parsedModern = null;
  const read = (key) => {
    try {
      const value = storageGetter(key);
      return value === undefined ? null : value;
    } catch (_) { return null; }
  };
  return function isPluginFastActive(pluginId) {
    if (!Object.prototype.hasOwnProperty.call(metadata, pluginId)) return true;
    const info = metadata[pluginId];
    if (info.alwaysOn) return true;
    if (info.alwaysOff) return false;
    const raw = read("pi-enh-settings-v1");
    if (raw !== lastRaw) {
      lastRaw = raw;
      parsedModern = null;
      if (raw) {
        try { parsedModern = JSON.parse(raw); } catch (_) {}
      }
    }
    // 与 getEnhancementConfig() 一致：任何 truthy 解析值均 normalize(defaults)。
    const moduleConfig = parsedModern && parsedModern.modules && parsedModern.modules[info.moduleId];
    const moduleEnabled = moduleConfig && typeof moduleConfig.enabled === "boolean"
      ? moduleConfig.enabled : info.moduleDefaultEnabled;
    if (info.moduleId && !moduleEnabled) return false;
    if (parsedModern) {
      const feature = parsedModern.features && parsedModern.features[pluginId];
      return feature && typeof feature.enabled === "boolean" ? feature.enabled : info.defaultEnabled;
    }
    const legacy = read("pi-enh-plugin-" + pluginId);
    return legacy === null ? info.defaultEnabled : legacy === "true";
  };
}

function evaluatePluginFastActive(pluginId, storageGetter, metadata) {
  return createFastPluginReader(storageGetter, getMetadata(metadata))(pluginId);
}

/**
 * 生成编译到 loader 客户端的统一 canonical fast reader 函数代码
 */
function buildFastPluginReaderSnippet(metadata) {
  return `  // Canonical fast reader: compiled from the same tested factory, no duplicate algorithm.
  var isPluginFastActive = (${createFastPluginReader.toString()})(function(key) {
    return typeof localStorage !== "undefined" && localStorage ? localStorage.getItem(key) : null;
  }, ${JSON.stringify(getMetadata(metadata))});`;
}

/**
 * 生成供 Native 编译使用的 enhancement-settings.generated.ts 模块源码
 */
function buildNativePluginSettingsModuleCode(metadata) {
  const meta = getMetadata(metadata);
  return `/**
 * @file enhancement-settings.generated.ts
 * Automatically generated by pi-web-settings-prepaint helper from 02-plugin-registry-and-settings-schema.js.
 * Do not edit manually. Same canonical schema and fast reader algorithm.
 */

export interface EnhancementPluginMetadataItem {
  defaultEnabled: boolean;
  alwaysOn: boolean;
  alwaysOff: boolean;
  moduleId: string | null;
  moduleDefaultEnabled: boolean;
}

export type EnhancementPluginMetadataMap = Record<string, EnhancementPluginMetadataItem>;

export const ENHANCEMENT_METADATA: EnhancementPluginMetadataMap = ${JSON.stringify(meta, null, 2)};

export type StorageGetter = (key: string) => string | null | undefined;

export function createFastPluginReader(
  storageGetter: StorageGetter,
  metadata: EnhancementPluginMetadataMap = ENHANCEMENT_METADATA
): (pluginId: string) => boolean {
  let lastRaw: string | null | undefined;
  let parsedModern: {
    modules?: Record<string, { enabled?: boolean }>;
    features?: Record<string, { enabled?: boolean }>;
  } | null = null;

  const read = (key: string): string | null => {
    try {
      const value = storageGetter(key);
      return value === undefined ? null : value;
    } catch (_) {
      return null;
    }
  };

  return function isPluginFastActive(pluginId: string): boolean {
    if (!Object.prototype.hasOwnProperty.call(metadata, pluginId)) return true;
    const info = metadata[pluginId];
    if (info.alwaysOn) return true;
    if (info.alwaysOff) return false;
    const raw = read("pi-enh-settings-v1");
    if (raw !== lastRaw) {
      lastRaw = raw;
      parsedModern = null;
      if (raw) {
        try {
          parsedModern = JSON.parse(raw);
        } catch (_) {}
      }
    }

    const moduleConfig = parsedModern && parsedModern.modules && parsedModern.modules[info.moduleId!];
    const moduleEnabled =
      moduleConfig && typeof moduleConfig.enabled === "boolean"
        ? moduleConfig.enabled
        : info.moduleDefaultEnabled;

    if (info.moduleId && !moduleEnabled) return false;

    if (parsedModern) {
      const feature = parsedModern.features && parsedModern.features[pluginId];
      return feature && typeof feature.enabled === "boolean"
        ? feature.enabled
        : info.defaultEnabled;
    }

    const legacy = read("pi-enh-plugin-" + pluginId);
    return legacy === null ? info.defaultEnabled : legacy === "true";
  };
}

const defaultReader = createFastPluginReader((key: string) => {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    return window.localStorage.getItem(key);
  } catch (_) {
    return null;
  }
});

export function isEnhancementPluginFastActive(
  pluginId: string,
  storageGetter?: StorageGetter
): boolean {
  if (storageGetter) {
    return createFastPluginReader(storageGetter, ENHANCEMENT_METADATA)(pluginId);
  }
  return defaultReader(pluginId);
}
`;
}

module.exports = {
  extractEnhancementMetadata,
  createFastPluginReader,
  evaluatePluginFastActive,
  buildFastPluginReaderSnippet,
  buildNativePluginSettingsModuleCode,
  decodeTemplateLiteralEscapes,
};

