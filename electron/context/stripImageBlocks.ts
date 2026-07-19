/**
 * Strip image / media content blocks from API messages.
 *
 * upstream §10.5 Layer 5 — when the model rejects a request because an attached
 * image is too large or malformed, the loop's recovery path retries the
 * same turn after physically removing the offending media. We don't know
 * which image triggered the failure (provider errors don't carry block
 * indices), so we strip **all** images from the transcript and let the
 * model proceed with text only. The user-visible signal is a
 * `stripped_image` context-compact event so the UI can show "1 image was
 * removed because the model couldn't process it".
 *
 * Block shapes recognised across providers:
 *   - Anthropic: `{type:'image', source:{type:'base64'|'url', ...}}`
 *   - OpenAI:    `{type:'image_url', image_url:{url, detail?}}`
 *   - Generic:   `{type:'media'|'document', ...}` — providers like Gemini
 *                 use these for non-text payloads.
 *
 * The function never mutates input. It returns a new array (or the same
 * reference when nothing was stripped) plus a count of removed blocks.
 */

const IMAGE_BLOCK_TYPES = new Set(['image', 'image_url', 'media', 'document', 'input_image'])

export type StripImageBlocksResult = {
  messages: Array<Record<string, unknown>>
  strippedCount: number
}

function isImageBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false
  const t = (block as { type?: unknown }).type
  return typeof t === 'string' && IMAGE_BLOCK_TYPES.has(t)
}

/**
 * Return a copy of `messages` with all image-shaped content blocks removed.
 * Tool-result blocks may also embed images (Anthropic shape:
 * `tool_result.content: [{type:'text'}, {type:'image'}]`); those nested
 * arrays are walked too.
 *
 * Messages whose `content` becomes empty after stripping are replaced with
 * a placeholder text block to keep the API contract intact (Anthropic
 * rejects messages with empty `content`).
 */
export function stripImageBlocks(
  messages: ReadonlyArray<Record<string, unknown>>,
): StripImageBlocksResult {
  let strippedCount = 0
  const out: Array<Record<string, unknown>> = []
  let anyChanged = false

  for (const msg of messages) {
    const content = msg.content
    if (typeof content === 'string') {
      out.push(msg)
      continue
    }
    if (!Array.isArray(content)) {
      out.push(msg)
      continue
    }
    const filtered: Array<Record<string, unknown>> = []
    let msgChanged = false

    for (const block of content as Array<Record<string, unknown>>) {
      if (isImageBlock(block)) {
        strippedCount++
        msgChanged = true
        continue
      }
      // Tool-result content may itself be a string OR an array of blocks
      // including images. Recurse only into the array case.
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'tool_result' &&
        Array.isArray((block as { content?: unknown }).content)
      ) {
        const inner = (block as { content: Array<Record<string, unknown>> }).content
        const innerKept: Array<Record<string, unknown>> = []
        let innerChanged = false
        for (const sub of inner) {
          if (isImageBlock(sub)) {
            strippedCount++
            innerChanged = true
            continue
          }
          innerKept.push(sub)
        }
        if (innerChanged) {
          msgChanged = true
          // Empty tool_result content is illegal — substitute a marker.
          const finalContent =
            innerKept.length > 0
              ? innerKept
              : [{ type: 'text', text: '[image stripped: model could not process it]' }]
          filtered.push({ ...block, content: finalContent })
        } else {
          filtered.push(block)
        }
        continue
      }
      filtered.push(block)
    }

    if (msgChanged) {
      anyChanged = true
      const finalBlocks =
        filtered.length > 0
          ? filtered
          : [{ type: 'text', text: '[image stripped: model could not process it]' }]
      out.push({ ...msg, content: finalBlocks })
    } else {
      out.push(msg)
    }
  }

  return {
    messages: anyChanged ? out : (messages as Array<Record<string, unknown>>),
    strippedCount,
  }
}
