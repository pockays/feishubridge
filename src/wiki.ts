import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { config } from './config.js'
import { logger } from './logger.js'
import { runCli } from './lark/cli.js'

/**
 * 知识库（Wiki）索引 + 检索。
 *
 * 背景：飞书的「搜索云文档」接口（drive +search）用**应用身份**时，只能搜到
 * 显式共享给该应用的文档 —— 企业知识库里的东西搜不到（返回 0 条）。但 wiki
 * 节点可以按 parent 逐层列出：应用只要能读某个节点，就能列出它的子节点。
 *
 * 所以这里做的是：从若干根节点广度优先爬一遍，把「标题 → node_token /
 * obj_token」建成索引落盘；查询时在内存里按标题匹配。命中之后，上层工具再用
 * docs +fetch / sheets +cells-get 去读正文。
 *
 * 爬取是 IO 密集型（每个节点一次 lark-cli 调用），所以只在启动时和每隔
 * WIKI_INDEX_REFRESH_HOURS 小时跑一次，聊天路径上只读内存索引。
 */

export interface WikiNode {
  /** wiki 节点 token，可用于拼接文档链接与继续向下列出子节点 */
  nodeToken: string
  /** 文档本身的 token（docx / sheet / bitable …），用于读内容 */
  objToken: string
  /** docx | sheet | bitable | slides | doc | file | … */
  objType: string
  title: string
  /** 从根节点到该节点的标题路径，便于消歧 */
  path: string
  spaceId: string
}

interface IndexFile {
  builtAt: number
  roots: string[]
  nodes: WikiNode[]
}

export interface WikiSearchResult {
  status: 'ready' | 'building' | 'disabled' | 'empty'
  builtAt: string | null
  indexedNodes: number
  total: number
  matches: Array<{
    title: string
    type: string
    path: string
    node_token: string
    obj_token: string
    url: string
  }>
}

let nodes: WikiNode[] = []
let builtAt = 0
let building: Promise<void> | null = null

/** "spaceId:nodeToken,spaceId:nodeToken" → 结构化数组 */
function parseRoots(): Array<{ spaceId: string; token: string }> {
  return config.WIKI_ROOT_TOKENS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((spec) => {
      const idx = spec.indexOf(':')
      if (idx < 0) return null
      return { spaceId: spec.slice(0, idx).trim(), token: spec.slice(idx + 1).trim() }
    })
    .filter((v): v is { spaceId: string; token: string } => Boolean(v?.spaceId && v.token))
}

export function wikiIndexEnabled(): boolean {
  return parseRoots().length > 0
}

/** 列一个节点的直接子节点；权限不足返回 null（调用方跳过这棵子树）。 */
async function listChildren(spaceId: string, parentToken: string): Promise<WikiNode[] | null> {
  const out: WikiNode[] = []
  let pageToken: string | undefined

  for (let page = 0; page < 10; page++) {
    const argv = [
      'wiki',
      '+node-list',
      '--as',
      'bot',
      '--space-id',
      spaceId,
      '--parent-node-token',
      parentToken,
      '--page-size',
      '50',
    ]
    if (pageToken) argv.push('--page-token', pageToken)

    const r = await runCli(argv, 45_000)
    if (!r.ok) {
      if (page === 0) {
        logger.debug({ spaceId, parentToken }, 'wiki node-list denied or failed, skipping subtree')
        return null
      }
      break
    }

    const data = r.data as {
      data?: { nodes?: RawNode[]; has_more?: boolean; page_token?: string }
    } | null
    const batch = data?.data?.nodes ?? []
    for (const n of batch) {
      if (!n.node_token || !n.title) continue
      out.push({
        nodeToken: n.node_token,
        objToken: n.obj_token ?? n.node_token,
        objType: n.obj_type ?? 'unknown',
        title: n.title,
        path: n.title,
        spaceId,
      })
    }
    if (!data?.data?.has_more || !data.data.page_token) break
    pageToken = data.data.page_token
  }

  return out
}

interface RawNode {
  node_token?: string
  obj_token?: string
  obj_type?: string
  title?: string
  has_child?: boolean
}

/** 广度优先爬取；并发受 WIKI_INDEX_CONCURRENCY 限制。 */
async function crawl(roots: Array<{ spaceId: string; token: string }>): Promise<WikiNode[]> {
  const found = new Map<string, WikiNode>()
  const queue = roots.map((r) => ({ spaceId: r.spaceId, token: r.token, path: [] as string[] }))
  let calls = 0

  while (queue.length > 0 && found.size < config.WIKI_INDEX_MAX_NODES) {
    const batch = queue.splice(0, config.WIKI_INDEX_CONCURRENCY)
    const results = await Promise.all(batch.map((b) => listChildren(b.spaceId, b.token)))
    calls += batch.length

    for (let i = 0; i < batch.length; i++) {
      const parent = batch[i]
      const children = results[i]
      if (!children) continue
      for (const child of children) {
        if (found.has(child.nodeToken)) continue
        const path = [...parent.path, child.title]
        found.set(child.nodeToken, { ...child, path: path.join(' / ') })
        if (!child.objToken) continue
        queue.push({ spaceId: parent.spaceId, token: child.nodeToken, path })
      }
    }
  }

  logger.info({ nodes: found.size, calls }, 'wiki index crawl finished')
  return [...found.values()]
}

