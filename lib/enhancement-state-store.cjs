'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  withAgentStateLock,
  withAgentStateLockSync,
  withAgentStateReadLockSync,
  getLockDir,
  recoverStaleLock
} = require('./agent-state-mutex.cjs');

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepClone(val) {
  if (val === undefined || val === null) return val;
  return JSON.parse(JSON.stringify(val));
}

function isDangerousId(val) {
  if (typeof val !== 'string') return false;
  const trimmed = val.trim();
  return DANGEROUS_KEYS.has(val) || DANGEROUS_KEYS.has(trimmed);
}

function isSafeIdString(val, maxLen = 128) {
  if (typeof val !== 'string') return false;
  const trimmed = val.trim();
  if (!trimmed || trimmed.length > maxLen) return false;
  if (isDangerousId(val)) return false;
  return true;
}

function checkPrototypePollution(obj, visited = new Set()) {
  if (!obj || typeof obj !== 'object') return false;
  if (visited.has(obj)) return false;
  visited.add(obj);

  if (Object.prototype.hasOwnProperty.call(obj, '__proto__') ||
      Object.prototype.hasOwnProperty.call(obj, 'constructor') ||
      Object.prototype.hasOwnProperty.call(obj, 'prototype')) {
    return true;
  }
  for (const key of Object.keys(obj)) {
    if (DANGEROUS_KEYS.has(key)) return true;
    const val = obj[key];
    if (val && typeof val === 'object') {
      if (checkPrototypePollution(val, visited)) return true;
    }
  }
  return false;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
}

