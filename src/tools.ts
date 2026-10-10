import { runCli } from './lark/cli.js'
import { logger } from './logger.js'

/**
 * Tool definitions exposed to the LLM. Each tool is a small, audited wrapper
 * around a single lark-cli subcommand. We deliberately do NOT auto-expose the
 * full CLI surface — that would let the LLM call things like `auth logout`,
 * `config remove`, or send broadcast messages with no human consent.
 *
 * The whitelist below covers the high-value read paths plus one carefully
 * scoped write path (`lark_send_text`) that requires an already-known
 * `chat_id` — the LLM cannot enumerate chats to discover targets.
 *
 * Identity note: read tools run `--as user` so they see exactly what the
 * operator sees in Feishu (this is what makes search behave like Feishu's own
 * search bar — the app identity only ever sees resources shared with the app).
 * The bridge injects a user_access_token per call; when no token is configured
 * `runCli` transparently downgrades the call to `--as bot`. Write paths
 * (`lark_send_text`) always stay on the bot identity — the reply must come
 * from the bot, not from the operator's account.
 */

export interface ToolDef {
  name: string
  description: string
  /** JSON Schema for input_schema, per Anthropic tool-use spec. */
  input_schema: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required?: string[]
  }
  /** Map input args to lark-cli argv. */
  run: (input: Record<string, unknown>) => Promise<unknown>
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key]
  if (typeof v !== 'string') throw new Error(`tool input '${key}' must be a string`)
  return v
}

function strOpt(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw new Error(`tool input '${key}' must be a string`)
  return v
}

function numOpt(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number') throw new Error(`tool input '${key}' must be a number`)
  return v
}

