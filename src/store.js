/**
 * store.js —— 数据持久化层（纯 JSON/JSONL 文件存储，零原生依赖）
 *
 * 设计目标：保证消息不丢、不重、可回溯。
 *  - 消息：每会话一个 {sid}.jsonl 文件，逐条追加（append-only），先落盘再广播；
 *  - 撤回：不修改历史行，而是追加一条 recall 事件行，读取时动态套用（文件永不重写）；
 *  - 幂等：客户端每条消息带 cid（客户端生成），服务端按 (sid,cid) 去重，断线重发不会产生重复消息；
 *  - 原子写：agents/tokens/meta 采用「临时文件 + rename」原子覆盖，避免写一半损坏；
 *  - 增量：每条消息会话内严格自增 seq，用于断线重连后的增量拉取与已读判定。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const sessionsDir = path.join(config.dataDir, 'sessions');
const agentsFile = path.join(config.dataDir, 'agents.json');
const tokensFile = path.join(config.dataDir, 'tokens.json');

/** 客服账号（内存缓存 + 落盘） */
let agents = [];
/** 登录令牌 token -> {agentId, createdAt} */
let tokens = {};
/** 会话元数据 sid -> meta（内存缓存 + 落盘） */
const sessions = new Map();
/** 幂等去重索引 sid -> Set<cid>（启动时从消息文件重建，只保留最近消息的 cid） */
const cidIndex = new Map();
/** 停机钩子标记 */
let inited = false;

/* ---------------- 基础工具 ---------------- */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 原子写 JSON 文件：写临时文件后 rename，保证不产生半截文件 */
function atomicWriteJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function sidOf(agentId, visitorId) {
  return crypto.createHash('sha1').update(agentId + '|' + visitorId).digest('hex').slice(0, 20);
}

function randomId(prefix) {
  return prefix + '_' + crypto.randomBytes(9).toString('hex');
}

/* ---------------- 初始化 ---------------- */

function init() {
  if (inited) return;
  inited = true;
  ensureDir(config.dataDir);
  ensureDir(sessionsDir);
  ensureDir(config.uploadDir);
  ensureDir(path.join(config.dataDir, 'logs'));

  agents = readJsonSafe(agentsFile, []);
  tokens = readJsonSafe(tokensFile, {});
  if (!Array.isArray(agents)) agents = [];
  if (!tokens || typeof tokens !== 'object') tokens = {};

  // 首次启动：创建初始管理员
  if (agents.length === 0) {
    const admin = {
      id: randomId('a'),
      username: config.initAdmin.username,
      passwordHash: hashPassword(config.initAdmin.password),
      name: config.initAdmin.name,
      role: 'admin',
      welcome: '您好，很高兴为您服务，请问有什么可以帮您？',
      quickReplies: ['您好，请稍等，我这边看一下~', '好的，没问题', '请您详细描述一下您的问题', '感谢您的咨询，还有其他问题吗？'],
      notifySound: 'beep',          // 提示音类型：beep|ding|bell|none
      disabled: false,
      createdAt: Date.now()
    };
    agents.push(admin);
    saveAgents();
    console.log('[store] 已创建初始管理员: ' + config.initAdmin.username + ' / ' + config.initAdmin.password + '（请尽快登录修改密码）');
  }

  // 恢复所有会话元数据
  for (const f of fs.readdirSync(sessionsDir)) {
    if (!f.endsWith('.meta.json')) continue;
    const meta = readJsonSafe(path.join(sessionsDir, f), null);
    if (meta && meta.sid) sessions.set(meta.sid, meta);
  }
  console.log('[store] 数据加载完成：客服 ' + agents.length + ' 个，会话 ' + sessions.size + ' 个');
}

/* ---------------- 客服账号 ---------------- */

function saveAgents() {
  atomicWriteJson(agentsFile, agents);
}

function listAgents() {
  return agents.map(a => ({ ...a, passwordHash: undefined }));
}

function getAgent(id) {
  return agents.find(a => a.id === id) || null;
}

function getAgentByUsername(username) {
  return agents.find(a => a.username === username) || null;
}

function createAgent({ username, name, password, role }) {
  if (getAgentByUsername(username)) throw new Error('登录账号已存在');
  const agent = {
    id: randomId('a'),
    username,
    passwordHash: hashPassword(password || '123456'),
    name: name || username,
    role: role === 'admin' ? 'admin' : 'agent',
    welcome: '您好，很高兴为您服务，请问有什么可以帮您？',
    quickReplies: [],
    notifySound: 'beep',
    disabled: false,
    createdAt: Date.now()
  };
  agents.push(agent);
  saveAgents();
  return { ...agent, passwordHash: undefined };
}

