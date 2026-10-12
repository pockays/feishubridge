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
    properties: Record<
      string,
      { type: string; description: string; items?: { type: string }; enum?: string[] }
    >
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

function strArray(input: Record<string, unknown>, key: string): string[] {
  const v = input[key]
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new Error(`tool input '${key}' must be an array of strings`)
  }
  return v as string[]
}

/**
 * 通用入口的边界。
 *
 * 为什么不是"每条命令一个工具"：有权限的域里光 shortcut 就有 300 条左右，逐条
 * 定义会让每次请求多背 ~1.8 万 token 的工具说明，既贵又会让模型选错工具。
 *
 * 这里的策略：
 *   1. 域白名单 —— 只放我们确实拿到 scope 的域（base/docs/drive/im/
 *      markdown/sheets/whiteboard/wiki）。日历、任务、邮箱等没授权，直接拒绝。
 *   2. 风险门禁 —— 读命令（Risk: read）和普通写命令放行；`high-risk-write`
 *      （删页签/清空单元格/删文件/撤回消息这类不可逆操作）一律拒绝，需要人工
 *      确认后再单独处理。`--yes` 永远透传不出去。
 *   3. 身份由 identity 参数决定，argv 里的 --as 会被剥掉，避免模型自己乱切。
 */
const ALLOWED_CLI_DOMAINS = new Set([
  'base',
  'docs',
  'drive',
  'im',
  'markdown',
  'sheets',
  'whiteboard',
  'wiki',
])

type RiskLevel = 'read' | 'write' | 'high-risk-write' | 'unknown'
const riskCache = new Map<string, RiskLevel>()

async function commandRisk(domain: string, sub: string): Promise<RiskLevel> {
  const key = `${domain} ${sub}`
  const cached = riskCache.get(key)
  if (cached) return cached
  const r = await runCli([domain, sub, '--help'], 20_000)
  const m = /Risk:\s*(read|write|high-risk-write)/.exec(`${r.raw}\n${r.stderr}`)
  const risk: RiskLevel = m ? (m[1] as RiskLevel) : 'unknown'
  riskCache.set(key, risk)
  return risk
}

interface SheetTab {
  name: string
  id: string
  rows: number
  cols: number
  hidden: boolean
}

/** 列出工作簿的所有页签（名称 / id / 行列数 / 是否隐藏）。 */
async function sheetDimensions(spreadsheet: string): Promise<SheetTab[]> {
  const r = await runCli([
    'sheets',
    '+workbook-info',
    '--as',
    'user',
    ...(spreadsheet.startsWith('http')
      ? ['--url', spreadsheet]
      : ['--spreadsheet-token', spreadsheet]),
    '--jq',
    '.data.sheets | map({name: .sheet_name, id: .sheet_id, rows: .row_count, cols: .column_count, hidden: .is_hidden})',
  ])
  if (!r.ok || !Array.isArray(r.data)) return []
  return (r.data as Array<Partial<SheetTab>>)
    .filter((s) => typeof s.name === 'string' && s.name)
    .map((s) => ({
      name: s.name ?? '',
      id: s.id ?? '',
      rows: s.rows ?? 0,
      cols: s.cols ?? 0,
      hidden: s.hidden === true,
    }))
}

