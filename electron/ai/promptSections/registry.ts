import type { SystemPromptOptions, SystemPromptLayers } from '../systemPrompt'
import { attributionSection } from './attribution'
import { buddyStateSection } from './buddyState'
import { editFileContractSection } from './editFileContract'
import { environmentSection } from './environment'
import { forkGuidanceSection } from './forkGuidance'
import { instructionBlockSection } from './instructionBlock'
import { lspDiagnosticsSection } from './lspDiagnostics'
import { memoryCapabilitiesSection } from './memoryCapabilities'
import { projectMemorySection } from './projectMemory'
import { selfAwarenessSection } from './selfAwareness'
import { sessionContextSection } from './sessionContext'
import { teamInboxGuidanceSection } from './teamInboxGuidance'
import { toolUseConventionsSection } from './toolUseConventions'
import {
  bucketsToLayers,
  type SystemPromptSection,
  type SystemPromptSectionBuckets,
} from './types'

/**
 * Default ordering — must match the legacy concatenation in
 * `systemPrompt.buildSystemPromptLayers` for byte-equality. Within each
 * layer the sections are joined with `\n\n` (see {@link bucketsToLayers}).
 *
 * Phase B contract: this list is the SINGLE source of truth for
 * what enters `SystemPromptLayers`. Adding a new section is "register
 * it here" + "write a section module"; assembly order, layer placement,
 * and ownership become visible in one place.
 */
const DEFAULT_REGISTRY: readonly SystemPromptSection[] = [
  // systemContext (cache-friendly static prefix)
  attributionSection,
  instructionBlockSection,
  toolUseConventionsSection,
  forkGuidanceSection,
  selfAwarenessSection,
  editFileContractSection,
  // Team Active Loop (PR-4): teaches the lead how to read `<team-inbox>`
  // host attachments. Returns empty string when POLE_TEAM_ACTIVE_LOOP is
  // unset so the legacy prompt-cache key stays stable for the default
  // configuration; only opt-in users get the extra layer.
  teamInboxGuidanceSection,
  // userContext (system field, volatile but session-stable) — currently empty;
  // edit-file-contract moved to systemContext in 2026-05 cleanup since it is
  // session-stable (per-agent capability flag, not per-turn input). Future
  // truly per-turn system-field blocks (e.g. plan-mode behavior) still land
  // here via `SystemPromptBuilder` at the call site.
  // userMessageContext (user-meta `<system-reminder>` at messages[0])
  memoryCapabilitiesSection,
  projectMemorySection,
  lspDiagnosticsSection,
  environmentSection,
  sessionContextSection,
  // Companion / buddy intro — landed after sessionContext so it reads as the
  // last reference block in the user-meta bucket. Audit P0-2a (2026-05).
  buddyStateSection,
]

/** For tests + introspection — never mutate the array, it is frozen. */
export function listRegisteredSections(): readonly SystemPromptSection[] {
  return DEFAULT_REGISTRY
}

/**
 * Run every registered section against `options`, fanning the produced
 * text into the correct layer bucket, then collapse to layers.
 *
 * Pure function: no side effects, no module-level memo. The legacy
 * `userContextLayerCache` memo around `userContext` is preserved by
 * the calling site in `buildSystemPromptLayers` (which keeps that cache
 * intact for prompt-cache stability).
 */
export function assembleLayersFromRegistry(
  options: SystemPromptOptions,
): SystemPromptLayers {
  const buckets: SystemPromptSectionBuckets = {
    system: [],
    user: [],
    userMeta: [],
  }
  const ctx = { options }
  for (const section of DEFAULT_REGISTRY) {
    const body = section.build(ctx)
    if (!body) continue
    if (section.layer === 'system') {
      buckets.system.push(body)
    } else if (section.layer === 'user') {
      buckets.user.push(body)
    } else if (section.layer === 'user-meta') {
      buckets.userMeta.push(body)
    } else {
      // Audit fix R1-L2 (2026-05): catch typo'd layer strings ('user_meta',
      // 'usermeta', etc.) instead of silently absorbing them into the
      // userMeta bucket where they would be mis-framed as background
      // by the user-meta disclaimer.
      //
      // Self-audit fix R2-N (2026-05): downgraded from a hard `throw`
      // to a console.error + skip. `assembleLayersFromRegistry` is on
      // the main prompt-assembly hot path; a hard throw inside a
      // misconfigured plugin section would prevent the entire chat
      // from starting up. Skipping the offending section is the safer
      // failure mode — the prompt is still usable (just missing the
      // misconfigured section), and the loud console.error in the
      // main-process log surfaces the bug for the developer.
      console.error(
        `[promptSections/registry] section ${String(section.id)} has unknown layer "${String(
          (section as { layer: unknown }).layer,
        )}" — must be one of 'system' | 'user' | 'user-meta'. SECTION SKIPPED.`,
      )
    }
  }
  // Self-audit follow-up to R1-5 / M4 (2026-05): `userContextLayerMemoKey`
  // in `systemPrompt.ts` hashes a single legacy bit that no longer
  // affects the `user` bucket — the bucket is currently always empty.
  // Loudly warn (do NOT throw — a future section legitimately on `user`
  // is allowed) when the bucket gains a non-empty entry without anyone
  // having extended the cache key, so the silent cache-poisoning trap
  // documented in `userContextLayerMemoKey` is observable in production
  // logs rather than only documented.
  if (buckets.user.length > 0) {
    console.warn(
      '[promptSections/registry] userContext bucket is non-empty but ' +
        '`userContextLayerMemoKey` does not yet hash any input that affects ' +
        "`layer: 'user'` sections — see the comment block in `systemPrompt.ts`. " +
        'Extend the key to cover those inputs before relying on the memo, or you ' +
        'will silently serve cached content keyed on stale inputs.',
    )
  }
  return bucketsToLayers(buckets)
}
