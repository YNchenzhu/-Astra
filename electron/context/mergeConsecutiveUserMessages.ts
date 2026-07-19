/**
 * Merge adjacent `user` messages (upstream messages.ts / Bedrock constraint parity).
 * Bedrock rejects back-to-back user turns; merging preserves intent.
 */

function toBlocks(content: unknown): Record<string, unknown>[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : []
  }
  if (Array.isArray(content)) {
    return (content as Record<string, unknown>[]).map((b) => ({ ...b }))
  }
  return [{ type: 'text', text: String(content ?? '') }]
}

function mergeUserContent(
  a: unknown,
  b: unknown,
): string | Array<Record<string, unknown>> {
  const blocks = [...toBlocks(a), ...toBlocks(b)]
  // Only collapse to a single string when BOTH originals were strings —
  // when either side was already an array of content blocks, preserve the
  // array form so downstream consumers (which may rely on block-level
  // metadata such as `cache_control`, image blocks, attachment markers)
  // do not silently lose structure. The previous "all blocks are text →
  // collapse" optimization conflated `[{text}] + "x"` with `"a\n\nb"`,
  // which broke the contract verified by `mergeConsecutiveUserMessages`
  // E23.
  const aWasArray = Array.isArray(a)
  const bWasArray = Array.isArray(b)
  const onlyText = blocks.length > 0 && blocks.every((x) => x.type === 'text')
  if (onlyText && !aWasArray && !bWasArray) {
    return blocks.map((x) => String((x as { text?: string }).text ?? '')).join('\n\n')
  }
  return blocks
}

/**
 * Returns a shallow-copied message array with consecutive `user` roles merged.
 *
 * v2/C3 fix — `_convertedFromSystem` propagation:
 *   The merged message inherits the flag ONLY when **both** sides were
 *   already `_convertedFromSystem: true`. If either side is a real user
 *   turn, the result must NOT be flagged — otherwise downstream consumers
 *   (smoosh, future pipeline stages) would treat a message containing
 *   real user text as side-channel context. Previously the spread copied
 *   the first message's flag blindly, so `[system-reminder, real user]`
 *   collapsed into a flagged message that hid the user's words.
 */
export function mergeConsecutiveUserMessages(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (messages.length < 2) return messages.map((m) => ({ ...m }))
  const out: Array<Record<string, unknown>> = []
  for (const m of messages) {
    const role = m.role as string | undefined
    if (role === 'user' && out.length > 0 && (out[out.length - 1].role as string) === 'user') {
      const prev = out[out.length - 1]
      const bothConverted =
        prev._convertedFromSystem === true && m._convertedFromSystem === true
      const merged: Record<string, unknown> = {
        ...prev,
        content: mergeUserContent(prev.content, m.content),
      }
      // AND semantics: drop flag when either side is a real user.
      if (!bothConverted && '_convertedFromSystem' in merged) {
        delete merged._convertedFromSystem
      }
      // `_sideChannelKind` is also AND-semantics: a merged turn that mixes
      // a real user turn with a side-channel reminder is no longer purely
      // side-channel. Only preserve when BOTH halves carry the same kind.
      if (!bothConverted || prev._sideChannelKind !== m._sideChannelKind) {
        if ('_sideChannelKind' in merged) delete merged._sideChannelKind
      }
      out[out.length - 1] = merged
    } else {
      out.push({ ...m })
    }
  }
  return out
}
