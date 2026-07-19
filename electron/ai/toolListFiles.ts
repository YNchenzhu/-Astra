/**
 * List-files tool — list files in a directory.
 */

import fs from 'node:fs'
import { resolvePathForTool } from '../tools/workspaceState'
import { getWorkspacePath } from '../tools/workspaceState'
import type { ToolResult } from '../tools/types'
import { buildToolFailure, formatUnexpectedToolError } from '../tools/toolErrorFormat'
import { buildFuzzyNotFoundError } from '../tools/fuzzyPathError'
import {
  noteSuccessfulDiscovery,
  noteFailedDiscovery,
} from './toolReadFile'

/**
 * Render the not-found error with all the context the AI needs to self-correct on its
 * next call: the closest sibling (when found), the full subdirectory listing of the
 * deepest-existing parent, and explicit "do NOT guess again" guidance after the second
 * consecutive miss.
 *
 * Heuristic implementation lives in `electron/tools/fuzzyPathError.ts` so other
 * path-taking tools (`excel_*`, `glob`) share the same self-correction shape.
 */
function buildNotFoundError(args: {
  inputPath: string
  resolvedPath: string
  workspace: string | undefined
  consecutiveFailures: number
}): ToolResult {
  const { inputPath, resolvedPath, workspace, consecutiveFailures } = args

  // ── Hard-block: AI is clearly hallucinating; stop the bleed ──
  if (consecutiveFailures >= 2) {
    return {
      success: false,
      ...buildToolFailure({
        what:
          `list_files BLOCKED: directory not found: ${inputPath} — and this is the ` +
          `${consecutiveFailures}th consecutive failed discovery call.`,
        tried: [resolvedPath],
        context: { workspace: workspace ?? '(none)' },
        next: [
          'You are guessing paths that do not exist. STOP guessing.',
          'Use glob with a directory-name pattern (e.g. glob pattern:"**/<basename>", or "**/*<basename>*").',
          'Or call list_files on the workspace root and inspect the actual structure.',
          'Only call list_files again AFTER you have confirmed the path exists.',
        ],
      }, 'not_found'),
    }
  }

  return {
    success: false,
    ...buildFuzzyNotFoundError({
      toolName: 'list_files',
      kind: 'directory',
      inputPath,
      resolvedPath,
      workspace,
      extraNext: [
        workspace
          ? 'Use a path relative to the workspace root, or an absolute path. Do NOT retry with another guessed path.'
          : 'No workspace is open; pass an absolute path.',
      ],
    }),
  }
}

/**
 * List files matching a glob-like pattern in a directory.
 * Simple implementation: just lists files in the directory.
 */
export function toolListFiles(dirPath: string): ToolResult {
  try {
    if (typeof dirPath !== 'string' || !dirPath.trim()) {
      return {
        success: false,
        ...buildToolFailure({
          what: 'list_files: `dirPath` is missing or empty.',
          next: 'Pass a directory path (absolute or relative to the workspace root).',
        }, 'validation'),
      }
    }
    const resolveResult = resolvePathForTool(dirPath)
    if (!resolveResult.ok) {
      return { success: false, error: resolveResult.reason }
    }
    const resolvedPath = resolveResult.resolved
    if (!fs.existsSync(resolvedPath)) {
      const consecutiveFailures = noteFailedDiscovery()
      return buildNotFoundError({
        inputPath: dirPath,
        resolvedPath,
        workspace: getWorkspacePath() ?? undefined,
        consecutiveFailures,
      })
    }
    const stat = fs.statSync(resolvedPath)
    if (!stat.isDirectory()) {
      return {
        success: false,
        ...buildToolFailure({
          what: `list_files: \`dirPath\` is a file, not a directory: ${dirPath}`,
          tried: [resolvedPath],
          next: 'Use the `read_file` tool to read this file, or pass the parent directory.',
        }, 'validation'),
      }
    }

    const entries = fs.readdirSync(resolvedPath, { withFileTypes: true })
    const output = entries
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => e.isDirectory() ? `${e.name}/` : e.name)
      .join('\n')

    // Reset the cross-tool guessing counter — a successful directory listing means
    // the AI is no longer flying blind.
    noteSuccessfulDiscovery()

    return { success: true, output }
  } catch (error) {
    return {
      success: false,
      error: formatUnexpectedToolError('list_files', error),
    }
  }
}
