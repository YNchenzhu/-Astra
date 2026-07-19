/**
 * Common section types for the prompt-section registry.
 *
 * Phase B of the upstream alignment: move the hard-coded
 * `attribution + instruction + toolUseConventions` concatenation in
 * `systemPrompt.ts` to a registry-driven pipeline. Each section carries
 * its own id, owner, and layer assignment so future maintainers can
 * adjust composition without re-reading the assembly site.
 *
 * NOTE: The registry-driven assembly MUST produce byte-identical output
 * to the legacy path for the same {@link SystemPromptOptions}. The
 * `sectionRegistry.test.ts` byte-equality test is the lock.
 */

import type { SystemPromptOptions, SystemPromptLayers } from '../systemPrompt'

export type SystemPromptSectionLayer = 'system' | 'user' | 'user-meta'

/**
 * Identifies who owns the wording of a section. Surfacing this lets
 * cross-team reviews know who needs to sign off on prompt copy edits.
 * The set is intentionally short; new owners are added as needed.
 */
export type SystemPromptSectionOwner =
  | 'core'
  | 'safeguards'
  | 'tooling'
  | 'memory'
  | 'skills'
  | 'session'
  | 'environment'
  | 'buddy'

export interface SystemPromptSectionContext {
  options: SystemPromptOptions
}

export interface SystemPromptSection {
  /** Stable id for dedup, ordering, and test diagnostics. */
  id: string
  /** Owner team — used in code review + future per-section A/B flags. */
  owner: SystemPromptSectionOwner
  /** Which layer of {@link SystemPromptLayers} this section lands in. */
  layer: SystemPromptSectionLayer
  /**
   * Returns the section text for the current request, or an empty
   * string when the section should be skipped this turn. Build functions
   * must be pure: same context in → same string out.
   */
  build(ctx: SystemPromptSectionContext): string
}

/**
 * Layer-keyed buckets the registry produces during assembly. Each bucket
 * preserves insertion order; the assembler joins parts with `\n\n` to
 * match the legacy concatenation contract.
 */
export interface SystemPromptSectionBuckets {
  system: string[]
  user: string[]
  userMeta: string[]
}

/**
 * Build the final layers from already-collected buckets. Centralised so
 * the join semantics (separators, empty-bucket handling) are tested in
 * one place.
 */
export function bucketsToLayers(buckets: SystemPromptSectionBuckets): SystemPromptLayers {
  return {
    systemContext: buckets.system.filter((s) => s.trim()).join('\n\n'),
    userContext: buckets.user.filter((s) => s.trim()).join('\n\n'),
    userMessageContext: buckets.userMeta.filter((s) => s.trim()).join('\n\n'),
  }
}
