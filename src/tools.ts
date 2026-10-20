import { runCli } from './lark/cli.js'
import { logger } from './logger.js'
import { config } from './config.js'

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
      { type: string; description: string; items?: Record<string, unknown>; enum?: string[] }
    >
    required?: string[]
  }
  /** Map input args to lark-cli argv. `ctx` 携带当前会话信息（chat_id 等）。 */
  run: (input: Record<string, unknown>, ctx?: ToolContext) => Promise<unknown>
}

/** 当前这一轮的上下文，由桥注入；工具可用它把"当前会话"作为默认值。 */
export interface ToolContext {
  chatId?: string
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

/**
 * 把一个文档 token 变成能直接在飞书里打开的链接。
 *
 * 实测坑：知识库里的文件必须用 `<host>/wiki/<node_token>`，写成
 * `<host>/sheets/<token>` 会打开"页面不存在"。而 wiki 节点接口能用同一个
 * token 反查出 node_token，所以先问它；反查不到（不是知识库里的文件）就退
 * 回按类型拼路径。
 */
async function resolveDocUrl(token: string, kind?: string): Promise<string | null> {
  const host = config.LARK_DOC_HOST.replace(/\/$/, '')
  if (/^https?:\/\//i.test(token)) return token

  // 每次读都要反查一次的话，一次会话能白白多花好几秒（每次调用约 0.9s）；
  // 同一个 token 的链接是稳定的，缓存住。
  const cached = urlCache.get(token)
  if (cached !== undefined) return cached

  const r = await runCli(['wiki', '+node-get', '--as', 'user', '--node-token', token, '--jq', '.data.node_token'])
  const nodeToken = typeof r.data === 'string' ? r.data.trim() : ''
  if (r.ok && nodeToken) {
    const url = `${host}/wiki/${nodeToken}`
    urlCache.set(token, url)
    return url
  }

  switch (kind) {
    case 'SHEET':
    case 'sheet':
      urlCache.set(token, `${host}/sheets/${token}`)
      return `${host}/sheets/${token}`
    case 'BITABLE':
    case 'bitable':
      urlCache.set(token, `${host}/base/${token}`)
      return `${host}/base/${token}`
    case 'DOCX':
    case 'docx':
      urlCache.set(token, `${host}/docx/${token}`)
      return `${host}/docx/${token}`
    default:
      urlCache.set(token, null)
      return null
  }
}

const urlCache = new Map<string, string | null>()

/** 列出工作簿的所有页签（名称 / id / 行列数 / 是否隐藏）。 */
async function sheetDimensions(spreadsheet: string): Promise<SheetTab[]> {
  // 页签结构变化很慢，但每次调用都要花约 0.9s（一次 lark-cli），
  // 一次会话里往往要读好几次，缓存住。
  const cached = tabCache.get(spreadsheet)
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.tabs

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
  const tabs = (r.data as Array<Partial<SheetTab>>)
    .filter((s) => typeof s.name === 'string' && s.name)
    .map((s) => ({
      name: s.name ?? '',
      id: s.id ?? '',
      rows: s.rows ?? 0,
      cols: s.cols ?? 0,
      hidden: s.hidden === true,
    }))
  tabCache.set(spreadsheet, { at: Date.now(), tabs })
  return tabs
}

const tabCache = new Map<string, { at: number; tabs: SheetTab[] }>()

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
    run: async (input, ctx) => {
      const chatId = strOpt(input, 'chat_id') ?? ctx?.chatId
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
      const id = str(input, 'document')
      const r = await runCli(['docs', '+fetch', '--as', 'user', '--doc', id])
      const url = await resolveDocUrl(id, 'docx')
      return r.ok
        ? { ...(url ? { url } : {}), document: r.data }
        : { error: r.stderr || r.raw, exit: r.exitCode }
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
      'Search the WHOLE drive (documents, wiki nodes, spreadsheets) by keyword — runs with the operator\'s own permission scope. Returns {scope, total, returned, has_more, results[]}: `total` counts DOCUMENTS (one row per file whose title/snippet matched) — it is NOT a cell count; always quote it when the user asks "how many", and say that it is a document count. `results` is only the page you asked for (≤20/page, auto-paged up to 5 pages when limit > 20). Each item has title, type, url, token, snippet — include the `url` in your answer whenever you mention that file. Use this first when the user asks "where is X documented" or wants to find a config table by name/id.',
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
        scope: 'documents (whole drive: title/snippet match, one row per document)',
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
      const url = await resolveDocUrl(target, 'sheet')
      return r.ok
        ? { ...(url ? { url } : {}), range, values: r.data }
        : { error: r.stderr || r.raw, exit: r.exitCode }
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
      const target = str(input, 'spreadsheet')
      const tabs = await sheetDimensions(target)
      if (tabs.length === 0) return { error: '读不到工作表信息（token 不对，或没有权限）' }
      const url = await resolveDocUrl(target, 'sheet')
      return {
        ...(url ? { url } : {}),
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
      'Find a value inside ONE Feishu spreadsheet and return its cell address (e.g. B15 in tab 活动). Its `match_count` counts CELLS in that single workbook — never present it as a whole-drive count, and remember the same document often has several copies (…副本 / 原版 / 第三份), each of which must be scanned separately. This is the tool for "这个 ID / 活动 / 道具在哪张表" — the document search only indexes titles, so a row like 公会KVM[公][限] is invisible to it. IMPORTANT: pass sheet_name whenever you can guess the tab (道具/活动/装备… — get the list from lark_sheet_info); one tab takes ~1s while a 38-tab workbook takes ~20s. Omit sheet_name only when you really have no idea where to look.',
    input_schema: {
      type: 'object',
      properties: {
        spreadsheet: { type: 'string', description: 'Spreadsheet URL or token' },
        find: { type: 'string', description: 'Text to look for (whole or partial cell content)' },
        sheet_name: {
          type: 'string',
          description:
            'Restrict the scan to one tab — strongly preferred when you can guess it (≈20x faster than scanning the whole workbook).',
        },
        match_case: { type: 'boolean', description: 'Case-sensitive match (default false)' },
        max_matches: {
          type: 'number',
          description:
            'Stop scanning once this many matches are found (default 10, max 50). Scanning every tab of a big workbook costs ~1s per tab, so keep this small unless you truly need exhaustiveness.',
        },
        scan_all: {
          type: 'boolean',
          description:
            'Set true to scan EVERY visible tab regardless of how many matches appear (up to 100 returned). Use it when the user asks for 所有/全部/完整清单 —— the default early-stop can miss later tabs.',
        },
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
      const url = await resolveDocUrl(target, 'sheet')
      const withUrl = <T extends Record<string, unknown>>(body: T) =>
        url ? { ...body, url } : body

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
        return withUrl({ find, scanned_tabs: [wantSheet], match_count: matches.length, matches })
      }

      const tabs = (await sheetDimensions(target)).filter((s) => !s.hidden).slice(0, 40)
      if (tabs.length === 0) return { error: '读不到工作表列表' }

      // 整本扫描是 N 次 API 调用（每个页签一次，各约 1 秒），找到足够结果就停，
      // 不必把 30 多个页签全扫完 —— 实测这一条能把 11 秒压到 3~4 秒。
      // 但"找得到"和"找全"是两回事：用户明确要全部时，用 scan_all 扫完。
      const scanAll = input.scan_all === true
      const maxMatches = Math.max(1, Math.min(50, numOpt(input, 'max_matches') ?? 10))
      const stopAt = scanAll ? Number.MAX_SAFE_INTEGER : maxMatches
      // 返回上限跟"何时停止扫描"是两件事：已经扫出来的命中没理由藏起来
      // （扫描成本已经付了），所以返回上限放宽，max_matches 只用来决定何时停止扫描。
      const returnLimit = scanAll ? 100 : 60
      const matches: Array<{ sheet: string; address: string; value: string }> = []
      let scanned = 0
      const CHUNK = 6
      for (let i = 0; i < tabs.length && matches.length < stopAt; i += CHUNK) {
        const batch = tabs.slice(i, i + CHUNK)
        scanned += batch.length
        const results = await Promise.all(batch.map((t) => searchTab(t.name)))
        for (const group of results) matches.push(...group)
      }

      const stoppedEarly = scanned < tabs.length
      return withUrl({
        scope: 'cells (this ONE workbook only; one row per matching cell)',
        find,
        scanned_tab_count: scanned,
        total_tabs: tabs.length,
        stopped_early: stoppedEarly,
        ...(stoppedEarly
          ? {
              note: `扫了 ${scanned}/${tabs.length} 个页签就达到 ${maxMatches} 条上限（已命中 ${matches.length} 条，全部返回），后面还有页签没扫 —— 若用户要"全部/所有"，请带 scan_all=true 重扫一次。`,
            }
          : {}),
        match_count: matches.length,
        matches: matches.slice(0, returnLimit),
      })
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
  {
    name: 'lark_search_all',
    description:
      'ONE-SHOT MULTI-SOURCE SEARCH — the default entry point when the user says 搜索 / 查一下 / 有没有关于 X / X 在哪. It fans out to every source the operator can see and reports them separately: (1) documents + wiki nodes + spreadsheets by title/snippet (whole drive, `documents.total` = document count), (2) chat records (`messages.total` + samples with sender/time/chat), (3) the actual CELL contents of the most relevant spreadsheet(s) (`sheet_cells`). Never present one source\'s number as the overall total — quote each with its scope. Follow up with lark_read_sheet / lark_doc_read / lark_chat_messages_list to drill in.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword, e.g. 挂鱼 / KVM / 无限之境' },
        max_per_source: {
          type: 'number',
          description: 'How many hits to return per source (default 5, max 15). Counts are unaffected.',
        },
        scan_sheet_cells: {
          type: 'boolean',
          description:
            'Also scan cell contents of the most relevant spreadsheet(s). Default true. Each workbook scan costs ~10s, so keep max_sheets small.',
        },
        max_sheets: {
          type: 'number',
          description: 'How many candidate workbooks to scan cell-by-cell (default 1, max 3).',
        },
      },
      required: ['query'],
    },
    run: async (input) => {
      const query = str(input, 'query')
      const per = Math.max(1, Math.min(15, numOpt(input, 'max_per_source') ?? 5))
      const scanCells = input.scan_sheet_cells !== false
      const maxSheets = Math.max(1, Math.min(3, numOpt(input, 'max_sheets') ?? 1))

      // ① 文档 / 知识库 / 表格（标题与片段）+ ② 聊天记录，并行跑
      const [docRaw, msgRaw] = await Promise.all([
        executeTool('lark_search_docs', { query, limit: per }),
        executeTool('lark_search_messages', { query, limit: per }),
      ])

      const docRes = docRaw as {
        total?: number
        returned?: number
        results?: Array<{ title: string; type: string; url: string; token: string; snippet?: string }>
      } | null
      // 注意：lark_search_messages 返回的是 CLI 的原始信封 {ok, identity, data:{messages,…}}，
      // 消息数组在 data.data.messages（踩过：直接读 .messages 会永远得到 0 条）。
      const msgEnv = msgRaw as {
        messages?: Array<Record<string, unknown>>
        has_more?: boolean
        data?: { messages?: Array<Record<string, unknown>>; has_more?: boolean }
      } | null
      const msgList = msgEnv?.data?.messages ?? msgEnv?.messages ?? []
      const msgHasMore = msgEnv?.data?.has_more ?? msgEnv?.has_more ?? false

      const out: Record<string, unknown> = {
        query,
        documents: {
          scope: 'whole drive — title/snippet match, one row per document/wiki/sheet',
          total: docRes?.total ?? null,
          returned: docRes?.returned ?? (docRes?.results ?? []).length,
          top: (docRes?.results ?? []).slice(0, per),
        },
        messages: {
          scope: 'chat records the operator is part of',
          count: msgList.length,
          has_more: msgHasMore,
          samples: msgList.slice(0, per).map((m) => ({
            chat: m.chat_name ?? m.chat_id,
            from: (m.sender as { name?: string } | undefined)?.name,
            time: m.create_time,
            text: String(m.content ?? '').slice(0, 200),
          })),
        },
      }

      // ③ 表内单元格：从文档命中里挑最相关的表格，逐本扫（scan_all=扫完所有页签）
      if (scanCells) {
        const candidates = (docRes?.results ?? [])
          .filter((r) => /sheet|bitable/i.test(String(r.type ?? '')))
          .slice(0, maxSheets)
        const scans = await Promise.all(
          candidates.map(async (c) => {
            const cellRaw = await executeTool('lark_search_in_sheet', {
              spreadsheet: c.token || c.url,
              find: query,
              scan_all: true,
            })
            const cell = cellRaw as {
              match_count?: number
              scanned_tab_count?: number
              total_tabs?: number
              url?: string
              matches?: unknown[]
              error?: string
            } | null
            return {
              workbook: c.title,
              url: cell?.url ?? c.url,
              cell_matches: cell?.match_count ?? 0,
              scanned_tabs: `${cell?.scanned_tab_count ?? 0}/${cell?.total_tabs ?? 0}`,
              ...(cell?.error ? { error: cell.error } : {}),
              hits: (cell?.matches ?? []).slice(0, per),
            }
          }),
        )
        out.sheet_cells = {
          scope: 'cell contents — only the workbook(s) listed here were scanned',
          scanned_workbooks: scans,
        }
      }

      out.note =
        '三个来源的口径不同：documents.total 是文档篇数，messages.count 是本次取回的聊天条数，sheet_cells 只覆盖上面列出的表格。回答时请分别标明，不要把某一个数字说成"总数"。'
      return out
    },
  },
  {
    name: 'lark_doc_insert_image',
    description:
      'Insert an IMAGE into a Feishu docx in ONE call: downloads it from a chat message when needed, then inserts it into the document. Use it whenever the user says 把这张图/截图存进文档、把消息里的图插到文档里. Give (message_id + file_key) for an image living in a chat message, or `file` for a path already on the server. Returns block_id — that is the proof the image really landed (writing only the text is the usual failure mode).',
    input_schema: {
      type: 'object',
      properties: {
        document: { type: 'string', description: 'Target docx URL or document_id' },
        message_id: { type: 'string', description: 'Message carrying the image (om_…)' },
        file_key: { type: 'string', description: 'Image file key from that message (img_v3_…)' },
        file: { type: 'string', description: 'Local path on the server, if the image is already there' },
        caption: { type: 'string', description: 'Optional caption' },
      },
      required: ['document'],
    },
    run: async (input) => {
      const document = str(input, 'document')
      const messageId = strOpt(input, 'message_id')
      const fileKey = strOpt(input, 'file_key')
      const caption = strOpt(input, 'caption')
      let path = strOpt(input, 'file')
      let downloaded: Record<string, unknown> | undefined

      if (!path) {
        if (!messageId || !fileKey) {
          return { error: '需要 file（服务器上的路径），或者 message_id + file_key（消息里的图）' }
        }
        const out = `/tmp/lark-img-${Date.now()}`
        const dl = await runCli(
          [
            'im',
            '+messages-resources-download',
            '--as',
            'user',
            '--message-id',
            messageId,
            '--file-key',
            fileKey,
            '--type',
            'image',
            '--output',
            out,
          ],
          60_000,
        )
        if (!dl.ok) {
          return { error: '从消息里下载图片失败', detail: (dl.stderr || dl.raw).slice(0, 400) }
        }
        const env = dl.data as { data?: { saved_path?: string; size_bytes?: number } } | null
        path = env?.data?.saved_path || out
        downloaded = { saved_path: path, bytes: env?.data?.size_bytes ?? null }
      }

      const argv = [
        'docs',
        '+media-insert',
        '--as',
        'user',
        '--doc',
        document,
        '--file',
        path,
        '--type',
        'image',
      ]
      if (caption) argv.push('--caption', caption)
      const ins = await runCli(argv, 120_000)
      if (!ins.ok) {
        return {
          error: '插入图片失败',
          ...(downloaded ? { downloaded } : {}),
          detail: (ins.stderr || ins.raw).slice(0, 400),
        }
      }
      const info = (
        ins.data as { data?: { block_id?: string; file_token?: string; document_id?: string } } | null
      )?.data
      const docId = info?.document_id
      return {
        ok: true,
        inserted: true,
        block_id: info?.block_id ?? null,
        file_token: info?.file_token ?? null,
        ...(docId ? { url: `${config.LARK_DOC_HOST.replace(/\/$/, '')}/docx/${docId}` } : {}),
        ...(downloaded ? { downloaded } : {}),
      }
    },
  },
  {
    name: 'lark_doc_insert_images',
    description:
      'Insert MANY images (with optional section headings) into a docx in ONE call — use this instead of calling lark_doc_insert_image in a loop, which burns the whole tool budget: 26 images would otherwise need 26 rounds. Pass groups, each with an optional `heading` (rendered as a Markdown H2). EASIEST: give the group a `message_id` and NO `images` — the tool pulls every image out of that message, in order. Otherwise pass `images: [{file_key, message_id?, file?, caption?}]`. Returns per-image ok/error so you can report precisely what landed.',
    input_schema: {
      type: 'object',
      properties: {
        document: { type: 'string', description: 'Target docx URL or document_id' },
        groups: {
          type: 'array',
          description:
            'Sections to append, in order. Example: [{"heading":"矿石icon","images":[{"message_id":"om_…","file_key":"img_v3_…","caption":"1/11"}]}]',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string', description: 'Optional H2 heading for this section' },
              message_id: {
                type: 'string',
                description:
                  'Optional: when `images` is omitted, pull EVERY image out of this message automatically (om_…).',
              },
              images: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    message_id: { type: 'string', description: 'Message carrying the image (om_…)' },
                    file_key: { type: 'string', description: 'img_v3_… key from that message' },
                    file: { type: 'string', description: 'Local path on the server instead of file_key' },
                    caption: { type: 'string', description: 'Optional caption' },
                  },
                },
              },
            },
            required: ['images'],
          },
        },
      },
      required: ['document', 'groups'],
    },
    run: async (input) => {
      const document = str(input, 'document')
      const rawGroups = input.groups
      if (!Array.isArray(rawGroups)) throw new Error("tool input 'groups' must be an array")

      const results: Array<Record<string, unknown>> = []
      let inserted = 0
      let failed = 0
      let index = 0

      for (const group of rawGroups as Array<Record<string, unknown>>) {
        const heading = typeof group.heading === 'string' ? group.heading.trim() : ''
        const groupMessageId = typeof group.message_id === 'string' ? group.message_id : ''
        if (heading) {
          const h = await runCli(
            [
              'docs',
              '+update',
              '--as',
              'user',
              '--doc',
              document,
              '--command',
              'append',
              '--doc-format',
              'markdown',
              '--content',
              `## ${heading}`,
            ],
            60_000,
          )
          if (!h.ok) {
            results.push({ heading, ok: false, error: (h.stderr || h.raw).slice(0, 200) })
          }
        }

        let images = Array.isArray(group.images) ? (group.images as Array<Record<string, unknown>>) : []

        // 只给了 message_id 时，自动把这条消息里的所有图片按顺序取出来
        // （模型没必要自己枚举 26 个 file_key —— 它既容易漏，也会把轮数耗光）。
        if (images.length === 0 && groupMessageId) {
          const r = await runCli(
            ['im', '+messages-mget', '--as', 'user', '--message-ids', groupMessageId],
            60_000,
          )
          const env = r.data as
            | { data?: { messages?: Array<{ content?: string }> }; messages?: Array<{ content?: string }> }
            | null
          const content = String(env?.data?.messages?.[0]?.content ?? env?.messages?.[0]?.content ?? '')
          // 真实 key 形如 img_v3_0216h_aff30b8b-a3f2-...；要求中间带 "-"，
          // 避免把正文里的占位写法（img_v3_0216l_...）误当成 key。
          const keys = [...content.matchAll(/img_[A-Za-z0-9_]+-[A-Za-z0-9_-]{10,}/g)].map((m) => m[0])
          images = keys.map((k) => ({ message_id: groupMessageId, file_key: k }))
          if (images.length === 0) {
            results.push({
              heading: heading || null,
              ok: false,
              error: `消息 ${groupMessageId} 里没有找到图片（msg_type=${String((env?.data?.messages?.[0] as { msg_type?: string } | undefined)?.msg_type ?? '?')}）`,
            })
          }
        }
        for (const img of images) {
          index += 1
          if (index > 40) {
            results.push({ index, ok: false, error: '超过单次 40 张上限，剩余未处理' })
            failed += 1
            continue
          }
          const messageId = typeof img.message_id === 'string' ? img.message_id : groupMessageId
          const fileKey = typeof img.file_key === 'string' ? img.file_key : ''
          const localFile = typeof img.file === 'string' ? img.file : ''
          const caption = typeof img.caption === 'string' ? img.caption : ''

          let path = localFile
          if (!path) {
            if (!messageId || !fileKey) {
              results.push({ index, ok: false, error: '缺少 file 或 message_id+file_key' })
              failed += 1
              continue
            }
            const out = `/tmp/lark-img-${Date.now()}-${index}`
            const dl = await runCli(
              [
                'im',
                '+messages-resources-download',
                '--as',
                'user',
                '--message-id',
                messageId,
                '--file-key',
                fileKey,
                '--type',
                'image',
                '--output',
                out,
              ],
              60_000,
            )
            const saved = (dl.data as { data?: { saved_path?: string } } | null)?.data?.saved_path
            if (!dl.ok || !saved) {
              results.push({ index, ok: false, error: (dl.stderr || dl.raw).slice(0, 200) })
              failed += 1
              continue
            }
            path = saved
          }

          const argv = [
            'docs',
            '+media-insert',
            '--as',
            'user',
            '--doc',
            document,
            '--file',
            path,
            '--type',
            'image',
          ]
          if (caption) argv.push('--caption', caption)
          const ins = await runCli(argv, 120_000)
          if (ins.ok) {
            inserted += 1
            results.push({
              index,
              heading: heading || null,
              ok: true,
              block_id:
                (ins.data as { data?: { block_id?: string } } | null)?.data?.block_id ?? null,
            })
          } else {
            failed += 1
            results.push({ index, ok: false, error: (ins.stderr || ins.raw).slice(0, 200) })
          }
        }
      }

      return {
        ok: failed === 0,
        document,
        total: index,
        inserted,
        failed,
        results: results.slice(0, 40),
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

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<unknown> {
  const t = TOOL_MAP.get(name)
  if (!t) throw new Error(`unknown tool: ${name}`)
  logger.info({ tool: name, input }, 'executing tool')
  try {
    const out = await t.run(input, ctx)
    logger.debug({ tool: name }, 'tool ok')
    return out
  } catch (err) {
    const e = err as { message?: string }
    logger.error({ tool: name, err: e.message }, 'tool execution failed')
    return { error: e.message ?? String(err) }
  }
}
