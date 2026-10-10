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
 * Identity note: every tool runs `--as bot`. The server deployment only has
 * app credentials (app_id / app_secret) and no user OAuth session, so tools
 * pinned to `--as user` would fail there. Keep new tools on bot identity.
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
      const argv = ['im', '+messages-search', '--as', 'bot', '--query', str(input, 'query')]
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
      const argv = ['im', '+chat-messages-list', '--as', 'bot']
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
      const r = await runCli(['docs', '+fetch', '--as', 'bot', '--doc', str(input, 'document')])
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
        'bot',
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
      'Search Feishu documents, wiki nodes and spreadsheets by keyword. Returns a compact list of matches (title, type, url, token, snippet). Use this first when the user asks "where is X documented" or wants to find a config table by name/id. Note: only documents shared with this bot are searchable.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keyword: a topic, an item name, or a config id (max 30 chars)',
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
      const argv = [
        'drive',
        '+search',
        '--as',
        'bot',
        '--query',
        str(input, 'query'),
        '--jq',
        '.data.results | map({title: .title_highlighted, type: .result_meta.doc_types, url: .result_meta.url, token: .result_meta.token, snippet: .summary_highlighted})',
      ]
      const types = strOpt(input, 'doc_types')
      if (types) argv.push('--doc-types', types)
      const r = await runCli(argv)
      return r.ok ? r.data : { error: r.stderr || r.raw, exit: r.exitCode }
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
        'bot',
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
