import { config } from '../config.js'
import { logger } from '../logger.js'
import { appCredentials } from '../user-token.js'

/**
 * 直接走 HTTP 更新卡片，不经过 lark-cli。
 *
 * 为什么要这么干：`lark-cli im messages patch` 每次都要新起一个进程
 * （实测 ~1.2~1.4s），而扫光/脉冲这类效果需要 3~5 帧/秒。直连之后单次
 * 只要 ~150~300ms，才谈得上"动画"。
 *
 * 这里用 tenant_access_token（应用身份）——卡片是机器人发的，用应用身份更新
 * 正合适，也不需要用户令牌。token 有 2 小时有效期，缓存到过期前 1 分钟。
 */

let cachedToken: { token: string; expiresAt: number } | null = null

export async function getTenantToken(): Promise<string | null> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token

  const creds = await appCredentials()
  if (!creds) {
    logger.warn('card patch: app credentials not found')
    return null
  }

  try {
    const res = await fetch(`${config.LARK_OPEN_API}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
    })
    const body = (await res.json()) as {
      tenant_access_token?: string
      expire?: number
      code?: number
      msg?: string
    }
    if (!body.tenant_access_token) {
      logger.error({ code: body.code, msg: body.msg }, 'card patch: tenant token failed')
      return null
    }
    cachedToken = {
      token: body.tenant_access_token,
      expiresAt: Date.now() + Math.max(60, (body.expire ?? 7200) - 60) * 1000,
    }
    return cachedToken.token
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'card patch: tenant token request threw')
    return null
  }
}

export interface PatchResult {
  ok: boolean
  ms: number
  error?: string
}

/** 更新一条已发送的卡片消息。`card` 会被序列化成 content 字符串。 */
export async function patchCardFast(messageId: string, card: unknown): Promise<PatchResult> {
  const t0 = Date.now()
  const token = await getTenantToken()
  if (!token) return { ok: false, ms: Date.now() - t0, error: 'no tenant token' }

  try {
    const res = await fetch(
      `${config.LARK_OPEN_API}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ content: JSON.stringify(card) }),
      },
    )
    const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string }
    const ok = res.ok && (body.code === 0 || body.code === undefined)
    if (!ok) {
      return { ok, ms: Date.now() - t0, error: `${res.status} ${body.code ?? ''} ${body.msg ?? ''}` }
    }
    return { ok, ms: Date.now() - t0 }
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: (err as Error).message }
  }
}
