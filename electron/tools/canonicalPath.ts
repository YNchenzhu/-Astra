/**
 * Canonical (realpath-aware) path helpers shared by the file-lock and
 * file-validation subsystems.
 *
 * Why this lives in its own leaf module (only `node:fs` + `node:path`):
 * `fileLock.ts` is intentionally a tiny dependency-free leaf so it can be
 * imported from anywhere without pulling the heavy `fileToolValidation.ts`
 * graph. Both need the SAME canonicalization, so the single source of truth
 * lives here.
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * Resolve a path to its canonical absolute form, following symlinks even when
 * the leaf file does not yet exist (create scenario). In that case we resolve
 * the **nearest existing ancestor directory** and re-join the remaining tail;
 * this closes symlink-traversal holes where two callers reach the same
 * underlying file via different link paths.
 */
export function resolveRealPathAllowingMissingLeaf(resolvedPath: string): string {
  const abs = path.resolve(resolvedPath)
  try {
    return fs.realpathSync(abs)
  } catch {
    // leaf may be missing — walk up to first existing ancestor and realpath that
  }
  const tail: string[] = []
  let cursor = abs
  for (let i = 0; i < 256; i++) {
    const parent = path.dirname(cursor)
    if (parent === cursor) return abs // reached filesystem root without success
    tail.unshift(path.basename(cursor))
    cursor = parent
    try {
      const real = fs.realpathSync(cursor)
      return path.join(real, ...tail)
    } catch {
      // keep walking up
    }
  }
  return abs
}

/**
 * Stable key for the in-process per-file write lock.
 *
 * Uses {@link resolveRealPathAllowingMissingLeaf} so a symlink path and its
 * real target collapse to the same key — without this, two concurrent writers
 * reaching the same underlying file via different paths (e.g. one passes the
 * symlink, the other the realpath the atomic writer resolves to) would take
 * two different locks and corrupt the file. Windows is case-insensitive, so
 * the key is lowercased there (matching `isSameResolvedPath`'s convention).
 */
export function canonicalFileLockKey(filePath: string): string {
  const real = resolveRealPathAllowingMissingLeaf(filePath)
  return process.platform === 'win32' ? real.toLowerCase() : real
}
