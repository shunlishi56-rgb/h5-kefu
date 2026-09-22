/**
 * api.js —— REST 接口（历史拉取、账号管理、图片上传、二维码）
 * 实时消息走 WebSocket（hub.js），这里只承担：登录、增量/全量历史、管理后台 CRUD。
 */
'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const config = require('./config');
const store = require('./store');
const hub = require('./hub');
const { authRequired, adminRequired, extractToken } = require('./auth');

const router = express.Router();

/* ---------------- 小工具 ---------------- */

function httpError(res, e, status = 400) {
  const msg = e && e.message ? e.message : '请求失败';
  res.status(status).json({ error: msg });
}

/** 根据请求生成对外访问链接（反代后也能拿到正确域名） */
function baseUrl(req) {
  const host = req.headers['host'] || ('127.0.0.1:' + config.port);
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return proto + '://' + host;
}

/** 访客上传限流（内存，按 IP） */
const uploadRate = new Map();
function rateLimitUpload(ip) {
  const now = Date.now();
  let rec = uploadRate.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + config.visitorUploadRate.windowMs };
    uploadRate.set(ip, rec);
  }
  rec.count += 1;
  return rec.count <= config.visitorUploadRate.max;
}

/** 解析并保存 base64 图片，返回可访问 URL；不合法则抛错 */
function saveDataUrlImage(dataUrl) {
  const m = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('图片格式不正确');
  const mime = m[1];
  const b64 = m[2];
  if (!config.allowedImageMime.includes(mime)) throw new Error('仅支持 jpg/png/gif/webp 图片');
  if (b64.length > config.maxUploadBase64Len) throw new Error('图片过大，请压缩后重试');
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[mime];
  const name = 'img_' + crypto.randomBytes(10).toString('hex') + '.' + ext;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) throw new Error('图片内容为空');
  store.init();
  const fs = require('fs');
  fs.writeFileSync(path.join(config.uploadDir, name), buf);
  return '/uploads/' + name;
}

/* ---------------- 登录 / 账号 ---------------- */

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const agent = store.getAgentByUsername(String(username || '').trim());
  if (!agent || !store.checkPassword(String(password || ''), agent.passwordHash)) {
    return res.status(401).json({ error: '账号或密码错误' });
  }
  if (agent.disabled) return res.status(403).json({ error: '该账号已被停用' });
  const token = store.issueToken(agent.id);
  res.json({ token, agent: { ...agent, passwordHash: undefined } });
});

router.post('/logout', authRequired, (req, res) => {
  store.revokeToken(extractToken(req));
  res.json({ ok: true });
});

router.get('/me', authRequired, (req, res) => {
  const a = store.getAgent(req.agent.id);
  res.json({ agent: { ...a, passwordHash: undefined } });
});

/** 本人资料修改：名字 / 欢迎语 / 快捷回复 / 密码 */
router.put('/me', authRequired, (req, res) => {
  try {
    const patch = req.body || {};
    if (typeof patch.password === 'string' && patch.password) {
      const a = store.getAgent(req.agent.id);
      if (!store.checkPassword(String(patch.oldPassword || ''), a.passwordHash)) {
        return res.status(401).json({ error: '原密码不正确' });
      }
    }
    const agent = store.updateAgent(req.agent.id, patch);
    res.json({ agent });
  } catch (e) { httpError(res, e); }
});

/** 管理员：客服列表 */
router.get('/agents', adminRequired, (req, res) => {
  res.json({ agents: store.listAgents() });
});

/** 管理员：新增客服（即创建独立链接/二维码） */
router.post('/agents', adminRequired, (req, res) => {
  try {
    const { username, name, password, role } = req.body || {};
    if (!String(username || '').trim()) throw new Error('请填写登录账号');
    if (String(password || '').length < 6) throw new Error('初始密码至少 6 位');
    const agent = store.createAgent({
      username: String(username).trim(),
      name: String(name || '').trim(),
      password: String(password),
      role: role
    });
    res.json({ agent });
  } catch (e) { httpError(res, e); }
});

/** 管理员或本人：修改客服资料 */
router.put('/agents/:id', authRequired, (req, res) => {
  try {
    if (req.agent.role !== 'admin' && req.agent.id !== req.params.id) {
      return res.status(403).json({ error: '只能修改自己的资料' });
    }
    res.json({ agent: store.updateAgent(req.params.id, req.body || {}) });
  } catch (e) { httpError(res, e); }
});

