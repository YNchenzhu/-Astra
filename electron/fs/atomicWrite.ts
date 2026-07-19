/**
 * Atomic file replace: write temp in same directory, then rename.
 * Reduces torn JSON / truncated settings on crash or power loss mid-write.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function writeFileAtomicUtf8(targetPath: string, data: string): void {
  const dir = path.dirname(targetPath)
  fs.mkdirSync(dir, { recursive: true })
  const base = path.basename(targetPath)
  const tmp = path.join(
    dir,
    `.${base}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  )
  let wroteTmp = false
  try {
    fs.writeFileSync(tmp, data, 'utf-8')
    wroteTmp = true
    if (process.platform === 'win32' && fs.existsSync(targetPath)) {
      try {
        fs.unlinkSync(targetPath)
      } catch {
        /* may be locked briefly */
      }
    }
    fs.renameSync(tmp, targetPath)
    wroteTmp = false
  } finally {
    if (wroteTmp) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
      } catch {
        /* ignore */
      }
    }
  }
}

export function writeJsonFileAtomic(
  targetPath: string,
  value: unknown,
  space = 2,
): void {
  writeFileAtomicUtf8(targetPath, JSON.stringify(value, null, space))
}
