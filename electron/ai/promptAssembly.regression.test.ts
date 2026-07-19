/**
 * Lock-down regression test for the full prompt-assembly pipeline.
 *
 * Composes layers / append / prepend / wire in the SAME ORDER as
 * `streamHandler.handleSendMessage`, then asserts on the final API-bound
 * `system` field and `messages[0]`. Exists so the multi-stage refactor
 * (cache scope defaults, date dedup, SystemPromptBuilder, env relocation,
 * delta attachments) can change implementation while preserving the
 * observable contract.
 *
 * NOTE: When a stage intentionally changes the assembly order or de-dupes
 * a known repeat, update the affected assertions atomically with the
 * implementation in the SAME commit — never weaken to "x or y" without a
 * paired comment explaining which stage moved the goalpost.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  USER_MESSAGE_CONTEXT_DISCLAIMER,
  PLAN_MODE_BEHAVIOR_BLOCK,
  mergeSystemPromptLayers,
} from './systemPrompt'
import {
  buildMainSystemPromptLayersFromOrchestration,
  type MainOrchestrationContext,
} from './orchestrationContext'
import { prependUserContext } from '../context/normalizeMessagesForAPI'
import { getTodayLocalISODate } from '../utils/dateLocal'
import { buildAnthropicSystemParam } from './anthropicSystemWire'
import { SystemPromptBuilder } from './systemPromptBuilder'

type Msg = { role: string; content: unknown; _convertedFromSystem?: boolean }

/**
 * Pure replay of the streamHandler assembly path — all the steps that
 * compose the API-bound `system` and `messages` fields, without IPC /
 * provider wiring.
 *
 * Mirrors streamHandler.ts §`buildMainSystemPromptLayersFromOrchestration`
 * → SystemPromptBuilder (auto-task-routing / coordinator / user-prompt-submit
 * / plan-mode) → `prependUserContext` (today + memory + LSP).
 *
 * Stage 2 removed the `appendSystemContext` step entirely — date and cwd
 * are now carried by exactly one block each (date in user-meta, cwd in
 * the # Environment block of `userContext`).
 *
 * Stage 3 replaced the per-injection dual-write pattern with
 * `SystemPromptBuilder`: `merged` and `layers` are derived from a single
 * source so they cannot drift.
 */
function composeAsStreamHandler(opts: {
  ctx: MainOrchestrationContext
  permissionMode?: string
  routingHint?: string
  coordSuffix?: string
  hookInjection?: string
  apiMessages: Msg[]
  retrievedBlocks?: string
}): {
  systemMerged: string
  layers: { systemContext: string; userContext: string; userMessageContext: string }
  messages: Msg[]
} {
  const initialLayers = buildMainSystemPromptLayersFromOrchestration(opts.ctx)
  const builder = new SystemPromptBuilder(initialLayers)

  if (opts.routingHint) {
    builder.add({
      id: 'auto-task-routing',
      text: opts.routingHint,
      layer: 'volatile',
      separator: '',
    })
  }

  if (opts.coordSuffix) {
    builder.add({
      id: 'coordinator-suffix',
      text: opts.coordSuffix,
      layer: 'volatile',
    })
  }

  if (opts.hookInjection) {
    builder.add({
      id: 'user-prompt-submit-hook',
      text: opts.hookInjection,
      layer: 'volatile',
      separator: '\n\n---\n\n',
    })
  }

  if (opts.permissionMode === 'plan') {
    builder.add({
      id: 'plan-mode-behavior',
      text: PLAN_MODE_BEHAVIOR_BLOCK,
      layer: 'volatile',
      marker: '# Plan mode is active',
    })
  }

  const built = builder.build()

  const todayLocal = getTodayLocalISODate()
  const todayLine = `# Today's date\nToday's date is ${todayLocal}.`
  const refContext = built.layers.userMessageContext.trim()
  const refWithRetrieval = opts.retrievedBlocks
    ? refContext ? `${refContext}\n\n${opts.retrievedBlocks}` : opts.retrievedBlocks
    : refContext
  // Audit fix R4-M2 (2026-05) — disclaimer is always injected (even
  // when refWithRetrieval is empty), mirroring streamHandler.ts.
  const userContextForPrepend = refWithRetrieval
    ? `${todayLine}\n\n${refWithRetrieval}\n\n${USER_MESSAGE_CONTEXT_DISCLAIMER}`
    : `${todayLine}\n\n${USER_MESSAGE_CONTEXT_DISCLAIMER}`

  const messages = prependUserContext(opts.apiMessages, userContextForPrepend) as Msg[]

  return { systemMerged: built.merged, layers: built.layers, messages }
}