/**
 * 更新客服资料。
 * patch 可含：name / welcome / quickReplies / disabled / password / username
 */
function updateAgent(id, patch) {
  const agent = getAgent(id);
  if (!agent) throw new Error('客服不存在');
  if (typeof patch.name === 'string' && patch.name.trim()) agent.name = patch.name.trim();
  if (typeof patch.welcome === 'string') agent.welcome = patch.welcome.slice(0, 500);
  if (Array.isArray(patch.quickReplies)) {
    agent.quickReplies = patch.quickReplies
      .map(s => String(s || '').trim())
      .filter(Boolean)
      .slice(0, 100)
      .map(s => s.slice(0, 500));
  }
  if (typeof patch.disabled === 'boolean') agent.disabled = patch.disabled;
  if (typeof patch.notifySound === 'string') agent.notifySound = patch.notifySound; // 提示音类型：'beep'|'ding'|'bell'|'none'
  if (typeof patch.username === 'string' && patch.username.trim() && patch.username !== agent.username) {
    if (getAgentByUsername(patch.username.trim())) throw new Error('登录账号已存在');
    agent.username = patch.username.trim();
  }
  if (typeof patch.password === 'string' && patch.password.length >= 6) {
    agent.passwordHash = hashPassword(patch.password);
  }
  saveAgents();
  return { ...agent, passwordHash: undefined };
}

function deleteAgent(id) {
  const agent = getAgent(id);
  if (!agent) throw new Error('客服不存在');
  if (agent.role === 'admin') {
    const admins = agents.filter(a => a.role === 'admin');
    if (admins.length <= 1) throw new Error('系统至少需要保留一个管理员');
  }
  agents = agents.filter(a => a.id !== id);
  saveAgents();
  // 令牌：使该客服所有令牌失效
  for (const t of Object.keys(tokens)) if (tokens[t].agentId === id) delete tokens[t];
  saveTokens();
}

/* ---------------- 登录令牌 ---------------- */

function saveTokens() {
  atomicWriteJson(tokensFile, tokens);
}

function issueToken(agentId) {
  const token = crypto.randomBytes(24).toString('hex');
  tokens[token] = { agentId, createdAt: Date.now() };
  saveTokens();
  return token;
}

function verifyToken(token) {
  if (!token || !tokens[token]) return null;
  const rec = tokens[token];
  if (config.tokenTtl > 0 && Date.now() - rec.createdAt > config.tokenTtl) {
    delete tokens[token];
    saveTokens();
    return null;
  }
  const agent = getAgent(rec.agentId);
  if (!agent || agent.disabled) return null;
  return agent;
}

function revokeToken(token) {
  if (tokens[token]) {
    delete tokens[token];
    saveTokens();
  }
}

/* ---------------- 会话 ---------------- */

function metaFile(sid) { return path.join(sessionsDir, sid + '.meta.json'); }
function msgFile(sid) { return path.join(sessionsDir, sid + '.jsonl'); }

function saveMeta(meta) {
  atomicWriteJson(metaFile(meta.sid), meta);
}

/**
 * 获取（或创建）访客与某客服的会话。
 * 返回 { session, created }：created=true 表示本次新建（调用方应下发欢迎语）。
 */
function getOrCreateSession(agentId, visitorId, visitorName) {
  const sid = sidOf(agentId, visitorId);
  let meta = sessions.get(sid);
  if (meta) {
    // 访客昵称可能更新（例如换设备名），刷新一下
    if (visitorName && visitorName !== meta.visitorName) {
      meta.visitorName = visitorName;
      saveMeta(meta);
    }
    return { session: meta, created: false };
  }
  const agent = getAgent(agentId);
  if (!agent) throw new Error('客服不存在');
  const now = Date.now();
  meta = {
    sid,
    agentId,
    visitorId,
    visitorName: visitorName || ('访客' + String(now).slice(-6)),
    remark: '',                       // 客服给访客的备注名（空则显示 visitorName）
    starred: false,                   // 标星/置顶（true 排在列表最前）
    status: 'open',                 // open=进行中 closed=已结束
    createdAt: now,
    lastMsgAt: now,
    lastMsgPreview: '',
    msgSeq: 0,                       // 会话内消息自增序号（持久化在 meta）
    unreadAgent: 0,                  // 客服未读
    unreadVisitor: 0,                // 访客未读
    visitorReadSeq: 0,               // 访客已读到 seq
    agentReadSeq: 0,                  // 客服已读到 seq
    msgCount: 0
  };
  sessions.set(sid, meta);
  saveMeta(meta);
  fs.writeFileSync(msgFile(sid), '', 'utf8'); // 建空消息文件
  return { session: meta, created: true };
}

