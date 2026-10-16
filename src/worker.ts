import { config } from './config.js'
import { logger } from './logger.js'
import { startConsumer } from './lark/consume.js'
import { respond as respondApi, respondImage as respondImageApi, recall } from './lark/reply.js'
import { react, unreact } from './lark/reactions.js'
import { extractLocalImages } from './lark/images.js'
import { buildCard, type CardPhase, type ToolEntry } from './lark/card.js'
import { sendCardReply, CardPatcher } from './lark/card-send.js'
import { startCardActionConsumer, type CardActionEvent } from './lark/card-action-consume.js'
import { chat } from './llm.js'
import { runClaudeCode, type ClaudeCodeProgress } from './llm-claude-code.js'
import { Store } from './store.js'
import { RateLimiter } from './rate-limit.js'
import { downloadResource } from './lark/download.js'
import { startMetricsServer, metrics } from './metrics.js'
import { parseCommand, isSandboxOff } from './commands.js'
import type { FeishuMessageEvent } from './lark/types.js'

/**
 * 回复的呈现形式由 config.RESPONSE_MODE 决定：
 *   - 'reply'  : 引用式回复，挂在用户那条消息下面（默认）
 *   - 'thread' : 话题回复，折叠成「N 条回复」入口
 *   - 'send'   : 独立消息，直接出现在主消息流里
 *   - 'auto'   : 私聊不 @ → 普通消息；私聊 @ → 引用回复；
 *                群聊 @ → 话题；已在话题内 → 回到同一话题（优先级最高）
 */
function responseMode(evt: FeishuMessageEvent): 'send' | 'reply' | 'thread' {
  switch (config.RESPONSE_MODE) {
    case 'send':
      return 'send'
    case 'reply':
      return 'reply'
    case 'thread':
      return 'thread'
    case 'auto': {
      // ① 已经在话题里（用户点进话题继续追问）→ 必须回到同一个话题里回复，
      //    否则回复会掉到主会话流，看起来像"跑到了私聊窗口"。
      if (evt.thread_id || evt.root_id) return 'thread'

      const mentioned = isMentioned(evt)

      // ② 私聊：不带 @ → 普通消息；带 @ → 引用回复（挂在用户消息下）
      if (evt.chat_type === 'p2p') return mentioned ? 'reply' : 'send'

      // ③ 群聊：带 @ → 话题；未 @（若触发限制被放开）→ 普通消息
      return mentioned ? 'thread' : 'send'
    }
  }
}

/**
 * 判断消息里有没有 @。
 *
 * 主判据是文本前缀（lark-cli 会把 @机器人 规范成以 '@' 开头的文本，群消息
 * 的触发判断也用同一套语义）；另外用事件自带的 `mentions` 兜底，覆盖
 * "先打字、@ 不在开头"的情况。
 */
function isMentioned(evt: FeishuMessageEvent): boolean {
  if (String(evt.content ?? '').trimStart().startsWith('@')) return true
  return Array.isArray(evt.mentions) && evt.mentions.length > 0
}

function respond(
  evt: FeishuMessageEvent,
  opts: { messageId: string; body: string; format?: 'text' | 'markdown' },
) {
  return respondApi({
    messageId: opts.messageId,
    chatId: evt.chat_id,
    mode: responseMode(evt),
    body: opts.body,
    ...(opts.format ? { format: opts.format } : {}),
  }).then((r) => {
    if (r.ok) void clearAck(opts.messageId)
    return r
  })
}

function respondImage(
  evt: FeishuMessageEvent,
  opts: { messageId: string; image: string; cwd?: string },
) {
  return respondImageApi({
    messageId: opts.messageId,
    chatId: evt.chat_id,
    mode: responseMode(evt),
    image: opts.image,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  }).then((r) => {
    if (r.ok) void clearAck(opts.messageId)
    return r
  })
}

/**
 * 已发出的"正在思考"表情回应：message_id → reaction_id。
 * 回复成功发出后按 message_id 撤回，避免提示一直挂着。
 */
const ackReactions = new Map<string, string>()

/** 加一个 ack 表情，并记下 reaction_id 以便稍后撤回。 */
function ackReact(evt: FeishuMessageEvent, emojiType: string): void {
  void react(evt.message_id, emojiType).then((reactionId) => {
    if (!reactionId) return
    if (ackReactions.size > 500) {
      // 简单封顶，防止长期运行内存无限增长
      const oldest = ackReactions.keys().next().value
      if (oldest) ackReactions.delete(oldest)
    }
    ackReactions.set(evt.message_id, reactionId)
  })
}

