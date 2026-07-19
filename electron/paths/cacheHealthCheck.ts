/**
 * Chromium cache self-heal for unclean shutdowns.
 *
 * Problem: when the app crashes, is force-killed, or the OS reboots while
 * Electron is running, Chromium can leave its on-disk cache in a
 * half-written state. On the next launch renderer resource loads fail with
 * `net::ERR_CACHE_READ_FAILURE`, `ERR_CACHE_CORRUPTION`, or similar — the
 * UI either loads blank or silently drops static assets (icons, fonts,
 * chunked JS).
 *
 * Fix: write a "clean shutdown" marker from `before-quit`; at the next
 * start-up, if the marker is missing we assume the previous run did not
 * exit cleanly and purge every Chromium-managed cache directory before
 * Chromium opens any handle to them. User data (settings, conversations,
 * embedding indices, IndexedDB / localStorage, logs) is NEVER touched.
 *
 * Invariants:
 *   - Must run SYNCHRONOUSLY and BEFORE `app.whenReady()` — otherwise
 *     Chromium has already opened file handles and deleting files on
 *     Windows fails with EBUSY.
 *   - `fs.rmSync` uses `force: true` so a missing dir is a no-op (common
 *     on a fresh install / after manual cleanup).
 */

import fs from 'node:fs'
import path from 'node:path'
import type { App } from 'electron'
import { getBundleDataRoot } from './bundleDataPaths'

const CLEAN_SHUTDOWN_MARKER = '.clean-shutdown'

/**
 * Chromium-managed subdirectories under `app.getPath('userData')` that are
 * safe to wipe. This list mirrors the directories Chromium creates for
 * HTTP cache, compiled-code cache, GPU shader cache, WebGPU cache, blob
 * cache, and the Service-Worker cache surface.
 *
 * Do NOT add: `IndexedDB`, `Local Storage`, `Session Storage`, `Cookies`,
 * `Preferences`, anything with user settings — those are persistent state,
 * not caches.
 */
const USERDATA_CACHE_SUBDIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'blob_storage',
  'Service Worker',
  'Network',
] as const

/** Extra cache subdir that lives inside the bundle data root (see `bundleDataPaths.ts`). */
const BUNDLE_CACHE_SUBDIR = 'chromium-cache'

function getMarkerPath(app: App): string {
  return path.join(getBundleDataRoot(app), CLEAN_SHUTDOWN_MARKER)
}

function purgeDir(dir: string): boolean {
  if (!fs.existsSync(dir)) return false
  try {
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    })
    return true
  } catch (err) {
    // EPERM means another process (likely Chromium) still holds handles
    // inside this directory. Fall back to per-file deletion so we at least
    // clear what we can.
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      try {
        let deleted = 0
        const walkAndRemove = (d: string) => {
          for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name)
            if (entry.isDirectory()) {
              walkAndRemove(full)
              try { fs.rmdirSync(full) } catch { /* keep going */ }
            } else {
              try { fs.unlinkSync(full); deleted++ } catch { /* keep going */ }
            }
          }
        }
        walkAndRemove(dir)
        try { fs.rmdirSync(dir) } catch { /* dir itself may still be locked */ }
        return deleted > 0
      } catch {
        console.warn(`[CacheHealth] per-file purge also failed for: ${dir}`)
        return false
      }
    }
    console.warn(`[CacheHealth] purge failed: ${dir}`, err)
    return false
  }
}

/**
 * Run at the very top of main.ts, before any session / BrowserWindow is
 * created. Detects unclean shutdowns via marker absence and purges caches
 * when needed.
 *
 * Returns a short report for logging purposes. Callers may ignore it.
 */
export function runCacheHealthCheck(app: App): {
  uncleanShutdown: boolean
  purged: string[]
} {
  const markerPath = getMarkerPath(app)
  const purged: string[] = []

  if (fs.existsSync(markerPath)) {
    // Previous exit was clean. Remove the marker so *this* run has to
    // re-declare a clean exit before the next start-up trusts it.
    try {
      fs.unlinkSync(markerPath)
    } catch {
      /* non-fatal — worst case we purge unnecessarily once */
    }
    return { uncleanShutdown: false, purged }
  }

  console.warn(
    '[CacheHealth] no clean-shutdown marker — previous run exited abnormally; purging Chromium caches',
  )

  const userData = app.getPath('userData')
  for (const sub of USERDATA_CACHE_SUBDIRS) {
    const dir = path.join(userData, sub)
    if (purgeDir(dir)) purged.push(dir)
  }

  const bundleCache = path.join(getBundleDataRoot(app), BUNDLE_CACHE_SUBDIR)
  if (purgeDir(bundleCache)) purged.push(bundleCache)

  if (purged.length > 0) {
    console.warn(`[CacheHealth] purged ${purged.length} cache director${purged.length === 1 ? 'y' : 'ies'}`)
  }

  return { uncleanShutdown: true, purged }
}

/**
 * Call synchronously from `before-quit` after all critical flushes
 * succeed, right before `app.quit()`. Writing fails silently — a missing
 * marker just triggers a benign cache purge on the next run, not data loss.
 */
export function markCleanShutdown(app: App): void {
  try {
    fs.writeFileSync(getMarkerPath(app), String(Date.now()))
  } catch (err) {
    console.warn('[CacheHealth] failed to write clean-shutdown marker', err)
  }
}
