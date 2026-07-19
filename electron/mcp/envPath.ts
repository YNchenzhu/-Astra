/**
 * Windows uses `Path` (mixed case) while Unix uses `PATH`. cross-spawn/npm use `path-key`
 * to resolve which key is in effect; MCP env must read/update the same key.
 */

import pathKey from 'path-key'

export function getPathFromEnv(env: Record<string, string>): string {
  const k = pathKey({ env, platform: process.platform })
  const v = env[k]
  return typeof v === 'string' ? v : ''
}

/** Replace all PATH-like keys with a single canonical key so spawn/which see one value. */
export function setPathOnEnv(env: Record<string, string>, value: string): void {
  if (process.platform === 'win32') {
    for (const key of [...Object.keys(env)]) {
      if (key.toUpperCase() === 'PATH') {
        delete env[key]
      }
    }
    const k = pathKey({ env, platform: 'win32' })
    env[k] = value
  } else {
    env.PATH = value
  }
}
