/**
 * When Gemini omits structured `part.thought`, some models stream English chain-of-thought
 * in `part.text` then the user-facing reply (often CJK). Split on `\n\n` + CJK start with a
 * Latin-heavy prefix guard to route the prefix to {@link StreamCallbacks.onThinkingDelta}.
 */

const MIN_THINKING_CHARS = 24
/** If the model never uses `\n\n`, it is unlikely our CJK split heuristic applies — stream as normal text. */
const PASSTHROUGH_NO_PARAGRAPH_BREAK = 360
/** Avoid unbounded buffering when thinking never ends with CJK answer */
const MAX_HOLD_CHARS = 24_000

/** Latin letters / common punctuation in English reasoning (not CJK). */
function latinHeavyPrefixRatio(s: string): number {
  if (!s.length) return 0
  let latin = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++
  }
  return latin / s.length
}

/**
 * If `buf` contains a blank-line gap followed by text that starts with CJK, and the prefix
 * is mostly Latin, return split indices. Otherwise null (keep buffering).
 */
export function findGeminiInlineThoughtSplit(buf: string): {
  thinkingEnd: number
  answerStart: number
} | null {
  if (buf.length < MIN_THINKING_CHARS) return null
  const re = /\n\n+\s*(?=[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af])/
  const m = re.exec(buf)
  if (!m || m.index < MIN_THINKING_CHARS) return null
  const prefix = buf.slice(0, m.index)
  if (latinHeavyPrefixRatio(prefix) < 0.12) return null
  return { thinkingEnd: m.index, answerStart: m.index + m[0].length }
}

export type GeminiTextThoughtSplitter = {
  pushTextChunk: (chunk: string) => void
  /** Call after stream end if no further text; flushes buffered thinking-only tail as main text */
  flush: () => void
}

export function createGeminiTextThoughtSplitter(options: {
  onThinkingDelta?: (text: string) => void
  onTextDelta: (text: string) => void
}): GeminiTextThoughtSplitter {
  let phase: 'buffering' | 'answer' = 'buffering'
  let buf = ''

  const pushTextChunk = (chunk: string) => {
    if (!chunk) return
    if (phase === 'answer') {
      options.onTextDelta(chunk)
      return
    }
    buf += chunk

    const split = findGeminiInlineThoughtSplit(buf)
    if (split) {
      const think = buf.slice(0, split.thinkingEnd).trimEnd()
      const answer = buf.slice(split.answerStart)
      buf = ''
      phase = 'answer'
      if (think.length > 0 && options.onThinkingDelta) {
        options.onThinkingDelta(think)
      }
      if (answer.length > 0) {
        options.onTextDelta(answer)
      }
      return
    }

    if (buf.length >= MAX_HOLD_CHARS) {
      phase = 'answer'
      options.onTextDelta(buf)
      buf = ''
      return
    }

    if (buf.length >= PASSTHROUGH_NO_PARAGRAPH_BREAK && !buf.includes('\n\n')) {
      phase = 'answer'
      options.onTextDelta(buf)
      buf = ''
    }
  }

  const flush = () => {
    if (phase === 'buffering' && buf.length > 0) {
      options.onTextDelta(buf)
      buf = ''
    }
  }

  return { pushTextChunk, flush }
}