async function saveIndex(roots: string[]): Promise<void> {
  try {
    await mkdir(dirname(config.WIKI_INDEX_PATH), { recursive: true })
    const payload: IndexFile = { builtAt, roots, nodes }
    await writeFile(config.WIKI_INDEX_PATH, JSON.stringify(payload), 'utf8')
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'failed to persist wiki index')
  }
}

async function loadIndexFromDisk(): Promise<void> {
  try {
    const raw = await readFile(config.WIKI_INDEX_PATH, 'utf8')
    const parsed = JSON.parse(raw) as IndexFile
    if (Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
      nodes = parsed.nodes
      builtAt = parsed.builtAt ?? 0
      logger.info(
        { nodes: nodes.length, builtAt: new Date(builtAt).toISOString() },
        'wiki index loaded from disk',
      )
    }
  } catch {
    // 首次启动没有索引文件是正常的
  }
}

/** 重建索引；并发调用共享同一次爬取。 */
export function refreshWikiIndex(reason: string): Promise<void> {
  if (building) return building
  const roots = parseRoots()
  if (roots.length === 0) return Promise.resolve()

  building = (async () => {
    const started = Date.now()
    try {
      logger.info({ reason, roots: roots.length }, 'wiki index rebuild started')
      const crawled = await crawl(roots)
      if (crawled.length > 0) {
        nodes = crawled
        builtAt = Date.now()
        await saveIndex(roots.map((r) => `${r.spaceId}:${r.token}`))
        logger.info(
          { nodes: nodes.length, ms: Date.now() - started },
          'wiki index rebuild done',
        )
      } else {
        logger.warn('wiki index rebuild yielded 0 nodes, keeping the previous index')
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'wiki index rebuild failed')
    } finally {
      building = null
    }
  })()

  return building
}

/** 进程启动时调用：先吃磁盘上的索引，过期/缺失再后台重建。 */
export function startWikiIndex(): void {
  if (!wikiIndexEnabled()) {
    logger.info('wiki index disabled (WIKI_ROOT_TOKENS is empty)')
    return
  }

  void loadIndexFromDisk().then(() => {
    const maxAgeMs = config.WIKI_INDEX_REFRESH_HOURS * 3600_000
    const stale = nodes.length === 0 || Date.now() - builtAt > maxAgeMs
    if (stale) void refreshWikiIndex('startup')
    else logger.info({ nodes: nodes.length }, 'wiki index is fresh, skipping startup rebuild')
  })

  const timer = setInterval(
    () => void refreshWikiIndex('scheduled'),
    Math.max(1, config.WIKI_INDEX_REFRESH_HOURS) * 3600_000,
  )
  timer.unref()
}

function docUrl(nodeToken: string): string {
  return `${config.WIKI_DOC_HOST.replace(/\/$/, '')}/wiki/${nodeToken}`
}

export function wikiIndexStats(): { indexedNodes: number; builtAt: string | null; building: boolean } {
  return {
    indexedNodes: nodes.length,
    builtAt: builtAt ? new Date(builtAt).toISOString() : null,
    building: building !== null,
  }
}

/**
 * 标题检索。多词查询要求标题全部命中（更精确），无结果时退化为命中任一关键词。
 */
export function searchWiki(query: string, limit = 20): WikiSearchResult {
  const stats = wikiIndexStats()
  const base = {
    builtAt: stats.builtAt,
    indexedNodes: stats.indexedNodes,
    total: 0,
    matches: [],
  }

  if (!wikiIndexEnabled()) return { status: 'disabled', ...base }
  if (nodes.length === 0) {
    return { status: stats.building ? 'building' : 'empty', ...base }
  }

  const terms = query
    .toLowerCase()
    .split(/[\s,，、]+/)
    .filter(Boolean)
  if (terms.length === 0) return { status: 'ready', ...base }

  const score = (n: WikiNode, requireAll: boolean): number => {
    const title = n.title.toLowerCase()
    let hits = 0
    let total = 0
    for (const term of terms) {
      const idx = title.indexOf(term)
      if (idx < 0) continue
      hits += 1
      // 命中越靠前、标题越短，相关度越高
      total += (idx === 0 ? 12 : 7) + Math.max(0, 6 - Math.floor(title.length / 6))
    }
    if (hits === 0) return 0
    if (requireAll && hits < terms.length) return 0
    return total + (hits === terms.length ? 15 : 0)
  }

  let ranked = nodes
    .map((n) => ({ n, s: score(n, true) }))
    .filter((x) => x.s > 0)
  if (ranked.length === 0) {
    ranked = nodes.map((n) => ({ n, s: score(n, false) })).filter((x) => x.s > 0)
  }

  ranked.sort((a, b) => b.s - a.s || a.n.title.length - b.n.title.length)
  const top = ranked.slice(0, Math.max(1, Math.min(50, limit)))

  return {
    status: 'ready',
    ...base,
    total: ranked.length,
    matches: top.map(({ n }) => ({
      title: n.title,
      type: n.objType,
      path: n.path,
      node_token: n.nodeToken,
      obj_token: n.objToken,
      url: docUrl(n.nodeToken),
    })),
  }
}

/** 按 node_token 或 obj_token 找回索引条目。 */
export function findWikiNode(token: string): WikiNode | undefined {
  return nodes.find((n) => n.nodeToken === token || n.objToken === token)
}
