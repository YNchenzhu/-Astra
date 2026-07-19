/**
 * BriefTool (SendUserMessage) — send a proactive message to the user.
 *
 * Unlike AskUserQuestion which waits for a response, BriefTool sends
 * a one-way informational message. Useful for status updates,
 * proactive notifications, and intermediate progress reports.
 *
 * Features:
 * - Attachments: supports file paths (images rendered as base64, others as text)
 * - Permission gating: controlled via ASTRA_BRIEF_ENABLED env var
 */

import { stat, readFile } from 'fs/promises'
import path from 'node:path'
import type { ToolResult } from './types'
import { briefToolInputZod } from './toolInputZod'
import { readImageAsBase64 } from '../utils/imageResizer'
import { buildTool } from './buildTool'
import { getWorkspacePath } from './workspaceState'

/**
 * Base directory used to resolve relative attachment paths.
 *
 * `briefToolInputZod` has no `cwd` field and `ToolUseContext` carries no
 * workspace path, so without this the tool fell back to `process.cwd()` —
 * the app *install* directory in a packaged build (e.g.
 * `E:\Program Files\astra`). That made workspace-relative attachments
 * fail to resolve. Anchor to the active session workspace instead, keeping
 * `process.cwd()` only as a last-resort fallback (dev / no workspace open).
 */
function attachmentBaseDir(cwd?: string): string {
  return cwd || getWorkspacePath() || process.cwd()
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'])

/**
 * Permission gate — controls whether BriefTool is available to the model.
 *
 * Activation modes (any one enables the tool):
 * - ASTRA_BRIEF_ENABLED=true  (force enable)
 * - NODE_ENV !== 'production'     (always enabled in dev/test)
 * - Default production: disabled until explicitly enabled
 */
export function isBriefEnabled(): boolean {
  if (process.env.ASTRA_BRIEF_ENABLED === 'true') return true
  if (process.env.NODE_ENV !== 'production') return true
  return false
}

function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

/**
 * Validate that all attachment paths exist and are regular files.
 */
async function validateAttachmentPaths(rawPaths: string[], cwd?: string): Promise<{ valid: boolean; message?: string }> {
  for (const rawPath of rawPaths) {
    const fullPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd || process.cwd(), rawPath)
    try {
      const stats = await stat(fullPath)
      if (!stats.isFile()) {
        return { valid: false, message: `Attachment "${rawPath}" is not a regular file.` }
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        return { valid: false, message: `Attachment "${rawPath}" does not exist. Working directory: ${cwd || process.cwd()}.` }
      }
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        return { valid: false, message: `Attachment "${rawPath}" is not accessible (permission denied).` }
      }
      return { valid: false, message: `Attachment "${rawPath}" failed to stat: ${err.message}` }
    }
  }
  return { valid: true }
}

/**
 * Resolve attachments to ToolResult content blocks.
 * Images → base64 content blocks; others → text description.
 */
async function resolveAttachments(rawPaths: string[], cwd?: string): Promise<{ contentBlocks: ToolResult['contentBlocks']; textSummary: string }> {
  const contentBlocks: ToolResult['contentBlocks'] = []
  const summaries: string[] = []

  for (const rawPath of rawPaths) {
    const fullPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd || process.cwd(), rawPath)
    const stats = await stat(fullPath)
    const isImage = isImageFile(fullPath)

    if (isImage) {
      const result = await readImageAsBase64(fullPath)
      if (result.success && result.contentBlocks?.[0]) {
        contentBlocks.push(result.contentBlocks[0])
        summaries.push(`[📎 ${path.basename(fullPath)} (${stats.size} bytes, image)]`)
      } else {
        summaries.push(`[📎 ${path.basename(fullPath)} (image, load failed: ${result.error})]`)
      }
    } else {
      // Non-image files: read first 2KB as text summary
      try {
        const content = await readFile(fullPath, 'utf-8')
        const preview = content.slice(0, 2000)
        summaries.push(`[📎 ${path.basename(fullPath)} (${stats.size} bytes)]`)
        contentBlocks.push({
          type: 'text',
          base64: Buffer.from(`--- ${path.basename(fullPath)} ---\n${preview}${content.length > 2000 ? '\n... (truncated)' : ''}`).toString('base64'),
          mediaType: 'text/plain',
        })
      } catch {
        summaries.push(`[📎 ${path.basename(fullPath)} (${stats.size} bytes, unreadable)]`)
      }
    }
  }

  return { contentBlocks, textSummary: summaries.join('\n') }
}

export const briefTool = buildTool({
  name: 'SendUserMessage',
  zInputSchema: briefToolInputZod,
  description:
    'Send an informational message to the user without waiting for a response. ' +
    'Use for progress updates, status notifications, or proactive alerts. ' +
    'The message supports Markdown formatting. You can attach files (images, ' +
    'screenshots, logs) via the attachments parameter.',
  inputSchema: [
    { name: 'message', type: 'string', description: 'The message to display to the user (supports Markdown)', required: true },
    { name: 'status', type: 'string', description: 'Message context: "normal" for direct replies, "proactive" for background notifications', enum: ['normal', 'proactive'] },
    { name: 'attachments', type: 'array', description: 'Optional file paths to attach. Use for photos, screenshots, diffs, logs, or any file the user should see.', items: { type: 'string' } },
  ],
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultChars: 100_000,
  isEnabled: isBriefEnabled,
  validateInput: async (input) => {
    const attachments = input.attachments as string[] | undefined
    if (!attachments || attachments.length === 0) {
      return { valid: true }
    }
    return validateAttachmentPaths(attachments, attachmentBaseDir(input.cwd as string | undefined))
  },
  async call({ message, status, attachments }) {
    if (!message || !message.trim()) {
      return { success: false, error: 'message is required' }
    }

    const prefix = status === 'proactive' ? '[Proactive] ' : ''
    let attachmentSummary = ''
    let contentBlocks: ToolResult['contentBlocks'] = undefined

    if (attachments && attachments.length > 0) {
      const resolved = await resolveAttachments(attachments, attachmentBaseDir())
      attachmentSummary = `\n\n${resolved.textSummary}`
      contentBlocks = resolved.contentBlocks
    }

    return {
      success: true,
      output: `${prefix}${message.trim()}${attachmentSummary}`,
      contentBlocks,
    }
  },
})
