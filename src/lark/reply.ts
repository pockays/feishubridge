import { spawn } from 'node:child_process'
import { logger } from '../logger.js'

export interface ReplyOptions {
  messageId: string
  /** Plain text (use `format: 'text'`) or markdown (use `format: 'markdown'`). */
  body: string
  format?: 'text' | 'markdown'
  as?: 'bot' | 'user'
  /** 回复进话题流（飞书客户端会把它折叠成「N 条回复」的话题入口）。 */
  inThread?: boolean
}

export interface ReplyResult {
  ok: boolean
  /** The message_id (om_...) of the freshly-sent reply, if the API returned one. */
  replyMessageId?: string
}

/**
 * Reply to a Feishu message via `lark-cli im +messages-reply`.
 *
 * Returns the new message's `om_*` id when the API succeeds — needed when the
 * caller wants to delete or visually mark the message later (e.g. removing a
 * "thinking…" placeholder).
 *
 * Failures are logged but never thrown — the consumer loop should keep
 * running even if one reply API call goes wrong.
 */
export function reply(opts: ReplyOptions): Promise<ReplyResult> {
  const format = opts.format ?? 'text'
  const args = [
    'im',
    '+messages-reply',
    '--as',
    opts.as ?? 'bot',
    '--message-id',
    opts.messageId,
    ...(opts.inThread ? ['--reply-in-thread'] : []),
    format === 'markdown' ? '--markdown' : '--text',
    opts.body,
    '--format',
    'json',
  ]

  return new Promise((resolve) => {
    const child = spawn('lark-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))

    child.on('exit', (code) => {
      if (code === 0) {
        const id = extractReplyMessageId(stdout)
        logger.debug({ messageId: opts.messageId, format, replyMessageId: id }, 'reply ok')
        resolve(id ? { ok: true, replyMessageId: id } : { ok: true })
      } else {
        logger.error(
          { code, format, messageId: opts.messageId, stderr: stderr.slice(0, 500) },
          'reply failed',
        )
        resolve({ ok: false })
      }
    })

    child.on('error', (err) => {
      logger.error({ err: err.message }, 'spawn lark-cli failed')
      resolve({ ok: false })
    })
  })
}

export interface ReplyImageOptions {
  messageId: string
  /**
   * `lark-cli --image` accepts: image key (`img_xxx`), URL, or cwd-relative
   * local path. **Absolute paths and `..` are rejected** by lark-cli — pass a
   * relative path AND set `cwd` to the directory it's resolved against.
   */
  image: string
  /** Working directory for the lark-cli child process. Required for local paths. */
  cwd?: string
  as?: 'bot' | 'user'
  /** 回复进话题流。 */
  inThread?: boolean
}

/**
 * Reply to a Feishu message with an image. Behaves like `reply()` for
 * errors — logs and resolves `{ ok: false }` rather than throwing.
 */
export function replyImage(opts: ReplyImageOptions): Promise<ReplyResult> {
  const args = [
    'im',
    '+messages-reply',
    '--as',
    opts.as ?? 'bot',
    '--message-id',
    opts.messageId,
    ...(opts.inThread ? ['--reply-in-thread'] : []),
    '--image',
    opts.image,
    '--format',
    'json',
  ]

  return new Promise((resolve) => {
    const child = spawn('lark-cli', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))

    child.on('exit', (code) => {
      if (code === 0) {
        const id = extractReplyMessageId(stdout)
        logger.debug({ messageId: opts.messageId, image: opts.image, replyMessageId: id }, 'reply image ok')
        resolve(id ? { ok: true, replyMessageId: id } : { ok: true })
      } else {
        logger.error(
          { code, messageId: opts.messageId, image: opts.image, stderr: stderr.slice(0, 500) },
          'reply image failed',
        )
        resolve({ ok: false })
      }
    })

    child.on('error', (err) => {
      logger.error({ err: err.message }, 'spawn lark-cli (image) failed')
      resolve({ ok: false })
    })
  })
}

export interface SendOptions {
  /** Target chat (oc_...). Works for both group and P2P chats. */
  chatId: string
  body: string
  format?: 'text' | 'markdown'
  as?: 'bot' | 'user'
}

/**
 * Send a **standalone** message into a chat (not attached to any other
 * message) via `lark-cli im +messages-send`.
 */
