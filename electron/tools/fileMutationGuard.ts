/**
 * Centralized guard against destructive empty writes.
 *
 * Closes the systemic gap identified in `空写入覆盖原因调查报告.md`:
 *
 * Previously each tool (`toolWriteFile`, `toolEditFile`, NotebookEditTool) had its
 * own ad-hoc `if (content === '') reject` check. That left at least three holes:
 *
 *   1. MCP server-provided `write_file` never went through any such check — its
 *      `execute` just forwarded to the MCP client (see `electron/mcp/registry.ts`).
 *   2. A `PreToolUse` hook could rewrite `input.content` to `""` after the tool's
 *      own Zod pass, and the destructive check inside the tool relied on
 *      `fs.existsSync(...)` which has a TOCTOU window.
 *   3. Direct IPC execution (`tool:execute-ui`) or renderer-driven calls bypassed
 *      the agentic loop's gates entirely.
 *
 * This module centralizes the invariant as one pure function and one wiring
 * point: {@link guardAgainstDestructiveEmptyWrite} is invoked from
 * {@link toolRegistry.execute}, which is the *single* execution funnel all four
 * paths (agentic loop, IPC UI, MCP bridge, direct ops) flow through. The tool
 * implementations keep their internal checks as defense-in-depth, but the
 * invariant no longer depends on every caller remembering to apply it.
 *
 * Semantics:
 *   - `write_file(path, content='')` with a non-empty file on disk → REJECT.
 *   - `write_file(path, content='')` with no file on disk → ALLOW (legit `touch`).
 *   - `write_file(path, content='non-empty')` → ALLOW.
 *   - `edit_file` with both oldString/newString empty → REJECT (no-op destructive).
 *   - `edit_file` with `oldString === ''` on a non-empty file → REJECT.
 *   - MCP `mcp__*__write_file(path/content)` → same rules as builtin `write_file`.
 *   - Non-mutating tools → pass through unchanged.
 *
 * All decisions are based on the on-disk state at call time; the TOCTOU window
 * is further closed inside the tool implementations by re-checking under the
 * exclusive file lock.
 */

import fs from 'node:fs'
import { resolvePathForTool } from './workspaceState'
import {
  isBuiltinFileMutationTool,
  isBuiltinFullFileWriteTool,
  isBuiltinEditTool,
  isBuiltinMultiEditTool,
  isMcpWorkspaceMutationTool,
  isMcpWorkspaceFullWriteTool,
  extractWorkspaceFilePathFromToolInput,
  getMcpBridgedToolSuffix,
} from './builtinToolAliases'

export type MutationGuardResult = { ok: true } | { ok: false; error: string }

/**
 * Extract the string being written by a write-style tool. Handles:
 *   - builtin `write_file`: `input.content`
 *   - MCP filesystem `write_file`: `input.content` (canonical) or `input.text` (some forks)
 *   - Other mutation tools: returns `undefined` (edit-style tools do not take raw content).
 */
function extractWriteContent(toolName: string, input: Record<string, unknown>): string | undefined {
  const isFullWrite =
    isBuiltinFullFileWriteTool(toolName) || isMcpWorkspaceFullWriteTool(toolName)
  if (!isFullWrite) return undefined
  const candidates = [input.content, (input as { text?: unknown }).text]
  for (const c of candidates) {
    if (typeof c === 'string') return c
  }
  return undefined
}

/**
 * Extract the old/new pair for an edit-style tool. Returns `null` if not edit.
 */
function extractEditPair(
  toolName: string,
  input: Record<string, unknown>,
): { oldString: string; newString: string } | null {
  const isBuiltin = isBuiltinEditTool(toolName)
  const isMcpEdit = getMcpBridgedToolSuffix(toolName)?.toLowerCase() === 'edit_file'
  if (!isBuiltin && !isMcpEdit) return null

  // MCP edit_file: edits = [{ oldText / newText }] (also accept snake_case aliases)
  if (isMcpEdit) {
    const edits = Array.isArray(input.edits)
      ? (input.edits as Array<Record<string, unknown>>)
      : undefined
    const oldString = String(edits?.[0]?.oldText ?? edits?.[0]?.old_string ?? '')
    const newString = String(edits?.[0]?.newText ?? edits?.[0]?.new_string ?? '')
    return { oldString, newString }
  }

  // Built-in Edit: oldString / newString at top level
  const oldString =
    typeof input.oldString === 'string'
      ? input.oldString
      : typeof input.old_string === 'string'
        ? input.old_string
        : ''
  const newString =
    typeof input.newString === 'string'
      ? input.newString
      : typeof input.new_string === 'string'
        ? input.new_string
        : ''
  return { oldString, newString }
}

/**
 * Extract per-edit `{oldString, newString}` pairs for the builtin multi-edit
 * batch tool. Returns `null` if the tool is not multi-edit. Same field-alias
 * tolerance as {@link extractEditPair} (camelCase + snake_case).
 *
 * The whole batch is what we surface here so the central guard can refuse a
 * batch where ANY entry would be destructive — independent of order. The
 * tool implementation re-validates each entry too (defense-in-depth).
 */
