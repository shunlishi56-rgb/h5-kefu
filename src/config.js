// 全局配置：全部支持环境变量覆盖（部署时无需改代码）
const path = require('path');

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  // 数据目录（聊天记录、账号、令牌全部保存在本地磁盘，重启不丢）
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  uploadDir: process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'),

  // ---------- 安全/限额 ----------
  // 图片上传限制：base64 字符串最大长度（约等于 6MB 原图）
  maxUploadBase64Len: 8 * 1024 * 1024,
  // 允许的图片类型
  allowedImageMime: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  // 访客文字消息最大长度
  maxTextLength: 2000,
  // 访客上传限流：每 IP 每 10 分钟最多 20 次
  visitorUploadRate: { windowMs: 10 * 60 * 1000, max: 20 },

  // ---------- 会话 ----------
  // 单会话历史消息一次最多拉取条数
  maxHistoryPerPull: 500,
  // token 有效期（毫秒），过期需重新登录，0 = 永久
  tokenTtl: 30 * 24 * 3600 * 1000,

  // ---------- 初始管理员（首次启动自动创建，登录后请立即改密码） ----------
  initAdmin: { username: 'admin', password: 'admin123', name: '管理员' }
};

module.exports = config;
