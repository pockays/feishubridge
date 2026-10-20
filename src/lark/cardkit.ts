import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { getTenantToken } from './card-patch.js'

/**
 * 卡片实体（CardKit）：建卡 → 作为消息发出 → 按 element_id 局部更新。
 *
 * 为什么不用 `im messages patch`：整卡 PATCH 实测要 ~640ms（建连 + 全量渲染），
 * 天花板 1.6 帧/秒，做不出扫光。卡片实体的**单元素更新**实测只要 ~110ms，
 * 可以跑到 5~8 帧/秒 —— 这是"文字扫光"能做到流畅的前提。
 *
 * 载荷坑：`element` 必须是 **JSON 字符串**（不是对象），且必须带自增的
 * `sequence` 与唯一 `uuid`，否则报 99992402 field validation failed。
 */

export interface CardkitResult<T> {
  ok: boolean
  data?: T
  error?: string
  ms: number
}

async function call<T>(
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
): Promise<CardkitResult<T>> {
  const t0 = Date.now()
  const token = await getTenantToken()
  if (!token) return { ok: false, ms: Date.now() - t0, error: 'no tenant token' }

  try {
    const res = await fetch(`${config.LARK_OPEN_API}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
    const j = (await res.json().catch(() => ({}))) as {
      code?: number
      msg?: string
      data?: T
    }
    const ok = res.ok && (j.code === 0 || j.code === undefined)
    return ok
      ? { ok: true, ...(j.data !== undefined ? { data: j.data } : {}), ms: Date.now() - t0 }
      : { ok: false, ms: Date.now() - t0, error: `${res.status} ${j.code ?? ''} ${j.msg ?? ''}` }
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: (err as Error).message }
  }
}

/** 建一张卡片实体，返回 card_id。card 是完整卡片 JSON（2.0 schema）。 */
export async function createCardEntity(card: unknown): Promise<CardkitResult<{ card_id: string }>> {
  return call<{ card_id: string }>('POST', '/open-apis/cardkit/v1/cards', {
    type: 'card_json',
    data: JSON.stringify(card),
  })
}

/** 把卡片实体作为消息发到会话里。 */
export async function sendCardEntity(
  chatId: string,
  cardId: string,
): Promise<CardkitResult<{ message_id: string }>> {
  return call<{ message_id: string }>(
    'POST',
    '/open-apis/im/v1/messages?receive_id_type=chat_id',
    {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
    },
  )
}

let sequence = 0

/**
 * 每张卡片的更新队列。
 *
 * 服务端会校验 `sequence`：比已应用的序号小就直接拒绝（300317
 * sequence number compare failed）。而我们的刷新是并发的（扫光定时器 +
 * 工具进度同时发），网络乱序会让"后发先到"，序号看起来倒退。
 * 所以按卡串行发送：同一张卡的更新排队，一条完成再发下一条。
 */
const queues = new Map<string, Promise<unknown>>()

export function cardUpdatePending(cardId: string): boolean {
  return queues.has(cardId)
}

/** 局部更新一个元素（按 element_id）。element 传对象即可，内部负责序列化。 */
export async function updateCardElement(
  cardId: string,
  elementId: string,
  element: Record<string, unknown>,
): Promise<CardkitResult<unknown>> {
  sequence += 1
  const seq = sequence
  const payload = { element: JSON.stringify(element), sequence: seq, uuid: randomUUID() }

  const prev = queues.get(cardId) ?? Promise.resolve()
  const next = prev
    .catch(() => undefined)
    .then(() =>
      call(
        'PUT',
        `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/${encodeURIComponent(elementId)}`,
        payload,
      ),
    )
    .finally(() => {
      if (queues.get(cardId) === next) queues.delete(cardId)
    })

  queues.set(cardId, next)
  return next
}

/** fire-and-forget 包装：流式刷新时不该因为一次失败就中断整轮。 */
export function updateCardElementSafe(
  cardId: string,
  elementId: string,
  element: Record<string, unknown>,
): void {
  void updateCardElement(cardId, elementId, element).then((r) => {
    if (!r.ok) logger.debug({ elementId, error: r.error }, 'card element update failed')
  })
}