/** 管理员：删除客服（会话记录保留在磁盘，可人工归档） */
router.delete('/agents/:id', adminRequired, (req, res) => {
  try {
    store.deleteAgent(req.params.id);
    res.json({ ok: true });
  } catch (e) { httpError(res, e); }
});

/* ---------------- 会话 / 消息（客服端） ---------------- */

/** 客服的会话列表（含未读角标与访客在线状态） */
router.get('/sessions', authRequired, (req, res) => {
  const status = req.query.status === 'closed' ? 'closed' : (req.query.status === 'open' ? 'open' : '');
  const list = store.listSessions(req.agent.id, status).map(s => ({
    ...s,
    online: hub.isVisitorOnline(s.sid)
  }));
  res.json({ sessions: list });
});

/** 消息历史 / 增量：?sid=xxx&after=seq */
router.get('/messages', authRequired, (req, res) => {
  const { sid, after } = req.query;
  const session = store.getSession(String(sid || ''));
  if (!session) return res.status(404).json({ error: '会话不存在' });
  if (session.agentId !== req.agent.id) return res.status(403).json({ error: '无权访问该会话' });
  const afterSeq = parseInt(after || '0', 10) || 0;
  res.json({ messages: store.listMessages(session.sid, afterSeq, 0) });
});

/** 结束会话（归入历史） */
router.post('/close-session', authRequired, (req, res) => {
  const { sid } = req.body || {};
  const session = store.getSession(String(sid || ''));
  if (!session || session.agentId !== req.agent.id) return res.status(404).json({ error: '会话不存在' });
  store.closeSession(session.sid);
  hub.broadcastSessionUpdate(session.sid);
  res.json({ ok: true });
});

/** 客服端图片上传 */
router.post('/upload', authRequired, (req, res) => {
  try {
    const url = saveDataUrlImage((req.body || {}).dataUrl);
    res.json({ url });
  } catch (e) { httpError(res, e); }
});

/* ---------------- 二维码 / 专属链接 ---------------- */

/** 生成某客服的专属链接 + 二维码（PNG dataURL），扫码直达该客服会话 */
router.get('/qr/:agentId', authRequired, async (req, res) => {
  const target = req.params.agentId === 'me' ? store.getAgent(req.agent.id) : store.getAgent(req.params.agentId);
  if (!target) return res.status(404).json({ error: '客服不存在' });
  if (req.agent.role !== 'admin' && req.agent.id !== target.id) {
    return res.status(403).json({ error: '只能查看自己的二维码' });
  }
  const url = baseUrl(req) + '/chat/' + target.id;
  const dataUrl = await QRCode.toDataURL(url, { width: 300, margin: 1, color: { dark: '#1f3b5d', light: '#ffffff' } });
  res.json({ url, dataUrl, agentId: target.id, name: target.name });
});

/* ---------------- 访客端公开接口（免登） ---------------- */

/** 访客进入页面时获取客服公开信息（名称 / 是否在线 / 是否停用） */
router.get('/public/agent-info', (req, res) => {
  const agentId = String(req.query.agentId || '');
  const agent = store.getAgent(agentId);
  if (!agent) return res.status(404).json({ error: '链接无效或客服不存在' });
  res.json({
    agent: {
      id: agent.id,
      name: agent.name,
      disabled: !!agent.disabled,
      online: hub.isAgentOnline(agent.id)
    }
  });
});

/** 访客历史消息（首次进入全量，断线重连增量）：?agentId=&visitorId=&after= */
router.get('/visitor/messages', (req, res) => {
  const agentId = String(req.query.agentId || '');
  const visitorId = String(req.query.visitorId || '');
  const after = parseInt(req.query.after || '0', 10) || 0;
  if (!agentId || !visitorId || visitorId.length > 64) return res.status(400).json({ error: '参数不完整' });
  const agent = store.getAgent(agentId);
  if (!agent) return res.status(404).json({ error: '链接无效' });
  const vName = String(req.query.visitorName || '').slice(0, 32);
  const { session } = store.getOrCreateSession(agentId, visitorId, vName);
  res.json({
    sid: session.sid,
    session: { ...session },
    messages: store.listMessages(session.sid, after, 0)
  });
});

/** 访客图片上传（按 IP 限流） */
router.post('/visitor/upload', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!rateLimitUpload(ip)) return res.status(429).json({ error: '操作太频繁，请稍后再试' });
  try {
    const url = saveDataUrlImage((req.body || {}).dataUrl);
    res.json({ url });
  } catch (e) { httpError(res, e); }
});

module.exports = router;
