#!/usr/bin/env bash
# 在服务器上安装/升级 老吴桥接（lark-agent-bridge）
#
# 用法（在已解压的 app 目录里）：
#   sudo bash deploy-server/install.sh
#
# 前置条件（只需一次）：
#   1) lark-cli 已用同一个应用的 app_id / app_secret 配置好：
#        lark-cli config init --app-id cli_xxx --app-secret-stdin < secret.txt
#   2) /opt/lark-agent-bridge/.env 已按 .env.example 填好
#        （ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL ...）

set -euo pipefail

APP_DIR="/opt/lark-agent-bridge"
SERVICE="lark-agent-bridge"
NODE_MAJOR="22"
LOG_DIR="/var/log/lark-agent-bridge"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "请用 root 运行（sudo bash $0）"; exit 1; }

# ---------------------------------------------------------------- 1. Node
if command -v node >/dev/null 2>&1 && [[ "$(node -v)" == v${NODE_MAJOR}.* ]]; then
  say "已有 Node $(node -v)，跳过安装"
else
  say "安装 Node ${NODE_MAJOR} LTS 到 /usr/local"
  ARCH="$(uname -m)"; case "$ARCH" in x86_64) NARCH=x64;; aarch64|arm64) NARCH=arm64;; *) echo "不支持的架构: $ARCH"; exit 1;; esac
  VER="$(curl -fsSL https://nodejs.org/dist/index.json \
          | sed -n 's/.*"version":"\(v'"${NODE_MAJOR}"'\.[0-9.]*\)","date.*"lts":"[A-Za-z].*/\1/p' \
          | head -1)"
  [[ -n "$VER" ]] || { echo "无法获取 Node 版本号"; exit 1; }
  TMP="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/${VER}/node-${VER}-linux-${NARCH}.tar.xz" -o "$TMP/node.tar.xz"
  tar -xJf "$TMP/node.tar.xz" -C "$TMP"
  cp -a "$TMP/node-${VER}-linux-${NARCH}/." /usr/local/
  rm -rf "$TMP"
  hash -r
  echo "已安装: $(node -v) / npm $(npm -v)"
fi

# ---------------------------------------------------------------- 2. lark-cli
if command -v lark-cli >/dev/null 2>&1; then
  say "已有 lark-cli $(lark-cli --version)，跳过安装"
else
  say "安装 @larksuite/cli"
  npm install -g @larksuite/cli
fi

if ! lark-cli doctor >/dev/null 2>&1; then
  echo
  echo "⚠️  lark-cli 尚未完成应用配置，桥启动后收不到事件。"
  echo "    请先执行（把 secret 从开发者后台复制到一个临时文件）："
  echo "      lark-cli config init --app-id <APP_ID> --app-secret-stdin < /tmp/secret.txt && rm -f /tmp/secret.txt"
  echo
fi

# ---------------------------------------------------------------- 3. 部署代码
say "部署代码到 ${APP_DIR}"
mkdir -p "$APP_DIR"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$SRC_DIR/package.json" && "$SRC_DIR" != "$APP_DIR" ]]; then
  tar -C "$SRC_DIR" \
    --exclude=node_modules --exclude=data --exclude=.git \
    --exclude='*.log' --exclude=bridge.out.log --exclude=bridge.err.log \
    -cf - . | tar -C "$APP_DIR" -xf -
fi

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "⚠️  $APP_DIR/.env 不存在，先复制一份 .env.example 并填好再启动"
  cp -n "$APP_DIR/.env.example" "$APP_DIR/.env" 2>/dev/null || true
fi

say "安装依赖（使用预编译 better-sqlite3，无需编译工具链）"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
npm run build

mkdir -p "$APP_DIR/data" "$LOG_DIR"

# ---------------------------------------------------------------- 4. systemd
say "安装 systemd 服务"
install -m 0644 "$APP_DIR/deploy-server/lark-agent-bridge.service" "/etc/systemd/system/${SERVICE}.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"
sleep 3

say "状态"
systemctl --no-pager --full status "$SERVICE" | head -20 || true
echo
echo "查看日志:  journalctl -u ${SERVICE} -f     或   tail -f ${LOG_DIR}/bridge.out.log"
