#!/usr/bin/env node
import { run } from './worker.js'
import { logger } from './logger.js'
import { startUserTokenKeepAlive } from './user-token.js'

const { stop } = run()
// 用户令牌保活：refresh_token 只有 7 天，靠定期续期滚动保鲜。
startUserTokenKeepAlive()

// Hold the event loop open until we explicitly call process.exit(). Without
// this, an `async` signal handler can race the default SIGTERM behavior:
// Node sees nothing ref'd in the loop the instant our handler returns
// (before its returned promise resolves) and exits prematurely, leaving
// the lark-cli child processes orphaned.
const keepAlive = setInterval(() => undefined, 1 << 30)

let exiting = false
async function shutdown(sig: NodeJS.Signals): Promise<void> {
  if (exiting) return
  exiting = true
  logger.info({ sig }, 'shutting down')
  try {
    await stop()
    logger.info('shutdown complete')
  } catch (err) {
    logger.error({ err }, 'error during shutdown')
  } finally {
    clearInterval(keepAlive)
    // Tiny delay so pino flushes its async stream.
    setTimeout(() => process.exit(0), 100)
  }
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('uncaughtException', (err) => logger.error({ err }, 'uncaughtException'))
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'))
