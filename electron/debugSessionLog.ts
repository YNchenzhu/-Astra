/**
 * Optional NDJSON debug sink (off by default). Enable with ASTRA_AGENT_DEBUG_LOG=1.
 * Avoids filesystem/network side effects in normal runs.
 *
 * P0-5: when enabled, file appends are async (`fs.promises.appendFile`) so we
 * never block the main process event loop on disk I/O. The previous
 * `appendFileSync` could stall every callsite for 5–50ms under heavy log
 * volume on slow disks. The HTTP `fetch` was already fire-and-forget.
 *
 * Packaging fixes:
 *   - The log file used to go to `process.cwd()`, which in a packaged app is
 *     the install dir (Program Files → EPERM, silently swallowed). Target is
 *     now `ASTRA_AGENT_DEBUG_LOG_DIR` when set, else the OS temp dir — both
 *     writable everywhere.
 *   - The HTTP ingest endpoint used to be a hardcoded personal collector URL;
 *     it is now opt-in via `ASTRA_AGENT_DEBUG_INGEST_URL` and nothing is
 *     POSTed when the variable is unset.
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'path'

const DEBUG_LOG_FILE = 'debug-e88e1a.log'
const SESSION_ID = 'e88e1a'

function debugLogEnabled(): boolean {
  const e = process.env.ASTRA_AGENT_DEBUG_LOG
  return e === '1' || e === 'true'
}

function debugLogFilePath(): string {
  const dir = process.env.ASTRA_AGENT_DEBUG_LOG_DIR?.trim() || os.tmpdir()
  return path.join(dir, DEBUG_LOG_FILE)
}

export function emitSessionDebugLog(payload: Record<string, unknown>): void {
  if (!debugLogEnabled()) return

  const body = { sessionId: SESSION_ID, timestamp: Date.now(), ...payload }
  const line = `${JSON.stringify(body)}\n`
  void fsp.appendFile(debugLogFilePath(), line, 'utf8').catch(() => {
    /* ignore — debug sink is best-effort */
  })
  const ingest = process.env.ASTRA_AGENT_DEBUG_INGEST_URL?.trim()
  if (!ingest) return
  fetch(ingest, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': SESSION_ID,
    },
    body: JSON.stringify(body),
  }).catch(() => {})
}
