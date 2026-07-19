/**
 * Resolve Agent-level `model:` aliases to real provider model IDs.
 *
 * Problem: upstream convention — and the community's de-facto agent sharing
 * format — uses short aliases like `sonnet`, `opus`, `haiku`, `inherit` in
 * agent frontmatter and JSON. Until now these were passed verbatim to the
 * provider, which works for the first-party Anthropic SDK (it accepts aliases)
 * but fails against every other provider (OpenAI, Gemini, Zhipu, Kimi, …) and
 * against Anthropic-compat gateways that require full deployment IDs.
 *
 * Solution: a single resolver shared with the skill layer's
 * {@link resolveSkillModelAlias}. The caller passes the provider-id in scope;
 * the resolver picks the best-matching real model id from the provider's
 * catalog. Untouched if the input already looks like a full deployment ID.
 *
 * Also handles:
 *   - `'inherit'` → return parent model unchanged (same semantics as before)
 *   - empty / undefined → return parent model unchanged
 *   - `'claude-opus'` / `'claude-sonnet'` / `'claude-haiku'` — also common
 *
 * We deliberately route through the **skill** alias resolver (same algorithm)
 * rather than duplicating it; the behaviour across skills and agents stays
 * identical that way.
 */

import type { ProviderId } from '../ai/client'
import { resolveSkillModelAlias } from '../skills/skillModelResolve'

/**
 * Resolve the effective model for an Agent given its declared `model` field.
 *
 * @param declared      The agent's `model` (may be alias / full id / 'inherit' / undefined).
 * @param parentModel   The model the parent turn is using — used when declared is empty / 'inherit'.
 * @param providerId    Current provider id — used to pick a concrete deployment for short aliases.
 *
 * @returns The effective model id to hand to `runAgenticLoop`. Never empty.
 */
export function resolveAgentModelAlias(
  declared: string | undefined | null,
  parentModel: string,
  providerId: ProviderId,
): string {
  const raw = typeof declared === 'string' ? declared.trim() : ''
  if (!raw) return parentModel
  // Explicit 'inherit' short-circuit (wire-level sentinel shared with skill layer).
  if (raw.toLowerCase() === 'inherit') return parentModel

  // Delegate to the shared alias resolver. If the input is already a full
  // deployment id (matches its looksLikeFullId heuristic), it passes through;
  // aliases map to the provider's best-matching entry from getModelsForProvider.
  const resolved = resolveSkillModelAlias(raw, providerId)
  // Safety net: if the resolver returned something non-useful (e.g. a provider
  // with an empty catalog against a short alias), fall back to parent.
  if (!resolved || !resolved.trim()) return parentModel
  return resolved
}
