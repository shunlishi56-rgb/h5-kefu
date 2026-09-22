/**
 * server.js —— 服务入口
 * 启动：node server.js  （或用宝塔 PM2 管理器 / ecosystem.config.js 托管）
 * 端口：默认 3000，环境变量 PORT 可覆盖
 */
'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const config = require('./src/config');
const store = require('./src/store');
const hub = require('./src/hub');
const api = require('./src/api');

store.init();

const app = express();
// 反向代理（宝塔 Nginx）场景下正确还原 req.protocol / req.ip
app.set('trust proxy', true);

// JSON 解析：放宽 body 限制以支持 base64 图片上传
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: false, limit: '12mb' }));

// API 路由
app.use('/api', api);

// 图片静态资源（上传的聊天图片）
app.use('/uploads', express.static(config.uploadDir, { maxAge: '30d', immutable: true }));

// 静态页面
const pub = path.join(__dirname, 'public');
app.use(express.static(pub, { maxAge: '1h' }));

/* ---------------- 页面路由 ---------------- */

// 访客聊天页：/chat/:agentId  （免登录，每个客服一个专属链接）
app.get('/chat/:agentId', (req, res) => {
  res.sendFile(path.join(pub, 'chat.html'));
});

// 客服后台：登录页 + 工作台
app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin.html')));
app.get('/workspace', (req, res) => res.sendFile(path.join(pub, 'workspace.html')));

// 兼容 / 落地页 → 管理登录
app.get('/', (req, res) => res.redirect('/admin'));

// 404
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
  res.status(404).send('Not Found');
});

/* ---------------- 启动 ---------------- */

const server = http.createServer(app);
server.keepAliveTimeout = 65000;  // 略大于常见反代默认超时，减少长连接误断
server.headersTimeout = 66000;

hub.init(server);

server.listen(config.port, () => {
  console.log('=====================================');
  console.log(' 免登录 H5 在线客服系统 已启动');
  console.log(' 访客示例链接 : http://127.0.0.1:' + config.port + '/chat/<客服ID>');
  console.log(' 客服工作台   : http://127.0.0.1:' + config.port + '/admin');
  console.log(' 初始账号     : admin / admin123 （登录后请立即修改）');
  console.log('=====================================');
});

/* ---------------- 优雅退出（保证最后几条消息落盘完成） ---------------- */
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
function shutdown() {
  console.log('[server] 收到退出信号，正在关闭...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