export function sendMessage(opts: SendOptions): Promise<ReplyResult> {
  const format = opts.format ?? 'text'
  const args = [
    'im',
    '+messages-send',
    '--as',
    opts.as ?? 'bot',
    '--chat-id',
    opts.chatId,
    format === 'markdown' ? '--markdown' : '--text',
    opts.body,
    '--format',
    'json',
  ]

  return new Promise((resolve) => {
    const child = spawn('lark-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))

    child.on('exit', (code) => {
      if (code === 0) {
        const id = extractReplyMessageId(stdout)
        logger.debug({ chatId: opts.chatId, format, messageId: id }, 'send ok')
        resolve(id ? { ok: true, replyMessageId: id } : { ok: true })
      } else {
        logger.error(
          { code, format, chatId: opts.chatId, stderr: stderr.slice(0, 500) },
          'send failed',
        )
        resolve({ ok: false })
      }
    })

    child.on('error', (err) => {
      logger.error({ err: err.message }, 'spawn lark-cli (send) failed')
      resolve({ ok: false })
    })
  })
}

/** 回复的呈现形式。 */
export type ResponseMode = 'send' | 'reply' | 'thread'

export interface RespondOptions {
  messageId: string
  chatId: string
  /**
   * - `send`   : 独立消息（主消息流里的普通消息）
   * - `reply`  : 引用式回复，挂在用户那条消息下面
   * - `thread` : 话题回复，折叠成「N 条回复」入口
   */
  mode: ResponseMode
  body: string
  format?: 'text' | 'markdown'
  as?: 'bot' | 'user'
}

/**
 * Context-aware response.
 *
 * 按 `mode` 选择飞书的呈现形式（独立消息 / 引用回复 / 话题回复）。
 */
export function respond(opts: RespondOptions): Promise<ReplyResult> {
  if (opts.mode === 'send') {
    return sendMessage({
      chatId: opts.chatId,
      body: opts.body,
      ...(opts.format ? { format: opts.format } : {}),
      ...(opts.as ? { as: opts.as } : {}),
    })
  }
  return reply({
    messageId: opts.messageId,
    body: opts.body,
    ...(opts.format ? { format: opts.format } : {}),
    ...(opts.as ? { as: opts.as } : {}),
    ...(opts.mode === 'thread' ? { inThread: true } : {}),
  })
}

export interface SendImageOptions {
  chatId: string
  image: string
  cwd?: string
  as?: 'bot' | 'user'
}

/** Send an image as a standalone message into a chat. */
export function sendMessageImage(opts: SendImageOptions): Promise<ReplyResult> {
  const args = [
    'im',
    '+messages-send',
    '--as',
    opts.as ?? 'bot',
    '--chat-id',
    opts.chatId,
    '--image',
    opts.image,
    '--format',
    'json',
  ]

  return new Promise((resolve) => {
    const child = spawn('lark-cli', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))

    child.on('exit', (code) => {
      if (code === 0) {
        const id = extractReplyMessageId(stdout)
        logger.debug({ chatId: opts.chatId, image: opts.image, messageId: id }, 'send image ok')
        resolve(id ? { ok: true, replyMessageId: id } : { ok: true })
      } else {
        logger.error(
          { code, chatId: opts.chatId, image: opts.image, stderr: stderr.slice(0, 500) },
          'send image failed',
        )
        resolve({ ok: false })
      }
    })

    child.on('error', (err) => {
      logger.error({ err: err.message }, 'spawn lark-cli (send image) failed')
      resolve({ ok: false })
    })
  })
}

export interface RespondImageOptions {
  messageId: string
  chatId: string
  mode: ResponseMode
  image: string
  cwd?: string
  as?: 'bot' | 'user'
}

/**
 * Context-aware image response — same split as `respond()`.
 */
export function respondImage(opts: RespondImageOptions): Promise<ReplyResult> {
  if (opts.mode === 'send') {
    return sendMessageImage({
      chatId: opts.chatId,
      image: opts.image,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.as ? { as: opts.as } : {}),
    })
  }
  return replyImage({
    messageId: opts.messageId,
    image: opts.image,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.as ? { as: opts.as } : {}),
    ...(opts.mode === 'thread' ? { inThread: true } : {}),
  })
}

/** Best-effort extraction of `message_id` from lark-cli JSON output. */
function extractReplyMessageId(stdout: string): string | undefined {
  try {
    const obj = JSON.parse(stdout) as Record<string, unknown>
    const data = (obj['data'] ?? obj) as Record<string, unknown>
    const id = data['message_id']
    if (typeof id === 'string' && id.startsWith('om_')) return id
  } catch {
    // fall through
  }
  return undefined
}

/**
 * Recall (delete) a previously-sent message. Best-effort — failures are
 * logged but never thrown; the caller's flow should not depend on success.
 */
export function recall(messageId: string, as: 'bot' | 'user' = 'bot'): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(
      'lark-cli',
      ['im', 'messages', 'delete', '--as', as, '--params', JSON.stringify({ message_id: messageId }), '--yes'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))
    child.on('exit', (code) => {
      if (code === 0) {
        logger.debug({ messageId }, 'recall ok')
      } else {
        logger.warn(
          { code, messageId, stderr: stderr.slice(0, 300) },
          'recall failed (this is best-effort)',
        )
      }
      resolve()
    })
    child.on('error', (err) => {
      logger.warn({ err: err.message }, 'spawn lark-cli (recall) failed')
      resolve()
    })
  })
}
