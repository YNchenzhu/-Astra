/**
 * upstream §10.8 — KAIROS-style daily log (append to logs/YYYY/MM/YYYY-MM-DD.md).
 */

import fs from 'node:fs'
import path from 'node:path'
import { resolveWorkspaceMemoryDir } from './storage'

function todayParts(): { y: string; m: string; ymd: string } {
  const d = new Date()
  const y = String(d.getFullYear())
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return { y, m, ymd: `${y}-${m}-${day}` }
}

export function getKairosDailyLogPath(workspacePath: string): string {
  const { y, m, ymd } = todayParts()
  return path.join(resolveWorkspaceMemoryDir(workspacePath), 'logs', y, m, `${ymd}.md`)
}

export function appendKairosDailyLogLine(workspacePath: string, line: string): void {
  const p = getKairosDailyLogPath(workspacePath)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const ts = new Date().toISOString()
  fs.appendFileSync(p, `- [${ts}] ${line.trim()}\n`, 'utf8')
}

export function readKairosDailyLogTail(workspacePath: string, maxBytes: number = 8000): string {
  const p = getKairosDailyLogPath(workspacePath)
  if (!fs.existsSync(p)) return ''
  try {
    const buf = fs.readFileSync(p)
    if (buf.length <= maxBytes) return buf.toString('utf8')
    return buf.subarray(buf.length - maxBytes).toString('utf8')
  } catch {
    return ''
  }
}
