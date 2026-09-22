/**
 * hub.js —— WebSocket 实时消息中心
 *
 * 可靠性设计：
 *  1. 服务端收到消息先落盘（store.appendMessage 幂等），成功后回 ACK，再向对端广播；
 *  2. 客户端未收到 ACK 会自动重发（同 cid），服务端幂等去重 → 消息不丢也不重；
 *  3. 断线重连后客户端按 seq 增量拉取漏掉的消息（HTTP /api/messages、/api/visitor/messages）。
 *
 * 扩展点（预留）：
 *  - onNewMessageHook：新消息钩子，可在此接邮件 / 企业微信机器人 / Webhook 提醒；
 *  - typing：正在输入提示（已实现，可在前端扩展更多反馈）；
 *  - 会话分配：目前为「固定客服链接」模式，后续可在 msg 处理中把消息转发给空闲客服池。
 */
'use strict';
const { WebSocketServer } = require('ws');
const config = require('./config');
const store = require('./store');

/** 访客连接：sid -> Set<ws>（同访客可开多个标签页） */
const visitorSockets = new Map();
/** 客服连接：agentId -> Set<ws> */
const agentSockets = new Map();
let wss = null;
let onNewMessageHook = null; // 扩展点：function(message, session) {}

/* ---------------- 发送工具 ---------------- */

function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch (e) { /* 忽略单连接异常 */ }
}

function sendToAgent(agentId, obj, excludeWs) {
  const set = agentSockets.get(agentId);
  if (!set) return;
  for (const ws of set) if (ws !== excludeWs) safeSend(ws, obj);
}

function sendToSession(sid, obj, excludeWs) {
  const set = visitorSockets.get(sid);
  if (!set) return;
  for (const ws of set) if (ws !== excludeWs) safeSend(ws, obj);
}

/* ---------------- 在线状态 ---------------- */

function isAgentOnline(agentId) {
  const set = agentSockets.get(agentId);
  return !!(set && set.size > 0);
}

function isVisitorOnline(sid) {
  const set = visitorSockets.get(sid);
  return !!(set && set.size > 0);
}

/** 客服在线状态变化 → 通知该客服所有会话中的访客 */
function broadcastAgentPresence(agentId, online) {
  // 通知该客服名下所有会话的访客
  for (const sid of sessionsOfAgent(agentId)) {
    sendToSession(sid, { type: 'presence', who: 'agent', online });
  }
}

/** 访客在线状态变化 → 通知客服 */
function broadcastVisitorPresence(sid, online) {
  const meta = store.getSession(sid);
  if (!meta) return;
  sendToAgent(meta.agentId, { type: 'presence', sid, who: 'visitor', online });
}

function sessionsOfAgent(agentId) {
  return store.listSessionSids(agentId);
}

/** 会话元数据变更（新消息/结束会话/未读变化）→ 通知客服端刷新列表 */
function broadcastSessionUpdate(sid, excludeAgentWs) {
  const meta = store.getSession(sid);
  if (!meta) return;
  sendToAgent(meta.agentId, { type: 'session', session: { ...meta, online: isVisitorOnline(sid) } }, excludeAgentWs);
}

/* ---------------- 连接管理 ---------------- */

function addVisitorSocket(sid, ws) {
  let set = visitorSockets.get(sid);
  if (!set) { set = new Set(); visitorSockets.set(sid, set); }
  set.add(ws);
  if (set.size === 1) broadcastVisitorPresence(sid, true);
}

function removeVisitorSocket(sid, ws) {
  const set = visitorSockets.get(sid);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    visitorSockets.delete(sid);
    broadcastVisitorPresence(sid, false);
  }
}

function addAgentSocket(agentId, ws) {
  let set = agentSockets.get(agentId);
  if (!set) { set = new Set(); agentSockets.set(agentId, set); }
  const wasOffline = set.size === 0;
  set.add(ws);
  if (wasOffline) broadcastAgentPresence(agentId, true);
}

function removeAgentSocket(agentId, ws) {
  const set = agentSockets.get(agentId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    agentSockets.delete(agentId);
    broadcastAgentPresence(agentId, false);
  }
}

/* ---------------- 消息处理 ---------------- */

