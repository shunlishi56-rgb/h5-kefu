本源码仅供学习研究及合法商业用途。买方不得将本代码用于任何违法违规活动，因买方违规使用产生的一切法律后果由买方自行承担。

H5 在线客服系统（h5-kefu）
访客免登录在线客服系统。访客通过专属链接或二维码直接进入会话，无需注册登录；客服通过多账号工作台接待。实时消息基于 WebSocket，数据以 JSONL 落盘持久化，自建闭环，不依赖第三方付费服务。

项目	说明
作者	诗绪
联系方式	V：THESX666
当前版本	v1.0.1（2026-09-21）
运行环境	Node.js ≥ 16，内存 512 MB 及以上
一、功能说明
1. 访客端（/chat/<客服ID>）
免登录：首次进入自动生成本地匿名身份，后续访问延续同一会话
消息类型：文字、图片（发送前本地压缩，GIF 与 300 KB 以内图片保持原样）
状态标记：单勾送达、双勾已读；消息撤回（长按或右键）
自动欢迎语、客服在线状态、离线留言提示
移动端优先布局，兼容微信内置浏览器
2. 客服端（/admin 登录 → /workspace）
多账号体系：管理员可创建、停用、删除客服账号并重置密码
每个客服拥有独立访问链接与二维码，支持复制与下载
会话列表：未读角标、访客在线状态、进行中/历史分区、昵称搜索
自动欢迎语按客服独立配置，支持 {访客} 昵称占位符
快捷回复库：增删、一键发送
已读回执、双向撤回、结束会话（访客再发消息自动恢复）
新消息提示音与标题闪烁提醒
3. 可靠性设计
消息先落盘（JSONL 逐条追加）再广播，进程重启不丢消息
每条消息携带客户端生成的 cid，服务端按 (sid, cid) 幂等去重，断线重发不产生重复
断线自动重连，按 seq 增量补拉漏掉的消息
账号、令牌、会话元数据写入采用「临时文件 + rename」原子覆盖，避免半截文件
密码使用 scrypt 加盐哈希存储，比对采用 timingSafeEqual
二、技术栈
类别	选型
Web 服务	Express 4.x
实时通道	ws 8.x（WebSocket）
二维码	qrcode 1.5.x
持久化	本地文件（JSON / JSONL），无数据库依赖
前端	原生单页 HTML，无构建环节
全部依赖均为纯 JS 包，安装过程无需编译。

三、目录结构
h5-kefu/
├── server.js              # 服务入口（Express + WebSocket）
├── install.sh             # Linux 一键部署脚本
├── ecosystem.config.js    # PM2 配置
├── Dockerfile             # Docker 镜像定义
├── docker-compose.yml     # Docker Compose 配置
├── package.json           # 依赖声明（express / ws / qrcode）
├── src/
│   ├── config.js          # 配置项，支持环境变量覆盖
│   ├── store.js           # 数据持久化层
│   ├── auth.js            # 客服认证中间件
│   ├── api.js             # REST 接口
│   └── hub.js             # WebSocket 消息中心
├── public/
│   ├── chat.html          # 访客聊天页
│   ├── admin.html         # 客服登录页
│   └── workspace.html     # 客服工作台
├── data/                  # 运行时数据（账号 / 会话 / 聊天记录）
└── uploads/               # 聊天图片
四、快速启动
三种部署方式的具体步骤见同目录《部署文档.md》。

# 方式一：一键脚本
cd /www/wwwroot/h5-kefu && bash install.sh

# 方式二：PM2
npm install --production --registry=https://registry.npmmirror.com
pm2 start ecosystem.config.js

# 方式三：Docker
docker compose up -d
客服后台：http://IP:3000/admin，初始账号 admin / admin123，首次登录后立即修改
访客入口：http://IP:3000/chat/<客服ID>，链接可在工作台「二维码」页获取
初始版本。

五、已知约束
单进程设计：会话状态为进程内存 + 本地磁盘，须以单实例部署，不可开启 PM2 多实例模式（ecosystem.config.js 已固定 instances: 1）。
数据无自动清理：会话记录与图片随使用累积，建议按需归档或清理 data/、uploads/ 目录。
缺少接口级频控：登录与会话创建接口未内置限流，生产环境建议通过 Nginx 限流或后续版本加固。
