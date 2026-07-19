/**
 * Writable per-user data root — holds user memory, Chromium disk cache, and file logs.
 *
 * Resolution strategy:
 *   - Dev: repo sibling directory (`<repo>/../星构Astra-data`) so the dev workflow can
 *     inspect / clean it easily.
 *   - Packaged:
 *       1. If `<exeDir>/星构Astra-data` is writable (portable / unzip install), use it.
 *          This preserves the original portable-style behavior.
 *       2. Otherwise fall back to `app.getPath('userData')` so NSIS installs under
 *          `Program Files` (where `<exeDir>` is read-only for standard users) still
 *          boot cleanly.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { App } from 'electron'

const BUNDLE_DIR_NAME = '星构Astra-data'

let cachedRoot: string | undefined

function isDirWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`)
    fs.writeFileSync(probe, '')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

export function getBundleDataRoot(app: App): string {
  if (cachedRoot) return cachedRoot

  if (app.isPackaged) {
    const exeSibling = path.normalize(
      path.join(path.dirname(app.getPath('exe')), BUNDLE_DIR_NAME),
    )
    if (isDirWritable(exeSibling)) {
      cachedRoot = exeSibling
      return cachedRoot
    }
    cachedRoot = path.normalize(path.join(app.getPath('userData'), BUNDLE_DIR_NAME))
    return cachedRoot
  }

  cachedRoot = path.normalize(path.join(app.getAppPath(), '..', BUNDLE_DIR_NAME))
  return cachedRoot
}

export function ensureBundleDataLayout(app: App): string {
  const root = getBundleDataRoot(app)
  fs.mkdirSync(path.join(root, 'memory', 'user'), { recursive: true })
  fs.mkdirSync(path.join(root, 'chromium-cache'), { recursive: true })
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true })
  return root
}

export function getBundleChromiumCacheDir(app: App): string {
  return path.join(getBundleDataRoot(app), 'chromium-cache')
}

export function getBundleLogsDir(app: App): string {
  return path.join(getBundleDataRoot(app), 'logs')
}
