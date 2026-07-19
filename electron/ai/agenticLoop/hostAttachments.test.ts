/**
 * Unit tests for the host-attachments orchestrator.
 *
 * Covers the upstream-parity guarantees:
 *
 *   1. `runCollectors` filters by call-site (collectors only run
 *      where they registered).
 *   2. `maybe()`-style failure isolation: a throwing collector does
 *      not crash the orchestrator or block other collectors.
 *   3. Actions apply in **registry order**, not promise-resolution
 *      order (matters because the model perceives ordering).
 *   4. `applyAction` correctly handles the two action modes
 *      (`push_message` / `concat_to_last_user`) plus the edge case
 *      where `concat_to_last_user` lands with no preceding user msg.
 *
 * The compaction_reminder collector's own gating is covered by the
 * higher-level iteration tests in
 * `electron/orchestration/phases/__tests__/iteration.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  applyAction,
  estimateActionChars,
  runCollectors,
  runCollectorsWith,
  COLLECTOR_PRIORITY,
  COLLECTORS,
  type AttachmentCallSite,
  type AttachmentContext,
  type Collector,
} from './hostAttachments'
import {
  SIDE_CHANNEL_KIND,
  makeSideChannelUserMessage,
} from '../../constants/sideChannelKinds'
import type { LoopState } from './loopShared'

function makeMinimalCtx(opts: {
  callSite: AttachmentCallSite
  apiMessages?: Array<Record<string, unknown>>
}): AttachmentContext {
  const state = {
    apiMessages: opts.apiMessages ?? [],
    appendixReport: () => {},
    syncConversation: () => {},
  } as unknown as LoopState
  return {
    state,
    systemPrompt: 'sys',
    callSite: opts.callSite,
  }
}

describe('applyAction', () => {
  it('push_message appends to apiMessages', () => {
    const ctx = makeMinimalCtx({ callSite: 'post_tool' })
    applyAction(ctx.state, {
      kind: 'push_message',
      message: { role: 'user', content: 'hello' },
    })
    expect(ctx.state.apiMessages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('push_message with replaceSideChannelKind removes prior instances of that kind', () => {
    const kind = SIDE_CHANNEL_KIND.systemDriveContext
    const stale = makeSideChannelUserMessage(kind, '[System drive context]\nstale contract')
    const ctx = makeMinimalCtx({
      callSite: 'iteration_top',
      apiMessages: [
        { role: 'user', content: 'first turn' },
        stale,
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second turn' },
      ],
    })
    const fresh = makeSideChannelUserMessage(kind, '[System drive context]\nfresh contract')
    applyAction(ctx.state, {
      kind: 'push_message',
      sideChannelKind: kind,
      replaceSideChannelKind: kind,
      message: fresh,
    })
    // Stale instance removed; fresh one appended at the tail; other
    // messages (including other side-channel kinds) untouched.
    expect(ctx.state.apiMessages).toHaveLength(4)
    expect(ctx.state.apiMessages[3]).toBe(fresh)
    const bodies = ctx.state.apiMessages.map((m) => String(m.content))
    expect(bodies.filter((b) => b.includes('stale contract'))).toHaveLength(0)
    expect(bodies.filter((b) => b.includes('fresh contract'))).toHaveLength(1)
  })

  it('concat_to_last_user merges into the trailing user message string', () => {
    const ctx = makeMinimalCtx({
      callSite: 'post_tool',
      apiMessages: [
        { role: 'user', content: 'first turn' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second turn' },
      ],
    })
    applyAction(ctx.state, { kind: 'concat_to_last_user', text: 'extra' })
    expect(ctx.state.apiMessages[2]).toEqual({
      role: 'user',
      content: 'second turn\n\nextra',
    })
  })

  it('concat_to_last_user appends a text block to an array-content user message', () => {
    const ctx = makeMinimalCtx({
      callSite: 'post_tool',
      apiMessages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }],
        },
      ],
    })
    applyAction(ctx.state, { kind: 'concat_to_last_user', text: 'note' })
    expect(ctx.state.apiMessages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'x', content: 'ok' },
        { type: 'text', text: 'note' },
      ],
    })
  })

  it('concat_to_last_user falls back to push_message when no user msg exists', () => {
    const ctx = makeMinimalCtx({
      callSite: 'post_tool',
      apiMessages: [{ role: 'assistant', content: 'only assistant' }],
    })
    applyAction(ctx.state, { kind: 'concat_to_last_user', text: 'orphan' })
    expect(ctx.state.apiMessages).toHaveLength(2)
    const pushed = ctx.state.apiMessages[1] as Record<string, unknown>
    expect(pushed.role).toBe('user')
    expect(String(pushed.content)).toContain('orphan')
    expect(pushed._convertedFromSystem).toBe(true)
  })
})

describe('runCollectors — call-site filtering', () => {
  it('runs only iteration_top-registered collectors at the iteration_top call site', async () => {
    // Phase C registered `pendingToolUseSummary` at iteration_top;
    // audit fix R4-L5 (2026-05) added `date_change` to iteration_top
    // ALSO so a non-agentic turn that spans midnight still triggers
    // the date-change notice. post_tool-only collectors must NOT fire
    // here.
    const ctx = makeMinimalCtx({ callSite: 'iteration_top' })
    const result = await runCollectors(ctx)
    const names = result.outcomes.map((o) => o.name).sort()
    // 2026-07 uplift #12 added `objective_conflict` to iteration_top;
    // the system-drive-context wiring added `system_drive_context`; the
    // skill-attention uplift added `explicit_skill_mention`.
    expect(names).toEqual([
      'date_change',
      'explicit_skill_mention',
      'objective_conflict',
      'pending_tool_use_summary',
      'system_drive_context',
    ])
    // `state.pendingToolUseSummary` not set → returns null → 0 applied.
    // `date_change` on first observation per conversation also returns
    // null (no "change" to announce yet). `system_drive_context` and
    // `explicit_skill_mention` gate on an ordinary current user query —
    // the empty transcript here has none. So still 0 applied.
    expect(result.appliedActions).toBe(0)
  })

  it('returns one outcome per eligible collector at post_tool, in registry order', async () => {
    // Phase B registry: kernelInbox, interAgentQueue, subAgentOutputs,
    // dateChange, tokenUsage, compactionReminder — all post_tool. The
    // test exercises the dispatch + ordering invariant, not the
    // collectors' own gating logic (each gate is tested elsewhere).
    const ctx = makeMinimalCtx({
      callSite: 'post_tool',
      apiMessages: [{ role: 'user', content: 'fixture' }],
    })
    // The minimal ctx doesn't carry a real ContextManager / AgentContext,
    // so collectors that probe those will either skip or throw — but
    // `maybe()` isolates failures so the orchestrator returns one
    // outcome per registered post_tool collector regardless.
    const result = await runCollectors(ctx)
    const names = result.outcomes.map((o) => o.name)
    // Order matters (upstream parity invariant): registry order, not
    // promise-resolution order. We don't depend on exact length here
    // — Phase C may add more — but we do assert the prefix matches
    // Phase B's registered set and that each is present exactly once.
    // Phase D-1 registry order (post_tool):
    //   1. kernel_inbox / inter_agent_queue / sub_agent_outputs /
    //      sub_agent_status_digest — orchestration & queue drains
    //   2. mcp_instructions_delta / agent_listing_delta /
    //      buddy_state_change — registry / config deltas
    //   3. date_change / token_usage / lsp_diagnostics —
    //      background context advisories
    //   4. compaction_reminder — behavioural reminder (last)
    const expectedOrder = [
      'kernel_inbox',
      'inter_agent_queue',
      'sub_agent_outputs',
      'sub_agent_status_digest',
      'mcp_instructions_delta',
      'agent_listing_delta',
      'buddy_state_change',
      'output_style',
      'date_change',
      'token_usage',
      'lsp_diagnostics',
      'context_efficiency',
      'verify_plan_reminder',
      'compaction_reminder',
    ]
    for (const name of expectedOrder) {
      expect(names).toContain(name)
    }
    const indexes = expectedOrder.map((n) => names.indexOf(n))
    for (let i = 1; i < indexes.length; i++) {
      expect(indexes[i]).toBeGreaterThan(indexes[i - 1]!)
    }
  })

  it('runCollectors at post_tool stays within the non-critical injection budget by construction', async () => {
    // Sanity: with the minimal ctx most collectors no-op, so nothing is
    // shed and the result carries the new fields with empty defaults.
    const ctx = makeMinimalCtx({
      callSite: 'post_tool',
      apiMessages: [{ role: 'user', content: 'fixture' }],
    })
    const result = await runCollectors(ctx)
    expect(Array.isArray(result.shedCollectors)).toBe(true)
  })

  it('isolates collector failures via maybe()', async () => {
    // The compaction_reminder collector reads
    // `state.loopContextManager.getState()` — undefined on the minimal
    // ctx, so it throws. `maybe()` should catch it; the orchestrator
    // must STILL return an outcome (with `ok: false`) and must not
    // propagate the throw to the caller.
    const ctx = makeMinimalCtx({
      callSite: 'post_tool',
      apiMessages: [{ role: 'user', content: 'fixture' }],
    })
    const result = await runCollectors(ctx)
    const compactionOutcome = result.outcomes.find(
      (o) => o.name === 'compaction_reminder',
    )
    expect(compactionOutcome).toBeDefined()
    expect(compactionOutcome!.ok).toBe(false)
    // Crucially: even though one collector threw, the call as a whole
    // succeeded.
    expect(result.outcomes.length).toBeGreaterThan(0)
  })
})

// ─── Injection budget & priority shedding (2026-07 uplift) ─────────────

/** Synthetic collector emitting one push_message of `chars` characters.
 *  `name` must exist in COLLECTOR_PRIORITY when a specific tier is
 *  needed (unlisted names default to 'normal'). */
