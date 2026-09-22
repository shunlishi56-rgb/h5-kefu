#!/usr/bin/env bash
# =====================================================
#  免登录 H5 在线客服系统 - Linux 一键部署脚本（宝塔通用）
#
#  用法：把整个 h5-kefu 目录上传到服务器后执行：
#      cd /www/wwwroot/h5-kefu && bash install.sh
#
#  自定义端口：
#      PORT=8080 bash install.sh
# =====================================================
set -u

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${GREEN}[√]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
die()  { echo -e "${RED}[×]${NC} $1"; exit 1; }

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-3000}"

echo "===================================="
echo "  免登录 H5 在线客服系统 - 一键部署"
echo "  目录: $APP_DIR"
echo "  端口: $PORT"
echo "===================================="

# ---------- 1. 查找 Node（兼容宝塔 PM2管理器 的安装路径） ----------
find_bin() {
  local p
  if command -v "$1" >/dev/null 2>&1; then command -v "$1"; return 0; fi
  for p in /www/server/nodejs/*/bin/"$1" /www/server/nvm/versions/node/*/bin/"$1" \
           /usr/local/bin/"$1" /usr/bin/"$1"; do
    if [ -x "$p" ]; then echo "$p"; return 0; fi
  done
  return 1
}

NODE_BIN="$(find_bin node)" || die "未找到 Node.js。请先在宝塔【软件商店】安装 PM2管理器，并在其设置里切换 Node 版本后，重新运行本脚本。"
NPM_BIN="$(find_bin npm)"   || die "已找到 Node 但未找到 npm，请重装 PM2管理器 或检查 Node 安装"
PM2_BIN="$(find_bin pm2)"
NODE_VER="$("$NODE_BIN" -v)"
info "Node 版本: $NODE_VER"

"$NODE_BIN" -e 'var v=process.versions.node.split(".");if(parseInt(v[0])<16){process.exit(1)}' \
  || die "Node 版本需 16 以上，请在宝塔 PM2管理器 设置中切换更高版本后重试"

# ---------- 2. 安装依赖 ----------
mkdir -p "$APP_DIR/data/logs"
cd "$APP_DIR"
info "安装依赖（国内镜像，通常 10 秒内完成）..."
if ! "$NPM_BIN" install --production --no-audit --no-fund --registry=https://registry.npmmirror.com; then
  warn "国内镜像安装失败，尝试官方源..."
  "$NPM_BIN" install --production --no-audit --no-fund || die "依赖安装失败，请检查服务器网络后重试"
fi
info "依赖安装完成"

# ---------- 3. 启动服务（优先 PM2，其次 systemd，最后 nohup） ----------
launch_mode="未知"
if [ -n "$PM2_BIN" ]; then
  info "通过 PM2 启动（支持开机自启、崩溃自动拉起）"
  export PATH="$(dirname "$NODE_BIN"):$PATH"
  "$PM2_BIN" delete h5-kefu >/dev/null 2>&1 || true
  PORT="$PORT" "$PM2_BIN" start ecosystem.config.js --update-env >/dev/null
  "$PM2_BIN" save >/dev/null 2>&1 || true
  launch_mode="PM2（查看: $PM2_BIN list，日志: pm2 logs h5-kefu）"
elif [ "$(id -u)" = "0" ] && command -v systemctl >/dev/null 2>&1; then
  info "未找到 PM2，改用 systemd 启动（开机自动运行）"
  cat > /etc/systemd/system/h5-kefu.service <<EOF
[Unit]
Description=H5 Online KeFu (free-login chat)
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable h5-kefu >/dev/null 2>&1
  systemctl restart h5-kefu
  launch_mode="systemd（查看: systemctl status h5-kefu）"
else
  warn "未找到 PM2 且无 systemd 权限，使用 nohup 后台启动"
  PORT="$PORT" nohup "$NODE_BIN" server.js >> "$APP_DIR/data/logs/nohup.log" 2>&1 &
  launch_mode="nohup（日志: data/logs/nohup.log）"
fi

# ---------- 4. 本机验证 ----------
sleep 2
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/admin" 2>/dev/null || true)"
if [ "$code" = "200" ]; then
  info "服务已启动，本机自测通过"
else
  warn "端口 $PORT 暂未响应（可能仍在启动中），稍后可查看 data/logs/ 下的日志"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -z "$IP" ] && IP="服务器IP"

echo ""
echo "===================================="
echo "  部署完成！"
echo "  启动方式 : $launch_mode"
echo "  客服后台 : http://$IP:$PORT/admin"
echo "  初始账号 : admin / admin123 （登录后请立即修改密码）"
echo "------------------------------------"
echo "  后续两步："
echo "  1) 宝塔【安全】放行 $PORT 端口；云服务器还需在控制台安全组放行"
echo "  2) 建议绑定域名 + 反向代理 + HTTPS（详见 部署文档.md）"
echo "     微信内使用请务必走 https 域名访问"
echo "===================================="