function handleHello(ws, data) {
  if (data.role === 'agent') {
    const agent = store.verifyToken(String(data.token || ''));
    if (!agent || agent.disabled) {
      safeSend(ws, { type: 'error', code: 'auth', message: '登录已失效，请重新登录' });
      return ws.close();
    }
    ws.role = 'agent';
    ws.agentId = agent.id;
    addAgentSocket(agent.id, ws);
    const sessions = store.listSessions(agent.id, '').map(s => ({ ...s, online: isVisitorOnline(s.sid) }));
    safeSend(ws, {
      type: 'ready',
      role: 'agent',
      agent: { ...agent, passwordHash: undefined },
      sessions
    });
    return;
  }

  // ---- 访客握手（免登录）----
  const agentId = String(data.agentId || '');
  const visitorId = String(data.visitorId || '').slice(0, 64);
  const visitorName = String(data.visitorName || '').slice(0, 32);
  const agent = store.getAgent(agentId);
  if (!agent) { safeSend(ws, { type: 'error', code: 'agent_not_found', message: '客服不存在' }); return ws.close(); }
  if (agent.disabled) { safeSend(ws, { type: 'error', code: 'agent_disabled', message: '该客服已停用' }); return ws.close(); }
  if (!visitorId) { safeSend(ws, { type: 'error', code: 'bad_visitor', message: '访客身份无效' }); return ws.close(); }

  let result;
  try {
    result = store.getOrCreateSession(agentId, visitorId, visitorName);
  } catch (e) {
    safeSend(ws, { type: 'error', code: 'session_error', message: e.message });
    return ws.close();
  }
  const { session, created } = result;
  ws.role = 'visitor';
  ws.sid = session.sid;
  ws.visitorId = visitorId;
  addVisitorSocket(session.sid, ws);

  // 新会话：自动下发该客服的自定义欢迎语（真实入库，历史中可见）
  let welcomeMsg = null;
  if (created && agent.welcome) {
    try {
      const content = agent.welcome.replace(/\{访客\}|\{name\}/g, session.visitorName || '您');
      welcomeMsg = store.appendMessage(session.sid, {
        from: 'agent', senderId: agent.id, type: 'text', content
      });
      sendToAgent(agent.id, { type: 'session', session: { ...store.getSession(session.sid), online: isVisitorOnline(session.sid) } });
    } catch (e) { /* 欢迎语失败不阻断会话 */ }
  }

  safeSend(ws, {
    type: 'ready',
    role: 'visitor',
    sid: session.sid,
    session: { ...store.getSession(session.sid) },
    messages: store.listMessages(session.sid, 0, 0),
    welcomeMsg,
    agentOnline: isAgentOnline(agent.id),
    agentName: agent.name
  });
}

function handleMsg(ws, data) {
  const sid = String(data.sid || '');
  const cid = String(data.cid || '').slice(0, 64);
  const type = data.msgType === 'image' ? 'image' : 'text';
  let content = String(data.content || '');

  // ---- 身份与归属校验 ----
  let from, senderId, meta;
  if (ws.role === 'visitor') {
    if (sid !== ws.sid) return safeSend(ws, { type: 'error', code: 'forbidden', message: '会话不匹配' });
    meta = store.getSession(sid);
    from = 'visitor';
    senderId = ws.visitorId;
  } else if (ws.role === 'agent') {
    meta = store.getSession(sid);
    if (!meta || meta.agentId !== ws.agentId) return safeSend(ws, { type: 'error', code: 'forbidden', message: '会话不匹配' });
    from = 'agent';
    senderId = ws.agentId;
  } else {
    return safeSend(ws, { type: 'error', code: 'auth', message: '请先握手' });
  }
  if (!meta) return safeSend(ws, { type: 'error', code: 'no_session', message: '会话不存在' });

  // ---- 内容校验 ----
  if (type === 'text') {
    if (!content.trim()) return safeSend(ws, { type: 'error', code: 'empty', message: '消息不能为空' });
    if (content.length > config.maxTextLength) return safeSend(ws, { type: 'error', code: 'too_long', message: '消息过长' });
  } else {
    if (!/^\/uploads\/img_[a-f0-9]{20}\.(jpg|png|gif|webp)$/.test(content)) {
      return safeSend(ws, { type: 'error', code: 'bad_image', message: '图片地址无效' });
    }
  }

  // ---- 已结束的会话收到新消息：自动回到进行中 ----
  if (meta.status === 'closed') meta = store.reopenSession(sid);

  // ---- 先落盘（幂等），成功后 ACK + 广播 ----
  let msg;
  try {
    msg = store.appendMessage(sid, { from, senderId, type, content, cid });
  } catch (e) {
    return safeSend(ws, { type: 'error', code: 'store_error', message: '消息保存失败，请重试' });
  }
  const fresh = { ...store.getSession(sid) };

  safeSend(ws, { type: 'ack', sid, cid, message: msg });   // 发送确认（客户端据此移除 pending 状态）
  if (from === 'visitor') {
    sendToSession(sid, { type: 'msg', sid, message: msg }, ws);       // 多端同步
    sendToAgent(fresh.agentId, { type: 'msg', sid, message: msg, session: { ...fresh, online: isVisitorOnline(sid) } });
  } else {
    sendToAgent(fresh.agentId, { type: 'msg', sid, message: msg }, ws);
    sendToSession(sid, { type: 'msg', sid, message: msg });
  }
  // 扩展点：新消息钩子（消息提醒：可在此接 Webhook / 邮件 / APP 推送）
  if (onNewMessageHook) {
    try { onNewMessageHook(msg, fresh); } catch (e) { /* 钩子异常不影响主流程 */ }
  }
}

