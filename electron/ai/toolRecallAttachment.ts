/**
 * `recall_attachment` tool — pulls back the bytes of an attachment that
 * was stripped from the conversation transcript by P2's threshold-based
 * binary stripper (`src/services/contextBuilder.ts` →
 * `<recall-pointer>`).
 *
 * Lifecycle:
 *   1. User pastes an image / drops a file. Renderer ingests the bytes;
 *      `electron/attachments/cache.ts` persists them under
 *      `(sha256, kindHint)` in `{userData}/attachment-cache/`.
 *   2. After `POLE_STRIP_BINARIES_AFTER_TURNS` user turns, the
 *      transcript serializer replaces the bytes with a
 *      `<recall-pointer kind="…" sha256="…" name="…">` text marker.
 *   3. When the model decides it needs the bytes (user asked about that
 *      specific old screenshot, debugging requires re-inspection, etc.)
 *      it calls this tool with the `sha256` + `kind` exactly as they
 *      appeared on the pointer.
 *   4. We reload the cache entry and return the appropriate
 *      `contentBlocks` (image / pdf / page images / inline images +
 *      extracted text), so the rest of the agentic loop surfaces them
 *      to the model just like a fresh attachment would.
 *
 * Caching guarantees:
 *   - Cache is opportunistically LRU-evicted at 200 MB total (see
 *     `cache.ts#evictIfOverBudget`). Recall WILL miss for very old or
 *     very large attachments. We surface that as a clear, actionable
 *     error so the model doesn't loop.
 *   - Direct clipboard images are staged via `cacheStageImage` only on
 *     conversation save. A model that recalls before the first save can
 *     get a miss; the error message hints at re-attach.
 */

import type { ToolResult } from '../tools/types'
import { buildTool } from '../tools/buildTool'
import { recallAttachmentInputZod } from '../tools/toolInputZod'
import type { IngestedAttachment } from '../attachments/types'
import { cacheGet as defaultCacheGet } from '../attachments/cache'

/**
 * Loose type for the cache lookup. Accepting a function rather than
 * importing `cacheGet` directly makes the tool unit-testable without
 * spinning up Electron's userData path or the on-disk cache.
 */
export type RecallCacheGetFn = (
  sha256: string,
  kindHint: string,
) => Promise<IngestedAttachment | null>

/**
 * Build a `ToolResult` from a hit. Exported so tests can assert on the
 * exact shape we hand back to the agentic loop.
 */
export function buildRecallSuccessResult(
  cached: IngestedAttachment,
): ToolResult {
  if (cached.type === 'image') {
    return {
      success: true,
      output: `Recalled image attachment "${cached.name}" (${cached.size} bytes, ${cached.mediaType}). The bytes are now available in the next assistant turn's content.`,
      contentBlocks: [
        {
          type: 'image',
          base64: cached.base64,
          mediaType: cached.mediaType,
          originalSize: cached.size,
        },
      ],
    }
  }
  // type === 'file' — may carry any combination of pdf bytes, page
  // images, inline (Office) images, and extracted text.
  const blocks: NonNullable<ToolResult['contentBlocks']> = []
  if (cached.pdf?.base64) {
    blocks.push({
      type: 'pdf',
      base64: cached.pdf.base64,
      originalSize: cached.size,
    })
  }
  if (cached.pageImages && cached.pageImages.length > 0) {
    for (const pi of cached.pageImages) {
      blocks.push({ type: 'image', base64: pi.base64, mediaType: pi.mediaType })
    }
  }
  if (cached.inlineImages && cached.inlineImages.length > 0) {
    for (const inl of cached.inlineImages) {
      blocks.push({ type: 'image', base64: inl.base64, mediaType: inl.mediaType })
    }
  }

  const headerBits: string[] = [
    `Recalled file attachment "${cached.name}" (${cached.kind}, ${cached.size} bytes).`,
  ]
  if (cached.pdf?.pageCount) headerBits.push(`PDF: ${cached.pdf.pageCount} pages.`)
  if (cached.pageImages?.length) headerBits.push(`${cached.pageImages.length} page image(s).`)
  if (cached.inlineImages?.length) headerBits.push(`${cached.inlineImages.length} inline image(s).`)
  if (cached.text?.content) {
    headerBits.push(`Text content: ${cached.text.content.length} chars.`)
  }

  // Include extracted text inline in `output` so even non-vision wires
  // (where contentBlocks downgrade to text notices) still get the
  // primary signal. Bound the inline copy so a 80k-char extract doesn't
  // gobble the model's reply budget — the caller can re-read the file
  // for the full body if needed.
  const output = cached.text?.content
    ? `${headerBits.join(' ')}\n\nExtracted text (first 4 KB):\n${cached.text.content.slice(0, 4096)}${cached.text.content.length > 4096 ? '\n…[truncated; call read_file on the original path for the full body]' : ''}`
    : headerBits.join(' ')

  return {
    success: true,
    output,
    contentBlocks: blocks.length > 0 ? blocks : undefined,
  }
}

