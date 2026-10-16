import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import { logger } from '../logger.js'

export interface ConsumeOptions<T> {
  eventKey: string
  as: 'bot' | 'user' | 'auto'
  /**
   * 把原始 JSON 解析成业务事件；返回 null 表示"这不是我要的事件，丢掉"。
   * 做成回调是因为不同 EventKey 的结构不同（消息事件 / 撤回事件 / …），
   * 早先这里写死了 isFeishuMessageEvent，导致消费其它事件时全被丢掉。
   */
  parse: (v: unknown) => T | null
  onEvent: (evt: T) => void
  /** Backoff between auto-restarts on unexpected exit. */
  restartDelayMs?: number
}

export interface ConsumerHandle {
  /** Send SIGTERM to the current child and disable auto-restart. */
  stop: () => Promise<void>
}

/**
 * Spawn `lark-cli event consume` and stream parsed events to `onEvent`.
 *
 * Auto-restart policy:
 *   - On non-zero exit (excluding voluntary stop), wait `restartDelayMs`
 *     and respawn. This survives transient network blips and lark-cli
 *     bus-daemon restarts. Event dedup is persisted in SQLite (see
 *     src/store.ts), so a respawn never causes double-handling even if
 *     Feishu replays events during the gap.
 *
 * Shutdown contract:
 *   - `stop()` first sends SIGTERM to the wrapper child (Node-side
 *     lark-cli), then waits up to 5s. If still alive, SIGKILL.
 *   - Then asks `lark-cli event stop --force` to bring down any orphaned
 *     bus daemon and consumer subprocesses (lark-cli's own wrapper
 *     sometimes leaves grandchildren behind).
 *
 * Critical detail: stdin must remain an open pipe — see docs/architecture.md.
 */
export function startConsumer<T>(opts: ConsumeOptions<T>): ConsumerHandle {
  const restartDelayMs = opts.restartDelayMs ?? 2000
  let stopping = false
  let current: ChildProcessWithoutNullStreams | null = null

  function spawnOnce(): void {
    if (stopping) return
    const child = spawn(
      'lark-cli',
      ['event', 'consume', opts.eventKey, '--as', opts.as, '--quiet'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    current = child
    logger.info({ pid: child.pid, key: opts.eventKey }, 'lark-cli event consumer spawned')

    child.stderr.on('data', (buf) => {
      for (const line of buf.toString('utf8').split('\n')) {
        if (line.trim()) logger.debug({ src: 'lark-cli' }, line)
      }
    })

    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      if (!line.trim()) return
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        logger.warn({ line: line.slice(0, 200) }, 'non-JSON line from lark-cli')
        return
      }
      const evt = opts.parse(parsed)
      if (evt === null) {
        logger.debug({ parsed }, 'event did not match this consumer, ignored')
        return
      }
      try {
        opts.onEvent(evt)
      } catch (err) {
        logger.error({ err }, 'onEvent handler threw')
      }
    })

    child.on('exit', (code, signal) => {
      current = null
      logger.warn({ code, signal, stopping }, 'lark-cli event consumer exited')
      if (stopping) return
      setTimeout(spawnOnce, restartDelayMs).unref()
    })
  }

  spawnOnce()

  async function stop(): Promise<void> {
    stopping = true
    if (current) {
      const c = current
      c.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          if (!c.killed) c.kill('SIGKILL')
          resolve()
        }, 5000)
        c.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
    }
    // Force-shutdown the bus daemon. We must --force because our wrapper
    // child may have exited before its own consume sub-subprocess.
    await new Promise<void>((resolve) => {
      const p = spawn('lark-cli', ['event', 'stop', '--force'], { stdio: 'ignore' })
      p.on('exit', () => resolve())
      p.on('error', () => resolve())
    })
  }

  return { stop }
}
