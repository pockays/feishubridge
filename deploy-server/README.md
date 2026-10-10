# 部署到服务器（Ubuntu / systemd）

把「老吴」桥接从 Windows 本机搬到 Linux 服务器常驻，实现 7×24 在线（不依赖本机开机）。

## 架构（服务器侧）

```
飞书云 ──WebSocket长连接──> lark-cli 事件总线 ──NDJSON──> bridge(dist/index.js)
                                                          ├─ SQLite 会话历史 (data/bridge.sqlite)
                                                          ├─ 调 LLM (ANTHROPIC_BASE_URL)
                                                          └─ lark-cli im +messages-* 发回飞书
```

不需要公网入口、不需要域名和证书；只监听 `127.0.0.1:9090`（metrics）。

## 需要准备的东西

| 项 | 说明 |
| --- | --- |
| App ID / App Secret | 你自己的飞书自建应用凭证。Secret 在开发者后台「凭证与基础信息」里复制（只会显示一次） |
| `.env` | 至少包含 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` |
| 服务器 | Ubuntu（本机验证过 24.04）、能访问 `open.feishu.cn` 与你的模型 API |

> 桥只以 **bot 身份** 调接口（收发消息、加表情、订阅事件），所以服务器上**不需要**做用户 OAuth 登录，只要有 app_id + app_secret 就够。

## 部署步骤

```bash
# 0. 上传代码（在本地执行；打包时排除 node_modules 和 data）
tar --exclude=node_modules --exclude=data --exclude=.git -czf bridge.tgz -C /path/to/lark-agent-bridge .
scp bridge.tgz root@<server>:/tmp/

# 1. 服务器上解压
ssh root@<server>
mkdir -p /opt/lark-agent-bridge && tar -xzf /tmp/bridge.tgz -C /opt/lark-agent-bridge

# 2. 配置 lark-cli（只需一次；secret 走 stdin，不会落到 shell 历史/进程列表）
printf '%s' '<APP_SECRET>' > /tmp/secret.txt
lark-cli config init --app-id <APP_ID> --app-secret-stdin < /tmp/secret.txt
rm -f /tmp/secret.txt
lark-cli doctor          # 应该全绿

# 3. 填 .env（模型 key 等）
vi /opt/lark-agent-bridge/.env

# 4. 一键安装（Node 22 + lark-cli + 依赖 + systemd 服务）
cd /opt/lark-agent-bridge && bash deploy-server/install.sh
```

## 验证

```bash
systemctl status lark-agent-bridge
tail -f /var/log/lark-agent-bridge/bridge.out.log
# 期望看到：
#   {"backend":"anthropic-sdk","model":"...","groupTrigger":"mention","ackEmoji":"Typing","msg":"bridge starting"}
#   {"pid":...,"key":"im.message.receive_v1","msg":"lark-cli event consumer spawned"}
lark-cli event status     # Bus: running, Active consumers: 1
```

然后在飞书里私聊 / 群里 @ 它各发一条，确认能回。

## 运维

```bash
systemctl restart lark-agent-bridge     # 重启
systemctl stop lark-agent-bridge        # 停止
systemctl disable lark-agent-bridge     # 取消开机自启
journalctl -u lark-agent-bridge -f      # 跟随日志
```

升级：把新代码同步到 `/opt/lark-agent-bridge`，然后 `npm ci && npm run build && systemctl restart lark-agent-bridge`（或重跑 `install.sh`）。

## 注意事项

1. **内存**：本机实测桥 + lark-cli 常驻约 100–200 MB。那台服务器只有 1.6 G 且没有 swap，建议先加 1–2 G swap，避免 OOM 把 mysqld 一起拖垮。
2. **不要动 `data/`**：`bridge.sqlite` 存会话历史和事件去重，删掉会丢上下文（不会崩）。
3. **迁移后停掉本机那份**：同一应用两个消费者同时跑，会导致同一条消息被回复两次。
4. **权限**：群里想收到"不带 @ 的消息"，需要在开发者后台开通「接收群聊中所有消息」（`im:message.group_msg`）。
5. **安全**：`.env` 里有模型 key，注意文件权限（`chmod 600 .env`）。