/** 撤回某条消息上的 ack 表情（如果之前加过）。 */
async function clearAck(messageId: string): Promise<void> {
  const reactionId = ackReactions.get(messageId)
  if (!reactionId) return
  ackReactions.delete(messageId)
  await unreact(messageId, reactionId)
}

const store = new Store(config.STORE_PATH)
const startedAtMs = Date.now()

const allowedUsers = parseList(config.ALLOWED_USERS)
const allowedChats = parseList(config.ALLOWED_CHATS)
const rateLimiter = new RateLimiter(config.RATE_PER_USER_PER_MIN)

function parseList(s: string): Set<string> {
  return new Set(
    s
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0),
  )
}

/**
 * In-flight Claude Code runs keyed by *card message id*. The card-action
 * consumer looks up the AbortController here when a "⏹ 停止" button is
 * clicked, so the streaming-card path can register itself before
 * spawning and clean up when the subprocess exits.
 */
const inflight = new Map<string, AbortController>()

function prune(): void {
  const removed = store.pruneSeenEvents(config.SEEN_EVENT_TTL_DAYS * 24 * 3600 * 1000)
  if (removed > 0) logger.debug({ removed }, 'pruned seen_events')
}
prune()
const pruneTimer = setInterval(prune, 3600 * 1000)
pruneTimer.unref()

/**
 * Decide whether a group message should trigger the bot. P2P always triggers.
 *
 * The exact mention semantics depend on Feishu's content normalisation done
 * by lark-cli: for `@bot` messages, the content string is pre-pended with
 * `@DisplayName ` (or the bot's @-handle). We treat any leading '@' as a
 * mention for simplicity — under the default delivery filter Feishu only
 * pushes group messages where the bot is involved, so this is safe.
 */
function shouldHandleGroup(content: string): boolean {
  switch (config.GROUP_TRIGGER) {
    case 'off':
      return false
    case 'all':
      return true
    case 'mention':
      return content.trimStart().startsWith('@')
  }
}

/**
 * 是否要响应该消息。
 *
 *   - 私聊：一律响应
 *   - 群里且在话题内：按私聊处理，**不要求 @**（用户明确要求）
 *   - 群里且不在话题内：按 GROUP_TRIGGER 判断（默认需要 @）
 */
function shouldHandle(evt: FeishuMessageEvent): boolean {
  if (evt.chat_type !== 'group') return true
  if (evt.thread_id || evt.root_id) return true
  return shouldHandleGroup(String(evt.content ?? ''))
}

/** Strip the bot's @-mention prefix so the LLM doesn't see it. */
function stripMention(content: string): string {
  let s = content.trimStart()
  if (config.BOT_AT_PREFIX && s.startsWith(config.BOT_AT_PREFIX)) {
    s = s.slice(config.BOT_AT_PREFIX.length).trimStart()
  } else if (s.startsWith('@')) {
    // Generic strip: '@something ' up to first space.
    const ix = s.indexOf(' ')
    s = ix === -1 ? '' : s.slice(ix + 1)
  }
  return s
}

/**
 * 富文本（post）消息：lark-cli 已经把内容渲染成可读文本，但图片是
 * `![Image](img_v3_xxx)` 这种占位符。模型看不了图片，留着这些 key 只会让它
 * 瞎猜，所以换成一句说明。
 */
export function normalizePostContent(content: string): string {
  const images = content.match(/!\[[^\]]*\]\(img_[^)]+\)/g)?.length ?? 0
  const withoutImages = content.replace(/!\[[^\]]*\]\(img_[^)]+\)/g, '').trim()
  if (images === 0) return content
  const note = `[这条消息里还有 ${images} 张图片，我暂时看不了图片内容；如果需要我读图，把图里的文字贴成文本给我]`
  return withoutImages ? `${withoutImages}\n\n${note}` : note
}

