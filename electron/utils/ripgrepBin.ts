/**
 * Resolve the ripgrep binary to spawn.
 *
 * Historically we spawned bare `rg` from PATH — fine on dev machines (ripgrep
 * installed), broken on end-user machines. We now ship `@vscode/ripgrep`
 * (per-platform binary packages, e.g. `@vscode/ripgrep-win32-x64`) with the
 * app and prefer that; bare PATH `rg` remains the fallback so environments
 * without the bundled package (or exotic platforms) behave exactly as before.
 *
 * Implementation notes:
 *   - We resolve the platform package directly instead of importing
 *     `@vscode/ripgrep` — its entry is ESM-only, and this module is bundled
 *     into CJS chunks (main process, worker_threads, utilityProcess).
 *   - In packaged builds `require.resolve` returns a path inside `app.asar`,
 *     but binaries cannot be spawned from an asar archive. The packages are
 *     listed in `asarUnpack` (electron-builder.json), so rewrite the path to
 *     `app.asar.unpacked` — same convention VS Code uses.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

let cached: string | undefined

function moduleDir(): string {
  // CJS bundle (dist-electron chunks): __dirname exists. Vitest / ESM
  // transforms: fall back to cwd (repo root — node_modules resolves fine).
  return typeof __dirname !== 'undefined' ? __dirname : process.cwd()
}

/** Rewrite `.../app.asar/...` to `.../app.asar.unpacked/...` (packaged only). */
function toUnpackedPath(p: string): string {
  return p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
}

/**
 * Absolute path to the bundled rg binary, or the bare `rg` / `rg.exe`
 * PATH-spawn fallback when the bundled package is unavailable.
 */
export function resolveRipgrepBin(): string {
  if (cached) return cached
  const fallback = process.platform === 'win32' ? 'rg.exe' : 'rg'
  try {
    const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg'
    const platformPkg = `@vscode/ripgrep-${process.platform}-${process.arch}`
    const req = createRequire(path.join(moduleDir(), '__ripgrep_resolver__.js'))
    const resolved = req.resolve(`${platformPkg}/bin/${binaryName}`)
    const spawnable = toUnpackedPath(resolved)
    if (fs.existsSync(spawnable)) {
      cached = spawnable
      return cached
    }
  } catch {
    /* platform package not installed — PATH fallback below */
  }
  cached = fallback
  return cached
}

/** Test seam. */
export function __resetRipgrepBinCacheForTests(): void {
  cached = undefined
}
