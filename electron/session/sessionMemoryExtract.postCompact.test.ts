/**
 * Regression test for the "post-compact scribe sees an empty transcript" bug.
 *
 * Before the fix, {@link buildSessionMemoryContext} filtered out every message
 * tagged with `_convertedFromSystem: true` OR `_sideChannelKind: <any>`. After
 * auto-compact the conversation history is replaced by a single
 * `compactSummary` message bearing both of those flags — so the session-memory
 * scribe received only the directive and produced placeholder notes saying
 * "No parent conversation transcript was visible in this sub-agent context".
 *
 * The fix unwraps durable-summary side-channel messages (compactSummary /
 * contextCollapseAuto / contextCollapseDrain) and forwards them as plain
 * user-role context with a "this is the prior summary" preface.
 */

import { describe, expect, it } from 'vitest'

import { SIDE_CHANNEL_KIND, wrapSideChannelBody } from '../constants/sideChannelKinds'
import { buildSessionMemoryContext } from './sessionMemoryExtract'

const DIRECTIVE = '## directive\nupdate memory.md'

function compactSummaryMessage(summaryBody: string): Record<string, unknown> {
  return {
    role: 'user',
    content: wrapSideChannelBody(SIDE_CHANNEL_KIND.compactSummary, summaryBody),
    _convertedFromSystem: true,
    _sideChannelKind: SIDE_CHANNEL_KIND.compactSummary,
    _type: 'compact_boundary',
    _compactBoundary: true,
    _compactedAt: 1_700_000_000_000,
  }
}

function collapseDrainMessage(body: string): Record<string, unknown> {
  return {
    role: 'user',
    content: wrapSideChannelBody(SIDE_CHANNEL_KIND.contextCollapseDrain, body),
    _convertedFromSystem: true,
    _sideChannelKind: SIDE_CHANNEL_KIND.contextCollapseDrain,
  }
}

function collapseAutoMessage(body: string): Record<string, unknown> {
  return {
    role: 'user',
    content: wrapSideChannelBody(SIDE_CHANNEL_KIND.contextCollapseAuto, body),
    _convertedFromSystem: true,
    _sideChannelKind: SIDE_CHANNEL_KIND.contextCollapseAuto,
  }
}

function postCompactFileHintAttachment(body: string): Record<string, unknown> {
  return {
    role: 'user',
    content: body,
    _type: 'post_compact_attachment',
    _attachmentKind: 'file_hints',
    _convertedFromSystem: true,
    _sideChannelKind: SIDE_CHANNEL_KIND.postCompactAttachment,
  }
}