async function handle(evt: FeishuMessageEvent): Promise<void> {
  const isGroup = evt.chat_type === 'group'
  const rawContent = String(evt.content ?? '')

  // Allow-lists (per-user + per-chat). Both are AND-combined when set.
  // We check before the group-mention filter so denied users get an
  // explicit logged reason — but we don't reply to them: a silent drop
  // is the right behaviour for spam / unauthorised users (replying
  // would help an attacker confirm the bot is alive).
  if (allowedUsers.size > 0 && !allowedUsers.has(evt.sender_id)) {
    logger.warn(
      { sender: evt.sender_id, chat: evt.chat_id, preview: rawContent.slice(0, 40) },
      'sender not in ALLOWED_USERS, dropped',
    )
    metrics.messagesDropped.inc({ reason: 'allowlist' })
    return
  }
  if (allowedChats.size > 0 && !allowedChats.has(evt.chat_id)) {
    logger.warn(
      { chat: evt.chat_id, sender: evt.sender_id },
      'chat not in ALLOWED_CHATS, dropped',
    )
    metrics.messagesDropped.inc({ reason: 'allowlist' })
    return
  }

  // Image / file messages → vision-or-doc input for the claude-code
  // backend. We download the resource to <sandbox>/in/<message_id>[.<ext>]
  // and synthesise a text prompt that points the agent at it via Read.
  // Other non-text types are still politely refused.
  if (evt.message_type === 'image' || evt.message_type === 'file') {
    if (!shouldHandle(evt)) return
    if (config.BACKEND !== 'claude-code') {
      await respond(evt, {
        messageId: evt.message_id,
        body: `(${evt.message_type === 'image' ? '图片' : '文件'}输入仅在 \`BACKEND=claude-code\` 后端下支持)`,
        format: 'markdown',
      })
      return
    }
    if (!(await admitAndAck(evt))) return
    await handleResourceMessage(evt, rawContent, evt.message_type)
    return
  }

  // 富文本（post）：lark-cli 已经渲染成可读文本（标题、正文、列表都在里面），
  // 所以直接按文本处理 —— 飞书里粘贴带格式的内容、转发/引用消息都会变成 post，
  // 之前一律拒绝会让用户莫名其妙收到"暂不支持"。
  if (evt.message_type === 'post') {
    const text = normalizePostContent(isGroup ? stripMention(rawContent) : rawContent)
    if (!shouldHandle(evt)) {
      metrics.messagesDropped.inc({ reason: 'group_filter' })
      return
    }
    await handleTextMessage(evt, text)
    return
  }

  // Non-text payloads (audio / sticker / interactive …): politely tell
  // the user we don't speak that yet. Surface to the log so operators
  // can see what's being silently refused.
  if (evt.message_type !== 'text') {
    if (!shouldHandle(evt)) {
      metrics.messagesDropped.inc({ reason: 'group_filter' })
      return
    }
    logger.info(
      { chat: evt.chat_id, type: evt.message_type, preview: rawContent.slice(0, 80) },
      'unsupported message type, replying with refusal',
    )
    metrics.messagesDropped.inc({ reason: 'unsupported_type' })
    await respond(evt, {
      messageId: evt.message_id,
      body: `(暂不支持 \`${evt.message_type}\` 类型消息,当前版本支持文本、图片和文件。)`,
      format: 'markdown',
    })
    return
  }

  // 普通文本消息：走与 post 共用的文本处理路径。
  await handleTextMessage(evt, isGroup ? stripMention(rawContent) : rawContent)
}

