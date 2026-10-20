import { z } from 'zod'
import { config as loadDotenv } from 'dotenv'

loadDotenv()

const Env = z.object({
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  ANTHROPIC_AUTH_TOKEN: z.string().min(1, 'ANTHROPIC_AUTH_TOKEN is required'),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-4-6'),

  LARK_EVENT_KEY: z.string().min(1).default('im.message.receive_v1'),
  LARK_EVENT_AS: z.enum(['bot', 'user', 'auto']).default('bot'),

  MAX_INPUT_CHARS: z.coerce.number().int().positive().default(4000),
  MAX_HISTORY_TURNS: z.coerce.number().int().positive().default(12),
  MAX_TOKENS_REPLY: z.coerce.number().int().positive().default(1024),

  /**
   * 一轮对话里最多允许模型调用几轮工具。
   * 最后一轮会**不带工具**发出去，逼模型拿已有信息给结论 —— 否则它会一直查到
   * 上限然后回一句 "(reached tool-use iteration cap)"，用户什么也拿不到。
   */
  MAX_TOOL_ITERATIONS: z.coerce.number().int().min(2).max(20).default(8),

  STORE_PATH: z.string().min(1).default('data/bridge.sqlite'),
  SEEN_EVENT_TTL_DAYS: z.coerce.number().int().positive().default(7),

  /**
   * Group-chat policy:
   *   - 'mention': only react when content starts with '@'  (default; matches
   *     Feishu's normal "bot @-mentioned" delivery semantics where lark-cli
   *     pre-renders the @-prefix into the content string).
   *   - 'all'    : react to every message in any group the bot is in.
   *   - 'off'    : ignore group messages entirely.
   * P2P (private) messages always go through regardless of this setting.
   */
  GROUP_TRIGGER: z.enum(['mention', 'all', 'off']).default('mention'),

  /**
   * 回复的呈现形式：
   *   - 'reply'  : 引用式回复，挂在用户那条消息下面（默认）
   *   - 'thread' : 话题回复，折叠成「N 条回复」入口
   *   - 'send'   : 独立消息，直接出现在主消息流里
   *   - 'auto'   : 私聊不 @ → 普通消息；私聊 @ → 引用回复；
   *                群聊 @ → 话题；已在话题内 → 回到同一话题（覆盖以上）
   */
  RESPONSE_MODE: z.enum(['send', 'reply', 'thread', 'auto']).default('reply'),

  /** Optional bot display-name prefix to strip from group content before sending to LLM. */
  BOT_AT_PREFIX: z.string().default(''),

  /**
   * Enable the LLM tool-use loop. Requires a model that supports the
   * Anthropic tools API (Claude on api.anthropic.com always; ARK and other
   * compatibility proxies vary — verify before enabling).
   */
  ENABLE_TOOLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /**
   * Backend strategy:
   *   - 'anthropic-sdk' (default): one HTTP call per message via the Anthropic
   *     SDK. Cheap, fast, but only as capable as the underlying model.
   *   - 'claude-code'  : spawn a headless Claude Code CLI per message. Gives
   *     you the full agentic loop (Bash/Read/Write/Edit/Grep, multi-step
   *     planning, MCP, hooks if --bare is off). Higher latency and cost.
   *     The CLI uses the same ANTHROPIC_* env, so it routes to your provider.
   */
  BACKEND: z.enum(['anthropic-sdk', 'claude-code']).default('anthropic-sdk'),

  /**
   * For BACKEND=claude-code: working directory for spawned Claude Code
   * sessions. Treated as a sandbox — Claude Code can read/write inside it,
   * --add-dir is NOT used so it cannot escape upward.
   */
  CLAUDE_CODE_SANDBOX: z.string().min(1).default('/home/leo/lark-bot-sandbox'),

  /** Per-message timeout for the claude-code subprocess (seconds). */
  CLAUDE_CODE_TIMEOUT_SEC: z.coerce.number().int().positive().default(180),

  /**
   * Extra args appended to `claude -p ...` (space-separated). Useful for
   * --allowedTools, --append-system-prompt, etc.
   */
  CLAUDE_CODE_EXTRA_ARGS: z.string().default(''),

  /**
   * Comma-separated allow-list of `open_id` values that may talk to the
   * bot. Empty (default) = no allow-list, anyone the bot can see is
   * allowed. P2P scope on the Feishu side already restricts who can DM
   * the bot, but groups containing the bot are also reachable — this
   * env adds a per-user gate on top.
   */
  ALLOWED_USERS: z.string().default(''),

  /**
   * Comma-separated allow-list of `chat_id` values. Same semantics as
   * `ALLOWED_USERS` but for the chat (group / P2P chat_id). Combined as
   * AND with ALLOWED_USERS — if both are set, the message must pass
   * both gates.
   */
  ALLOWED_CHATS: z.string().default(''),

  /**
   * Per-user rate limit: token-bucket capacity over a 60 s window. The
   * bucket refills smoothly (capacity / 60 tokens per second), so a
   * burst of N messages within a few seconds is fine if the user has
   * been idle; sustained traffic is capped at `capacity` per minute.
   * Set to 0 to disable rate limiting (not recommended).
   */
  RATE_PER_USER_PER_MIN: z.coerce.number().int().nonnegative().default(6),

  /**
   * Send an immediate "⏳ 思考中…" placeholder to Feishu while Claude Code
   * is running, then recall it after the real reply lands. Improves UX for
   * the multi-second latency without needing interactive cards. Only
   * affects BACKEND=claude-code, and ONLY when STREAMING_CARD=false.
   */
  SHOW_THINKING_PLACEHOLDER: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /**
   * Use an interactive card as the reply surface, and PATCH it as the
   * Claude Code agent loop streams tool-use / text events — the user
   * sees the card visibly update (state header, growing tool log, body
   * text) instead of a "..." placeholder swapped for one final message.
   * Falls back to the legacy text path on send failure. Only affects
   * BACKEND=claude-code.
   */
  STREAMING_CARD: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /**
   * Card PATCH throttle in ms. Lower = snappier UI but more API calls.
   * Feishu's rate limit on message-patch is generous; 1200 ms keeps us
   * well under it and is below human flicker-detection threshold.
   */
  STREAMING_CARD_MIN_INTERVAL_MS: z.coerce.number().int().positive().default(1200),

  /**
   * Emoji reaction added to the user's message the moment we accept it
   * for processing — visible ack before the much longer LLM round-trip.
   * Use Feishu's emoji_type enum (OK, THUMBSUP, HEART, FINGERHEART, …).
   * Set to empty string to disable.
   */
  ACK_EMOJI: z.string().default('OK'),

  /**
   * Subscribe to `card.action.trigger` events (interactive-card button
   * callbacks) in addition to message events. Requires "callback config"
   * to be enabled in the Feishu Developer Console for this app. When
   * disabled (default), the regenerate button on cards will silently
   * no-op when clicked.
   */
  ENABLE_CARD_CALLBACK: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /**
   * Expose a Prometheus `/metrics` endpoint on this port. Set to `0` to
   * disable (the bridge binds nothing). Bound to `127.0.0.1` only; put
   * a reverse proxy in front if you need external scraping.
   */
  METRICS_PORT: z.coerce.number().int().nonnegative().default(9090),

  /**
   * 用户身份令牌（user_access_token）文件。由 scripts/user-token-login.mjs
   * 一次性生成，桥负责用里面的 refresh_token 自动续期。
   *
   * 存在时，所有读取类工具会以**用户身份**调用 lark-cli —— 这才是"飞书搜索栏"
   * 的可见范围；不存在则降级回机器人身份（只能看到共享给应用的资源）。
   */
  USER_TOKEN_PATH: z.string().min(1).default('data/user-token.json'),

  /** lark-cli 的配置文件位置，用来借它的 appId/appSecret 做令牌续期。 */
  LARK_CLI_CONFIG_PATH: z.string().min(1).default('/root/.lark-cli/config.json'),

  /** 飞书开放平台域名（续期请求用）。 */
  LARK_OPEN_API: z.string().url().default('https://open.feishu.cn'),

  /** 可选：直接给应用凭据，省掉读 lark-cli 配置这一步。 */
  LARK_APP_ID: z.string().default(''),
  LARK_APP_SECRET: z.string().default(''),

  /**
   * 拼文档链接用的域名（租户域名）。实测知识库里的表格必须用
   * `<host>/wiki/<node_token>` 这种形式，`<host>/sheets/<token>` 会 404。
   */
  LARK_DOC_HOST: z.string().min(1).default('https://thedream.feishu.cn'),

  /**
   * 同时最多允许几个 lark-cli 子进程。飞书云空间接口的频控是 5 QPS，而模型
   * 一轮里可能发多个工具调用、每个工具内部又自己并发，所以这里设一个**全局**
   * 闸门，避免瞬时打爆被回 99991400（实测并发 12 时会触发，退避重试虽然能兜住
   * 但要白等 1 秒多）。顺带约束内存：每个子进程约 30~50MB，容器上限 384MB。
   */
  LARK_CLI_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),

  /**
   * 消息撤回事件。订阅后，用户撤回消息会取消正在跑的那一轮并且不回复。
   * 注意：这需要在开发者后台「事件与回调」里订阅 `im.message.recalled_v1`
   * 并**发版**才收得到；没订阅时桥会探测到并打印警告，不会反复重启消费者。
   */
  LARK_RECALL_EVENT_KEY: z.string().default('im.message.recalled_v1'),
  ENABLE_RECALL_CANCEL: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /** 用卡片（CardKit）代替纯文本回复：封面图 + 扫光状态 + 工具列表 + 统计 + 停止按钮。 */
  CARD_KIT: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /** 卡片顶部的封面图 image_key（先上传一次，长期复用）。留空则不显示封面。 */
  CARD_COVER_IMAGE_KEY: z.string().default(''),

  /** 扫光刷新间隔（毫秒）。卡片实体单元素更新实测 ~350ms，低于这个值没有意义。 */
  CARD_SHIMMER_INTERVAL_MS: z.coerce.number().int().min(150).default(340),

  /** 统计行里的 ctx 占用需要模型上下文窗口大小。 */
  MODEL_CONTEXT_TOKENS: z.coerce.number().int().positive().default(128000),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
})

const parsed = Env.safeParse(process.env)
if (!parsed.success) {
  // Don't use the logger here — logger depends on this config.
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors)
  process.exit(2)
}

export const config = parsed.data
export type Config = typeof config