function extractMultiEditPairs(
  toolName: string,
  input: Record<string, unknown>,
): Array<{ oldString: string; newString: string }> | null {
  if (!isBuiltinMultiEditTool(toolName)) return null
  const rawEdits = input.edits
  if (!Array.isArray(rawEdits)) return null
  const out: Array<{ oldString: string; newString: string }> = []
  for (const e of rawEdits) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue
    const rec = e as Record<string, unknown>
    const oldString =
      typeof rec.oldString === 'string'
        ? rec.oldString
        : typeof rec.old_string === 'string'
          ? rec.old_string
          : ''
    const newString =
      typeof rec.newString === 'string'
        ? rec.newString
        : typeof rec.new_string === 'string'
          ? rec.new_string
          : ''
    out.push({ oldString, newString })
  }
  return out
}

/**
 * `true` for any tool that could write to a workspace file (builtin or MCP).
 */
function isWriteCapableTool(toolName: string): boolean {
  return isBuiltinFileMutationTool(toolName) || isMcpWorkspaceMutationTool(toolName)
}

/**
 * Read the current file state from disk. Returns:
 *   - `{ exists: false }` if the target does not exist (or is not a regular file)
 *   - `{ exists: true, size }` otherwise.
 *
 * Bytes-on-disk is preferred over reading the full content for the hot guard path —
 * we only need to know whether the file is currently non-empty.
 */
function probeDiskState(resolvedPath: string): { exists: false } | { exists: true; size: number } {
  try {
    const st = fs.statSync(resolvedPath)
    if (!st.isFile()) return { exists: false }
    return { exists: true, size: st.size }
  } catch {
    return { exists: false }
  }
}

/**
 * The single invariant enforcer for destructive empty writes. See module doc.
 */
export function guardAgainstDestructiveEmptyWrite(
  toolName: string,
  input: Record<string, unknown>,
): MutationGuardResult {
  if (!isWriteCapableTool(toolName)) return { ok: true }

  const rawPath = extractWorkspaceFilePathFromToolInput(input)
  if (!rawPath) return { ok: true } // let the tool's own validator handle missing path
  const resolved = resolvePathForTool(rawPath)
  if (!resolved.ok) return { ok: true } // same — the tool returns a clearer error
  const disk = probeDiskState(resolved.resolved)

  // ── Full-file write (builtin write_file, MCP write_file) ──
  const writeContent = extractWriteContent(toolName, input)
  if (writeContent !== undefined) {
    if (writeContent === '' && disk.exists && disk.size > 0) {
      return {
        ok: false,
        error:
          `Refusing empty write to "${rawPath}" — the file currently has ${disk.size} bytes on disk ` +
          `and would be cleared. Call Delete/rm explicitly if you mean to remove it, or pass a ` +
          `non-empty payload if you mean to replace its contents.`,
      }
    }
    return { ok: true }
  }

  // ── Edit-style (builtin edit_file, MCP edit_file) ──
  const edit = extractEditPair(toolName, input)
  if (edit) {
    if (edit.oldString === '' && edit.newString === '') {
      return {
        ok: false,
        error:
          `Refusing empty edit on "${rawPath}" — both oldString and newString are empty, which is a no-op.`,
      }
    }
    // `oldString === ''` on a non-empty file would replace the entire contents
    // with `newString`. If `newString` is also empty we already caught it above.
    // If `newString` is non-empty, the tool implementation still enforces
    // the "create-intent on empty disk only" rule.
    if (edit.oldString === '' && disk.exists && disk.size > 0) {
      return {
        ok: false,
        error:
          `Refusing edit with empty oldString against non-empty file "${rawPath}" — this would ` +
          `clobber the file. Use write_file for a deliberate full-file replacement, or pass a ` +
          `concrete oldString to target a specific substring.`,
      }
    }
    return { ok: true }
  }

  // ── Multi-edit batch (builtin multi_edit_file) ──
  // Apply the same destructive-empty-write rules to EVERY entry. The batch
  // is destructive if ANY entry is destructive — refuse the whole call so
  // the tool layer never sees a half-validated batch. Mirrors the per-edit
  // checks in the single-edit branch above (`oldString===newString===''`
  // and `oldString===''` on non-empty disk).
  const multiEdits = extractMultiEditPairs(toolName, input)
  if (multiEdits) {
    for (let i = 0; i < multiEdits.length; i++) {
      const e = multiEdits[i]!
      if (e.oldString === '' && e.newString === '') {
        return {
          ok: false,
          error:
            `Refusing multi_edit_file on "${rawPath}" — edit #${i + 1} has both oldString and newString empty, which is a no-op.`,
        }
      }
      if (e.oldString === '' && disk.exists && disk.size > 0) {
        return {
          ok: false,
          error:
            `Refusing multi_edit_file on "${rawPath}" — edit #${i + 1} has an empty oldString against a non-empty file, which would clobber the file. ` +
            `Use write_file for a deliberate full-file replacement, or pass a concrete oldString to target a specific substring.`,
        }
      }
    }
    return { ok: true }
  }

  return { ok: true }
}