/**
 * Pure implementation of recall — no side effects beyond the supplied
 * `cacheGetFn`. Tests inject a fake. Production wires to
 * `electron/attachments/cache.ts#cacheGet`.
 */
export async function executeRecallAttachment(
  input: { sha256: string; kind: string },
  cacheGetFn: RecallCacheGetFn = defaultCacheGet,
): Promise<ToolResult> {
  const sha = input.sha256.trim()
  const kind = input.kind.trim()
  if (!sha || !kind) {
    return {
      success: false,
      error:
        'recall_attachment requires both `sha256` and `kind`. Copy these verbatim from the `<recall-pointer>` tag attributes.',
      toolErrorClass: 'invalid_input',
    }
  }

  let cached: IngestedAttachment | null
  try {
    cached = await cacheGetFn(sha, kind)
  } catch (err) {
    return {
      success: false,
      error: `recall_attachment failed to read the cache: ${err instanceof Error ? err.message : String(err)}`,
      toolErrorClass: 'cache_read_error',
    }
  }

  if (!cached) {
    return {
      success: false,
      error:
        `Attachment not found in cache for sha256="${sha}" kind="${kind}". ` +
        `The bytes were either never staged (some clipboard pastes are only persisted on conversation save), ` +
        `or the cache entry has been LRU-evicted (200 MB soft cap on the on-disk cache). ` +
        `Ask the user to re-attach the original file/image if you genuinely need to inspect its bytes.`,
      toolErrorClass: 'cache_miss',
    }
  }

  return buildRecallSuccessResult(cached)
}

export const toolRecallAttachment = buildTool({
  name: 'recall_attachment',
  description:
    'Retrieve the original bytes of an attachment that was stripped from earlier turns to save tokens. ' +
    'When you see a `<recall-pointer kind="…" sha256="…" name="…">` marker in the conversation history, ' +
    'pass that exact `sha256` and `kind` to this tool to load the original image / PDF / Office document ' +
    'bytes back into your context. The tool returns the bytes as content blocks (image / pdf) plus any ' +
    'extracted text. ' +
    'IMPORTANT: do NOT call this reflexively whenever you see a recall-pointer — only call it when the ' +
    'user has explicitly asked about that specific historical attachment OR you genuinely need to ' +
    'inspect its bytes to answer. Recalling a binary you do not need wastes the entire token budget you ' +
    'just saved by stripping it. ' +
    'On a cache miss (the bytes were never persisted, or the on-disk cache evicted them under its ' +
    '200 MB LRU policy), the tool returns a clear error — at that point ask the user to re-attach ' +
    'rather than retrying with different parameters.',
  inputSchema: [
    {
      name: 'sha256',
      type: 'string',
      description:
        'The sha256 hash exactly as it appears in the recall-pointer tag\'s `sha256` attribute. ' +
        'Lowercase hex, 64 chars.',
      required: true,
    },
    {
      name: 'kind',
      type: 'string',
      description:
        'The attachment kind from the recall-pointer\'s `kind` attribute (e.g. "image", "pdf", "docx", ' +
        '"xlsx", "pptx"). Required because the cache is keyed by `(sha256, kind)`.',
      required: true,
    },
  ],
  zInputSchema: recallAttachmentInputZod,
  isReadOnly: true,
  isConcurrencySafe: true,
  searchHint: 'Recall stripped attachment bytes (image / PDF / Office) from the conversation cache.',
  async call({ sha256, kind }): Promise<ToolResult> {
    return executeRecallAttachment({ sha256, kind })
  },
})