function fsyncDir(dirPath) {
  try {
    const fd = fs.openSync(dirPath, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    // Windows平台或特定文件系统对目录 open/fsync 明确不支持（EISDIR, EINVAL, EPERM, EACCES, EBADF, ENOTSUP）
    if (process.platform === 'win32' && ['EINVAL', 'EPERM', 'EACCES', 'EISDIR', 'EBADF', 'ENOTSUP'].includes(err.code)) {
      // 兼容不支持目录 fsync 的环境并注释说明限制
      return;
    }
    throw err;
  }
}

function atomicWriteJson(targetPath, data) {
  const dir = path.dirname(targetPath);
  ensureDir(dir);
  const randomSuffix = crypto.randomBytes(6).toString('hex');
  const tempPath = path.join(dir, `.tmp.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${randomSuffix}`);
  const content = JSON.stringify(data, null, 2);

  const fd = fs.openSync(tempPath, 'w', 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.renameSync(tempPath, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_) {}
    throw err;
  }

  fsyncDir(dir);
}

function appendJournalLine(journalPath, entry) {
  const dir = path.dirname(journalPath);
  ensureDir(dir);
  const line = JSON.stringify(entry) + '\n';
  const fd = fs.openSync(journalPath, 'a', 0o600);
  try {
    fs.writeFileSync(fd, line, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDir(dir);
}

function computeEntryHash(entry) {
  const normalized = {
    revision: entry.revision,
    timestamp: entry.timestamp,
    type: entry.type,
    operations: entry.operations,
    state: entry.state,
    acknowledgedOpIds: entry.acknowledgedOpIds || [],
    tagIdRemap: entry.tagIdRemap || {},
    previousHash: entry.previousHash !== undefined ? entry.previousHash : null,
    storageVersion: entry.storageVersion || 1
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
}

function parseJsonWithSdkCompat(rawContent) {
  if (typeof rawContent !== 'string') {
    throw new Error('Input must be a string');
  }
  let str = rawContent.replace(/^\uFEFF/, '');

  let inString = false;
  let inSingleComment = false;
  let inMultiComment = false;
  let isEscaped = false;
  let strippedComments = '';

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const next = str[i + 1];

    if (inString) {
      strippedComments += ch;
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === '\\') {
        isEscaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (inSingleComment) {
      if (ch === '\n' || ch === '\r') {
        inSingleComment = false;
        strippedComments += ch;
      }
      continue;
    }

    if (inMultiComment) {
      if (ch === '*' && next === '/') {
        inMultiComment = false;
        i++;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      strippedComments += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      inSingleComment = true;
      i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      inMultiComment = true;
      i++;
      continue;
    }

    strippedComments += ch;
  }

  let result = '';
  inString = false;
  isEscaped = false;
  for (let i = 0; i < strippedComments.length; i++) {
    const ch = strippedComments[i];
    if (inString) {
      result += ch;
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === '\\') {
        isEscaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }

    if (ch === ',') {
      let j = i + 1;
      while (j < strippedComments.length && /\s/.test(strippedComments[j])) {
        j++;
      }
      if (j < strippedComments.length && (strippedComments[j] === ']' || strippedComments[j] === '}')) {
        continue;
      }
    }

    result += ch;
  }

  return JSON.parse(result);
}

const OP_ALLOWED_KEYS = {
  tag_create: new Set(['opId', 'type', 'timestamp', 'tag']),
  tag_update: new Set(['opId', 'type', 'timestamp', 'tagId', 'updates']),
  tag_delete: new Set(['opId', 'type', 'timestamp', 'tagId']),
  session_tag_add: new Set(['opId', 'type', 'timestamp', 'sessionId', 'tagId']),
  session_tag_remove: new Set(['opId', 'type', 'timestamp', 'sessionId', 'tagId']),
  session_tag_clear: new Set(['opId', 'type', 'timestamp', 'sessionId']),
  session_color_set: new Set(['opId', 'type', 'timestamp', 'sessionId', 'color']),
  session_color_clear: new Set(['opId', 'type', 'timestamp', 'sessionId']),
  preferences_snapshot: new Set(['opId', 'type', 'timestamp', 'clientId', 'values'])
};

const TAG_CREATE_ALLOWED_KEYS = new Set(['id', 'name', 'color', 'createdAt', 'updatedAt']);
const TAG_UPDATE_ALLOWED_KEYS = new Set(['name', 'color']);

function validateOperationSchema(op) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) {
    throw new Error('Operation must be an object');
  }
  if (checkPrototypePollution(op)) {
    throw new Error('Dangerous prototype pollution key detected in operation');
  }

  const type = op.type;
  const allowedKeys = OP_ALLOWED_KEYS[type];
  if (!allowedKeys) {
    throw new Error(`Unsupported operation type: ${type}`);
  }

  // 检查未知字段
  for (const key of Object.keys(op)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown field in operation: ${key}`);
    }
  }

  // 基础字段检查
  if (!isSafeIdString(op.opId, 128)) {
    throw new Error('Invalid or dangerous opId in operation');
  }

  if (op.timestamp !== undefined && typeof op.timestamp !== 'number' && typeof op.timestamp !== 'string') {
    throw new Error('Invalid timestamp in operation');
  }

  switch (type) {
    case 'tag_create': {
      if (!op.tag || typeof op.tag !== 'object' || Array.isArray(op.tag)) {
        throw new Error('tag_create requires a tag object');
      }
      for (const k of Object.keys(op.tag)) {
        if (!TAG_CREATE_ALLOWED_KEYS.has(k)) {
          throw new Error(`Unknown field in tag object: ${k}`);
        }
      }
      if (!isSafeIdString(op.tag.id, 128)) {
        throw new Error('Invalid or dangerous tag.id in tag_create');
      }
      if (typeof op.tag.name !== 'string' || !op.tag.name.trim() || op.tag.name.trim().length > 100) {
        throw new Error('tag.name must be a non-empty string <= 100 chars');
      }
      if (op.tag.color !== undefined && (typeof op.tag.color !== 'string' || op.tag.color.length > 50)) {
        throw new Error('tag.color must be a string <= 50 chars');
      }
      if (op.tag.createdAt !== undefined && typeof op.tag.createdAt !== 'string' && typeof op.tag.createdAt !== 'number') {
        throw new Error('tag.createdAt must be string or number');
      }
      if (op.tag.updatedAt !== undefined && typeof op.tag.updatedAt !== 'string' && typeof op.tag.updatedAt !== 'number') {
        throw new Error('tag.updatedAt must be string or number');
      }
      break;
    }

    case 'tag_update': {
      if (!isSafeIdString(op.tagId, 128)) {
        throw new Error('Invalid or dangerous tagId in tag_update');
      }
      if (!op.updates || typeof op.updates !== 'object' || Array.isArray(op.updates)) {
        throw new Error('tag_update requires updates object');
      }
      for (const k of Object.keys(op.updates)) {
        if (!TAG_UPDATE_ALLOWED_KEYS.has(k)) {
          throw new Error(`Unknown field in tag_update updates: ${k}`);
        }
      }
      let hasUpdate = false;
      if (op.updates.name !== undefined) {
        if (typeof op.updates.name !== 'string' || !op.updates.name.trim() || op.updates.name.trim().length > 100) {
          throw new Error('updates.name must be a non-empty string <= 100 chars');
        }
        hasUpdate = true;
      }
      if (op.updates.color !== undefined) {
        if (typeof op.updates.color !== 'string' || !op.updates.color.trim() || op.updates.color.length > 50) {
          throw new Error('updates.color must be a non-empty string <= 50 chars');
        }
        hasUpdate = true;
      }
      if (!hasUpdate) {
        throw new Error('tag_update requires at least name or color');
      }
      break;
    }

    case 'tag_delete': {
      if (!isSafeIdString(op.tagId, 128)) {
        throw new Error('Invalid or dangerous tagId in tag_delete');
      }
      break;
    }

    case 'session_tag_add':
    case 'session_tag_remove': {
      if (!isSafeIdString(op.sessionId, 256)) {
        throw new Error(`Invalid or dangerous sessionId in ${type}`);
      }
      if (!isSafeIdString(op.tagId, 128)) {
        throw new Error(`Invalid or dangerous tagId in ${type}`);
      }
      break;
    }

    case 'session_tag_clear':
    case 'session_color_clear': {
      if (!isSafeIdString(op.sessionId, 256)) {
        throw new Error(`Invalid or dangerous sessionId in ${type}`);
      }
      break;
    }

    case 'session_color_set': {
      if (!isSafeIdString(op.sessionId, 256)) {
        throw new Error('Invalid or dangerous sessionId in session_color_set');
      }
      if (typeof op.color !== 'string' || !op.color.trim() || op.color.length > 50) {
        throw new Error('color must be a non-empty string <= 50 chars in session_color_set');
      }
      break;
    }

    case 'preferences_snapshot': {
      if (!isSafeIdString(op.clientId, 128)) {
        throw new Error('Invalid or dangerous clientId in preferences_snapshot');
      }
      if (!op.values || typeof op.values !== 'object' || Array.isArray(op.values)) {
        throw new Error('values must be an object in preferences_snapshot');
      }
      for (const [key, val] of Object.entries(op.values)) {
        if (isDangerousId(key)) {
          throw new Error(`Dangerous preference key detected: ${key}`);
        }
        const isValidKey = key === 'pi-enh-settings-v1' || key.startsWith('pi-enh-plugin-');
        if (!isValidKey) {
          throw new Error(`Illegal preference key: ${key}`);
        }
        if (typeof val !== 'string') {
          throw new Error(`Preference value for key ${key} must be a string`);
        }
        if (val.length > 256 * 1024) {
          throw new Error(`Preference value for key ${key} exceeds size limit`);
        }
      }
      break;
    }
  }
}

class EnhancementStateStore {
  constructor({ agentDir }) {
    if (!agentDir || typeof agentDir !== 'string') {
      throw new Error('agentDir is required');
    }
    this.agentDir = agentDir;
    this.stateDir = path.join(agentDir, 'state', 'enhancement-state');
    this.snapshotsDir = path.join(this.stateDir, 'snapshots');
    this.currentFile = path.join(this.stateDir, 'current.json');
    this.journalFile = path.join(this.stateDir, 'journal.jsonl');

    this.revision = 0;
    this.state = null;
    this.lastHash = null;
    this.isInitialized = false;
    this.needsReload = true;
    this.seenOpIds = new Set();
    this.tagAliases = new Map();
    this._lastJournalMtimeMs = null;
    this._lastJournalSize = null;
  }

  _resolveTargetTagId(tagId, batchTagIdRemap) {
    if (!tagId) return tagId;
    let curr = String(tagId);
    let guard = 0;
    while (guard < 10) {
      if (batchTagIdRemap && batchTagIdRemap[curr]) {
        curr = String(batchTagIdRemap[curr]);
      } else if (this.tagAliases.has(curr)) {
        curr = String(this.tagAliases.get(curr));
      } else {
        break;
      }
      guard++;
    }
    return curr;
  }

  _validateStateStructure(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return false;
    }
    if (!Array.isArray(state.sessionTagsDefinitions)) {
      return false;
    }
    if (!state.sessionTagMappings || typeof state.sessionTagMappings !== 'object' || Array.isArray(state.sessionTagMappings)) {
      return false;
    }
    if (!state.sessionColors || typeof state.sessionColors !== 'object' || Array.isArray(state.sessionColors)) {
      return false;
    }
    if (!state.enhancementSettingsByClient || typeof state.enhancementSettingsByClient !== 'object' || Array.isArray(state.enhancementSettingsByClient)) {
      return false;
    }
    return true;
  }

  _loadFromDisk(forceReload = false) {
    const hasJournal = fs.existsSync(this.journalFile);
    const hasCurrent = fs.existsSync(this.currentFile);

    if (!hasJournal && !hasCurrent) {
      this.isInitialized = false;
      this.needsReload = false;
      this.state = null;
      this.revision = 0;
      this._lastJournalMtimeMs = null;
      this._lastJournalSize = null;
      return;
    }

    let journalStat = null;
    if (hasJournal) {
      try {
        journalStat = fs.statSync(this.journalFile);
      } catch (_) {}
    }

    const isJournalChanged = journalStat && (
      this._lastJournalMtimeMs !== journalStat.mtimeMs ||
      this._lastJournalSize !== journalStat.size
    );

    if (this.isInitialized && !forceReload && !this.needsReload && !isJournalChanged) {
      return;
    }

    // 若 current.json 存在，先校验其格式与合法性
    let currentData = null;
    if (hasCurrent) {
      let content;
      try {
        content = fs.readFileSync(this.currentFile, 'utf8');
      } catch (err) {
        throw new Error(`CORRUPTED_CURRENT: Failed to read current.json: ${err.message}`);
      }
      try {
        currentData = JSON.parse(content);
      } catch (err) {
        throw new Error(`CORRUPTED_CURRENT: current.json is invalid JSON: ${err.message}`);
      }

      if (!currentData || typeof currentData !== 'object' || !this._validateStateStructure(currentData.state) || typeof currentData.revision !== 'number') {
        throw new Error('CORRUPTED_CURRENT: current.json missing valid state or revision');
      }
    }

    // 若缺少 journal.jsonl，但存在 current.json，则视为 journal 缺失损坏，安全拒绝
    if (!hasJournal) {
      throw new Error('CORRUPTED_JOURNAL: journal.jsonl is missing');
    }

    // 读取并逐行验证 journal.jsonl
    let journalEntries = [];
    const content = fs.readFileSync(this.journalFile, 'utf8');
    if (!content.endsWith('\n')) throw new Error('CORRUPTED_JOURNAL: incomplete trailing record');
    const lines = content.split('\n');
    let expectedRev = 1;
    let expectedPrevHash = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (err) {
        throw new Error(`CORRUPTED_JOURNAL: Line ${i + 1} is invalid JSON: ${err.message}`);
      }

      if (!entry || typeof entry !== 'object' || entry.storageVersion !== 1) {
        throw new Error(`CORRUPTED_JOURNAL: Entry at line ${i + 1} has invalid schema`);
      }

      if (entry.revision !== expectedRev) {
        throw new Error(`CORRUPTED_JOURNAL: Non-monotonic revision at line ${i + 1}: expected ${expectedRev}, got ${entry.revision}`);
      }

      const recordedPrevHash = entry.previousHash !== undefined ? entry.previousHash : null;
      if (recordedPrevHash !== expectedPrevHash) {
        throw new Error(`CORRUPTED_JOURNAL: Hash chain broken at line ${i + 1}: previousHash mismatch`);
      }

      const computedHash = computeEntryHash(entry);
      if (entry.hash !== computedHash) {
        throw new Error(`CORRUPTED_JOURNAL: Entry hash mismatch at line ${i + 1}`);
      }

      if (!this._validateStateStructure(entry.state)) {
        throw new Error(`CORRUPTED_JOURNAL: Invalid state structure at line ${i + 1}`);
      }

      journalEntries.push(entry);
      expectedRev++;
      expectedPrevHash = entry.hash;
    }

    if (journalEntries.length === 0) {
      throw new Error('CORRUPTED_JOURNAL: journal.jsonl contains no valid entries');
    }

    const latestJournalEntry = journalEntries[journalEntries.length - 1];
    const latestJournalRev = latestJournalEntry.revision;

    // 校验 current 异常：current revision 不能大于 journal 最新 revision（唯一权威在 journal）
    if (currentData && currentData.revision > latestJournalRev) {
      throw new Error(`CORRUPTED_CURRENT: current.json revision (${currentData.revision}) exceeds journal latest revision (${latestJournalRev})`);
    }

    // 重建 seenOpIds 与 tagAliases
    this.seenOpIds.clear();
    this.tagAliases.clear();

    for (const entry of journalEntries) {
      if (entry.acknowledgedOpIds && Array.isArray(entry.acknowledgedOpIds)) {
        for (const opId of entry.acknowledgedOpIds) {
          this.seenOpIds.add(String(opId));
        }
      }
      if (entry.operations && Array.isArray(entry.operations)) {
        for (const op of entry.operations) {
          if (op && op.opId !== undefined) {
            this.seenOpIds.add(String(op.opId));
          }
        }
      }
      if (entry.tagIdRemap && typeof entry.tagIdRemap === 'object') {
        for (const [fromId, toId] of Object.entries(entry.tagIdRemap)) {
          this.tagAliases.set(String(fromId), String(toId));
        }
      }
    }

    // 权威状态以最新 journal 记录为准（journal 记录包含完整状态，绝不写回 current.json）
    this.revision = latestJournalRev;
    this.state = deepClone(latestJournalEntry.state);
    this.lastHash = latestJournalEntry.hash;
    this.isInitialized = true;
    this.needsReload = false;
    if (journalStat) {
      this._lastJournalMtimeMs = journalStat.mtimeMs;
      this._lastJournalSize = journalStat.size;
    }
  }

  _initializeFromLegacyLocked({ modelsConfigPath } = {}) {
    const targetModelsPath = modelsConfigPath || path.join(this.agentDir, 'models.json');

    // 核验是否已有 canonical 状态
    this._loadFromDisk(true);
    if (this.isInitialized) {
      throw new Error('ALREADY_INITIALIZED: canonical state already exists, cannot overwrite');
    }

    if (!fs.existsSync(targetModelsPath)) {
      throw new Error(`LEGACY_MODELS_NOT_FOUND: ${targetModelsPath} does not exist`);
    }

    let modelsConfig;
    let content;
    try {
      content = fs.readFileSync(targetModelsPath, 'utf8');
      modelsConfig = parseJsonWithSdkCompat(content);
    } catch (err) {
      throw new Error(`LEGACY_MODELS_INVALID: Failed to parse ${targetModelsPath}: ${err.message}`);
    }

    if (!modelsConfig || typeof modelsConfig !== 'object' || Array.isArray(modelsConfig)) {
      throw new Error('LEGACY_MODELS_INVALID: models.json root must be an object');
    }

    if (checkPrototypePollution(modelsConfig)) {
      throw new Error('LEGACY_MODELS_INVALID: Dangerous prototype pollution detected in models.json');
    }

    // 字段类型严格检查：missing 才默认为空，类型错拒绝！
    let initialTags = [];
    if (modelsConfig.sessionTagsDefinitions !== undefined) {
      if (!Array.isArray(modelsConfig.sessionTagsDefinitions)) {
        throw new Error('LEGACY_MODELS_INVALID: sessionTagsDefinitions must be an array');
      }
      for (const tag of modelsConfig.sessionTagsDefinitions) {
        if (!tag || typeof tag !== 'object' || Array.isArray(tag)) {
          throw new Error('LEGACY_MODELS_INVALID: sessionTagsDefinitions item must be an object');
        }
        if (checkPrototypePollution(tag)) {
          throw new Error('LEGACY_MODELS_INVALID: Dangerous prototype pollution detected in tag');
        }
        if (!isSafeIdString(tag.id, 128)) {
          throw new Error('LEGACY_MODELS_INVALID: Invalid or dangerous tag id in sessionTagsDefinitions');
        }
        if (typeof tag.name !== 'string' || !tag.name.trim() || tag.name.trim().length > 100) {
          throw new Error('LEGACY_MODELS_INVALID: tag.name must be a non-empty string <= 100 chars');
        }
        if (tag.color !== undefined && (typeof tag.color !== 'string' || tag.color.length > 50)) {
          throw new Error('LEGACY_MODELS_INVALID: tag.color must be a string <= 50 chars');
        }
        if (tag.createdAt !== undefined && typeof tag.createdAt !== 'string' && typeof tag.createdAt !== 'number') {
          throw new Error('LEGACY_MODELS_INVALID: tag.createdAt must be string or number');
        }
        if (tag.updatedAt !== undefined && typeof tag.updatedAt !== 'string' && typeof tag.updatedAt !== 'number') {
          throw new Error('LEGACY_MODELS_INVALID: tag.updatedAt must be string or number');
        }
      }
      initialTags = deepClone(modelsConfig.sessionTagsDefinitions);
    }

    let initialMappings = {};
    if (modelsConfig.sessionTagMappings !== undefined) {
      if (typeof modelsConfig.sessionTagMappings !== 'object' || modelsConfig.sessionTagMappings === null || Array.isArray(modelsConfig.sessionTagMappings)) {
        throw new Error('LEGACY_MODELS_INVALID: sessionTagMappings must be an object');
      }
      if (checkPrototypePollution(modelsConfig.sessionTagMappings)) {
        throw new Error('LEGACY_MODELS_INVALID: Dangerous prototype pollution detected in sessionTagMappings');
      }
      for (const [sessionId, val] of Object.entries(modelsConfig.sessionTagMappings)) {
        if (!isSafeIdString(sessionId, 256)) {
          throw new Error('LEGACY_MODELS_INVALID: Invalid or dangerous sessionId in sessionTagMappings');
        }
        // 已有契约保留曾故意 nonarray 拒 test：若 val 是 array，检查每个 tagId；若不是 array，不清洗保留
        if (Array.isArray(val)) {
          for (const tagId of val) {
            if (!isSafeIdString(tagId, 128)) {
              throw new Error('LEGACY_MODELS_INVALID: Invalid or dangerous tagId in sessionTagMappings');
            }
          }
        }
      }
      // 历史 mapping 值 deepClone 不清洗（非数组不改成 []）
      initialMappings = deepClone(modelsConfig.sessionTagMappings);
    }

    let initialColors = {};
    if (modelsConfig.sessionColors !== undefined) {
      if (typeof modelsConfig.sessionColors !== 'object' || modelsConfig.sessionColors === null || Array.isArray(modelsConfig.sessionColors)) {
        throw new Error('LEGACY_MODELS_INVALID: sessionColors must be an object');
      }
      if (checkPrototypePollution(modelsConfig.sessionColors)) {
        throw new Error('LEGACY_MODELS_INVALID: Dangerous prototype pollution detected in sessionColors');
      }
      for (const [sessionId, color] of Object.entries(modelsConfig.sessionColors)) {
        if (!isSafeIdString(sessionId, 256)) {
          throw new Error('LEGACY_MODELS_INVALID: Invalid or dangerous sessionId in sessionColors');
        }
        if (typeof color !== 'string' || !color.trim() || color.length > 50) {
          throw new Error('LEGACY_MODELS_INVALID: color must be a non-empty string <= 50 chars in sessionColors');
        }
      }
      initialColors = deepClone(modelsConfig.sessionColors);
    }

    const initialState = {
      sessionTagsDefinitions: initialTags,
      sessionTagMappings: initialMappings,
      sessionColors: initialColors,
      enhancementSettingsByClient: {}
    };

    if (!this._validateStateStructure(initialState)) {
      throw new Error('LEGACY_MODELS_INVALID: Invalid state structure');
    }

    const initialRevision = 1;
    const nowIso = new Date().toISOString();
    const timestamp = Date.now();

    ensureDir(this.stateDir);
    ensureDir(this.snapshotsDir);

    const initJournalEntry = {
      type: 'init',
      revision: initialRevision,
      timestamp,
      operations: [],
      state: initialState,
      acknowledgedOpIds: [],
      tagIdRemap: {},
      previousHash: null,
      storageVersion: 1
    };

    initJournalEntry.hash = computeEntryHash(initJournalEntry);

    // 1. 追加 journal.jsonl
    appendJournalLine(this.journalFile, initJournalEntry);

    // 2. snapshot
    const snapFileName = `snapshot_${String(initialRevision).padStart(8, '0')}.json`;
    const snapPath = path.join(this.snapshotsDir, snapFileName);
    atomicWriteJson(snapPath, {
      revision: initialRevision,
      timestamp,
      operations: [],
      state: initialState,
      storageVersion: 1
    });

    // 3. current.json
    atomicWriteJson(this.currentFile, {
      ok: true,
      revision: initialRevision,
      state: initialState,
      storageVersion: 1,
      updatedAt: nowIso
    });

    this.revision = initialRevision;
    this.state = initialState;
    this.lastHash = initJournalEntry.hash;
    this.isInitialized = true;
    this.needsReload = false;
    this.seenOpIds.clear();
    this.tagAliases.clear();

    try {
      const st = fs.statSync(this.journalFile);
      this._lastJournalMtimeMs = st.mtimeMs;
      this._lastJournalSize = st.size;
    } catch (_) {}

    return {
      ok: true,
      revision: this.revision,
      state: deepClone(this.state),
      storageVersion: 1
    };
  }

  initializeFromLegacyLocked(opts) {
    return this._initializeFromLegacyLocked(opts);
  }

  initializeFromLegacy(opts) {
    return withAgentStateLockSync(this.agentDir, () => {
      return this._initializeFromLegacyLocked(opts);
    });
  }

  _ensureInitializedFromLegacyLocked({ modelsConfigPath } = {}) {
    this._loadFromDisk(true);
    if (this.isInitialized && this.state) {
      return {
        ok: true,
        revision: this.revision,
        state: deepClone(this.state),
        storageVersion: 1,
        alreadyInitialized: true
      };
    }

    const targetModelsPath = modelsConfigPath || path.join(this.agentDir, 'models.json');
    if (fs.existsSync(targetModelsPath)) {
      return this._initializeFromLegacyLocked({ modelsConfigPath: targetModelsPath });
    }

    // 缺 models 时安全创建 empty tags 不创建 models 凭据
    const initialState = {
      sessionTagsDefinitions: [],
      sessionTagMappings: {},
      sessionColors: {},
      enhancementSettingsByClient: {}
    };

    const initialRevision = 1;
    const nowIso = new Date().toISOString();
    const timestamp = Date.now();

    ensureDir(this.stateDir);
    ensureDir(this.snapshotsDir);

    const initJournalEntry = {
      type: 'init',
      revision: initialRevision,
      timestamp,
      operations: [],
      state: initialState,
      acknowledgedOpIds: [],
      tagIdRemap: {},
      previousHash: null,
      storageVersion: 1
    };

    initJournalEntry.hash = computeEntryHash(initJournalEntry);

    appendJournalLine(this.journalFile, initJournalEntry);

    const snapFileName = `snapshot_${String(initialRevision).padStart(8, '0')}.json`;
    const snapPath = path.join(this.snapshotsDir, snapFileName);
    atomicWriteJson(snapPath, {
      revision: initialRevision,
      timestamp,
      operations: [],
      state: initialState,
      storageVersion: 1
    });

    atomicWriteJson(this.currentFile, {
      ok: true,
      revision: initialRevision,
      state: initialState,
      storageVersion: 1,
      updatedAt: nowIso
    });

    this.revision = initialRevision;
    this.state = initialState;
    this.lastHash = initJournalEntry.hash;
    this.isInitialized = true;
    this.needsReload = false;
    this.seenOpIds.clear();
    this.tagAliases.clear();

    try {
      const st = fs.statSync(this.journalFile);
      this._lastJournalMtimeMs = st.mtimeMs;
      this._lastJournalSize = st.size;
    } catch (_) {}

    return {
      ok: true,
      revision: this.revision,
      state: deepClone(this.state),
      storageVersion: 1
    };
  }

  ensureInitializedFromLegacyLocked(opts) {
    return this._ensureInitializedFromLegacyLocked(opts);
  }

  ensureInitializedFromLegacy(opts) {
    return withAgentStateLockSync(this.agentDir, () => {
      return this._ensureInitializedFromLegacyLocked(opts);
    });
  }

  read() {
    return withAgentStateReadLockSync(this.agentDir, () => {
      this._loadFromDisk(false);
      if (!this.isInitialized || !this.state) {
        const err = new Error('NOT_INITIALIZED: Enhancement state store has not been initialized');
        err.code = 'NOT_INITIALIZED';
        throw err;
      }
      return {
        ok: true,
        revision: this.revision,
        state: deepClone(this.state),
        storageVersion: 1
      };
    });
  }

  _commitLocked(operations) {
    this._loadFromDisk(true);
    if (!this.isInitialized || !this.state) {
      const err = new Error('NOT_INITIALIZED: Enhancement state store has not been initialized');
      err.code = 'NOT_INITIALIZED';
      throw err;
    }

    // 同批次 opId 去重
    const seenInBatch = new Set();
    const deduplicatedBatchOps = [];
    for (const op of operations) {
      const opIdStr = String(op.opId);
      if (!seenInBatch.has(opIdStr)) {
        seenInBatch.add(opIdStr);
        deduplicatedBatchOps.push(op);
      }
    }

    // 区分全新操作与已处理的重复操作
    const newOperations = [];
    const duplicateOpIds = [];
    for (const op of deduplicatedBatchOps) {
      const opIdStr = String(op.opId);
      if (this.seenOpIds.has(opIdStr)) {
        duplicateOpIds.push(opIdStr);
      } else {
        newOperations.push(op);
      }
    }

    // 无新 op 的幂等重试：不增 revision，不写盘，返回已有 ack 与 alias
    if (newOperations.length === 0) {
      const relevantAliases = {};
      for (const op of deduplicatedBatchOps) {
        const targetTagId = op.tagId || (op.tag && op.tag.id);
        if (targetTagId && this.tagAliases.has(String(targetTagId))) {
          relevantAliases[String(targetTagId)] = this.tagAliases.get(String(targetTagId));
        }
      }
      return {
        ok: true,
        revision: this.revision,
        state: deepClone(this.state),
        acknowledgedOpIds: [...seenInBatch],
        tagIdRemap: relevantAliases,
        storageVersion: 1
      };
    }

    // 执行新操作
    const draftState = deepClone(this.state);
    const acknowledgedOpIds = [...duplicateOpIds];
    const batchTagIdRemap = {};

    for (const op of newOperations) {
      const opIdStr = String(op.opId);
      const type = op.type;

      switch (type) {
        case 'tag_create': {
          const rawId = String(op.tag.id);
          const trimmedName = op.tag.name.trim().toLowerCase();
          const existingTag = draftState.sessionTagsDefinitions.find(
            (t) => (t && typeof t.name === 'string' ? t.name.trim().toLowerCase() : '') === trimmedName
          );

          if (existingTag) {
            batchTagIdRemap[rawId] = String(existingTag.id);
          } else {
            const targetId = this._resolveTargetTagId(rawId, batchTagIdRemap);
            const alreadyExistsId = draftState.sessionTagsDefinitions.some((t) => t && t.id === targetId);
            if (!alreadyExistsId) {
              const newTagDef = {
                id: targetId,
                name: op.tag.name.trim()
              };
              if (op.tag.color !== undefined) newTagDef.color = op.tag.color.trim();
              if (op.tag.createdAt !== undefined) newTagDef.createdAt = op.tag.createdAt;
              if (op.tag.updatedAt !== undefined) newTagDef.updatedAt = op.tag.updatedAt;
              draftState.sessionTagsDefinitions.push(newTagDef);
            }
          }
          break;
        }

        case 'tag_update': {
          const targetId = this._resolveTargetTagId(op.tagId, batchTagIdRemap);
          const targetTag = draftState.sessionTagsDefinitions.find((t) => t && t.id === targetId);
          if (targetTag) {
            if (op.updates.name !== undefined) {
              targetTag.name = op.updates.name.trim();
            }
            if (op.updates.color !== undefined) {
              targetTag.color = op.updates.color.trim();
            }
            if (targetTag.updatedAt !== undefined || op.updates.updatedAt !== undefined) {
              targetTag.updatedAt = new Date().toISOString();
            }
          }
          break;
        }

        case 'tag_delete': {
          const targetId = this._resolveTargetTagId(op.tagId, batchTagIdRemap);
          draftState.sessionTagsDefinitions = draftState.sessionTagsDefinitions.filter((t) => t?.id !== targetId);

          // 级联清理 mappings 中的 targetId
          for (const sId of Object.keys(draftState.sessionTagMappings)) {
            const list = draftState.sessionTagMappings[sId];
            if (Array.isArray(list) && list.includes(targetId)) {
              const filtered = list.filter((id) => id !== targetId);
              if (filtered.length === 0) {
                delete draftState.sessionTagMappings[sId];
              } else {
                draftState.sessionTagMappings[sId] = filtered;
              }
            }
          }
          break;
        }

        case 'session_tag_add': {
          const targetId = this._resolveTargetTagId(op.tagId, batchTagIdRemap);
          // 后续新关联不存在 tag 拒绝！
          const tagExists = draftState.sessionTagsDefinitions.some((t) => t && t.id === targetId);
          if (!tagExists) {
            throw new Error(`TAG_NOT_FOUND: Tag ${targetId} does not exist`);
          }

          const sId = String(op.sessionId);
          if (Object.hasOwn(draftState.sessionTagMappings, sId) && !Array.isArray(draftState.sessionTagMappings[sId])) {
            throw new Error('MAPPING_NOT_ARRAY: preserve historical mapping until explicitly resolved');
          }
          const currentList = Array.isArray(draftState.sessionTagMappings[sId])
            ? [...draftState.sessionTagMappings[sId]]
            : [];
          if (!currentList.includes(targetId)) {
            currentList.push(targetId);
            draftState.sessionTagMappings[sId] = currentList;
          }
          break;
        }

        case 'session_tag_remove': {
          const targetId = this._resolveTargetTagId(op.tagId, batchTagIdRemap);
          const sId = String(op.sessionId);
          if (Array.isArray(draftState.sessionTagMappings[sId])) {
            const filtered = draftState.sessionTagMappings[sId].filter((id) => id !== targetId);
            if (filtered.length === 0) {
              delete draftState.sessionTagMappings[sId];
            } else {
              draftState.sessionTagMappings[sId] = filtered;
            }
          }
          break;
        }

        case 'session_tag_clear': {
          const sId = String(op.sessionId);
          if (draftState.sessionTagMappings[sId]) {
            delete draftState.sessionTagMappings[sId];
          }
          break;
        }

        case 'session_color_set': {
          const sId = String(op.sessionId);
          draftState.sessionColors[sId] = op.color.trim();
          break;
        }

        case 'session_color_clear': {
          const sId = String(op.sessionId);
          if (draftState.sessionColors[sId]) {
            delete draftState.sessionColors[sId];
          }
          break;
        }

        case 'preferences_snapshot': {
          const cId = String(op.clientId);
          const existingClientPrefs = draftState.enhancementSettingsByClient[cId] || {};
          const newClientPrefs = { ...existingClientPrefs };

          for (const [key, val] of Object.entries(op.values)) {
            newClientPrefs[key] = val;
          }
          draftState.enhancementSettingsByClient[cId] = newClientPrefs;
          break;
        }
      }

      acknowledgedOpIds.push(opIdStr);
    }

    const newRevision = this.revision + 1;
    const timestamp = Date.now();
    const nowIso = new Date().toISOString();

    const journalEntry = {
      type: 'commit',
      revision: newRevision,
      timestamp,
      operations: deepClone(newOperations),
      state: draftState,
      acknowledgedOpIds: [...acknowledgedOpIds],
      tagIdRemap: { ...batchTagIdRemap },
      previousHash: this.lastHash,
      storageVersion: 1
    };

    journalEntry.hash = computeEntryHash(journalEntry);

    // 唯一提交点：写入并 fsync 追加 journal.jsonl
    try {
      appendJournalLine(this.journalFile, journalEntry);
    } catch (appendErr) {
      this.needsReload = true;
      throw appendErr;
    }

    // 投影更新：snapshot 与 current.json
    try {
      const snapFileName = `snapshot_${String(newRevision).padStart(8, '0')}.json`;
      const snapPath = path.join(this.snapshotsDir, snapFileName);
      atomicWriteJson(snapPath, {
        revision: newRevision,
        timestamp,
        operations: deepClone(newOperations),
        state: draftState,
        storageVersion: 1
      });

      atomicWriteJson(this.currentFile, {
        ok: true,
        revision: newRevision,
        state: draftState,
        storageVersion: 1,
        updatedAt: nowIso
      });
    } catch (projectionErr) {
      // 写日志后投影失败，后续调用必须重新加载已提交日志，不能继续旧缓存
      this.needsReload = true;
      throw projectionErr;
    }

    // 提交成功，更新内存缓存
    this.revision = newRevision;
    this.state = draftState;
    this.lastHash = journalEntry.hash;
    this.needsReload = false;

    try {
      const st = fs.statSync(this.journalFile);
      this._lastJournalMtimeMs = st.mtimeMs;
      this._lastJournalSize = st.size;
    } catch (_) {}

    for (const opId of acknowledgedOpIds) {
      this.seenOpIds.add(String(opId));
    }
    for (const [k, v] of Object.entries(batchTagIdRemap)) {
      this.tagAliases.set(String(k), String(v));
    }

    return {
      ok: true,
      revision: this.revision,
      state: deepClone(this.state),
      acknowledgedOpIds,
      tagIdRemap: batchTagIdRemap,
      storageVersion: 1
    };
  }

  commitLocked(operations) {
    if (!Array.isArray(operations)) {
      throw new Error('operations must be an array');
    }
    if (operations.length > 100) {
      throw new Error('Batch size exceeds maximum limit of 100 operations');
    }
    for (const op of operations) {
      validateOperationSchema(op);
    }
    return this._commitLocked(operations);
  }

  commitSync(operations) {
    if (!Array.isArray(operations)) {
      throw new Error('operations must be an array');
    }
    if (operations.length > 100) {
      throw new Error('Batch size exceeds maximum limit of 100 operations');
    }
    for (const op of operations) {
      validateOperationSchema(op);
    }

    return withAgentStateLockSync(this.agentDir, () => {
      return this._commitLocked(operations);
    });
  }

  commit(operations) {
    if (!Array.isArray(operations)) {
      return Promise.reject(new Error('operations must be an array'));
    }
    if (operations.length > 100) {
      return Promise.reject(new Error('Batch size exceeds maximum limit of 100 operations'));
    }

    for (const op of operations) {
      try {
        validateOperationSchema(op);
      } catch (err) {
        return Promise.reject(err);
      }
    }

    return withAgentStateLock(this.agentDir, async () => {
      return this._commitLocked(operations);
    });
  }
}

function createStateStore({ agentDir }) {
  const store = new EnhancementStateStore({ agentDir });
  return {
    initializeFromLegacy: (opts) => store.initializeFromLegacy(opts),
    initializeFromLegacyLocked: (opts) => store.initializeFromLegacyLocked(opts),
    ensureInitializedFromLegacy: (opts) => store.ensureInitializedFromLegacy(opts),
    ensureInitializedFromLegacyLocked: (opts) => store.ensureInitializedFromLegacyLocked(opts),
    read: () => store.read(),
    commit: (operations) => store.commit(operations),
    commitSync: (operations) => store.commitSync(operations),
    commitLocked: (operations) => store.commitLocked(operations),
    recoverStaleLock: (opts) => recoverStaleLock(agentDir, opts),
    withLock: (fn, opts) => withAgentStateLock(agentDir, fn, opts),
    withLockSync: (fn, opts) => withAgentStateLockSync(agentDir, fn, opts),
    withReadLockSync: (fn, opts) => withAgentStateReadLockSync(agentDir, fn, opts)
  };
}

module.exports = {
  createStateStore,
  withAgentStateLock,
  withAgentStateLockSync,
  withAgentStateReadLockSync,
  recoverStaleLock,
  EnhancementStateStore
};
