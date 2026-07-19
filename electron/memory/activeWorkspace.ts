/**
 * Tiny shim: exposes the active workspace id used by memory-related vector
 * caches.
 *
 * Why a separate file? `embeddingRecall.ts` lives outside `electron/tools/`
 * and importing `workspaceState` directly from there pulls a chunk of
 * unrelated tool-runtime state into the memory module's TS dependency graph.
 * This shim normalizes the answer ("a stable workspace id, or 'global'")
 * without dragging the rest of the workspace tooling along.
 *
 * Stability rules:
 *   - Always lowercased + path-normalized so `D:\Foo` and `d:/foo/` both
 *     resolve to the same id.
 *   - Never returns an empty string — falls back to `'global'` so the
 *     memory namespace always has a deterministic source key.
 */

import path from 'node:path'
import { getWorkspacePath } from '../tools/workspaceState'

export function getActiveMemoryWorkspaceId(): string {
  const ws = (getWorkspacePath() || '').trim()
  if (!ws) return 'global'
  return path.resolve(ws).replace(/\\/g, '/').toLowerCase()
}