function fakeCollector(name: string, chars: number, ran: string[]): Collector {
  return {
    name,
    callSites: ['post_tool'],
    async run() {
      ran.push(name)
      return {
        kind: 'push_message',
        message: { role: 'user', content: 'x'.repeat(chars) },
      }
    },
  }
}

describe('runCollectorsWith — injection budget & priority shedding', () => {
  afterEach(() => {
    delete process.env.POLE_ATTACHMENT_BUDGET
    delete process.env.POLE_ATTACHMENT_BUDGET_MAX_MESSAGES
    delete process.env.POLE_ATTACHMENT_BUDGET_MAX_CHARS
  })

  it('sheds lowest-priority collectors once the message budget is exhausted — WITHOUT running them', async () => {
    process.env.POLE_ATTACHMENT_BUDGET_MAX_MESSAGES = '2'
    const ran: string[] = []
    const collectors = [
      fakeCollector('context_efficiency', 10, ran), // low
      fakeCollector('token_usage', 10, ran), // normal
      fakeCollector('lsp_diagnostics', 10, ran), // high
      fakeCollector('compaction_reminder', 10, ran), // normal
    ]
    const ctx = makeMinimalCtx({ callSite: 'post_tool' })
    const result = await runCollectorsWith(collectors, ctx)

    // high runs first, then normals by registry index; budget=2 admits
    // lsp_diagnostics + token_usage. compaction_reminder (later normal)
    // and context_efficiency (low) are shed and their run() never fired.
    expect(ran).toEqual(['lsp_diagnostics', 'token_usage'])
    expect(result.shedCollectors.sort()).toEqual([
      'compaction_reminder',
      'context_efficiency',
    ])
    const shedOutcome = result.outcomes.find((o) => o.name === 'context_efficiency')
    expect(shedOutcome?.shed).toBe(true)
    expect(shedOutcome?.ok).toBe(true)
    expect(result.appliedActions).toBe(2)
  })

  it('critical collectors are budget-exempt and never shed', async () => {
    process.env.POLE_ATTACHMENT_BUDGET_MAX_MESSAGES = '1'
    const ran: string[] = []
    const collectors = [
      fakeCollector('kernel_inbox', 10, ran), // critical
      fakeCollector('sub_agent_outputs', 10, ran), // critical
      fakeCollector('token_usage', 10, ran), // normal
      fakeCollector('context_efficiency', 10, ran), // low
    ]
    const ctx = makeMinimalCtx({ callSite: 'post_tool' })
    const result = await runCollectorsWith(collectors, ctx)

    // Both criticals ran and applied despite maxMessages=1; the budget
    // only constrained the non-criticals (1 admitted, 1 shed).
    expect(ran).toContain('kernel_inbox')
    expect(ran).toContain('sub_agent_outputs')
    expect(ran).toContain('token_usage')
    expect(result.shedCollectors).toEqual(['context_efficiency'])
    expect(result.appliedActions).toBe(3)
  })

  it('char budget closes the gate after an oversized action (which still applies)', async () => {
    process.env.POLE_ATTACHMENT_BUDGET_MAX_CHARS = '100'
    const ran: string[] = []
    const collectors = [
      fakeCollector('lsp_diagnostics', 500, ran), // high — oversized
      fakeCollector('token_usage', 10, ran), // normal — should be shed
    ]
    const ctx = makeMinimalCtx({ callSite: 'post_tool' })
    const result = await runCollectorsWith(collectors, ctx)

    // The oversized high-priority action is applied (post-run drops would
    // lose latched collector state) but exhausts the char budget, so the
    // next collector is shed unrun.
    expect(ran).toEqual(['lsp_diagnostics'])
    expect(result.appliedActions).toBe(1)
    expect(result.shedCollectors).toEqual(['token_usage'])
  })

  it('applies admitted actions in registry order, not priority run order', async () => {
    const ran: string[] = []
    const collectors = [
      fakeCollector('token_usage', 10, ran), // normal, registry index 0
      fakeCollector('lsp_diagnostics', 20, ran), // high, registry index 1
    ]
    const ctx = makeMinimalCtx({ callSite: 'post_tool' })
    const result = await runCollectorsWith(collectors, ctx)

    // Ran high-first…
    expect(ran).toEqual(['lsp_diagnostics', 'token_usage'])
    // …but applied registry-first (token_usage's 10-char message precedes
    // lsp_diagnostics' 20-char one in the transcript).
    const lengths = ctx.state.apiMessages.map((m) => String(m.content).length)
    expect(lengths).toEqual([10, 20])
    expect(result.requiresConversationSync).toBe(true)
  })

  it('POLE_ATTACHMENT_BUDGET=0 restores legacy unlimited behaviour', async () => {
    process.env.POLE_ATTACHMENT_BUDGET = '0'
    process.env.POLE_ATTACHMENT_BUDGET_MAX_MESSAGES = '1'
    const ran: string[] = []
    const collectors = [
      fakeCollector('context_efficiency', 10, ran),
      fakeCollector('token_usage', 10, ran),
      fakeCollector('compaction_reminder', 10, ran),
    ]
    const ctx = makeMinimalCtx({ callSite: 'post_tool' })
    const result = await runCollectorsWith(collectors, ctx)
    expect(result.shedCollectors).toEqual([])
    expect(result.appliedActions).toBe(3)
  })

  it('every registered collector has an explicit priority entry', () => {
    // Guard against a future collector silently defaulting: defaulting to
    // 'normal' is safe behaviour, but the registry review contract is that
    // COLLECTORS and COLLECTOR_PRIORITY stay in sync.
    for (const collector of COLLECTORS) {
      expect(
        COLLECTOR_PRIORITY[collector.name],
        `collector "${collector.name}" missing from COLLECTOR_PRIORITY`,
      ).toBeDefined()
    }
  })

  it('estimateActionChars covers string content, block arrays, and concat actions', () => {
    expect(
      estimateActionChars({
        kind: 'push_message',
        message: { role: 'user', content: 'abcde' },
      }),
    ).toBe(5)
    expect(
      estimateActionChars({
        kind: 'push_message',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'abc' },
            { type: 'tool_result', tool_use_id: 'x', content: 'ignored-not-text' },
            { type: 'text', text: 'de' },
          ],
        },
      }),
    ).toBe(5)
    expect(estimateActionChars({ kind: 'concat_to_last_user', text: 'abcd' })).toBe(4)
  })
})
