/**
 * Best-effort removal of process narration before the first substantive section
 * in sub-agent text returned to the parent. Models often prepend "我将…/Let me…"
 * despite system instructions; this trims only when cues + a clear cut point match.
 */

const FILLER_CUE_RE =
  /我将|我先|让我|我来|以便了解|制定全面|全面的开发计划|检查一下|查看一下|详细查看|项目处于|早期(?:的)?原型|现在(?:我已)?完全理解|可以交付|交付全面|^好的[。.]|Let me |I'll |I will |First, I |Now that I (?:have |fully |understand)/i

/** Prefix must be at least this long before we consider stripping (avoid false positives). */
const MIN_PREFIX_TO_STRIP = 80

/** Substantive tail after cut must retain at least this many chars. */
const MIN_REST = 24

function firstStructuralCutIndex(text: string): number {
  let best = -1
  const candidates = [
    /\n(#{2,6}\s+\S)/,
    /\n```[\t ]*\r?\n/,
    /\nVERDICT:\s*/im,
    /\n\*\*Summary\*\*/i,
  ]
  for (const re of candidates) {
    const m = re.exec(text)
    if (!m) continue
    const idx = m.index + 1
    if (idx >= 0 && (best < 0 || idx < best)) best = idx
  }
  return best
}

/**
 * If a long filler-like prefix appears before the first `##`/`###`/fence/VERDICT/Summary,
 * drop the prefix. Otherwise return `text` unchanged.
 */
export function stripLeadingSubAgentProcessNarration(text: string): string {
  const t = text.trim()
  if (t.length < MIN_PREFIX_TO_STRIP + MIN_REST) return t

  // No /m: with multiline ^ would match "### …" on a later line and skip stripping wrongly.
  if (/^(#{2,6}\s|```|VERDICT:|\*\*Summary\*\*)/i.test(t)) return t

  const cut = firstStructuralCutIndex(t)
  if (cut < MIN_PREFIX_TO_STRIP) return t

  const prefix = t.slice(0, cut).trim()
  const rest = t.slice(cut).trim()
  if (rest.length < MIN_REST) return t

  const hasStructuralInPrefix = /```/.test(prefix) || /^#{2,6}\s/m.test(prefix)
  if (hasStructuralInPrefix) return t

  if (FILLER_CUE_RE.test(prefix)) return rest
  return t
}
