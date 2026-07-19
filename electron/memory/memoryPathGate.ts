/**
 * Resolves whether a path is under an intentional memory write root (upstream §2.5 / §4 tool allowlist).
 * Used by Write/Edit pre-flight so `.claude`-segment paths like `.claude/memory` are not blocked as "protected".
 */

import path from 'node:path'

import { getWorkspacePath } from '../tools/workspaceState'
import { getSessionMemoryRootDir } from '../session/sessionMemoryPaths'
import { userMemoryDir, resolveWorkspaceMemoryDir } from './storage'
import { isKnownMemoryPath } from './pathSafety'
import { isAgentMemoryPath } from './agentMemory'
import { getMemoryBundleDataRoot } from './service'

/**
 * True when `resolvedPath` is under user / project / team / flat session-memory roots, or agent-memory trees.
 * Project-scoped session memory under ~/.claude/projects/.../session-memory/ is handled separately via
 * isUnderSessionMemoryWritableRoot in fileToolValidation.ts.
 */
export function isResolvedPathInKnownMemoryWritableTree(resolvedPath: string): boolean {
  const ws = getWorkspacePath()?.trim()
  const bundleRoot = getMemoryBundleDataRoot().trim()
  const under = isKnownMemoryPath(resolvedPath, {
    userMemoryDir: bundleRoot ? userMemoryDir(bundleRoot) : undefined,
    workspaceMemoryDir: ws ? resolveWorkspaceMemoryDir(ws) : undefined,
    teamMemoryDir: ws ? path.join(ws, '.claude', 'team-memory') : undefined,
    sessionMemoryDir: getSessionMemoryRootDir(),
  })
  if (under) return true
  if (ws && isAgentMemoryPath(resolvedPath, ws)) return true
  return false
}
