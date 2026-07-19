/**
 * upstream §8 — plugin / MCPB bundle cache under userData (installer artifact retention).
 */

import path from 'node:path'

const CACHE_ROOT = 'plugin-cache'
const BUNDLES = 'bundles'

export function getPluginBundleCacheRoot(userDataPath: string): string {
  return path.join(userDataPath, CACHE_ROOT, BUNDLES)
}
