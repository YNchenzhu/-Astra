import fs from 'node:fs'
import path from 'node:path'

let logFile: string | null = null

type LifecycleSink = (payload: {
  channelId: string
  message: string
  type?: 'info' | 'warning' | 'error'
}) => void
let lifecycleSink: LifecycleSink | null = null

/**
 * Register a sink that forwards each line captured by the bundle logger to the
 * renderer's `lifecycle-log` IPC channel (see `preload.ts → onLifecycleLog`).
 * Without this wiring the renderer-side subscribers (e.g. the Output "Application"
 * channel) never receive any updates.
 */
export function setLifecycleLogSink(sink: LifecycleSink | null): void {
  lifecycleSink = sink
}

function levelToLifecycleType(
  level: string,
): 'info' | 'warning' | 'error' {
  if (level === 'error') return 'error'
  if (level === 'warn') return 'warning'
  return 'info'
}

export function initBundleFileLogging(logsDir: string): void {
  fs.mkdirSync(logsDir, { recursive: true })
  logFile = path.join(logsDir, 'main.log')
}

export function bundleLogLine(message: string): void {
  if (!logFile) return
  try {
    fs.appendFileSync(
      logFile,
      `[${new Date().toISOString()}] ${message}\n`,
      'utf-8',
    )
  } catch {
    /* ignore disk errors */
  }
}

/** Mirror console to main.log without breaking the original console. */
export function attachConsoleToBundleLog(): void {
  if (!logFile) return
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
  for (const m of methods) {
    const orig = console[m].bind(console) as (...a: unknown[]) => void
    console[m] = (...args: unknown[]) => {
      orig(...args)
      try {
        const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
        bundleLogLine(`[${m}] ${line}`)
        try {
          lifecycleSink?.({
            channelId: 'app',
            message: line,
            type: levelToLifecycleType(m),
          })
        } catch {
          /* sink failures must never crash the logger */
        }
      } catch {
        bundleLogLine(`[${m}] <unserializable>`)
      }
    }
  }
}
