/**
 * Anthropic-style apiMessages → Gemini `contents` for generateContentStream.
 *
 * Mirrors the per-block conversion logic in `transformer/claudeToGemini.ts`
 * but for the apiMessage-shaped (already-flattened agentic-loop transcript)
 * input. The two paths used to diverge silently:
 *   - claudeToGemini.ts handled `tool_result` arrays with image/document
 *     children by emitting a `functionResponse` followed by sibling
 *     `inlineData` parts.
 *   - convertApiMessagesToGemini.ts simply `JSON.stringify(content)`-ed the
 *     same array, so any image returned from a tool was reduced to a JSON
 *     string the model couldn't see.
 *
 * They are now aligned — both paths defer multipart resolution to the same
 * helper and both protect against gateway-serialized JSON-string `input` /
 * `args` values.
 */

import { parseToolArguments } from './transformer/parseToolArguments'

export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | {
      functionCall: { name: string; args: Record<string, unknown> }
      thoughtSignature?: string
    }
  | { functionResponse: { name: string; response: Record<string, unknown> } }

export type GeminiContent = {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

const SYNTHETIC_FUNCTION_RESPONSE = {
  result:
    'Error: Tool execution result was unavailable after context compaction (synthetic functionResponse inserted to satisfy Gemini function-calling protocol).',
}

function repairGeminiFunctionAdjacency(contents: GeminiContent[]): GeminiContent[] {
  const out: GeminiContent[] = []
  const pendingNames: string[] = []

  const flushMissing = (): void => {
    if (pendingNames.length === 0) return
    out.push({
      role: 'user',
      parts: pendingNames.splice(0).map((name) => ({
        functionResponse: { name, response: SYNTHETIC_FUNCTION_RESPONSE },
      })),
    })
  }

  for (const content of contents) {
    const functionCallNames = content.parts
      .map((p) => ('functionCall' in p ? p.functionCall.name : undefined))
      .filter((name): name is string => typeof name === 'string' && name.length > 0)

    if (content.role === 'model' && functionCallNames.length > 0) {
      flushMissing()
      out.push(content)
      pendingNames.push(...functionCallNames)
      continue
    }

    if (content.role === 'user') {
      const matchingResponses: GeminiPart[] = []
      const remainingParts: GeminiPart[] = []
      for (const part of content.parts) {
        const name = 'functionResponse' in part ? part.functionResponse.name : undefined
        if (typeof name === 'string') {
          const idx = pendingNames.indexOf(name)
          if (idx >= 0) {
            pendingNames.splice(idx, 1)
            matchingResponses.push(part)
          }
          continue
        }
        if (matchingResponses.length > 0 && 'inlineData' in part) {
          matchingResponses.push(part)
          continue
        }
        remainingParts.push(part)
      }
      if (matchingResponses.length > 0) {
        out.push({ role: 'user', parts: matchingResponses })
      }
      flushMissing()
      if (remainingParts.length > 0) {
        out.push({ ...content, parts: remainingParts })
      }
      continue
    }

    flushMissing()
    out.push(content)
  }

  flushMissing()
  return out
}

/**
 * Convert one Anthropic-style `tool_result` block to Gemini parts.
 *
 * `tool_result.content` has three shapes:
 *   1. string                                — body is plain text
 *   2. Array<text | image | document blocks> — multipart payload
 *   3. unknown / undefined                   — degenerate; emit empty result
 *
 * For shape 2 we emit ONE `functionResponse` carrying any joined text + a
 * placeholder note when only media is present, followed by zero-or-more
 * sibling `inlineData` parts so vision-capable Gemini models can actually
 * see the image / PDF. This mirrors `transformer/claudeToGemini.ts:112-153`.
 */
function partsFromToolResult(
  b: Record<string, unknown>,
  toolUseIdToName: Map<string, string>,
): GeminiPart[] {
  const toolUseId = typeof b.tool_use_id === 'string' ? b.tool_use_id : ''
  const name =
    (typeof b.name === 'string' && b.name.trim()
      ? b.name.trim()
      : toolUseIdToName.get(toolUseId)) || 'unknown'

  // Plain string body — emit directly; empty string falls back so Gemini
  // doesn't 400 on an empty struct.
  if (typeof b.content === 'string') {
    return [
      {
        functionResponse: {
          name,
          response: { result: b.content.length > 0 ? b.content : '(empty tool result)' },
        },
      },
    ]
  }

  // Array body — split into text + image/document children. Concatenate
  // text into the functionResponse `result`; trailing media becomes
  // sibling parts.
  if (Array.isArray(b.content)) {
    let textAccum = ''
    const mediaInlineParts: GeminiPart[] = []
    for (const c of b.content as Array<Record<string, unknown>>) {
      if (c.type === 'text' && typeof c.text === 'string') {
        textAccum += (textAccum ? '\n' : '') + c.text
      }
      if (c.type === 'image') {
        const src = (c as { source?: Record<string, unknown> }).source
        const data = src && typeof src.data === 'string' ? src.data : ''
        const mime =
          src && typeof src.media_type === 'string' ? src.media_type : 'image/png'
        if (data.trim()) {
          mediaInlineParts.push({ inlineData: { mimeType: mime, data } })
        }
      }
      if (c.type === 'document') {
        const src = (c as { source?: Record<string, unknown> }).source
        const data = src && typeof src.data === 'string' ? src.data : ''
        const mime =
          src && typeof src.media_type === 'string' ? src.media_type : 'application/pdf'
        if (data.trim()) {
          mediaInlineParts.push({ inlineData: { mimeType: mime, data } })
        }
      }
    }
    const responseStruct: Record<string, unknown> =
      textAccum.length > 0
        ? { result: textAccum }
        : mediaInlineParts.length > 0
          ? { result: `[${mediaInlineParts.length} file(s) attached]` }
          : { result: '(empty tool result)' }
    return [
      { functionResponse: { name, response: responseStruct } },
      ...mediaInlineParts,
    ]
  }

  // Degenerate (undefined / null / number / boolean) — JSON-encode for
  // legibility, fall back to empty marker on undefined.
  const fallback =
    b.content === undefined || b.content === null
      ? '(empty tool result)'
      : JSON.stringify(b.content)
  return [{ functionResponse: { name, response: { result: fallback } } }]
}

/**
 * Convert agentic loop's Anthropic-format apiMessages to Gemini contents format.
 *
 * Handles:
 *  - Simple string content → single text part on the matching role turn
 *  - Assistant `tool_use` blocks → `functionCall` parts on a `model` turn
 *    (gateway-serialized JSON-string `input` is parsed via
 *    `parseToolArguments` so it survives history replay through compat
 *    proxies that re-encode tool args as strings)
 *  - User `tool_result` blocks → `functionResponse` (+ optional sibling
 *    `inlineData` parts when the tool returned images / documents)
 *  - User `image` blocks → `inlineData` parts directly on the user turn
 *  - User `document` blocks → `inlineData` parts (Gemini accepts PDF/MD/etc.)
 *
 * Per Gemini SDK contract, `systemPrompt` belongs in
 * `ModelParams.systemInstruction`, NOT inside `contents`. The previous fake
 * `[user(system), model(ack)]` workaround has been removed; the caller
 * (`providers/gemini.ts:streamGemini`) is now responsible for setting
 * systemInstruction on the model config. Passing `systemPrompt` here would
 * silently double-up, so the parameter is gone.
 */
export function convertApiMessagesToGemini(
  apiMessages: Array<Record<string, unknown>>,
): GeminiContent[] {
  const result: GeminiContent[] = []
  /** tool_result 只有 tool_use_id，必须用上一轮 assistant 的 id→name 映射出 functionResponse.name */
  const toolUseIdToName = new Map<string, string>()

  for (const msg of apiMessages) {
    const role = msg.role as string
    const content = msg.content

    if (typeof content === 'string') {
      const geminiRole = role === 'assistant' ? 'model' : 'user'
      result.push({ role: geminiRole, parts: [{ text: content }] })
      continue
    }

    if (!Array.isArray(content)) {
      continue
    }

    if (role === 'assistant') {
      const parts: GeminiPart[] = []
      for (const block of content) {
        const b = block as Record<string, unknown>
        if (b.type === 'text') {
          parts.push({ text: typeof b.text === 'string' ? b.text : String(b.text ?? '') })
        } else if (b.type === 'tool_use') {
          const tuId = typeof b.id === 'string' ? b.id : ''
          const tuName = typeof b.name === 'string' ? b.name : 'unknown'
          if (tuId) toolUseIdToName.set(tuId, tuName)
          // Robust args parse: history replay through some Anthropic-compat
          // proxies re-serializes tool_use input as a JSON string. The bare
          // `(b.input as Record) || {}` cast used to coerce that to {} → all
          // historical tool calls would lose their args mid-conversation
          // and the model would hallucinate a "fresh" call.
          const args = parseToolArguments(b.input)
          const fc: GeminiPart = {
            functionCall: { name: tuName, args },
          }
          const sig = typeof b.thoughtSignature === 'string' ? b.thoughtSignature : undefined
          if (sig && sig.length > 0) {
            ;(fc as { thoughtSignature?: string }).thoughtSignature = sig
          }
          parts.push(fc)
        }
      }
      if (parts.length > 0) {
        result.push({ role: 'model', parts })
      }
      continue
    }

    // role === 'user' (or anything else routed as user)
    const parts: GeminiPart[] = []
    for (const block of content) {
      const b = block as Record<string, unknown>
      if (b.type === 'text') {
        parts.push({ text: typeof b.text === 'string' ? b.text : String(b.text ?? '') })
      } else if (b.type === 'image') {
        const src = b.source as Record<string, unknown> | undefined
        const data = src && typeof src.data === 'string' ? src.data : ''
        const mime =
          src && typeof src.media_type === 'string' ? src.media_type : 'image/png'
        if (data) {
          parts.push({ inlineData: { mimeType: mime, data } })
        }
      } else if (b.type === 'document') {
        const src = b.source as Record<string, unknown> | undefined
        const data = src && typeof src.data === 'string' ? src.data : ''
        const mime =
          src && typeof src.media_type === 'string' ? src.media_type : 'application/pdf'
        if (data) {
          parts.push({ inlineData: { mimeType: mime, data } })
        }
      } else if (b.type === 'tool_result') {
        for (const p of partsFromToolResult(b, toolUseIdToName)) {
          parts.push(p)
        }
      }
    }
    if (parts.length > 0) {
      result.push({ role: 'user', parts })
    }
  }

  return repairGeminiFunctionAdjacency(result)
}
