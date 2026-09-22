# 免登录 H5 在线客服系统 - Docker 镜像
# 构建:  docker build -t h5-kefu .
# 运行:  docker run -d --name h5-kefu -p 3000:3000 \
#           -v $(pwd)/data:/app/data -v $(pwd)/uploads:/app/uploads \
#           --restart always h5-kefu
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Shanghai

# 先装依赖（利用 Docker 层缓存：源码改动不重新下载依赖）
COPY package.json ./
RUN npm install --production --no-audit --no-fund \
      --registry=https://registry.npmmirror.com

COPY . .

# 数据与图片挂载出来持久化（容器删了聊天记录还在）
VOLUME ["/app/data", "/app/uploads"]

EXPOSE 3000
CMD ["node", "server.js"]