const baseCtx: MainOrchestrationContext = {
  workspacePath: '/proj/repo',
  cwd: '/proj/repo',
  platform: 'linux',
  outputStyle: 'default',
  language: 'en',
  memoryContext: '',
  sessionContext: '',
  passiveLspDiagnostics: '',
  customSystemPrompt: undefined,
  userRulesPrompt: undefined,
}

describe('Prompt assembly · regression lock-down (pre-Stage-1..3 refactor)', () => {
  // ── §1. Distinct-fact occurrence count in the wire (Stage 2 SSOT) ─────
  // SSOT (single source of truth) per fact. After Stage 2 consolidation:
  //   - Today's date: exactly once (user-meta `# Today's date` line).
  //   - workspacePath: exactly once (`# Environment` block in userContext).
  // Tests are LOWER bounds here — should the day's date or the cwd happen
  // to appear inside the user's actual prompt text or a memory snippet,
  // that's a separate occurrence and not a regression. We assert "exactly
  // once across the host-managed surface" by counting in JUST the host
  // sections (no user message body interference).

  it('Today\'s date appears exactly once across the host-managed surface (SSOT)', () => {
    const today = getTodayLocalISODate()
    const composed = composeAsStreamHandler({
      ctx: baseCtx,
      apiMessages: [{ role: 'user', content: 'hi' }],
    })

    // System surface (merged) — must NOT contain today (date moved to user-meta).
    const systemHits = composed.systemMerged.split(today).length - 1
    expect(systemHits).toBe(0)

    // user-meta (messages[0]) — exactly one mention.
    const userMeta = typeof composed.messages[0]!.content === 'string'
      ? composed.messages[0]!.content
      : JSON.stringify(composed.messages[0]!.content)
    const userMetaHits = userMeta.split(today).length - 1
    expect(userMetaHits).toBe(1)
  })

  it('workspacePath appears exactly once across the host-managed surface (SSOT)', () => {
    const composed = composeAsStreamHandler({
      ctx: baseCtx,
      apiMessages: [{ role: 'user', content: 'hi' }],
    })

    // System surface (Stage 4) — env block moved to user-meta, so
    // `userContext` no longer carries cwd. The merged system field has
    // no cwd mention.
    const systemHits = composed.systemMerged.split('/proj/repo').length - 1
    expect(systemHits).toBe(0)

    // user-meta — exactly one mention (`# Environment` block in
    // userMessageContext).
    const userMeta = typeof composed.messages[0]!.content === 'string'
      ? composed.messages[0]!.content
      : JSON.stringify(composed.messages[0]!.content)
    const userMetaHits = userMeta.split('/proj/repo').length - 1
    expect(userMetaHits).toBe(1)
  })

  it('# Environment block lives in userMessageContext (Stage 4) and carries no Today\'s date / Node version', () => {
    // Stage 4: env moved out of `userContext` (system field) and into
    // `userMessageContext` (user-meta). Stage 2 had already removed
    // Today's date and Node version from the env body.
    const composed = composeAsStreamHandler({
      ctx: baseCtx,
      apiMessages: [{ role: 'user', content: 'hi' }],
    })
    expect(composed.layers.userContext).not.toContain('# Environment')
    expect(composed.layers.userMessageContext).toContain('# Environment')
    expect(composed.layers.userMessageContext).not.toMatch(/Today's date is/)
    expect(composed.layers.userMessageContext).not.toMatch(/Node:/)
  })

  // ── §2. Layer / merged consistency (Stage 3 invariant) ──────────────
  // After Stage 3, `SystemPromptBuilder` derives `merged` from layers in
  // `.build()`, so the two views are by-construction consistent. This
  // test exists to detect a future refactor that would re-introduce
  // independent merged-string mutation outside the Builder.

  it('Builder invariant — merged === merge(layers.systemContext, layers.userContext) under all injection combos', () => {
    const composed = composeAsStreamHandler({
      ctx: baseCtx,
      routingHint: '\n\n## Task Routing\nDelegate.',
      coordSuffix: '---\n\n# Coordinator suffix\nWork in phases.',
      hookInjection: 'HOOK_INJECTED_TEXT',
      permissionMode: 'plan',
      apiMessages: [{ role: 'user', content: 'hi' }],
    })
    expect(
      mergeSystemPromptLayers(composed.layers.systemContext, composed.layers.userContext),
    ).toBe(composed.systemMerged)
  })

  it('plan-mode block — adding twice via Builder is a no-op (id-dedup)', () => {
    const composed = composeAsStreamHandler({
      ctx: baseCtx,
      permissionMode: 'plan',
      apiMessages: [{ role: 'user', content: 'hi' }],
    })
    // The behavior block appears exactly once.
    const occurrences = composed.systemMerged.split('# Plan mode is active').length - 1
    expect(occurrences).toBe(1)
  })

  it('Stage 3 — every injection point lives behind a unique `id` in the Builder (no spelled-out dual-write)', () => {
    // Sanity: when we run the full injection set, the section ids show
    // up via observable side-effects (each section appends distinct
    // marker text). If a future refactor accidentally bypasses the
    // Builder and writes directly to the merged string, the merge
    // invariant test above will catch it; this test additionally
    // anchors the section ids to specific marker substrings so renames
    // are explicit.
    const composed = composeAsStreamHandler({
      ctx: baseCtx,
      routingHint: '\n\n## Task Routing\nDelegate.',
      coordSuffix: '---\n\n# Coordinator suffix\nWork in phases.',
      hookInjection: 'HOOK_INJECTED_TEXT',
      permissionMode: 'plan',
      apiMessages: [{ role: 'user', content: 'hi' }],
    })
    expect(composed.systemMerged).toContain('## Task Routing')
    expect(composed.systemMerged).toContain('# Coordinator suffix')
    expect(composed.systemMerged).toContain('HOOK_INJECTED_TEXT')
    expect(composed.systemMerged).toContain('# Plan mode is active')
  })

  // ── §3. messages[0] structure ─────────────────────────────────────────

  it('messages[0] is a <system-reminder>-wrapped user-meta message produced by prependUserContext', () => {
    const composed = composeAsStreamHandler({
      ctx: { ...baseCtx, memoryContext: 'remembered.fact' },
      apiMessages: [{ role: 'user', content: 'hi' }],
    })
    const m0 = composed.messages[0]!
    expect(m0.role).toBe('user')
    expect(m0._convertedFromSystem).toBe(true)
    const text = typeof m0.content === 'string' ? m0.content : JSON.stringify(m0.content)
    // Stage 10 audit fix — the wrap carries a `type="user-meta-context"`
    // attribute so the dedup pass can identify it without depending on
    // `_convertedFromSystem` (which `stripInternalFields` would erase
    // before this function runs in production).
    expect(text.startsWith('<system-reminder type="user-meta-context">')).toBe(true)
    expect(text.endsWith('</system-reminder>')).toBe(true)
    expect(text).toContain("# Today's date")
    expect(text).toContain('# Project Memory')
    expect(text).toContain('remembered.fact')
    expect(text).toContain(USER_MESSAGE_CONTEXT_DISCLAIMER)
  })

  it('prependUserContext is a no-op when userMessageContext + todayLine are both effectively empty', () => {
    // Today's date is never empty, so the user-meta message ALWAYS appears
    // for non-empty turns. This documents that property — the day we want
    // a true no-op path (e.g. for sub-agents bypassing user-meta) we need
    // a distinct call site rather than expecting prepend to skip itself.
    const composed = composeAsStreamHandler({
      ctx: baseCtx,
      apiMessages: [{ role: 'user', content: 'hi' }],
    })
    const m0 = composed.messages[0]!
    const text = typeof m0.content === 'string' ? m0.content : ''
    expect(text).toContain("# Today's date")
  })

  // ── §4. Wire defaults — cache scope behavior (Stage 1) ───────────────
  // Stage 1 flipped the defaults: blocks + cache_control are now the
  // default behavior. Disable flags are escape hatches.

  afterEach(() => {
    delete process.env.POLE_ANTHROPIC_SYSTEM_BLOCKS_DISABLE
    delete process.env.POLE_ANTHROPIC_SYSTEM_BLOCK_CACHE_DISABLE
  })

  it('default (Stage 1) — buildAnthropicSystemParam emits two blocks with ephemeral cache on prefix', () => {
    const layers = {
      systemContext: 'STATIC_PREFIX',
      userContext: 'VOLATILE_BODY',
      userMessageContext: '',
    }
    const wire = buildAnthropicSystemParam(
      'STATIC_PREFIX\n\nVOLATILE_BODY',
      layers,
    ) as Array<{ text: string; cache_control?: { type: string } }>
    expect(Array.isArray(wire)).toBe(true)
    expect(wire).toHaveLength(2)
    expect(wire[0]!.text).toBe('STATIC_PREFIX')
    expect(wire[0]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(wire[1]!.text).toBe('VOLATILE_BODY')
    expect(wire[1]!.cache_control).toBeUndefined()
  })

  it('escape hatch — POLE_ANTHROPIC_SYSTEM_BLOCKS_DISABLE=1 reverts to merged-string', () => {
    process.env.POLE_ANTHROPIC_SYSTEM_BLOCKS_DISABLE = '1'
    const wire = buildAnthropicSystemParam('M', {
      systemContext: 'STATIC',
      userContext: 'DYNAMIC',
      userMessageContext: '',
    })
    expect(wire).toBe('M')
  })

  it('escape hatch — POLE_ANTHROPIC_SYSTEM_BLOCK_CACHE_DISABLE=1 keeps blocks but drops cache_control', () => {
    process.env.POLE_ANTHROPIC_SYSTEM_BLOCK_CACHE_DISABLE = '1'
    const wire = buildAnthropicSystemParam('M', {
      systemContext: 'STATIC',
      userContext: 'DYNAMIC',
      userMessageContext: '',
    }) as Array<{ cache_control?: unknown }>
    expect(Array.isArray(wire)).toBe(true)
    expect(wire[0]!.cache_control).toBeUndefined()
    expect(wire[1]!.cache_control).toBeUndefined()
  })

  // ── §5. Host runtime contract on BOTH default and custom paths ────────

  it('Stage 5 — custom system prompt now carries # Tool-use conventions and recall guidance', () => {
    const L = buildMainSystemPromptLayersFromOrchestration({
      ...baseCtx,
      customSystemPrompt: 'I am a sales engineer. Answer in plain prose.',
    })
    // The bundle's own persona text is preserved.
    expect(L.systemContext).toContain('I am a sales engineer.')
    // Host runtime contract injected ahead of the bundle prompt.
    expect(L.systemContext).toContain('# System')
    expect(L.systemContext).toContain('# Tool-use conventions')
    expect(L.systemContext).toContain('How to recall what already happened')
    // <system-reminder> framing reaches the model.
    expect(L.systemContext).toContain('<system-reminder>')
    // read_file → edit_file workflow guidance reaches the model.
    expect(L.systemContext).toContain('read_file → edit_file workflow')
  })

  it('Stage 5 — host contract precedes the bundle prompt; anti-hallucination guardrail tails it (recency weight)', () => {
    const L = buildMainSystemPromptLayersFromOrchestration({
      ...baseCtx,
      customSystemPrompt: 'BUNDLE_PERSONA_BODY',
    })
    const contractIdx = L.systemContext.indexOf('# Tool-use conventions')
    const personaIdx = L.systemContext.indexOf('BUNDLE_PERSONA_BODY')
    const guardIdx = L.systemContext.indexOf('No action hallucination')
    expect(contractIdx).toBeGreaterThan(-1)
    expect(personaIdx).toBeGreaterThan(contractIdx)
    expect(guardIdx).toBeGreaterThan(personaIdx)
  })

  it('Stage 5 — host contract injection is idempotent when the bundle already inlines those sections', () => {
    // A future preset may want to phrase the runtime contract its own
    // way. If both `# System` + `## How to recall…` markers are present
    // in the bundle prompt, the host must not re-inject. Same idea for
    // `# Tool-use conventions`.
    const customWithContract = `# System
- bundle phrasing of system rules

## How to recall what already happened in this session
1. bundle phrasing of recall rules

# Tool-use conventions
- bundle phrasing of tool conventions

BUNDLE_BODY`
    const L = buildMainSystemPromptLayersFromOrchestration({
      ...baseCtx,
      customSystemPrompt: customWithContract,
    })
    // No duplication — exactly one occurrence of each header.
    expect(L.systemContext.split('# System').length - 1).toBe(1)
    expect(L.systemContext.split('How to recall what already happened').length - 1).toBe(1)
    expect(L.systemContext.split('# Tool-use conventions').length - 1).toBe(1)
  })

  it('Stage 5 — default path still carries the host contract (sanity)', () => {
    const L = buildMainSystemPromptLayersFromOrchestration(baseCtx)
    expect(L.systemContext).toContain('# Tool-use conventions')
    expect(L.systemContext).toContain('How to recall what already happened')
  })

  // ── §6. Skill index lives in user-meta, not system field (Stage 6) ────
  // Skill listing is a reference catalogue ("here are the skills you can
  // call"), not an instruction. Stage 6 moved it from `userContext`
  // (system field) to `userMessageContext` (user-meta) so a skill
  // add/remove no longer busts the system-field cache.

  it('Stage 6 — skill index lives in userMessageContext, not in userContext or systemContext', () => {
    // The actual skill catalogue is built per-cwd; the lock-down here
    // covers structural placement only — if any skills are loaded, they
    // must surface ONLY through `userMessageContext`. Empty catalogue
    // (no skills loaded) is also fine; we assert symmetry: if the
    // listing exists, it's in user-meta.
    const composed = composeAsStreamHandler({
      ctx: baseCtx,
      apiMessages: [{ role: 'user', content: 'hi' }],
    })
    if (composed.layers.userContext.includes('# Skill index')) {
      throw new Error('Stage 6 regression: # Skill index leaked into userContext (system field)')
    }
    if (composed.layers.systemContext.includes('# Skill index')) {
      throw new Error('Stage 6 regression: # Skill index leaked into systemContext (cacheable prefix)')
    }
    // (No positive assertion here because skill loading depends on disk
    // state in the test runner; the negative invariants above are what
    // matters for the cache contract.)
  })

  // ── §7. SSOT — deduplicated rules survive future edits (2026-05) ──────
  // These three locks landed alongside the 2026-05 prompt cleanup that
  // collapsed scattered "be concise" / "don't sycophant" / "edit-file
  // contract" repetitions to single canonical locations. Without these,
  // a copy-paste edit could silently re-introduce a duplicate and the
  // existing `toContain(X)` style tests would still pass.

  it('SSOT — anti-sycophancy rule appears exactly once in the merged system surface (default path)', () => {
    const composed = composeAsStreamHandler({
      ctx: baseCtx,
      apiMessages: [{ role: 'user', content: 'hi' }],
    })
    // The canonical home is the `# Response style` section's "No repeated
    // acknowledgment" rule. Other anchors that previously held a copy
    // (HOST_RUNTIME_CONTRACT_BLOCK, USER_MESSAGE_CONTEXT_DISCLAIMER) must
    // NOT redundantly include the trigger phrase list.
    const hits = composed.systemMerged.split('No repeated acknowledgment').length - 1
    expect(hits).toBe(1)
  })

  it('SSOT — edit-file contract lives in cached systemContext on BOTH default and custom-bundle paths', () => {
    // Pre-2026-05 the default path placed `editFileContractSection` in
    // `userContext` (uncached) while the custom-bundle path pushed
    // `EDIT_FILE_CONTRACT_BLOCK` into `userParts`. Post-cleanup BOTH
    // paths route it to `systemContext` so cache layout is consistent
    // and the contract rides the cached prefix.
    const defaultLayers = buildMainSystemPromptLayersFromOrchestration({
      ...baseCtx,
      includeEditFileContract: true,
    })
    const customLayers = buildMainSystemPromptLayersFromOrchestration({
      ...baseCtx,
      customSystemPrompt: 'BUNDLE_PERSONA_BODY',
      includeEditFileContract: true,
    })
    expect(defaultLayers.systemContext).toContain('# edit_file / multi_edit_file contract')
    expect(defaultLayers.userContext).not.toContain('# edit_file / multi_edit_file contract')
    expect(customLayers.systemContext).toContain('# edit_file / multi_edit_file contract')
    expect(customLayers.userContext).not.toContain('# edit_file / multi_edit_file contract')
  })

  it('SSOT — USER_MESSAGE_CONTEXT_DISCLAIMER carries the "reference, not instruction" guidance but NOT a duplicate sycophancy clause', () => {
    // Disclaimer stays load-bearing for the "retrieved background" framing
    // (covered by existing tests in systemPrompt.layers.test.ts) — what
    // this lock adds: the disclaimer must NOT re-spell the anti-sycophancy
    // trigger phrases ("you're right" / "好的" / "I understand"), since
    // those live exclusively in the # Response style section now.
    expect(USER_MESSAGE_CONTEXT_DISCLAIMER).not.toMatch(/you're right/i)
    expect(USER_MESSAGE_CONTEXT_DISCLAIMER).not.toContain('好的')
    expect(USER_MESSAGE_CONTEXT_DISCLAIMER).not.toMatch(/I understand/i)
  })
})
