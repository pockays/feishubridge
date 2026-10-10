import { runCli } from './lark/cli.js'
import { logger } from './logger.js'
import { findWikiNode, searchWiki } from './wiki.js'

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
  {
    name: 'lark_wiki_search',
    description:
      '在公司知识库（飞书 Wiki）里按标题关键词检索文档/表格。这是回答"X 的文档在哪""某功能的配置表叫什么"这类问题的首选工具。飞书自带的搜索接口在机器人身份下搜不到未共享给它的文档，本工具改为检索桥自己维护的知识库索引，因此能覆盖 QA 知识库等内部空间。返回标题、所在路径、类型、node_token、obj_token 与链接；命中后用 lark_wiki_read 读正文、用 lark_read_sheet 读表格。',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '关键词，可多个（空格分隔），例如 "GVG 活动" / "掉落概率"',
        },
        limit: { type: 'number', description: '最多返回多少条，默认 20' },
      },
      required: ['query'],
    },
    run: async (input) => {
      const limit = numOpt(input, 'limit') ?? 20
      const result = searchWiki(str(input, 'query'), limit)
      if (result.status === 'disabled') {
        return { error: '知识库索引未启用（WIKI_ROOT_TOKENS 为空），请改用 lark_search_docs' }
      }
      if (result.status === 'building' || result.status === 'empty') {
        return {
          status: 'building',
          note: '知识库索引正在后台构建（首次启动或刚重建，通常 1~3 分钟），稍后再问一次即可。',
        }
      }
      return result
    },
  },
  {
    name: 'lark_wiki_read',
    description:
      '读取一篇知识库文档的正文。参数用 lark_wiki_search 返回的 node_token 或 obj_token。docx 返回正文文本；表格返回第一张工作表的 A1:Z60 区域和全部工作表名（需要看别的区域或工作表时改用 lark_read_sheet）。',
    input_schema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'lark_wiki_search 结果里的 node_token 或 obj_token' },
      },
      required: ['token'],
    },
    run: async (input) => {
      const token = str(input, 'token')
      const node = findWikiNode(token)
      const objToken = node?.objToken ?? token
      const objType = node?.objType ?? 'unknown'
      const meta = {
        title: node?.title ?? null,
        path: node?.path ?? null,
        type: objType,
      }

      if (objType === 'sheet') {
        const info = await runCli(['sheets', '+workbook-info', '--as', 'bot', '--spreadsheet-token', objToken])
        const sheets =
          (info.data as { data?: { sheets?: Array<{ sheet_name?: string }> } } | null)?.data?.sheets ?? []
        const names = sheets.map((s) => s.sheet_name).filter((v): v is string => Boolean(v))
        if (names.length === 0) return { ...meta, error: '读取工作表信息失败', raw: info.stderr || info.raw }

        const cells = await runCli([
          'sheets',
          '+cells-get',
          '--as',
          'bot',
          '--spreadsheet-token',
          objToken,
          '--sheet-name',
          names[0],
          '--range',
          'A1:Z60',
          '--include',
          'value',
          '--jq',
          '.data.ranges[0].cells | map(map(.value // ""))',
        ])
        return {
          ...meta,
          sheet_names: names,
          preview_sheet: names[0],
          values: cells.ok ? cells.data : { error: cells.stderr || cells.raw },
        }
      }

      if (objType === 'docx' || objType === 'doc') {
        const r = await runCli(['docs', '+fetch', '--as', 'bot', '--doc', objToken], 60_000)
        const content = (r.data as { data?: { document?: { content?: string } } } | null)?.data?.document
          ?.content
        if (typeof content !== 'string') {
          return { ...meta, error: '读取文档失败', raw: r.stderr || r.raw }
        }
        return {
          ...meta,
          chars: content.length,
          truncated: content.length > 8000,
          content: content.slice(0, 8000),
        }
      }

      return {
        ...meta,
        note: '该类型暂不支持直接读正文；可以把链接发给用户，或对 wiki 里的表格改调 lark_wiki_read 之外的方式。',
      }
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
