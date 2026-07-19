/**
 * SystemPromptBuilder — single-source-of-truth assembler for the
 * (systemContext, userContext, userMessageContext) layers that go on the
 * wire. Replaces the per-injection-point dual-write pattern in
 * `streamHandler.ts` (Stage 3 of the prompt-assembly upgrade).
 *
 * Why a Builder:
 *   - The wire serializes layers into either a multi-block `system` array
 *     (default) or a merged single string (escape hatch). Previously,
 *     every injection mutated BOTH a `merged` local AND `layers.userContext`
 *     so that *both* paths saw the same prompt — easy to forget, easy to
 *     drift. The Builder keeps layers as the only source of truth and
 *     derives the merged string on `.build()`.
 *
 *   - Each injection (auto-task-routing hint, Coordinator suffix,
 *     UserPromptSubmit hook output, plan-mode behavior block, …) becomes a
 *     declarative `SystemPromptSection` value the caller adds via
 *     `.add(section)`. Sections carry their own id (for de-dup) and
 *     optional marker (for idempotent re-injection across paths), so the
 *     mechanics that used to live inline in `streamHandler.ts` are now in
 *     this module behind a uniform API.
 *
 * Non-goals:
 *   - This module does NOT decide WHICH sections to add for a given turn.
 *     That stays in `streamHandler.ts` (and per-feature `buildXxxSection`
 *     helpers). The Builder only knows "add to layer X with these
 *     separator / dedup rules".
 */

import type { SystemPromptLayers } from './systemPrompt'
import { mergeSystemPromptLayers } from './systemPrompt'

/** Which layer the section's text lands in. */
export type SystemPromptLayerName = 'static' | 'volatile'

export interface SystemPromptSection {
  /**
   * Stable id used for de-dup within a builder. Re-adding a section with
   * the same id is a no-op (first one wins). Pick descriptive ids like
   * `'auto-task-routing'`, `'coordinator-suffix'`, `'plan-mode-behavior'`
   * so test failures are diagnosable.
   */
  id: string
  /** Body to append. Whitespace-only text is dropped. */
  text: string
  /**
   * Which layer this section appends to.
   *   - `'static'`   → systemContext (cache-friendly prefix)
   *   - `'volatile'` → userContext (volatile, recomputed per turn)
   */
  layer: SystemPromptLayerName
  /**
   * Sentinel substring used to detect "already injected" cases when the
   * same section may flow in from multiple call sites (e.g. a sub-agent
   * inheriting a parent prompt that already carries the plan-mode block).
   * If the marker is found in the target layer's accumulated text, the
   * section is skipped even if the id has not been seen.
   */
  marker?: string
  /**
   * Separator placed between this section and the prior content of the
   * target layer. Default `'\n\n'`. Use `''` when the section's body
   * already encodes its own leading whitespace (matches the pre-Builder
   * behavior of `systemPrompt += routingHint` where `routingHint` started
   * with `\n\n`).
   */
  separator?: string
}

export class SystemPromptBuilder {
  private staticParts: string[] = []
  private volatileParts: string[] = []
  /**
   * Per-section explicit separator. Stored at index `i` to apply BEFORE
   * `parts[i]` when joining (parts[0] never gets a separator).
   * Default `'\n\n'` — matches `mergeSystemPromptLayers` semantics.
   */
  private staticSeparators: string[] = []
  private volatileSeparators: string[] = []
  private seenIds = new Set<string>()
  private readonly userMessageContext: string

  constructor(initial: SystemPromptLayers) {
    if (initial.systemContext.trim()) {
      this.staticParts.push(initial.systemContext)
      this.staticSeparators.push('')
    }
    if (initial.userContext.trim()) {
      this.volatileParts.push(initial.userContext)
      this.volatileSeparators.push('')
    }
    this.userMessageContext = initial.userMessageContext
  }

  /**
   * Append a section. Returns this for chaining.
   *
   * Skip rules (in order):
   *   1. Same id already added.
   *   2. Whitespace-only text.
   *   3. `marker` (if set) found anywhere in the target layer's current
   *      accumulated text.
   */
  add(section: SystemPromptSection): this {
    if (this.seenIds.has(section.id)) return this
    if (!section.text.trim()) return this

    if (section.marker) {
      const acc = (section.layer === 'static' ? this.staticParts : this.volatileParts).join('\n\n')
      if (acc.includes(section.marker)) {
        this.seenIds.add(section.id)
        return this
      }
    }

    const target = section.layer === 'static' ? this.staticParts : this.volatileParts
    const sep = section.layer === 'static' ? this.staticSeparators : this.volatileSeparators
    target.push(section.text)
    sep.push(target.length === 1 ? '' : (section.separator ?? '\n\n'))
    this.seenIds.add(section.id)
    return this
  }

  /** Have any sections been added with the given id? */
  has(id: string): boolean {
    return this.seenIds.has(id)
  }

  /**
   * Materialize the layered prompt. The merged string is derived from
   * layers via {@link mergeSystemPromptLayers} so the two views are
   * guaranteed consistent (the bug Stage 3 targets).
   */
  build(): { merged: string; layers: SystemPromptLayers } {
    const systemContext = joinWithSeparators(this.staticParts, this.staticSeparators)
    const userContext = joinWithSeparators(this.volatileParts, this.volatileSeparators)
    return {
      merged: mergeSystemPromptLayers(systemContext, userContext),
      layers: {
        systemContext,
        userContext,
        userMessageContext: this.userMessageContext,
      },
    }
  }
}

function joinWithSeparators(parts: string[], seps: string[]): string {
  if (parts.length === 0) return ''
  let out = parts[0]!
  for (let i = 1; i < parts.length; i++) {
    out += seps[i] ?? '\n\n'
    out += parts[i]
  }
  return out
}
