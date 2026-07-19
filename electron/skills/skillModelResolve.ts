/**
 * Resolve skill `model:` aliases and carry `[1m]` like upstream `resolveSkillModelOverride`.
 */

import type { ProviderId } from '../ai/client'
import { getModelsForProvider } from '../ai/client'

const ONE_M_SUFFIX = /\[1m\]$/i

export function has1mContext(model: string): boolean {
  return ONE_M_SUFFIX.test(model.trim())
}

export function strip1mSuffix(model: string): string {
  return model.trim().replace(ONE_M_SUFFIX, '').trim()
}

/**
 * After alias resolution, whether appending `[1m]` is meaningful (Sonnet/Opus-class, not Haiku).
 */
export function resolvedModelSupports1mCarry(resolvedBase: string): boolean {
  const m = strip1mSuffix(resolvedBase).toLowerCase()
  if (m.includes('haiku')) return false
  if (m.includes('opus') || m.includes('sonnet')) return true
  return false
}

function pickModel(
  providerId: ProviderId,
  match: (name: string, id: string) => boolean,
): string | undefined {
  const models = getModelsForProvider(providerId)
  const found = models.find((opt) => match(opt.name.toLowerCase(), opt.id.toLowerCase()))
  return found?.id
}

/**
 * Map short names (opus / sonnet / haiku) to this app's default model id for the provider.
 * If the string already looks like a full deployment id, return it unchanged (trimmed).
 */
export function resolveSkillModelAlias(skillModel: string, providerId: ProviderId): string {
  const trimmed = skillModel.trim()
  const base = strip1mSuffix(trimmed)
  const lower = base.toLowerCase()

  const looksLikeFullId =
    /^claude-|^gpt-|^gemini-|^o[0-9]/i.test(base) ||
    base.includes('us.anthropic.') ||
    base.includes('v1:0') ||
    base.includes('@')

  if (looksLikeFullId) {
    return trimmed
  }

  if (lower === 'opus' || lower === 'claude-opus') {
    const id = pickModel(providerId, (name) => name.includes('opus'))
    if (id) return has1mContext(trimmed) ? `${strip1mSuffix(id)}[1m]` : id
  }
  if (lower === 'sonnet' || lower === 'claude-sonnet') {
    const id = pickModel(providerId, (name) => name.includes('sonnet'))
    if (id) return has1mContext(trimmed) ? `${strip1mSuffix(id)}[1m]` : id
  }
  if (lower === 'haiku' || lower === 'claude-haiku') {
    const id = pickModel(providerId, (name) => name.includes('haiku'))
    if (id) return id
  }

  return trimmed
}

/**
 * upstream-style: if the session uses `[1m]` and the skill asks for opus/sonnet (without its own `[1m]`),
 * append `[1m]` when the target family supports a 1M variant.
 */
export function resolveSkillModelOverride(
  skillModel: string,
  currentModel: string,
  providerId: ProviderId,
): string {
  const trimmed = skillModel.trim()
  if (!trimmed) return currentModel

  if (has1mContext(trimmed)) {
    return resolveSkillModelAlias(trimmed, providerId)
  }

  if (!has1mContext(currentModel)) {
    return resolveSkillModelAlias(trimmed, providerId)
  }

  const aliased = resolveSkillModelAlias(trimmed, providerId)
  const aliasedBase = strip1mSuffix(aliased)
  if (resolvedModelSupports1mCarry(aliasedBase)) {
    return `${aliasedBase}[1m]`
  }
  return aliased
}
