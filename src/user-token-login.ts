#!/usr/bin/env node
/**
 * 一次性登录：把飞书 device flow 的 device_code 换成 user_access_token，
 * 连同 refresh_token 一起写进 USER_TOKEN_PATH。之后桥会自己续期。
 *
 * 用法（在容器里执行）：
 *   1) lark-cli auth login --no-wait --json --recommend 拿到 device_code 和
 *      verification_url，把 URL 给操作人打开授权；
 *   2) node dist/user-token-login.js <device_code>；
 *   3) docker compose restart lark-agent-bridge，让桥读到新令牌。
 *
 * 为什么不用 lark-cli auth login --device-code：容器里没有钥匙串，CLI 存不
 * 下令牌；这里的令牌必须由桥自己拿着才能续期。
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { config } from './config.js'
import { appCredentials } from './user-token.js'

const deviceCode = process.argv[2]
if (!deviceCode) {
  console.error('usage: node dist/user-token-login.js <device_code>')
  process.exit(2)
}

const creds = await appCredentials()
if (!creds) {
  console.error(
    '找不到应用凭据：设置 LARK_APP_ID / LARK_APP_SECRET，或确保能读到 ' + config.LARK_CLI_CONFIG_PATH,
  )
  process.exit(2)
}

const tokenRes = await fetch(`${config.LARK_OPEN_API}/open-apis/authen/v2/oauth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: creds.appId,
    client_secret: creds.appSecret,
    device_code: deviceCode,
  }),
})
const token = (await tokenRes.json()) as {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  refresh_token_expires_in?: number
  scope?: string
  code?: number
  message?: string
  error_description?: string
}

if (!token.access_token || !token.refresh_token) {
  console.error('换取令牌失败：', JSON.stringify(token))
  process.exit(1)
}

let openId: string | undefined
let userName: string | undefined
try {
  const meRes = await fetch(`${config.LARK_OPEN_API}/open-apis/authen/v1/user_info`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  })
  const me = (await meRes.json()) as { data?: { open_id?: string; name?: string } }
  openId = me.data?.open_id
  userName = me.data?.name
} catch {
  // 拿不到用户信息不影响令牌本身
}

const now = Date.now()
const stored = {
  ...(openId ? { openId } : {}),
  ...(userName ? { userName } : {}),
  accessToken: token.access_token,
  refreshToken: token.refresh_token,
  expiresAt: now + (token.expires_in ?? 7200) * 1000,
  ...(token.refresh_token_expires_in
    ? { refreshExpiresAt: now + token.refresh_token_expires_in * 1000 }
    : {}),
  ...(token.scope ? { scope: token.scope } : {}),
  grantedAt: now,
}

await mkdir(dirname(config.USER_TOKEN_PATH), { recursive: true })
await writeFile(config.USER_TOKEN_PATH, JSON.stringify(stored, null, 2), 'utf8')
await chmod(config.USER_TOKEN_PATH, 0o600).catch(() => undefined)

// eslint-disable-next-line no-console -- 这个入口的产物就是给人看的
console.log(
  JSON.stringify(
    {
      ok: true,
      path: config.USER_TOKEN_PATH,
      user: userName ?? openId ?? '(unknown)',
      scopeCount: token.scope ? token.scope.split(' ').length : null,
      expiresAt: new Date(stored.expiresAt).toISOString(),
    },
    null,
    2,
  ),
)
