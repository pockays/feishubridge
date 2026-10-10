/**
 * Real-world event shape captured from `lark-cli event consume im.message.receive_v1`.
 * Fields are flat at root — there is no `event`/`header` wrapper despite what some
 * docs imply. `content` is *pre-rendered* by lark-cli to a human-readable string,
 * so consumers do NOT need to `JSON.parse(content).text` again.
 */
export interface FeishuMessageEvent {
  type: 'im.message.receive_v1'
  event_id: string
  /** Alias of message_id, kept for compatibility. */
  id: string
  message_id: string
  chat_id: string
  chat_type: 'p2p' | 'group'
  message_type: string
  sender_id: string
  content: string
  /** ms timestamp string */
  timestamp: string
  /** ms timestamp string */
  create_time: string
  /**
   * 话题/回复上下文。消息在话题里时由 lark-cli 带上：
   *  - thread_id: 所属话题 id
   *  - root_id:   话题根消息 id
   *  - reply_to:  直接回复的父消息 id
   */
  thread_id?: string
  root_id?: string
  reply_to?: string
  /** 消息里的 @ 提及（由 lark-cli 归一化）。只要非空即表示这条消息 @ 了人。 */
  mentions?: unknown[]
}

export function isFeishuMessageEvent(v: unknown): v is FeishuMessageEvent {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { type?: unknown }).type === 'im.message.receive_v1' &&
    typeof (v as { message_id?: unknown }).message_id === 'string'
  )
}
