import { spawn } from 'node:child_process'
import { logger } from '../logger.js'
import { appCredentials, getUserAccessToken } from '../user-token.js'
import { config } from '../config.js'

export interface CliResult {
  ok: boolean
  /** Parsed JSON output if the command produced JSON; raw text otherwise. */
  data: unknown
  raw: string
  stderr: string
  exitCode: number
}

/**
 * Run `lark-cli` with the given argv, return its stdout JSON (or raw text on parse failure).
 *
 * - Always passes `--format json` unless `--format` / `--text` / etc. is already present.
 * - Captures stderr separately so tool-call results can include diagnostic info.
 * - Times out at `timeoutMs` (default 30s); a killed command resolves with ok=false.
 * - For `--as user` calls it injects a fresh user_access_token via
 *   LARKSUITE_CLI_USER_ACCESS_TOKEN (the container has no keychain, so lark-cli
 *   cannot keep its own user session there). The CLI refuses a token that
 *   arrives alone — "blocked by env: ... is set but LARKSUITE_CLI_APP_ID is
 *   missing" — so the app id/secret ride along in the same env. If no user
 *   token is configured we downgrade the call to the bot identity so the bridge
 *   keeps working, just with a narrower visible scope.
 * - Rate limits (`99991400` / `rate_limit`) are retried with backoff: the API
 *   gateway throttles per app + per interface, and a burst of tool calls inside
 *   one answer can graze it. Retrying is cheap; handing the error to the model
 *   is not (it tends to guess instead).
 */
export async function runCli(
  argv: string[],
  timeoutMs = 30_000,
  maxAttempts = RATE_LIMIT_ATTEMPTS,
): Promise<CliResult> {
  const wantsFormat = argv.some(
    (a) => a === '--format' || a === '--json' || a === '--text' || a === '--ndjson',
  )
  let finalArgv = wantsFormat ? argv : [...argv, '--format', 'json']
  let env = process.env

  const asIdx = finalArgv.indexOf('--as')
  const wantsUser = asIdx >= 0 && finalArgv[asIdx + 1] === 'user'
  if (wantsUser) {
    const [token, creds] = await Promise.all([getUserAccessToken(), appCredentials()])
    if (token && creds) {
      env = {
        ...process.env,
        LARKSUITE_CLI_APP_ID: creds.appId,
        LARKSUITE_CLI_APP_SECRET: creds.appSecret,
        LARKSUITE_CLI_USER_ACCESS_TOKEN: token,
      }
    } else {
      logger.warn(
        { argv: finalArgv, hasToken: Boolean(token), hasCreds: Boolean(creds) },
        'user credentials unavailable, falling back to bot identity',
      )
      finalArgv = [...finalArgv]
      finalArgv[asIdx + 1] = 'bot'
    }
  }

  let last: CliResult = { ok: false, data: null, raw: '', stderr: '', exitCode: -1 }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 退避等待时不占槽位，否则会把全局闸门堵死
    last = await withSlot(() => spawnCli(finalArgv, env, timeoutMs))
    if (last.ok) return last

    const limit = rateLimitInfo(last)
    if (!limit.limited || attempt === maxAttempts) {
      if (limit.limited) {
        logger.warn({ argv: finalArgv, attempt }, 'still rate limited after retries, giving up')
      }
      return last
    }

    const delayMs = retryDelayMs(limit, attempt)
    logger.warn(
      { argv: finalArgv, attempt, delayMs, retryAfterSec: limit.retryAfterSec ?? null },
      'lark-cli hit a rate limit, backing off before retry',
    )
    await sleep(delayMs)
  }

  return last
}

/** 遇到频控时的最大尝试次数（1 次原始 + 2 次重试）。 */
const RATE_LIMIT_ATTEMPTS = 3

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 全局并发闸门：飞书云空间接口频控 5 QPS，而模型一轮可能发多个工具调用、
 * 每个工具内部又自己并发（整本表扫描最多 6 路），叠起来很容易瞬时超限。
 * 所有 lark-cli 子进程统一从这里取槽位。
 */
let activeSlots = 0
const slotWaiters: Array<() => void> = []

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  const limit = Math.max(1, config.LARK_CLI_CONCURRENCY)
  while (activeSlots >= limit) {
    await new Promise<void>((resolve) => slotWaiters.push(resolve))
  }
  activeSlots += 1
  try {
    return await fn()
  } finally {
    activeSlots -= 1
    const next = slotWaiters.shift()
    if (next) next()
  }
}

/**
 * 识别频控。lark-cli 把结构化错误同时写在 stderr（有时也回落到 stdout），
 * 形态是 `{"error":{"type":"rate_limit","code":99991400,...}}`，并常带
 * `retry_after_seconds` 提示。
 */
function rateLimitInfo(r: CliResult): { limited: boolean; retryAfterSec?: number } {
  const text = `${r.stderr}\n${r.raw}`
  if (!/99991400|rate_limit|rate limit|too many requests/i.test(text)) {
    return { limited: false }
  }
  const m = /"?retry_after_seconds"?\s*[:=]\s*(\d+(?:\.\d+)?)/i.exec(text)
  const retryAfterSec = m ? Number(m[1]) : undefined
  return retryAfterSec === undefined ? { limited: true } : { limited: true, retryAfterSec }
}

function retryDelayMs(
  info: { limited: boolean; retryAfterSec?: number },
  attempt: number,
): number {
  if (info.retryAfterSec !== undefined) {
    return Math.min(10_000, Math.max(500, info.retryAfterSec * 1000))
  }
  // 1s, 3s, 7s…（带一点抖动，避免多路并发同时撞回去）
  return Math.min(10_000, 1000 * 2 ** (attempt - 1) - 1000) + Math.floor(Math.random() * 300)
}

function spawnCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn('lark-cli', argv, { stdio: ['ignore', 'pipe', 'pipe'], env })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))

    const killTimer = setTimeout(() => {
      logger.warn({ argv, timeoutMs }, 'lark-cli timed out, killing')
      child.kill('SIGTERM')
    }, timeoutMs)

    child.on('exit', (code) => {
      clearTimeout(killTimer)
      const exitCode = code ?? -1
      let data: unknown = null
      try {
        data = JSON.parse(stdout)
      } catch {
        data = stdout
      }
      resolve({
        ok: exitCode === 0,
        data,
        raw: stdout,
        stderr,
        exitCode,
      })
    })

    child.on('error', (err) => {
      clearTimeout(killTimer)
      logger.error({ err: err.message }, 'spawn lark-cli failed')
      resolve({ ok: false, data: null, raw: '', stderr: err.message, exitCode: -1 })
    })
  })
}