describe('buildSessionMemoryContext — post-compact transcript visibility', () => {
  it('forwards compactSummary body to scribe with the <system-reminder> envelope stripped', () => {
    const summary = 'User asked X. Assistant did Y. Files touched: foo.ts, bar.ts.'
    const messages = [compactSummaryMessage(summary)]

    const result = buildSessionMemoryContext(messages, DIRECTIVE)

    // [summaryAsUserMsg, directive]
    expect(result).toHaveLength(2)

    const forwarded = result[0]!
    expect(forwarded.role).toBe('user')
    expect(typeof forwarded.content).toBe('string')

    const body = forwarded.content as string
    // Envelope must be gone — the scribe is taught to ignore reminder tags.
    expect(body).not.toContain('<system-reminder>')
    expect(body).not.toContain('</system-reminder>')
    // The summary body itself must survive.
    expect(body).toContain(summary)
    // Preface must label the body as "prior summary, not user instruction" so
    // the scribe treats it as source-of-truth rather than echoing it back.
    expect(body).toContain('Prior conversation summary')
    expect(body).toContain('NOT a fresh user instruction')

    // The directive itself is still the final message.
    expect(result[1]).toEqual({ role: 'user', content: DIRECTIVE })
  })

  it('forwards contextCollapseAuto and contextCollapseDrain bodies too', () => {
    const autoBody =
      '[Prior conversation segment — auto-folded for context. Treat as authoritative recap; do NOT respond as if the user just narrated this.]\nEarlier the user asked Z.'
    const drainBody =
      '[Context collapse summaries — prior segments folded offline. Treat as authoritative recap of earlier conversation; do NOT respond as if the user just narrated this.]\n\n### Collapsed segment 1\nA'
    const messages = [collapseAutoMessage(autoBody), collapseDrainMessage(drainBody)]

    const result = buildSessionMemoryContext(messages, DIRECTIVE)

    expect(result).toHaveLength(3)
    for (const msg of result.slice(0, 2)) {
      expect(msg.role).toBe('user')
      expect(typeof msg.content).toBe('string')
      const body = msg.content as string
      expect(body).not.toContain('<system-reminder>')
      expect(body).toContain('Prior conversation summary')
    }
    expect((result[0]!.content as string)).toContain('Earlier the user asked Z')
    expect((result[1]!.content as string)).toContain('Collapsed segment 1')
  })

  it('still filters out post_compact_attachment file-hint messages (those are not narrative)', () => {
    // The fileHints attachment is `_convertedFromSystem: true` and
    // `_sideChannelKind: postCompactAttachment` — NOT in the durable-summary
    // set. It must continue to be filtered so memory.md does not absorb stale
    // file-rehydration hints as if they were conversation content.
    const messages = [
      postCompactFileHintAttachment(
        '[Post-compact — files read during the conversation]\n- unchanged: `/abs/foo.ts`',
      ),
    ]

    const result = buildSessionMemoryContext(messages, DIRECTIVE)
    // Only the directive — the attachment was dropped.
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ role: 'user', content: DIRECTIVE })
  })

  it('preserves the compact summary AND the surviving tail messages together', () => {
    // Realistic post-compact layout: summary first, then a few real
    // user/assistant text exchanges in the retained tail.
    const summary = 'Earlier work: refactor X, fix Y.'
    const messages: Array<Record<string, unknown>> = [
      compactSummaryMessage(summary),
      { role: 'user', content: '请继续之前的重构工作。' },
      { role: 'assistant', content: '好的，我先看看 X 的当前状态。' },
    ]

    const result = buildSessionMemoryContext(messages, DIRECTIVE)

    expect(result).toHaveLength(4)
    expect((result[0]!.content as string)).toContain(summary)
    expect(result[1]).toEqual({ role: 'user', content: '请继续之前的重构工作。' })
    expect(result[2]).toEqual({
      role: 'assistant',
      content: '好的，我先看看 X 的当前状态。',
    })
    expect(result[3]).toEqual({ role: 'user', content: DIRECTIVE })
  })

  it('does NOT regress: forkBoilerplate side-channel messages stay filtered', () => {
    // forkBoilerplate carries `_sideChannelKind` and (typically)
    // `_convertedFromSystem: true` but is a child-fork directive, not a
    // narrative recap — must continue to be filtered.
    const forkBoiler: Record<string, unknown> = {
      role: 'user',
      content: '<system-reminder>\n[fork boilerplate body]\n</system-reminder>',
      _convertedFromSystem: true,
      _sideChannelKind: SIDE_CHANNEL_KIND.forkBoilerplate,
    }

    const result = buildSessionMemoryContext([forkBoiler], DIRECTIVE)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ role: 'user', content: DIRECTIVE })
  })

  it('handles a durable-summary message whose body is empty (no spurious forward)', () => {
    const empty: Record<string, unknown> = {
      role: 'user',
      content: '<system-reminder>\n</system-reminder>',
      _convertedFromSystem: true,
      _sideChannelKind: SIDE_CHANNEL_KIND.compactSummary,
    }

    const result = buildSessionMemoryContext([empty], DIRECTIVE)
    // Unwrapping yields empty body → nothing pushed; only the directive remains.
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ role: 'user', content: DIRECTIVE })
  })
})