/** 1 → A, 27 → AA（读整页时用来算末列）。 */
function columnLetter(n: number): string {
  let out = ''
  let x = Math.max(1, Math.floor(n))
  while (x > 0) {
    const rem = (x - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    x = Math.floor((x - 1) / 26)
  }
  return out
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
      'Read cell values from one tab of a Feishu spreadsheet. Give the spreadsheet URL (or token) plus the tab (sheet_name, or sheet_id from lark_sheet_info) and an A1 range; omit the range to read the tab\'s whole used area (capped at 200 rows). IMPORTANT: config/ID workbooks often have dozens of tabs and thousands of rows — call lark_sheet_info first for the tab list, and prefer lark_search_in_sheet when hunting for one specific row/ID instead of reading everything.',
    input_schema: {
      type: 'object',
      properties: {
        spreadsheet: { type: 'string', description: 'Spreadsheet URL or token' },
        sheet_name: { type: 'string', description: 'Sheet (tab) name, e.g. 活动' },
        sheet_id: {
          type: 'string',
          description: 'Sheet id from lark_sheet_info — use instead of sheet_name when that is easier',
        },
        range: {
          type: 'string',
          description: 'A1 range without sheet prefix, e.g. A1:G30 or B10:U20. Omit to read the whole used area.',
        },
        max_rows: { type: 'number', description: 'Row cap used when range is omitted (default 200)' },
      },
      required: ['spreadsheet'],
    },
    run: async (input) => {
      const target = str(input, 'spreadsheet')
      const sheetName = strOpt(input, 'sheet_name')
      const sheetId = strOpt(input, 'sheet_id')
      let range = strOpt(input, 'range')

      if (!sheetName && !sheetId) {
        const tabs = await sheetDimensions(target)
        return {
          error: '需要 sheet_name 或 sheet_id：先看下面的 tabs，或改用 lark_search_in_sheet 定位具体单元格',
          tabs: tabs.map((s) => ({ name: s.name, id: s.id, rows: s.rows, cols: s.cols })),
        }
      }

      if (!range) {
        const tabs = await sheetDimensions(target)
        const tab = tabs.find((s) => s.name === sheetName || s.id === sheetId)
        const rows = Math.max(1, Math.min(numOpt(input, 'max_rows') ?? 200, tab?.rows ?? 200))
        const cols = Math.max(1, Math.min(30, tab?.cols ?? 20))
        range = `A1:${columnLetter(cols)}${rows}`
      }

      const argv = [
        'sheets',
        '+cells-get',
        '--as',
        'user',
        ...(target.startsWith('http') ? ['--url', target] : ['--spreadsheet-token', target]),
        ...(sheetId ? ['--sheet-id', sheetId] : ['--sheet-name', sheetName ?? '']),
        '--range',
        range,
        '--include',
        'value',
        '--jq',
        '.data.ranges[0].cells | map(map(.value // ""))',
      ]
      const r = await runCli(argv)
      return r.ok ? { range, values: r.data } : { error: r.stderr || r.raw, exit: r.exitCode }
    },
  },
  {
    name: 'lark_sheet_info',
    description:
      'List every tab of a Feishu spreadsheet (name, sheet_id, row/column count, hidden flag). ALWAYS call this before reading a workbook you do not know: ID/config workbooks routinely have 30+ tabs (道具/装备/活动/副本…), and guessing one tab is exactly how an answer ends up incomplete.',
    input_schema: {
      type: 'object',
      properties: {
        spreadsheet: { type: 'string', description: 'Spreadsheet URL or token' },
      },
      required: ['spreadsheet'],
    },
    run: async (input) => {
      const tabs = await sheetDimensions(str(input, 'spreadsheet'))
      if (tabs.length === 0) return { error: '读不到工作表信息（token 不对，或没有权限）' }
      return {
        tab_count: tabs.length,
        tabs: tabs.map((s) => ({
          name: s.name,
          id: s.id,
          rows: s.rows,
          cols: s.cols,
          ...(s.hidden ? { hidden: true } : {}),
        })),
      }
    },
  },
  {
    name: 'lark_search_in_sheet',
    description:
      'Find a value inside a Feishu spreadsheet and return its cell address (e.g. B15 in tab 活动). This is the tool for "这个 ID / 活动 / 道具在哪张表" — the document search only indexes titles, so a row like 公会KVM[公][限] is invisible to it. Pass sheet_name to scan one tab, or omit it to scan every visible tab of the workbook.',
    input_schema: {
      type: 'object',
      properties: {
        spreadsheet: { type: 'string', description: 'Spreadsheet URL or token' },
        find: { type: 'string', description: 'Text to look for (whole or partial cell content)' },
        sheet_name: { type: 'string', description: 'Optional: restrict the scan to one tab' },
        match_case: { type: 'boolean', description: 'Case-sensitive match (default false)' },
      },
      required: ['spreadsheet', 'find'],
    },
    run: async (input) => {
      const target = str(input, 'spreadsheet')
      const find = str(input, 'find')
      const wantSheet = strOpt(input, 'sheet_name')
      const matchCase = input.match_case === true
      const targetArg = target.startsWith('http')
        ? ['--url', target]
        : ['--spreadsheet-token', target]

      const searchTab = async (sheetName: string) => {
        const r = await runCli([
          'sheets',
          '+cells-search',
          '--as',
          'user',
          ...targetArg,
          '--sheet-name',
          sheetName,
          '--find',
          find,
          ...(matchCase ? ['--match-case'] : []),
          '--jq',
          '.data.matches | map({address: .address, value: .value})',
        ])
        if (!r.ok || !Array.isArray(r.data)) return []
        return (r.data as Array<{ address: string; value: string }>).map((m) => ({
          sheet: sheetName,
          address: m.address,
          value: m.value,
        }))
      }

      if (wantSheet) {
        const matches = await searchTab(wantSheet)
        return { find, scanned_tabs: [wantSheet], match_count: matches.length, matches }
      }

      const tabs = (await sheetDimensions(target)).filter((s) => !s.hidden).slice(0, 40)
      if (tabs.length === 0) return { error: '读不到工作表列表' }

      const matches: Array<{ sheet: string; address: string; value: string }> = []
      const CHUNK = 4
      for (let i = 0; i < tabs.length && matches.length < 50; i += CHUNK) {
        const batch = tabs.slice(i, i + CHUNK)
        const results = await Promise.all(batch.map((t) => searchTab(t.name)))
        for (const group of results) matches.push(...group)
      }

      return {
        find,
        scanned_tab_count: tabs.length,
        match_count: matches.length,
        matches: matches.slice(0, 50),
      }
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
    name: 'lark_cli',
    description:
      'Run ANY authorised Feishu CLI command — use this whenever the task needs a capability the purpose-built tools above do not cover (multi-dimensional tables/Bitable records, uploading files to Drive, writing cells, creating docs, chat administration, whiteboards, …). Pass argv as an array of strings WITHOUT the leading "lark-cli", e.g. ["base","+record-search","--base-token","<t>","--table-id","<id>","--keyword","Alice"] or ["drive","+upload","--file","/tmp/a.png","--folder-token","<t>"]. Discover what exists with ["<domain>","--help"] and inspect flags with ["<domain>","<command>","--help"]. Do NOT pass --as (choose `identity` instead) and do NOT pass --yes. Commands that are irreversible (delete/clear/recall/remove) are rejected by the bridge and must be done by a human.',
    input_schema: {
      type: 'object',
      properties: {
        argv: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Full command after "lark-cli", e.g. ["wiki","+node-list","--space-id","123","--parent-node-token","abc"]',
        },
        identity: {
          type: 'string',
          enum: ['user', 'bot'],
          description:
            'Which identity to call with: user (the operator\'s own permissions, default) or bot (the app itself, needed for things like sending messages).',
        },
      },
      required: ['argv'],
    },
    run: async (input) => {
      const raw = strArray(input, 'argv')
      const identity = strOpt(input, 'identity') === 'bot' ? 'bot' : 'user'

      // 剥掉 --as（身份由 identity 参数决定）和 --yes（高危操作不能自助确认）
      const cleaned: string[] = []
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] === '--as') {
          i += 1
          continue
        }
        if (raw[i] === '--yes') continue
        cleaned.push(raw[i])
      }

      const domain = cleaned[0]
      const sub = cleaned[1]
      if (!domain || domain.startsWith('-')) {
        return { error: 'argv 至少要包含域名，例如 ["sheets","--help"]' }
      }
      if (!ALLOWED_CLI_DOMAINS.has(domain)) {
        return {
          error: `域 "${domain}" 不在允许列表里（该域需要额外授权）`,
          allowed_domains: [...ALLOWED_CLI_DOMAINS],
        }
      }

      // 只有域名或带了 --help → 当作查看帮助，直接放行
      const wantsHelp = cleaned.includes('--help') || cleaned.includes('-h')
      if (!sub || sub.startsWith('-') || wantsHelp) {
        const r = await runCli(cleaned, 30_000)
        return r.ok ? { result: r.raw.slice(0, 6000) } : { error: r.stderr || r.raw }
      }

      const risk = await commandRisk(domain, sub)
      if (risk === 'high-risk-write') {
        return {
          error: `"${domain} ${sub}" 是不可逆的高危操作，桥已拒绝执行`,
          hint: '把这一步交给人来做；如果确实要自动化，告诉我，我单独放开。',
        }
      }
      if (risk === 'unknown') {
        return {
          error: `无法确认 "${domain} ${sub}" 的风险等级，已拒绝`,
          hint: '先看 ["' + domain + '","--help"] 确认命令名是否正确。',
        }
      }

      const r = await runCli([...cleaned, '--as', identity], 60_000)
      return r.ok
        ? r.data
        : { error: r.stderr || r.raw, exit: r.exitCode, risk, identity }
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