function getSession(sid) {
  return sessions.get(sid) || null;
}

function listSessions(agentId, status) {
  const arr = [];
  for (const m of sessions.values()) {
    if (m.agentId !== agentId) continue;
    if (status && m.status !== status) continue;
    arr.push({ ...m });
  }
  arr.sort((a, b) => b.lastMsgAt - a.lastMsgAt);
  return arr;
}

/** 轻量版：仅取某客服名下会话的 sid 列表（用于在线状态广播，避免全量排序） */
function listSessionSids(agentId) {
  const out = [];
  for (const m of sessions.values()) {
    if (m.agentId === agentId) out.push(m.sid);
  }
  return out;
}

function closeSession(sid) {
  const meta = sessions.get(sid);
  if (!meta) return null;
  meta.status = 'closed';
  meta.closedAt = Date.now();
  saveMeta(meta);
  return meta;
}

/**
 * 彻底删除会话：清理内存 + 删除磁盘文件。不可恢复。
 */
function deleteSession(sid) {
  const meta = sessions.get(sid);
  if (!meta) return null;
  sessions.delete(sid);
  cidIndex.delete(sid);
  cidInited.delete(sid);
  try { fs.unlinkSync(metaFile(sid)); } catch (e) { /* 文件不存在则忽略 */ }
  try { fs.unlinkSync(msgFile(sid)); } catch (e) { /* 文件不存在则忽略 */ }
  return meta;
}

/**
 * 更新会话元数据的部分字段（用于备注、标星等）。
 * patch 可含：remark / starred
 */
function updateSessionMeta(sid, patch) {
  const meta = sessions.get(sid);
  if (!meta) return null;
  if (typeof patch.remark === 'string') meta.remark = patch.remark.slice(0, 50);
  if (typeof patch.starred === 'boolean') meta.starred = patch.starred;
  saveMeta(meta);
  return meta;
}

/** 已结束的会话收到新消息时自动恢复为进行中 */
function reopenSession(sid) {
  const meta = sessions.get(sid);
  if (!meta) return null;
  if (meta.status === 'closed') {
    meta.status = 'open';
    delete meta.closedAt;
    saveMeta(meta);
  }
  return meta;
}

/* ---------------- 消息（JSONL 追加写） ---------------- */

/**
 * 获取该会话的幂等去重索引（cid 集合）。
 * 进程重启后内存索引为空，这里从磁盘惰性重建最近 200 条的 cid，
 * 保证「断线重发 + 服务端恰好重启」场景下消息依然不会重复入库。
 */
const cidInited = new Set(); // sid -> 是否已从磁盘重建过
function ensureCidIndex(sid) {
  let set = cidIndex.get(sid);
  if (!set) { set = new Set(); cidIndex.set(sid, set); }
  if (!cidInited.has(sid)) {
    cidInited.add(sid);
    const meta = sessions.get(sid);
    if (meta && meta.msgSeq > 0) {
      const from = Math.max(0, meta.msgSeq - 200);
      for (const m of listMessages(sid, from, 0)) {
        if (m.cid) set.add(m.cid);
      }
    }
  }
  return set;
}

/**
 * 追加一条消息（先落盘，再更新内存）。
 * 幂等：cid 已存在时直接返回已有消息（用于断线重发去重）。
 */
function appendMessage(sid, { from, senderId, type, content, cid }) {
  const meta = sessions.get(sid);
  if (!meta) throw new Error('会话不存在');
  if (cid) {
    const set = ensureCidIndex(sid);
    if (set.has(cid)) {
      // 幂等命中：找到已存在的那条返回
      for (const m of listMessages(sid, 0, 0)) {
        if (m.cid === cid) return m;
      }
    }
  }
  const now = Date.now();
  const msg = {
    id: randomId('m'),
    cid: cid || '',
    sid,
    seq: ++meta.msgSeq,
    from,                                 // 'visitor' | 'agent'
    senderId: senderId || '',
    type,                                 // 'text' | 'image' | 'event'
    content: String(content || '').slice(0, type === 'text' ? config.maxTextLength : 100000),
    ts: now,
    recalled: false,
    recallTs: 0
  };
  fs.appendFileSync(msgFile(sid), JSON.stringify(msg) + '\n', 'utf8');
  if (cid) ensureCidIndex(sid).add(cid);
  // 维持 cid 索引体积：只保留最近 200 条的 cid
  const set = ensureCidIndex(sid);
  if (set.size > 200) {
    const recent = listMessages(sid, Math.max(0, meta.msgSeq - 200), 0).map(m => m.cid).filter(Boolean);
    cidIndex.set(sid, new Set(recent));
  }
  // 更新会话元数据
  meta.lastMsgAt = now;
  meta.msgCount = (meta.msgCount || 0) + 1;
  meta.lastMsgPreview = type === 'image' ? '[图片]' : (msg.content || '').slice(0, 60);
  if (from === 'visitor') meta.unreadAgent += 1;
  else if (from === 'agent') meta.unreadVisitor += 1;
  saveMeta(meta);
  return msg;
}

