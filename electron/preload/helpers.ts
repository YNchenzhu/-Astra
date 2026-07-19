/**
 * Shared helpers used by every domain builder under `electron/preload/*`.
 *
 * This file must stay free of `node:*` builtins — the renderer sandbox
 * runs preload in an environment where `preloadRequire` cannot load
 * Node's built-in `path`/`os`/etc. modules.
 */

/**
 * Join workspace root + relative path without `node:path`.
 * Renderer sandbox runs preload in an environment where `node:*` builtins
 * are not available to `preloadRequire`.
 */
export function joinWorkspacePath(root: string, rel: string): string {
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const r = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  return `${base}/${r}`
}

/** IPC payload from main process for `ai:stream-event` (aligns with renderer `StreamEvent`). */
export type AiStreamEventPayload = Record<string, unknown>
