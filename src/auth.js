/**
 * auth.js —— 客服端认证中间件（访客免登，不经过此层）
 */
'use strict';
const store = require('./store');

/** 从请求中提取 token：优先 Authorization: Bearer xxx，其次 body.token / query.token */
function extractToken(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  if (req.body && typeof req.body.token === 'string') return req.body.token;
  if (req.query && typeof req.query.token === 'string') return req.query.token;
  return '';
}

/** 登录态校验：通过后 req.agent = 客服对象（不含密码哈希） */
function authRequired(req, res, next) {
  const agent = store.verifyToken(extractToken(req));
  if (!agent) return res.status(401).json({ error: '登录已失效，请重新登录' });
  req.agent = agent;
  next();
}

/** 管理员校验（创建/删除客服等操作） */
function adminRequired(req, res, next) {
  authRequired(req, res, () => {
    if (req.agent.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
    next();
  });
}

module.exports = { authRequired, adminRequired, extractToken };
