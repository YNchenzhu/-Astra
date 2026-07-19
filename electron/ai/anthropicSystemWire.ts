/**
 * Wire `system` as Anthropic text-block array (default) or single string (opt-out).
 *
 * Default behavior (Stage 1 of the prompt-assembly upgrade):
 *   - When {@link SystemPromptLayers} are present and at least one layer is
 *     non-empty, returns a `TextBlockParam[]` with two blocks (systemContext,
 *     userContext) and a `cache_control: { type: 'ephemeral' }` marker on the
 *     stable prefix (`systemContext`) so Anthropic prompt caching can re-use
 *     the cross-turn invariant body.
 *   - Falls back to the merged single-string form when layers are absent or
 *     fully empty (preserves callers that never built a layered prompt).
 *
 * Opt-out env switches (kept as escape hatches for production debugging or
 * for routing through a gateway that mishandles either feature):
 *   - `POLE_ANTHROPIC_SYSTEM_BLOCKS_DISABLE=1` — force the merged-string path
 *     even when layers are non-empty. Use when a downstream wire transformer
 *     misbehaves on multi-block `system` (Anthropic native + every transformer
 *     in this repo handles arrays correctly today, so this is purely a kill
 *     switch).
 *   - `POLE_ANTHROPIC_SYSTEM_BLOCK_CACHE_DISABLE=1` — emit the block array
 *     but drop `cache_control`. Use when a billing-sensitive integration
 *     wants explicit no-caching, or when chasing a reproducibility bug.
 *
 * Legacy `POLE_ANTHROPIC_SYSTEM_BLOCKS=1` / `POLE_ANTHROPIC_SYSTEM_BLOCK_CACHE=1`
 * are now no-ops (their previous "opt-in" semantics matches the new default,
 * so leaving them set has no effect). The compat-gateway downgrade in
 * `anthropicCompatHttp.ts` (quirks.systemMustBeString=true) still joins the
 * blocks back into a string for gateways that reject the array form, so
 * 3P providers do not need to flip these switches.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { SystemPromptLayers } from './systemPrompt'

export type AnthropicSystemWire = string | Anthropic.TextBlockParam[] | undefined

function isBlockModeDisabled(): boolean {
  return process.env.POLE_ANTHROPIC_SYSTEM_BLOCKS_DISABLE === '1'
}

function isBlockCacheDisabled(): boolean {
  return process.env.POLE_ANTHROPIC_SYSTEM_BLOCK_CACHE_DISABLE === '1'
}

export function buildAnthropicSystemParam(
  mergedSystem: string | undefined,
  layers: SystemPromptLayers | undefined,
): AnthropicSystemWire {
  const layersUsable =
    !!layers &&
    (layers.systemContext.trim() !== '' || layers.userContext.trim() !== '')

  if (!layersUsable || isBlockModeDisabled()) {
    const m = mergedSystem?.trim()
    return m || undefined
  }

  const blocks: Anthropic.TextBlockParam[] = []
  const sc = layers!.systemContext.trim()
  const uc = layers!.userContext.trim()
  const cacheStablePrefix = !isBlockCacheDisabled() && sc.length > 0

  if (sc) {
    blocks.push({
      type: 'text',
      text: sc,
      ...(cacheStablePrefix ? { cache_control: { type: 'ephemeral' as const } } : {}),
    })
  }
  if (uc) {
    blocks.push({ type: 'text', text: uc })
  }
  if (blocks.length === 0) {
    const m = mergedSystem?.trim()
    return m || undefined
  }
  return blocks
}