/** 文本与富文本（post）共用的处理路径：群过滤 → 斜杠命令 → 会话历史 → 模型。 */
async function handleTextMessage(evt: FeishuMessageEvent, rawText: string): Promise<void> {
  const isGroup = evt.chat_type === 'group'

  // Group filter.
  if (!shouldHandle(evt)) {
    logger.debug(
      {
        chat: evt.chat_id,
        preview: rawText.slice(0, 40),
        thread: evt.thread_id,
        mentions: Array.isArray(evt.mentions) ? evt.mentions.length : 0,
      },
      'group msg ignored',
    )
    metrics.messagesDropped.inc({ reason: 'group_filter' })
    return
  }

  if (isGroup) {
    logger.trace({ chat: evt.chat_id, raw: rawText.slice(0, 120) }, 'group raw content')
  }

  const userText = rawText.slice(0, config.MAX_INPUT_CHARS)
  if (!userText.trim()) return

  // Functional slash-commands (/sandbox, /status, /new, /help, …) run a
  // built-in handler instead of calling the LLM. They are NOT rate-limited
  // (cheap, local) but we still ack them. A handler may emit a
  // `contextNote` recorded as a user turn so the next LLM call sees that a
  // system command ran.
  const cmd = parseCommand(userText)
  if (cmd) {
    if (config.ACK_EMOJI) ackReact(evt, config.ACK_EMOJI)
    logger.info(
      { chat: evt.chat_id, from: evt.sender_id, command: cmd.def.name, args: cmd.args },
      'functional command',
    )
    metrics.commands.inc({ name: cmd.def.name })
    try {
      const result = await cmd.def.handler({
        chatId: evt.chat_id,
        args: cmd.args,
        store,
        startedAtMs,
      })
      if (result.contextNote) {
        store.appendMessage(evt.chat_id, 'user', result.contextNote)
      }
      await respond(evt, { messageId: evt.message_id, body: result.reply, format: 'markdown' })
    } catch (err) {
      logger.error({ err, command: cmd.def.name }, 'command handler threw')
      await respond(evt, {
        messageId: evt.message_id,
        body: `(命令 \`/${cmd.def.name}\` 执行失败)`,
        format: 'text',
      })
    }
    return
  }

  if (!(await admitAndAck(evt))) return

  logger.info(
    {
      chat: evt.chat_id,
      chatType: evt.chat_type,
      from: evt.sender_id,
      preview: userText.slice(0, 80),
        thread: evt.thread_id,
        root: evt.root_id,
        replyTo: evt.reply_to,
        mentions: Array.isArray(evt.mentions) ? evt.mentions.length : 0,
    },
    'incoming message',
  )

  store.appendMessage(evt.chat_id, 'user', userText)
  metrics.messagesTotal.inc({ type: 'text', backend: config.BACKEND })

  if (config.BACKEND === 'claude-code') {
    await handleClaudeCode(evt, userText)
    return
  }

  // Default backend: one Anthropic-SDK HTTP call with our SQLite-backed
  // history. Tools (if ENABLE_TOOLS=true) loop inside `chat()`.
  let body: string
  let format: 'text' | 'markdown' = 'text'
  const history = store.history(evt.chat_id, config.MAX_HISTORY_TURNS * 2)
  const sdkStart = Date.now()
  try {
    const result = await chat(history)
    body = result.text
    metrics.llmCalls.inc({ backend: 'anthropic-sdk', outcome: 'success' })
    metrics.llmLatencySec.observe({ backend: 'anthropic-sdk' }, (Date.now() - sdkStart) / 1000)
    metrics.llmToolCalls.inc({ backend: 'anthropic-sdk' }, result.toolCalls)
  } catch (err) {
    const e = err as { status?: number; message?: string }
    logger.error({ status: e.status, msg: e.message }, 'LLM call failed')
    body = `(调用模型失败: ${e.status ?? ''} ${e.message ?? String(err)})`
    metrics.llmCalls.inc({ backend: 'anthropic-sdk', outcome: 'error' })
  }

  if (/[`*#>\-_]|\n/.test(body)) format = 'markdown'

  store.appendMessage(evt.chat_id, 'assistant', body)
  await respond(evt, { messageId: evt.message_id, body, format })
}

/**
 * Shared admission gate used by both text and image branches: applies
 * the per-user rate limit and fires the ack-emoji on success. Returns
 * `true` when the message should proceed to handling, `false` when it
 * was throttled (a textual signal + ⏰ emoji have already been sent).
 */
async function admitAndAck(evt: FeishuMessageEvent): Promise<boolean> {
  const limit = rateLimiter.tryConsume(evt.sender_id)
  if (!limit.ok) {
    const wait = Math.ceil(limit.retryAfterSec ?? 10)
    logger.warn({ sender: evt.sender_id, retryAfterSec: wait }, 'rate-limited')
    metrics.messagesDropped.inc({ reason: 'rate_limited' })
    ackReact(evt, 'CLOCK')
    await respond(evt, {
      messageId: evt.message_id,
      body: `⏰ 请求过于频繁,请约 ${wait} 秒后再试(每用户每分钟 ${config.RATE_PER_USER_PER_MIN} 条)。`,
      format: 'text',
    })
    return false
  }
  if (config.ACK_EMOJI) ackReact(evt, config.ACK_EMOJI)
  return true
}

/**
 * Vision/doc input flow: download the resource (image or file) into the
 * sandbox, synthesise a user-text prompt pointing the agent at it via
 * Read, and dispatch through the regular claude-code pipeline. Lark-cli
 * normalises message content as:
 *   - image  →  `<image key="img_v3_…"/>`  (sometimes `[Image: img_v3_…]`)
 *   - file   →  `<file key="file_v3_…" name="original-name.docx"/>`
 * We accept the key from anywhere in the string.
 */
async function handleResourceMessage(
  evt: FeishuMessageEvent,
  rawContent: string,
  kind: 'image' | 'file',
): Promise<void> {
  const keyPrefix = kind === 'image' ? 'img_' : 'file_'
  const m = rawContent.match(new RegExp(`${keyPrefix}[A-Za-z0-9_-]+`))
  if (!m) {
    logger.warn(
      { chat: evt.chat_id, kind, preview: rawContent.slice(0, 80) },
      `${kind} message: no key found in content`,
    )
    await respond(evt, {
      messageId: evt.message_id,
      body: `(无法从消息中提取 ${kind === 'image' ? 'image_key' : 'file_key'},请重试)`,
      format: 'text',
    })
    return
  }
  const fileKey = m[0]

  // Extract the original filename for files so the sandbox name + the
  // prompt both surface something the user (and the model) recognises.
  // Images rarely carry a meaningful filename from the lark-cli content
  // string, so we just fall back to the message_id.
  let baseName = evt.message_id
  if (kind === 'file') {
    const nm = rawContent.match(/name="([^"]+)"/)
    if (nm?.[1]) {
      // Sanitise: keep alphanumerics, dot, dash, underscore, CJK; drop
      // path separators. Cap at 80 chars to avoid filesystem grief.
      baseName = nm[1].replace(/[\\/]/g, '_').slice(0, 80)
    }
  }
  const relPath = `in/${baseName}`

  const dl = await downloadResource({
    messageId: evt.message_id,
    fileKey,
    type: kind,
    output: relPath,
    cwd: config.CLAUDE_CODE_SANDBOX,
    as: 'bot',
  })
  if (!dl.ok) {
    await respond(evt, {
      messageId: evt.message_id,
      body: `(${kind === 'image' ? '图片' : '文件'}下载失败,请稍后再试)`,
      format: 'text',
    })
    return
  }
  const finalPath = dl.output ?? relPath
  logger.info(
    { chat: evt.chat_id, kind, fileKey, path: finalPath },
    `${kind} downloaded for agent input`,
  )

  // Synthesise the user turn. Claude Code's Read tool can open images
  // and (for files) any binary it understands; the agent self-services
  // from a textual pointer.
  const synthText =
    kind === 'image'
      ? `用户发来了一张图片，已保存到沙箱内的 \`${finalPath}\`。请用 Read 工具查看图片，然后根据图片内容回应用户（如果用户没附文字，就描述图片或回答可能的问题）。`
      : `用户发来了一个文件，已保存到沙箱内的 \`${finalPath}\`。请先用 Read 工具读取（如果是文本/Markdown/JSON 等直接打开；如果是 .docx/.pdf/.xlsx 等二进制文档，用 Bash 调用合适的命令行工具，例如 \`pandoc\`、\`pdftotext\`、\`unzip\` 解 docx 等），然后根据内容回应用户。`
  store.appendMessage(evt.chat_id, 'user', synthText)
  metrics.messagesTotal.inc({ type: kind, backend: config.BACKEND })
  await handleClaudeCode(evt, synthText)
}

/**
 * Claude Code backend with optional streaming-card UI.
 *
 * Path A (default, STREAMING_CARD=true): send an interactive card as the
 * reply, PATCH it as the agent loop streams tool-use / text events.
 *
 * Path B (STREAMING_CARD=false or card send failed): legacy text path,
 * preserves the Phase 7 "⏳ 思考中…" placeholder + Phase 8 image replies.
 */
async function handleClaudeCode(evt: FeishuMessageEvent, userText: string): Promise<void> {
  const fullAccess = isSandboxOff(store, evt.chat_id)
  // The claude-code backend keeps its OWN session history and never sees
  // our SQLite contextNotes, so a `/sandbox off` recorded there is
  // invisible to the model — it would still refuse with "I can only
  // access the sandbox". Prepend an explicit per-turn directive while
  // full access is on so the model actually uses its lifted permissions.
  const prompt = fullAccess
    ? `[系统提示：管理员已执行 /sandbox off，沙箱限制已解除。你现在拥有主机完整文件系统权限，可用 Read / Edit / Write / Bash 访问任意绝对路径（如 /etc、/var、其他用户目录等），不要再以"只能访问沙箱目录"为由拒绝。请直接执行下面的用户请求。]\n\n${userText}`
    : userText

  if (config.STREAMING_CARD) {
    const ok = await tryStreamingCard(evt, prompt, fullAccess)
    if (ok) return
    // Fall through to legacy path on send failure.
    logger.warn({ chat: evt.chat_id }, 'streaming card path failed, falling back to text')
  }

  // ---- Legacy text path ----
  let placeholderId: string | undefined
  if (config.SHOW_THINKING_PLACEHOLDER) {
    const r = await respond(evt, {
      messageId: evt.message_id,
      body: '⏳ 思考中…',
      format: 'text',
    })
    placeholderId = r.replyMessageId
  }

  let body: string
  try {
    const result = await runClaudeCode(evt.chat_id, prompt, {
      onProgress: (p) => logProgress(evt.chat_id, p),
      fullAccess,
    })
    body = result.text
    metrics.llmToolCalls.inc({ backend: 'claude-code' }, result.toolCalls)
    metrics.llmLatencySec.observe({ backend: 'claude-code' }, result.durationSec)
    if (result.costUsd !== undefined) {
      metrics.llmCostUsd.inc({ backend: 'claude-code' }, result.costUsd)
    }
    store.recordTurn(evt.chat_id, result.costUsd ?? 0)
    metrics.llmCalls.inc({
      backend: 'claude-code',
      outcome: result.stopReason === 'error' ? 'error' : 'success',
    })
    logger.info(
      {
        chat: evt.chat_id,
        sec: result.durationSec.toFixed(1),
        cost: result.costUsd,
        stop: result.stopReason,
        session: result.sessionId.slice(0, 8),
        toolCalls: result.toolCalls,
      },
      'claude-code done',
    )
  } catch (err) {
    const e = err as { message?: string }
    logger.error({ err: e.message }, 'claude-code threw')
    body = `(Claude Code 失败: ${e.message ?? String(err)})`
    metrics.llmCalls.inc({ backend: 'claude-code', outcome: 'error' })
  }

  let format: 'text' | 'markdown' = 'text'
  if (/[`*#>\-_]|\n/.test(body)) format = 'markdown'

  store.appendMessage(evt.chat_id, 'assistant', body)

  const { images, skipped, stripped } = extractLocalImages(body, config.CLAUDE_CODE_SANDBOX)
  if (skipped.length > 0) {
    logger.warn(
      {
        chat: evt.chat_id,
        skipped: skipped.map((s) => ({ reason: s.reason, ref: s.ref.slice(0, 80) })),
      },
      'image refs skipped (kept as markdown)',
    )
  }

  const textBody = stripped.trim()
  if (textBody) {
    await respond(evt, { messageId: evt.message_id, body: textBody, format })
  } else if (images.length === 0) {
    await respond(evt, { messageId: evt.message_id, body: '(空回复)', format: 'text' })
  }

  for (const img of images) {
    logger.info({ chat: evt.chat_id, image: img.relPath, alt: img.alt }, 'sending image reply')
    const r = await respondImage(evt, {
      messageId: evt.message_id,
      image: img.relPath,
      cwd: config.CLAUDE_CODE_SANDBOX,
    })
    if (!r.ok) logger.warn({ chat: evt.chat_id, image: img.relPath }, 'image reply failed')
  }

  if (placeholderId) {
    recall(placeholderId).catch((err) =>
      logger.warn({ err }, 'placeholder recall failed (non-fatal)'),
    )
  }
}

/**
 * Streaming-card path. Returns `true` on success, `false` if the card
 * couldn't even be sent (so the caller can fall back to the text path).
 */
async function tryStreamingCard(
  evt: FeishuMessageEvent,
  userText: string,
  fullAccess: boolean,
): Promise<boolean> {
  // 1. Send the initial "thinking" card, with the stop button already
  //    showing so the user can bail out before the first tool fires.
  const initialCard = buildCard({
    phase: 'thinking',
    tools: [],
    body: '',
    showActions: false,
    showStop: true,
  })
  const sendResult = await sendCardReply(evt.message_id, initialCard)
  if (!sendResult.ok || !sendResult.messageId) return false
  const cardMsgId = sendResult.messageId
  const patcher = new CardPatcher(cardMsgId, config.STREAMING_CARD_MIN_INTERVAL_MS)
  const abort = new AbortController()
  inflight.set(cardMsgId, abort)

  // 2. Run Claude Code, queue card updates from each progress event.
  const tools: ToolEntry[] = []
  const toolIdxById = new Map<string, number>()
  let partialBody = ''
  const startedAt = Date.now()

  const snapshot = (phase: CardPhase, opts: { costUsd?: number } = {}) =>
    buildCard({
      phase,
      tools,
      body: partialBody,
      durationSec: (Date.now() - startedAt) / 1000,
      ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
      showActions: phase === 'done' || phase === 'error' || phase === 'aborted',
      showStop: phase === 'thinking' || phase === 'running',
    })

  const onProgress = (p: ClaudeCodeProgress): void => {
    logProgress(evt.chat_id, p)
    switch (p.kind) {
      case 'tool_use': {
        toolIdxById.set(p.toolUseId, tools.length)
        tools.push({ tool: p.tool, brief: p.brief })
        patcher.queue(snapshot('running'))
        break
      }
      case 'tool_result': {
        const idx = toolIdxById.get(p.toolUseId)
        if (idx !== undefined && tools[idx]) tools[idx]!.ok = p.ok
        patcher.queue(snapshot('running'))
        break
      }
      case 'text': {
        partialBody += p.text
        patcher.queue(snapshot('running'))
        break
      }
    }
  }

  let body: string
  let costUsd: number | undefined
  let stopReason: string | undefined
  try {
    const result = await runClaudeCode(evt.chat_id, userText, {
      onProgress,
      abortSignal: abort.signal,
      fullAccess,
    })
    body = result.text
    costUsd = result.costUsd
    stopReason = result.stopReason
    metrics.llmToolCalls.inc({ backend: 'claude-code' }, result.toolCalls)
    metrics.llmLatencySec.observe({ backend: 'claude-code' }, result.durationSec)
    if (result.costUsd !== undefined) {
      metrics.llmCostUsd.inc({ backend: 'claude-code' }, result.costUsd)
    }
    store.recordTurn(evt.chat_id, result.costUsd ?? 0)
    logger.info(
      {
        chat: evt.chat_id,
        sec: result.durationSec.toFixed(1),
        cost: result.costUsd,
        stop: result.stopReason,
        session: result.sessionId.slice(0, 8),
        toolCalls: result.toolCalls,
      },
      'claude-code done',
    )
  } catch (err) {
    const e = err as { message?: string }
    logger.error({ err: e.message }, 'claude-code threw')
    body = `(Claude Code 失败: ${e.message ?? String(err)})`
    stopReason = 'error'
  } finally {
    inflight.delete(cardMsgId)
  }

  const outcome =
    stopReason === 'aborted' ? 'aborted' : stopReason === 'error' ? 'error' : 'success'
  metrics.llmCalls.inc({ backend: 'claude-code', outcome })

  store.appendMessage(evt.chat_id, 'assistant', body)

  // 3. Process images and replace partialBody with the canonical body
  //    (cleaned of local-file image refs) before flushing.
  const { images, skipped, stripped } = extractLocalImages(body, config.CLAUDE_CODE_SANDBOX)
  if (skipped.length > 0) {
    logger.warn(
      {
        chat: evt.chat_id,
        skipped: skipped.map((s) => ({ reason: s.reason, ref: s.ref.slice(0, 80) })),
      },
      'image refs skipped (kept as markdown)',
    )
  }
  partialBody = stripped || body

  const finalPhase: CardPhase =
    stopReason === 'aborted' ? 'aborted' : stopReason === 'error' ? 'error' : 'done'
  await patcher.flush(snapshot(finalPhase, costUsd !== undefined ? { costUsd } : {}))

  // 4. Image replies still go as separate messages (Phase 8 unchanged).
  for (const img of images) {
    logger.info({ chat: evt.chat_id, image: img.relPath, alt: img.alt }, 'sending image reply')
    const r = await respondImage(evt, {
      messageId: evt.message_id,
      image: img.relPath,
      cwd: config.CLAUDE_CODE_SANDBOX,
    })
    if (!r.ok) logger.warn({ chat: evt.chat_id, image: img.relPath }, 'image reply failed')
  }
  return true
}

/** Pure-logging onProgress used by both paths. */
function logProgress(chatId: string, p: ClaudeCodeProgress): void {
  switch (p.kind) {
    case 'tool_use':
      logger.info(
        { chat: chatId, tool: p.tool, brief: p.brief.slice(0, 80) },
        'claude-code tool_use',
      )
      break
    case 'tool_result':
      logger.debug(
        { chat: chatId, tool: p.tool, ok: p.ok, len: p.preview.length },
        'claude-code tool_result',
      )
      break
    case 'text':
      logger.debug({ chat: chatId, preview: p.text.slice(0, 80) }, 'claude-code partial text')
      break
  }
}

export function run(): { stop: () => Promise<void> } {
  logger.info(
    {
      backend: config.BACKEND,
      model: config.ANTHROPIC_MODEL,
      key: config.LARK_EVENT_KEY,
      groupTrigger: config.GROUP_TRIGGER,
      streamingCard: config.BACKEND === 'claude-code' ? config.STREAMING_CARD : undefined,
      cardCallback: config.ENABLE_CARD_CALLBACK,
      ackEmoji: config.ACK_EMOJI || null,
      ratePerUserPerMin: config.RATE_PER_USER_PER_MIN || null,
      allowedUsers: allowedUsers.size || null,
      allowedChats: allowedChats.size || null,
      metricsPort: config.METRICS_PORT || null,
      sandbox: config.BACKEND === 'claude-code' ? config.CLAUDE_CODE_SANDBOX : undefined,
    },
    'bridge starting',
  )

  const { stop: stopMsgConsumer } = startConsumer({
    eventKey: config.LARK_EVENT_KEY,
    as: config.LARK_EVENT_AS,
    onEvent: (evt) => {
      if (!store.claimEvent(evt.event_id)) {
        logger.debug({ event_id: evt.event_id }, 'duplicate event, skipped')
        return
      }
      handle(evt).catch((err) => logger.error({ err }, 'handle threw'))
    },
  })

  // Optional second consumer for card-action callbacks. Requires the
  // app's Developer Console to have "Callback Configuration" enabled —
  // see docs/architecture.md for setup. We always wire the handler when
  // ENABLE_CARD_CALLBACK is on, even if the user hasn't enabled the
  // console toggle (the lark-cli consumer will simply receive nothing).
  let stopCardConsumer: (() => Promise<void>) | undefined
  if (config.ENABLE_CARD_CALLBACK) {
    const h = startCardActionConsumer(onCardAction)
    stopCardConsumer = h.stop
  }

  // Optional Prometheus /metrics endpoint, bound to localhost.
  let stopMetrics: (() => Promise<void>) | undefined
  if (config.METRICS_PORT > 0) {
    const { stop } = startMetricsServer(config.METRICS_PORT)
    stopMetrics = stop
  }

  return {
    stop: async () => {
      clearInterval(pruneTimer)
      await stopMsgConsumer()
      if (stopCardConsumer) await stopCardConsumer()
      if (stopMetrics) await stopMetrics()
      store.close()
    },
  }
}

/**
 * Handle a card button click. Supported actions:
 *   - `stop`       → abort the in-flight claude-code subprocess for that
 *                    card (if any); the running tryStreamingCard()
 *                    promise will resolve with `stopReason: 'aborted'`
 *                    and patch the card to the "已停止" state.
 *   - `regenerate` → re-run the last user message in this chat as a
 *                    new LLM turn. Bypasses the group-mention filter
 *                    (the operator already opted in by clicking).
 */
async function onCardAction(action: CardActionEvent): Promise<void> {
  const name = String(action.actionValue['action'] ?? '')
  logger.info(
    {
      chat: action.chatId,
      msg: action.messageId,
      operator: action.operatorId,
      name,
      tag: action.actionTag,
    },
    'card action received',
  )
  metrics.cardActions.inc({ action: name || 'unknown' })

  if (name === 'stop') {
    const ctrl = inflight.get(action.messageId)
    if (!ctrl) {
      logger.info({ msg: action.messageId }, 'stop: no in-flight run for this card')
      return
    }
    ctrl.abort()
    return
  }

  if (name !== 'regenerate') {
    logger.debug({ name }, 'card action ignored (unknown name)')
    return
  }
  // Walk recent history to find the most recent user turn — that's what
  // we re-run. We deliberately ignore the previous assistant turn (don't
  // delete it; just send a fresh one in reply).
  const history = store.history(action.chatId, 8)
  const lastUser = [...history].reverse().find((m) => m.role === 'user')
  if (!lastUser) {
    logger.warn({ chat: action.chatId }, 'regenerate: no user message in history')
    return
  }
  // Send a "regenerate" prefix so Claude Code sees this is a retry,
  // not a fresh question — it can decide to take a different angle.
  const synthetic: FeishuMessageEvent = {
    type: 'im.message.receive_v1',
    event_id: `regenerate-${action.messageId}-${Date.now()}`,
    id: action.messageId,
    message_id: action.messageId,
    chat_id: action.chatId,
    // p2p bypasses the group-mention filter; even if the original chat
    // is a group, the operator already opted in by clicking.
    chat_type: 'p2p',
    message_type: 'text',
    sender_id: action.operatorId,
    content: `请重新回答上一个问题（用不同的角度或更详尽的内容）：${lastUser.content}`,
    timestamp: String(Date.now()),
    create_time: String(Date.now()),
  }
  await handle(synthetic)
}