/**
 * 追加撤回事件（append-only，不改动历史行）。
 * 校验：只能撤回自己发的、且是文本/图片消息。
 */
function appendRecall(sid, targetId, operator) {
  const meta = sessions.get(sid);
  if (!meta) throw new Error('会话不存在');
  const target = listMessages(sid, 0, 0).find(m => m.id === targetId);
  if (!target) throw new Error('消息不存在');
  if (target.recalled) return target;                 // 重复撤回，直接成功
  if (target.from !== operator.from) throw new Error('只能撤回自己发送的消息');
  const ev = {
    id: randomId('m'),
    cid: '',
    sid,
    seq: ++meta.msgSeq,
    from: operator.from,
    senderId: operator.senderId,
    type: 'event',
    event: 'recall',
    targetId,
    content: '',
    ts: Date.now(),
    recalled: false,
    recallTs: 0
  };
  fs.appendFileSync(msgFile(sid), JSON.stringify(ev) + '\n', 'utf8');
  meta.lastMsgAt = ev.ts;
  meta.lastMsgPreview = '[消息已撤回]';
  meta.msgCount = (meta.msgCount || 0) + 1;
  saveMeta(meta);
  // 在事件流里被标记后，读取层会返回 recalled=true 的目标消息
  const updated = { ...target, recalled: true, recallTs: ev.ts };
  return updated;
}

/**
 * 读取会话消息（读取时套用撤回事件）。
 * afterSeq=0 返回全部；否则只返回 seq > afterSeq 的（增量拉取）。
 * limit=0 表示不限制（但超出 maxHistoryPerPull 时返回最新的一批）。
 */
function listMessages(sid, afterSeq, limit) {
  const meta = sessions.get(sid);
  if (!meta) return [];
  const file = msgFile(sid);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return [];
  }
  const lines = raw.split('\n');
  const byId = new Map();
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.type === 'event' && m.event === 'recall' && m.targetId) {
      const t = byId.get(m.targetId);
      if (t) { t.recalled = true; t.recallTs = m.ts; }
      continue;
    }
    if (m.type === 'event') continue;
    byId.set(m.id, m);
    out.push(m);
  }
  let filtered = afterSeq > 0 ? out.filter(m => m.seq > afterSeq) : out;
  const cap = limit > 0 ? limit : config.maxHistoryPerPull;
  if (filtered.length > cap) filtered = filtered.slice(filtered.length - cap);
  return filtered;
}

/** 已读上报：who = 'visitor' | 'agent'，readSeq 为已读到的最大消息 seq */
function markRead(sid, who, readSeq) {
  const meta = sessions.get(sid);
  if (!meta) return null;
  if (who === 'visitor') {
    if (readSeq > meta.visitorReadSeq) {
      meta.visitorReadSeq = readSeq;
      meta.unreadVisitor = 0;
      saveMeta(meta);
    }
  } else {
    if (readSeq > meta.agentReadSeq) {
      meta.agentReadSeq = readSeq;
      meta.unreadAgent = 0;
      saveMeta(meta);
    }
  }
  return meta;
}

/* ---------------- 密码哈希（零依赖，Node 内置 scrypt） ---------------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(12).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return 'scrypt$' + salt + '$' + hash;
}

function checkPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const hash = crypto.scryptSync(String(password), parts[1], 32).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(parts[2], 'hex'));
  } catch (e) {
    return false;
  }
}

/* ---------------- 导出 ---------------- */

module.exports = {
  init,
  listAgents, getAgent, getAgentByUsername, createAgent, updateAgent, deleteAgent,
  issueToken, verifyToken, revokeToken,
  getOrCreateSession, getSession, listSessions, listSessionSids, closeSession, deleteSession, updateSessionMeta, reopenSession,
  appendMessage, appendRecall, listMessages, markRead,
  hashPassword, checkPassword,
  sidOf, randomId
};
