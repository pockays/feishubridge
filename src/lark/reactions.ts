import { spawn } from 'node:child_process'
import { logger } from '../logger.js'

/**
 * Add an emoji reaction to a Feishu message — used as an "ack" so the user
 * sees the bot has seen their message within ~200 ms, before the much
 * longer LLM round-trip starts.
 *
 * `emojiType` is Feishu's enum string (e.g. `OK`, `THUMBSUP`, `HEART`). See
 * https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/emojis-introduce
 *
 * Best-effort: failures are logged but never thrown.
 */
export function react(
  messageId: string,
  emojiType: string,
  as: 'bot' | 'user' = 'bot',
): Promise<string | undefined> {
  const data = JSON.stringify({ reaction_type: { emoji_type: emojiType } })
  return new Promise((resolve) => {
    const child = spawn(
      'lark-cli',
      [
        'im',
        'reactions',
        'create',
        '--as',
        as,
        '--message-id',
        messageId,
        '--data',
        data,
        '--format',
        'json',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))
    child.on('exit', (code) => {
      if (code === 0) {
        const id = extractReactionId(stdout)
        logger.debug({ messageId, emojiType, reactionId: id }, 'reaction ok')
        resolve(id)
      } else {
        logger.warn(
          { code, messageId, emojiType, stderr: stderr.slice(0, 300) },
          'reaction failed (best-effort)',
        )
        resolve(undefined)
      }
    })
    child.on('error', (err) => {
      logger.warn({ err: err.message }, 'spawn lark-cli (reactions) failed')
      resolve(undefined)
    })
  })
}

/**
 * 撤回之前加的表情回应（回复发出后调用，让"正在思考"的提示消失）。
 * 需要创建时返回的 `reaction_id`。
 *
 * Best-effort：失败只记日志，不抛错。
 */
export function unreact(
  messageId: string,
  reactionId: string,
  as: 'bot' | 'user' = 'bot',
): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(
      'lark-cli',
      [
        'im',
        'reactions',
        'delete',
        '--as',
        as,
        '--message-id',
        messageId,
        '--reaction-id',
        reactionId,
        '--format',
        'json',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))
    child.on('exit', (code) => {
      if (code === 0) {
        logger.debug({ messageId, reactionId }, 'reaction removed')
      } else {
        logger.warn(
          { code, messageId, reactionId, stderr: stderr.slice(0, 300) },
          'reaction remove failed (best-effort)',
        )
      }
      resolve()
    })
    child.on('error', (err) => {
      logger.warn({ err: err.message }, 'spawn lark-cli (unreact) failed')
      resolve()
    })
  })
}

/** 从 lark-cli 的 JSON 输出里取 reaction_id。 */
function extractReactionId(stdout: string): string | undefined {
  try {
    const obj = JSON.parse(stdout) as Record<string, unknown>
    const data = (obj['data'] ?? obj) as Record<string, unknown>
    const id = data['reaction_id']
    if (typeof id === 'string' && id.length > 0) return id
  } catch {
    // 保守起见忽略解析失败
  }
  return undefined
}