export const TOOLS: ToolDef[] = [
  {
    name: 'lark_search_messages',
    description:
      'Search recent messages across all chats the bot can see. Returns matching message snippets with chat_id, sender, and message_id. User identity recommended for better recall.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword to search for' },
        limit: { type: 'number', description: 'Max results to return (1-50)' },
      },
      required: ['query'],
    },
    run: async (input) => {
      const argv = ['im', '+messages-search', '--as', 'user', '--query', str(input, 'query')]
      const limit = numOpt(input, 'limit')
      if (limit !== undefined) argv.push('--page-size', String(Math.min(50, Math.max(1, limit))))
      const r = await runCli(argv)
      return r.ok ? r.data : { error: r.stderr || r.raw, exit: r.exitCode }
    },
  },
  {
    name: 'lark_chat_messages_list',
    description:
      'List recent messages in a specific chat. Useful for catching up on a conversation. Provide chat_id (oc_...) OR user_id (ou_...) for a P2P thread.',
    input_schema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat ID (oc_...)' },
        user_id: { type: 'string', description: 'User open_id (ou_...) for a 1:1 thread' },
        limit: { type: 'number', description: 'Max messages (1-50)' },
      },
    },
    run: async (input) => {
      const chatId = strOpt(input, 'chat_id')
      const userId = strOpt(input, 'user_id')
      if (!chatId && !userId) throw new Error('chat_id or user_id is required')
      const argv = ['im', '+chat-messages-list', '--as', 'user']
      if (chatId) argv.push('--chat-id', chatId)
      else if (userId) argv.push('--user-id', userId)
      const limit = numOpt(input, 'limit')
      if (limit !== undefined) argv.push('--page-size', String(Math.min(50, Math.max(1, limit))))
      const r = await runCli(argv)
      return r.ok ? r.data : { error: r.stderr || r.raw, exit: r.exitCode }
    },
  },
  {
    name: 'lark_doc_read',
    description:
      'Fetch the content of a Feishu docx document. Accepts a document URL or token (e.g. https://thedream.feishu.cn/docx/XXXX or the bare token). Use it when the user pastes a doc link or asks about a document found via lark_search_docs.',
    input_schema: {
      type: 'object',
      properties: {
        document: { type: 'string', description: 'Document URL or token' },
      },
      required: ['document'],
    },
    run: async (input) => {
      const r = await runCli(['docs', '+fetch', '--as', 'user', '--doc', str(input, 'document')])
      return r.ok ? r.data : { error: r.stderr || r.raw, exit: r.exitCode }
    },
  },
  {
    name: 'lark_base_records_search',
    description:
      'Search records in a Feishu Base (multi-dimensional table). Returns matching rows.',
    input_schema: {
      type: 'object',
      properties: {
        app_token: { type: 'string', description: 'Base app token (bascn...)' },
        table_id: { type: 'string', description: 'Table ID (tbl...)' },
        page_size: { type: 'number', description: 'Page size (1-100)' },
      },
      required: ['app_token', 'table_id'],
    },
    run: async (input) => {
      const argv = [
        'base',
        '+record-search',
        '--as',
        'user',
        '--app-token',
        str(input, 'app_token'),
        '--table-id',
        str(input, 'table_id'),
      ]
      const ps = numOpt(input, 'page_size')
      if (ps !== undefined) argv.push('--page-size', String(Math.min(100, Math.max(1, ps))))
      const r = await runCli(argv)
      return r.ok ? r.data : { error: r.stderr || r.raw, exit: r.exitCode }
    },
  },
  {
    name: 'lark_search_docs',
    description:
      'Search Feishu documents, wiki nodes and spreadsheets by keyword (runs with the operator\'s own permission scope, so results match what they can see in Feishu). Returns {total, returned, has_more, results[]}: `total` is the FULL number of matches — always quote it when the user asks "how many"; `results` is only the page you asked for (≤20 per page, and the tool pages through automatically when limit > 20, up to 5 pages). Each item has title, type, url, token, snippet. Use this first when the user asks "where is X documented" or wants to find a config table by name/id.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keyword: a topic, an item name, or a config id (max 30 chars)',
        },
        limit: {
          type: 'number',
          description:
            'How many results to return, up to 100 (default 15). `total` is unaffected by this — it is always the full match count.',
        },
        doc_types: {
          type: 'string',
          description:
            'Optional comma-separated filter: doc,docx,sheet,bitable,wiki,slides,mindnote,file',
        },
      },
      required: ['query'],
    },
    run: async (input) => {
      const limit = Math.max(1, Math.min(100, numOpt(input, 'limit') ?? 15))
      const pageSize = Math.min(20, limit)
      const maxPages = Math.max(1, Math.min(5, Math.ceil(limit / pageSize)))
      const types = strOpt(input, 'doc_types')

      // 接口一页最多 20 条且默认只给 15 条；这里自己翻页，并把 total 一并带回去
      // —— 少了 total，模型会把"第一页有 15 条"当成"一共 15 条"。
      const collected: unknown[] = []
      let total: number | null = null
      let hasMore = false
      let nextToken: string | undefined

      for (let page = 0; page < maxPages; page++) {
        const argv = [
          'drive',
          '+search',
          '--as',
          'user',
          '--query',
          str(input, 'query'),
          '--page-size',
          String(pageSize),
          '--jq',
          '.data | {total: .total, has_more: .has_more, page_token: .page_token, results: (.results | map({title: (.title_highlighted | gsub("<h>"; "") | gsub("</h>"; "")), type: .result_meta.doc_types, url: .result_meta.url, token: .result_meta.token, snippet: .summary_highlighted}))}',
        ]
        if (types) argv.push('--doc-types', types)
        if (nextToken) argv.push('--page-token', nextToken)

        const r = await runCli(argv)
        if (!r.ok) {
          return {
            error: r.stderr || r.raw,
            exit: r.exitCode,
            returned: collected.length,
            ...(total !== null ? { total } : {}),
          }
        }

        const page_ = r.data as {
          total?: number
          has_more?: boolean
          page_token?: string
          results?: unknown[]
        } | null
        if (typeof page_?.total === 'number') total = page_.total
        collected.push(...(page_?.results ?? []))
        hasMore = Boolean(page_?.has_more)
        nextToken = page_?.page_token
        if (!hasMore || !nextToken || collected.length >= limit) break
      }

      return {
        total,
        returned: collected.length,
        has_more: hasMore,
        next_page_token: hasMore ? (nextToken ?? null) : null,
        results: collected.slice(0, limit),
      }
    },
  },
  {
    name: 'lark_read_sheet',
    description:
      'Read cell values from a Feishu spreadsheet. Provide the spreadsheet URL (or token), the sheet (tab) name and an A1 range. Returns a compact 2-D array of values — ideal for reading config/drop-rate tables found via lark_search_docs.',
    input_schema: {
      type: 'object',
      properties: {
        spreadsheet: { type: 'string', description: 'Spreadsheet URL or token' },
        sheet_name: { type: 'string', description: 'Sheet (tab) name, e.g. 经济数值QA文档2' },
        range: { type: 'string', description: 'A1 range without sheet prefix, e.g. A1:G30' },
      },
      required: ['spreadsheet', 'sheet_name', 'range'],
    },
    run: async (input) => {
      const target = str(input, 'spreadsheet')
      const argv = [
        'sheets',
        '+cells-get',
        '--as',
        'user',
        ...(target.startsWith('http') ? ['--url', target] : ['--spreadsheet-token', target]),
        '--sheet-name',
        str(input, 'sheet_name'),
        '--range',
        str(input, 'range'),
        '--include',
        'value',
        '--jq',
        '.data.ranges[0].cells | map(map(.value // ""))',
      ]
      const r = await runCli(argv)
      return r.ok ? r.data : { error: r.stderr || r.raw, exit: r.exitCode }
    },
  },
  {
    name: 'lark_send_text',
    description:
      'Send a plain-text message to a specific chat_id or user_id (P2P). DO NOT use this to enumerate or broadcast — only send when the user explicitly asked you to.',
    input_schema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat ID (oc_...)' },
        user_id: { type: 'string', description: 'User open_id (ou_...)' },
        text: { type: 'string', description: 'Plain-text body' },
      },
      required: ['text'],
    },
    run: async (input) => {
      const chatId = strOpt(input, 'chat_id')
      const userId = strOpt(input, 'user_id')
      if (!chatId && !userId) throw new Error('chat_id or user_id is required')
      const argv = ['im', '+messages-send', '--as', 'bot', '--text', str(input, 'text')]
      if (chatId) argv.push('--chat-id', chatId)
      else if (userId) argv.push('--user-id', userId)
      const r = await runCli(argv)
      return r.ok ? r.data : { error: r.stderr || r.raw, exit: r.exitCode }
    },
  },
]

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]))

/** Format for Anthropic SDK — strip the runtime `run` method. */
export function anthropicTools(): Array<{
  name: string
  description: string
  input_schema: ToolDef['input_schema']
}> {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }))
}

export async function executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  const t = TOOL_MAP.get(name)
  if (!t) throw new Error(`unknown tool: ${name}`)
  logger.info({ tool: name, input }, 'executing tool')
  try {
    const out = await t.run(input)
    logger.debug({ tool: name }, 'tool ok')
    return out
  } catch (err) {
    const e = err as { message?: string }
    logger.error({ tool: name, err: e.message }, 'tool execution failed')
    return { error: e.message ?? String(err) }
  }
}
