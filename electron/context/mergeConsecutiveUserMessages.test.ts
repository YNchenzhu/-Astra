import { describe, it, expect } from 'vitest'
import { mergeConsecutiveUserMessages } from './mergeConsecutiveUserMessages'

describe('mergeConsecutiveUserMessages', () => {
  it('merges two adjacent user string turns', () => {
    const out = mergeConsecutiveUserMessages([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('a\n\nb')
  })

  it('does not merge across assistant', () => {
    const out = mergeConsecutiveUserMessages([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ])
    expect(out).toHaveLength(3)
  })

  it('merges block content into a single array when non-text blocks exist', () => {
    const out = mergeConsecutiveUserMessages([
      {
        role: 'user',
        content: [{ type: 'text', text: 'x' }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }],
      },
    ])
    expect(out).toHaveLength(1)
    const blocks = out[0].content as Record<string, unknown>[]
    expect(blocks).toHaveLength(2)
    expect(blocks[0].type).toBe('text')
    expect(blocks[1].type).toBe('tool_result')
  })
})

/**
 * 2026-05 audit (long-run semantic-tag integrity) — production failure
 * mode pinned by these tests:
 *
 *   When `post_tool` host attachments inject a side-channel reminder
 *   (`_convertedFromSystem: true`, typed `_sideChannelKind`) right
 *   after the `user (tool_result)` turn produced by tool execution,
 *   `mergeConsecutiveUserMessages`'s AND-semantics treats the
 *   tool_result user as a "real user turn" (it carries no
 *   `_convertedFromSystem` flag) and DROPS the side-channel reminder's
 *   typed kind from the merged turn. Downstream `staleTodoNudge` /
 *   `staleTaskNudge` `computeTurnCounts` can then no longer identify
 *   the prior reminder in history, and the cadence throttle silently
 *   reduces to "fire every 10 assistant turns".
 *
 * The fix is split across two call sites — `normalizeMessagesForAPI`
 * gained an `applyConsecutiveUserMerge` option (defaults to `true` for
 * wire compatibility) so the iteration-level state writeback can opt
 * out. The tests below pin both halves of that contract directly on
 * the merge helper so a future refactor that reintroduces the merge
 * on the state path fails loudly.
 */
describe('mergeConsecutiveUserMessages — AND-semantics drops side-channel kind when adjacent to tool_result user', () => {
  it('demonstrates the failure mode the audit fix routes around', () => {
    // Production-shape pair: tool_result-only user immediately followed
    // by a side-channel reminder injected by `runCollectors({ callSite:
    // 'post_tool' })` as a separate push_message action.
    const toolResultUser = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }],
    }
    const reminder = {
      role: 'user',
      content: '<system-reminder>\n[Stale todo reminder]\nbody\n</system-reminder>',
      _convertedFromSystem: true,
      _sideChannelKind: 'stale_todo_nudge',
    }

    const merged = mergeConsecutiveUserMessages([toolResultUser, reminder])

    // Both halves collapsed into one user turn.
    expect(merged).toHaveLength(1)
    const m = merged[0]

    // AND-semantics drops both flags because the tool_result-only user
    // has no `_convertedFromSystem`. This is the documented v2/C3
    // behaviour — `mergeConsecutiveUserMessages` cannot tell apart "a
    // tool_result envelope" from "a real user typing words", so it
    // defends against false-positive side-channel labelling.
    //
    // Consequence: callers that need to identify the reminder's kind
    // in history (e.g. `staleTodoNudge.computeTurnCounts`) MUST avoid
    // invoking this merge on the iteration-level state writeback path.
    // That's why `normalizeMessagesForAPI` accepts an
    // `applyConsecutiveUserMerge` flag.
    expect(m._sideChannelKind).toBeUndefined()
    expect(m._convertedFromSystem).toBeUndefined()
  })
})

import { normalizeMessagesForAPI } from './normalizeMessagesForAPI'

describe('normalizeMessagesForAPI applyConsecutiveUserMerge option (audit fix D)', () => {
  function buildToolResultPlusReminderPair(): Array<Record<string, unknown>> {
    return [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }],
      },
      {
        role: 'user',
        content: '<system-reminder>\n[Stale todo reminder]\nbody\n</system-reminder>',
        _convertedFromSystem: true,
        _sideChannelKind: 'stale_todo_nudge',
      },
    ]
  }

  it('default — wire path — merges the pair (Bedrock-compatible) and drops the side-channel typed kind', () => {
    const out = normalizeMessagesForAPI(buildToolResultPlusReminderPair(), {
      stripInternalMeta: false,
    })
    // Two user turns merged into one — wire invariant.
    const userTurns = out.filter((m) => m.role === 'user')
    expect(userTurns).toHaveLength(1)
    // AND-semantics drops the kind. The merged turn is no longer a
    // typed side-channel from the host-detection contract's POV.
    expect(userTurns[0]._sideChannelKind).toBeUndefined()
  })

  it('applyConsecutiveUserMerge: false — state path — keeps the pair distinct and preserves the side-channel typed kind', () => {
    const out = normalizeMessagesForAPI(buildToolResultPlusReminderPair(), {
      stripInternalMeta: false,
      applyConsecutiveUserMerge: false,
    })
    const userTurns = out.filter((m) => m.role === 'user')
    // Both user turns retained — iteration-level state writeback now
    // sees the original shape.
    expect(userTurns).toHaveLength(2)
    // The reminder still carries its typed flag — downstream
    // `staleTodoNudge.computeTurnCounts` can identify it in history.
    const reminder = userTurns[1]
    expect(reminder._sideChannelKind).toBe('stale_todo_nudge')
    expect(reminder._convertedFromSystem).toBe(true)
    // The tool_result turn is unchanged.
    const toolResult = userTurns[0]
    expect(toolResult._sideChannelKind).toBeUndefined()
    expect(toolResult._convertedFromSystem).toBeUndefined()
    expect(Array.isArray(toolResult.content)).toBe(true)
  })
})
