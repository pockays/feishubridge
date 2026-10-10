import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { config } from './config.js'
import { logger } from './logger.js'

/**
 * 用户身份（user_access_token）令牌管理。
 *
 * 为什么要自己管：服务器容器里没有钥匙串服务，lark-cli 自己的登录状态存不住
 * （keychain 不可用），而把明文 token 写进 config.json 的 users[] 会被 CLI 忽略。
 * 但 CLI 认环境变量里的 user token —— 于是由桥持有 refresh token、按需换取
 * UAT，再在 spawn lark-cli 时把它注入子进程环境。
 *
 * 令牌来源是 scripts/user-token-login.mjs 一次性跑出来的
 * `data/user-token.json`（device flow 授权一次，之后靠 refresh_token 续期）。
 */

interface StoredToken {
  openId?: string
  userName?: string
  accessToken: string
  refreshToken: string
  /** epoch ms */
  expiresAt: number
  refreshExpiresAt?: number
  scope?: string
  grantedAt: number
}

let cached: StoredToken | null = null
let loaded = false
let refreshing: Promise<string | null> | null = null

/** 到期前多久就提前续期 */
const REFRESH_SKEW_MS = 15 * 60_000

export function userTokenPath(): string {
  return config.USER_TOKEN_PATH
}

async function readStored(): Promise<StoredToken | null> {
  try {
    const raw = await readFile(config.USER_TOKEN_PATH, 'utf8')
    const parsed = JSON.parse(raw) as StoredToken
    if (!parsed.accessToken || !parsed.refreshToken) return null
    return parsed
  } catch {
    return null
  }
}

async function writeStored(token: StoredToken): Promise<void> {
  await mkdir(dirname(config.USER_TOKEN_PATH), { recursive: true })
  await writeFile(config.USER_TOKEN_PATH, JSON.stringify(token, null, 2), 'utf8')
  // 里面是 refresh token，别让它被别的进程读走
  await chmod(config.USER_TOKEN_PATH, 0o600).catch(() => undefined)
}

/** 应用凭据：优先环境变量，其次读 lark-cli 自己的 config.json。 */
export async function appCredentials(): Promise<{ appId: string; appSecret: string } | null> {
  if (config.LARK_APP_ID && config.LARK_APP_SECRET) {
    return { appId: config.LARK_APP_ID, appSecret: config.LARK_APP_SECRET }
  }
  try {
    const raw = await readFile(config.LARK_CLI_CONFIG_PATH, 'utf8')
    const cfg = JSON.parse(raw) as { apps?: Array<{ appId?: string; appSecret?: string }> }
    const app = cfg.apps?.[0]
    if (app?.appId && typeof app.appSecret === 'string' && app.appSecret) {
      return { appId: app.appId, appSecret: app.appSecret }
    }
  } catch {
    // 本地开发时没有这个文件是正常的
  }
  return null
}

/** 用 refresh_token 换一个新的 access_token（Feishu 会顺带滚动 refresh_token）。 */
async function refresh(stored: StoredToken): Promise<string | null> {
  const creds = await appCredentials()
  if (!creds) {
    logger.warn('cannot refresh user token: app credentials not found')
    return null
  }

  try {
    const res = await fetch(`${config.LARK_OPEN_API}/open-apis/authen/v2/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: creds.appId,
        client_secret: creds.appSecret,
        refresh_token: stored.refreshToken,
      }),
    })
    const body = (await res.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      refresh_token_expires_in?: number
      scope?: string
      code?: number
      error_description?: string
      message?: string
    }

    if (!body.access_token || !body.refresh_token) {
      logger.error(
        { status: res.status, code: body.code, msg: body.message ?? body.error_description },
        'user token refresh failed',
      )
      return null
    }

    const now = Date.now()
    cached = {
      ...stored,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: now + (body.expires_in ?? 7200) * 1000,
      ...(body.refresh_token_expires_in
        ? { refreshExpiresAt: now + body.refresh_token_expires_in * 1000 }
        : {}),
      ...(body.scope ? { scope: body.scope } : {}),
    }
    await writeStored(cached)
    logger.info(
      { expiresAt: new Date(cached.expiresAt).toISOString() },
      'user access token refreshed',
    )
    return cached.accessToken
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'user token refresh threw')
    return null
  }
}

/**
 * 返回一个可用的 user_access_token；没有令牌文件或续期失败时返回 null
 * （调用方据此降级成机器人身份）。
 */
export async function getUserAccessToken(): Promise<string | null> {
  if (!loaded) {
    cached = await readStored()
    loaded = true
    if (cached) {
      logger.info(
        { openId: cached.openId, userName: cached.userName },
        'user token loaded (tools will run as the user identity)',
      )
    }
  }
  if (!cached) return null
  if (Date.now() < cached.expiresAt - REFRESH_SKEW_MS) return cached.accessToken

  if (!refreshing) {
    refreshing = refresh(cached).finally(() => {
      refreshing = null
    })
  }
  const fresh = await refreshing
  return fresh ?? (Date.now() < cached.expiresAt ? cached.accessToken : null)
}

/** 供 /status 之类的自检使用。 */
export async function userTokenStatus(): Promise<{
  configured: boolean
  openId?: string
  userName?: string
  expiresAt?: string
  refreshExpiresAt?: string
}> {
  const stored = cached ?? (await readStored())
  if (!stored) return { configured: false }
  return {
    configured: true,
    ...(stored.openId ? { openId: stored.openId } : {}),
    ...(stored.userName ? { userName: stored.userName } : {}),
    expiresAt: new Date(stored.expiresAt).toISOString(),
    ...(stored.refreshExpiresAt
      ? { refreshExpiresAt: new Date(stored.refreshExpiresAt).toISOString() }
      : {}),
  }
}

/** 测试/诊断用：强制重新读盘。 */
export function resetUserTokenCache(): void {
  cached = null
  loaded = false
}

/**
 * 保活：refresh_token 只有 7 天寿命，靠续期滚动延长。如果没人跟机器人说话，
 * 就永远不会触发续期 —— 出差/长假回来就得重新授权一次。这里每 6 小时主动
 * 续一次，只要进程活着令牌就不会过期。
 */
export function startUserTokenKeepAlive(): void {
  if (!config.USER_TOKEN_PATH) return
  const timer = setInterval(
    () => {
      void getUserAccessToken().then((token) => {
        if (!token) logger.warn('user token keep-alive: no usable token (re-login may be required)')
      })
    },
    6 * 3600_000,
  )
  timer.unref()
}
