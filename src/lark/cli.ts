import { spawn } from 'node:child_process'
import { logger } from '../logger.js'
import { appCredentials, getUserAccessToken } from '../user-token.js'

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
 */
export async function runCli(argv: string[], timeoutMs = 30_000): Promise<CliResult> {
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

  return new Promise((resolve) => {
    const child = spawn('lark-cli', finalArgv, { stdio: ['ignore', 'pipe', 'pipe'], env })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))

    const killTimer = setTimeout(() => {
      logger.warn({ argv: finalArgv, timeoutMs }, 'lark-cli timed out, killing')
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