function handleRecall(ws, data) {
  const sid = String(data.sid || '');
  const msgId = String(data.msgId || '');
  let operator;
  if (ws.role === 'visitor') {
    if (sid !== ws.sid) return safeSend(ws, { type: 'error', code: 'forbidden', message: '会话不匹配' });
    operator = { from: 'visitor', senderId: ws.visitorId };
  } else if (ws.role === 'agent') {
    const meta = store.getSession(sid);
    if (!meta || meta.agentId !== ws.agentId) return safeSend(ws, { type: 'error', code: 'forbidden', message: '会话不匹配' });
    operator = { from: 'agent', senderId: ws.agentId };
  } else {
    return safeSend(ws, { type: 'error', code: 'auth', message: '请先握手' });
  }
  let updated;
  try {
    updated = store.appendRecall(sid, msgId, operator);
  } catch (e) {
    return safeSend(ws, { type: 'error', code: 'recall_failed', message: e.message });
  }
  const meta = store.getSession(sid);
  const payload = { type: 'recall', sid, msgId, ts: updated.recallTs || Date.now() };
  if (meta) {
    sendToAgent(meta.agentId, payload);
    sendToSession(sid, payload);
    // 同步刷新客服端会话列表（预览、最后时间）
    broadcastSessionUpdate(sid);
  }
}

function handleRead(ws, data) {
  const sid = String(data.sid || '');
  const readSeq = parseInt(data.readSeq || '0', 10) || 0;
  let who;
  if (ws.role === 'visitor') {
    if (sid !== ws.sid) return;
    who = 'visitor';
  } else if (ws.role === 'agent') {
    const meta = store.getSession(sid);
    if (!meta || meta.agentId !== ws.agentId) return;
    who = 'agent';
  } else {
    return;
  }
  const meta = store.markRead(sid, who, readSeq);
  if (!meta) return;
  const payload = { type: 'read', sid, who, readSeq };
  if (who === 'visitor') {
    // 通知客服端：该会话已读，未读角标清零
    sendToAgent(meta.agentId, { type: 'session', session: { ...meta, online: isVisitorOnline(sid) } });
    sendToAgent(meta.agentId, payload);
  } else {
    sendToSession(sid, payload);   // 通知访客端：消息已读
  }
}

function handleTyping(ws, data) {
  const sid = String(data.sid || '');
  if (ws.role === 'visitor' && sid === ws.sid) {
    const meta = store.getSession(sid);
    if (meta) sendToAgent(meta.agentId, { type: 'typing', sid, who: 'visitor' });
  } else if (ws.role === 'agent') {
    const meta = store.getSession(sid);
    if (meta && meta.agentId === ws.agentId) sendToSession(sid, { type: 'typing', who: 'agent' });
  }
}

/* ---------------- 心跳 ---------------- */

function startHeartbeat() {
  const timer = setInterval(() => {
    if (!wss) return;
    wss.clients.forEach(ws => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* ignore */ }
    });
  }, 30000);
  timer.unref && timer.unref();
}

/* ---------------- 初始化 ---------------- */

function init(httpServer) {
  store.init();
  wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, ws => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', ws => {
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', raw => {
      let data;
      try { data = JSON.parse(raw.toString()); } catch (e) { return; }
      if (data.type === 'ping') return safeSend(ws, { type: 'pong', t: data.t });
      try {
        switch (data.type) {
          case 'hello': return handleHello(ws, data);
          case 'msg': return handleMsg(ws, data);
          case 'recall': return handleRecall(ws, data);
          case 'read': return handleRead(ws, data);
          case 'typing': return handleTyping(ws, data);
        }
      } catch (e) {
        safeSend(ws, { type: 'error', code: 'server_error', message: '服务处理异常，请重试' });
      }
    });

    ws.on('close', () => {
      if (ws.role === 'visitor' && ws.sid) removeVisitorSocket(ws.sid, ws);
      if (ws.role === 'agent' && ws.agentId) removeAgentSocket(ws.agentId, ws);
    });
    ws.on('error', () => { /* 连接异常由 close 兜底 */ });
  });

  startHeartbeat();
  console.log('[hub] WebSocket 服务已就绪 (/ws)');
}

module.exports = {
  init,
  isAgentOnline,
  isVisitorOnline,
  broadcastSessionUpdate,
  /** 扩展点：注册新消息钩子（提醒推送） */
  onNewMessage(hook) { onNewMessageHook = hook; }
};
