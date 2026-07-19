/**
 * Skill `effort` frontmatter → API/runtime (aligned with upstream EffortLevel).
 */

export type SkillEffort = 'low' | 'medium' | 'high' | 'max'

const LEVELS = new Set<string>(['low', 'medium', 'high', 'max'])

export function parseSkillEffort(raw: unknown): SkillEffort | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const s = String(raw).trim().toLowerCase()
  if (LEVELS.has(s)) return s as SkillEffort
  return undefined
}

/** Best-effort: newer Claude IDs and DeepSeek Anthropic-compat models support `output_config.effort`. */
export function anthropicModelLikelySupportsEffort(modelId: string): boolean {
  const m = modelId.toLowerCase().replace(/\[1m\]$/i, '')
  if (m.includes('haiku')) return false
  if (m.includes('deepseek-v4')) return true
  if (m.includes('opus-4-6') || m.includes('sonnet-4-6')) return true
  if (m.includes('opus-4') || m.includes('sonnet-4')) return true
  return false
}

/** For OpenAI/Gemini where effort is not a first-class API field. */
export function adjustMaxTokensForEffort(
  maxTokens: number | undefined,
  effort: SkillEffort | undefined,
): number {
  const base = maxTokens ?? 8192
  if (!effort) return base
  switch (effort) {
    case 'low':
      return Math.max(1024, Math.floor(base * 0.85))
    case 'medium':
      return base
    case 'high':
      return Math.min(Math.ceil(base * 1.12), 32768)
    case 'max':
      return Math.min(Math.ceil(base * 1.2), 32768)
    default:
      return base
  }
}
