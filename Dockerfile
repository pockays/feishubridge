FROM node:22-slim

# 换成国内源：默认的 deb.debian.org 在境内会慢到卡死
RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; \
    fi; \
    if [ -f /etc/apt/sources.list ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates curl python3 make g++ ; \
    rm -rf /var/lib/apt/lists/*

# 官方飞书 CLI（npm 包装 + 自带 Linux 版 lark-cli 二进制）
RUN npm config set registry https://registry.npmmirror.com \
 && npm install -g @larksuite/cli@latest \
 && lark-cli --version

WORKDIR /app

# 先只拷依赖清单，最大化利用构建缓存
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund

# 源码 + 构建（tsc），构建后裁掉 devDependencies
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

ENV NODE_ENV=production
ENV PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

# WebSocket 长连接出网即可，无需对外暴露端口
CMD ["node", "dist/index.js"]
