/**
 * Session-memory fork snapshot tests — including the 2026-07 one-turn-lag
 * fix: the CURRENT turn's final assistant text (not yet pushed into
 * apiMessages at trigger time) must be appended to the scribe's material.
 */

import { describe, expect, it } from 'vitest'
import { snapshotAgentContextForSessionMemoryFork } from './memoryForkSnapshot'
import { buildSessionMemoryContext } from './sessionMemoryExtract'
import type { AgentContext } from '../agents/agentContext'

function ctxWith(messages: Array<Record<string, unknown>>): AgentContext {
  return { agentId: 'main', messages } as unknown as AgentContext
}

describe('snapshotAgentContextForSessionMemoryFork', () => {
  it('deep-clones messages — mutating the snapshot never touches the original', () => {
    const original = [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
    ]
    const snap = snapshotAgentContextForSessionMemoryFork(ctxWith(original))
    ;(snap.messages[0]!.content as Array<Record<string, unknown>>)[0]!.text = 'MUTATED'
    expect((original[0]!.content as Array<Record<string, unknown>>)[0]!.text).toBe('q')
  })

  it('appends the pending final assistant text (one-turn-lag fix)', () => {
    const snap = snapshotAgentContextForSessionMemoryFork(
      ctxWith([{ role: 'user', content: '排查内存泄漏' }]),
      { pendingAssistantText: '结论：泄漏在 watcher 未解绑，已修复。' },
    )
    const tail = snap.messages[snap.messages.length - 1]!
    expect(tail.role).toBe('assistant')
    expect(tail.content).toBe('结论：泄漏在 watcher 未解绑，已修复。')
  })

  it('does not append empty / whitespace-only pending text', () => {
    const base = [{ role: 'user', content: 'q' }]
    expect(
      snapshotAgentContextForSessionMemoryFork(ctxWith(base), { pendingAssistantText: '  \n ' })
        .messages,
    ).toHaveLength(1)
    expect(
      snapshotAgentContextForSessionMemoryFork(ctxWith(base)).messages,
    ).toHaveLength(1)
  })

  it('dedupes when the tail already carries the same text (string content)', () => {
    const snap = snapshotAgentContextForSessionMemoryFork(
      ctxWith([
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '最终结论' },
      ]),
      { pendingAssistantText: '最终结论' },
    )
    expect(snap.messages).toHaveLength(2)
  })

  it('dedupes when the tail already carries the same text (block-array content)', () => {
    const snap = snapshotAgentContextForSessionMemoryFork(
      ctxWith([
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: '最终结论' },
          ],
        },
      ]),
      { pendingAssistantText: '最终结论' },
    )
    expect(snap.messages).toHaveLength(2)
  })

  it('end-to-end: the synthetic assistant message survives the scribe context filter', () => {
    // The whole point of the fix — the CURRENT round's conclusion must be
    // in the material the scribe actually reads after sanitisation.
    const snap = snapshotAgentContextForSessionMemoryFork(
      ctxWith([
        { role: 'user', content: '排查内存泄漏' },
        // Tool-only assistant turn — stripped by the scribe filter.
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }] },
      ]),
      { pendingAssistantText: '结论：泄漏在 watcher 未解绑，已修复。' },
    )
    const scribeContext = buildSessionMemoryContext(
      snap.messages as Array<Record<string, unknown>>,
      'DIRECTIVE',
    )
    const flat = JSON.stringify(scribeContext)
    expect(flat).toContain('结论：泄漏在 watcher 未解绑，已修复。')
    expect(flat).toContain('排查内存泄漏')
    // Tool noise stays stripped.
    expect(flat).not.toContain('tool_use')
  })
})
