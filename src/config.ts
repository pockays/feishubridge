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
