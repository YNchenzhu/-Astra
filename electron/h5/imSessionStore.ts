/**
 * Durable IM session map (sessionId → workDir).
 *
 * IM (`imBridge`) keeps live sessions in memory only, so a desktop restart loses
 * the binding the adapter persisted on disk: the adapter reconnects with its
 * stored `sessionId`, finds it gone, and starts a brand-new session — dropping
 * the multi-turn context. Persisting the id→workDir map here lets the bridge
 * rehydrate the session (and rebuild its history from the saved conversation)
 * across restarts, so WeChat conversations keep their context.
 *
 * Pure Node fs (no Electron) so it is unit-testable in isolation. Honors
 * `CLAUDE_CONFIG_DIR` for parity with the adapter config files.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

export interface StoredImSession {
  workDir: string
}

function storePath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(dir, 'cc-haha-im-sessions.json')
}

function readAll(): Record<string, StoredImSession> {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf-8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, StoredImSession> = {}
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v && typeof v === 'object' && typeof (v as { workDir?: unknown }).workDir === 'string') {
        out[id] = { workDir: (v as { workDir: string }).workDir }
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeAll(data: Record<string, StoredImSession>): void {
  const filePath = storePath()
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.tmp.${crypto.randomBytes(8).toString('hex')}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmp, filePath)
}

export function persistImSession(sessionId: string, workDir: string): void {
  if (!sessionId || !workDir) return
  const all = readAll()
  if (all[sessionId]?.workDir === workDir) return
  all[sessionId] = { workDir }
  try {
    writeAll(all)
  } catch {
    /* best-effort: persistence failure should not break the live session */
  }
}

export function loadImSession(sessionId: string): StoredImSession | null {
  if (!sessionId) return null
  return readAll()[sessionId] ?? null
}

export function deleteImSession(sessionId: string): void {
  if (!sessionId) return
  const all = readAll()
  if (!(sessionId in all)) return
  delete all[sessionId]
  try {
    writeAll(all)
  } catch {
    /* ignore */
  }
}
