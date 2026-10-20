import { config } from '../config.js'
import { logger } from '../logger.js'
import {
  cardUpdatePending,
  createCardEntity,
  sendCardEntity,
  updateCardElement,
  type CardkitResult,
} from './cardkit.js'

/**
 * 一张"活着"的回复卡片：封面图 + 扫光状态行 + 工具列表 + 统计行 + 停止按钮。
 *
 * 刷新走 CardKit 的**单元素更新**（~350ms/次），比整卡 PATCH（~640ms）快一倍，
 * 这是能做扫光的前提。所有更新都是 fire-and-forget，失败只记 debug 日志，
 * 绝不能因为一次刷新失败把整轮回复搞挂。
 */

export interface CardStats {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  toolCalls: number
  model: string
}

const TEXT = '少女祈祷中…'
const SEGS = [...TEXT]

function shimmer(frame: number): string {
  const center = frame % (SEGS.length + 2)
  return SEGS.map((ch, i) => {
    const d = Math.abs(i - center)
    const color = d === 0 ? 'carmine' : d === 1 ? 'red' : d === 2 ? 'orange' : 'grey'
    return `<font color='${color}'>${ch}</font>`
  }).join('')
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}分${s % 60}秒` : `${s}秒`
}

const md = (id: string, content: string) => ({ tag: 'markdown', element_id: id, content })

export class CardLive {
  private constructor(
    private readonly cardId: string,
    readonly messageId: string,
  ) {}

  private timer: NodeJS.Timeout | undefined
  private frame = 0
  private startedAt = Date.now()
  private toolLines: string[] = []
  private lastStats = ''
  private closed = false

  /** 建卡并发出；失败返回 null，调用方回退到纯文本。 */
  static async start(chatId: string): Promise<CardLive | null> {
    const cover = config.CARD_COVER_IMAGE_KEY
    const elements: Array<Record<string, unknown>> = []
    if (cover) {
      elements.push({
        tag: 'img',
        img_key: cover,
        alt: { tag: 'plain_text', content: '' },
        scale_type: 'fit_horizontal',
        margin: '0px -12px',
      })
    }
    elements.push(
      md('status', `**${shimmer(0)}**`),
      md('tools', "<font color='grey'>· 正在理解你的问题…</font>"),
      md('stats', ' '),
      md('answer', ' '),
      {
        tag: 'button',
        element_id: 'button',
        text: { tag: 'plain_text', content: '⏹ 停止' },
        type: 'danger',
        behaviors: [{ type: 'callback', value: { action: 'stop' } }],
      },
    )

    const card = {
      schema: '2.0',
      config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: '老吴' }, template: 'default' },
      body: { elements },
    }

    const created = await createCardEntity(card)
    if (!created.ok || !created.data?.card_id) {
      logger.warn({ err: created.error }, 'card live: create failed, falling back to text')
      return null
    }
    const sent = await sendCardEntity(chatId, created.data.card_id)
    if (!sent.ok || !sent.data?.message_id) {
      logger.warn({ err: sent.error }, 'card live: send failed, falling back to text')
      return null
    }
    logger.info({ cardId: created.data.card_id, messageId: sent.data.message_id }, 'card live started')
    return new CardLive(created.data.card_id, sent.data.message_id)
  }

  startShimmer(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (this.closed) return
      // 上一帧还没刷完就跳过这一帧：宁可掉帧，也别把队列堆起来
      if (cardUpdatePending(this.cardId)) return
      this.frame += 1
      this.push('status', md('status', `**${shimmer(this.frame)}**`))
    }, config.CARD_SHIMMER_INTERVAL_MS)
    this.timer.unref()
  }

  stopShimmer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  addTool(name: string, brief: string, ok = true): void {
    const icon = ok ? '•' : '✗'
    this.toolLines.push(`${icon} \`${name}\` ${brief}`.slice(0, 120))
    if (this.toolLines.length > 12) this.toolLines = this.toolLines.slice(-12)
    this.push('tools', md('tools', this.toolLines.join('\n')))
  }

  setStats(stats: CardStats): void {
    const elapsed = (Date.now() - this.startedAt) / 1000
    const totalIn = stats.inputTokens + stats.cacheReadTokens
    const tokPerSec = elapsed > 0 ? Math.round(stats.outputTokens / elapsed) : 0
    const cachePct = totalIn > 0 ? ((stats.cacheReadTokens / totalIn) * 100).toFixed(2) : '0.00'
    const ctxPct = ((totalIn / config.MODEL_CONTEXT_TOKENS) * 100).toFixed(0)
    const line =
      `<font color='grey'>${fmtDuration(Date.now() - this.startedAt)} · ${tokPerSec} tok/s · ` +
      `${(totalIn / 1000).toFixed(0)}k tok · 缓存 ${cachePct}% · ctx ${ctxPct}%</font>`
    if (line === this.lastStats) return
    this.lastStats = line
    this.push('stats', md('stats', line))
  }

  /** 收尾：状态改完成、写入正文、撤掉停止按钮（用空白元素覆盖）。 */
  async finish(answer: string): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stopShimmer()
    await updateCardElement(this.cardId, 'status', md('status', '**✅ 完成**'))
    await updateCardElement(this.cardId, 'answer', md('answer', answer || '（无内容）'))
    await updateCardElement(this.cardId, 'button', md('button', ' '))
  }

  async fail(reason: string): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stopShimmer()
    await updateCardElement(this.cardId, 'status', md('status', '**⚠️ 出错了**'))
    await updateCardElement(this.cardId, 'answer', md('answer', reason))
  }

  private push(elementId: string, element: Record<string, unknown>): void {
    void updateCardElement(this.cardId, elementId, element).then((r: CardkitResult<unknown>) => {
      if (!r.ok) logger.debug({ elementId, error: r.error }, 'card live: element update failed')
    })
  }
}
