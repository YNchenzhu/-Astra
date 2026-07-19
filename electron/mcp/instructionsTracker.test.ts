/**
 * Unit tests for the MCP server `instructions` field tracker.
 *
 * Covers the data-source contract the `mcp_instructions_delta`
 * collector relies on: setter / clearer semantics, first-time vs
 * subsequent diffs, atomic snapshot update, per-conversation
 * isolation, and the normalisation of empty/whitespace strings.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetMcpInstructionsTrackerForTests,
  clearMcpServerInstructions,
  diffMcpInstructionsForConversation,
  getCurrentMcpInstructions,
  resetMcpInstructionsSnapshotForConversation,
  setMcpServerInstructions,
} from './instructionsTracker'

afterEach(() => __resetMcpInstructionsTrackerForTests())

describe('setMcpServerInstructions / getCurrentMcpInstructions', () => {
  it('stores trimmed instructions', () => {
    setMcpServerInstructions('alpha', '  hello world  ')
    expect(getCurrentMcpInstructions().get('alpha')).toBe('hello world')
  })

  it('clears the entry when given an empty / whitespace string', () => {
    setMcpServerInstructions('alpha', 'first')
    setMcpServerInstructions('alpha', '   ')
    expect(getCurrentMcpInstructions().has('alpha')).toBe(false)
  })

  it('clears the entry on null / undefined', () => {
    setMcpServerInstructions('alpha', 'first')
    setMcpServerInstructions('alpha', null)
    expect(getCurrentMcpInstructions().has('alpha')).toBe(false)
    setMcpServerInstructions('alpha', 'second')
    setMcpServerInstructions('alpha', undefined)
    expect(getCurrentMcpInstructions().has('alpha')).toBe(false)
  })

  it('clearMcpServerInstructions removes the entry', () => {
    setMcpServerInstructions('alpha', 'x')
    clearMcpServerInstructions('alpha')
    expect(getCurrentMcpInstructions().has('alpha')).toBe(false)
  })

  it('ignores empty server names defensively', () => {
    setMcpServerInstructions('', 'noop')
    expect(getCurrentMcpInstructions().size).toBe(0)
  })

  it('getCurrentMcpInstructions returns a fresh copy (not a live view)', () => {
    setMcpServerInstructions('alpha', 'first')
    const snap = getCurrentMcpInstructions()
    setMcpServerInstructions('alpha', 'second')
    // The previously-returned snapshot must not reflect the later mutation.
    expect(snap.get('alpha')).toBe('first')
  })
})

describe('diffMcpInstructionsForConversation', () => {
  it('first call surfaces every currently-connected server as `added`', () => {
    setMcpServerInstructions('alpha', 'a-instructions')
    setMcpServerInstructions('beta', 'b-instructions')
    const delta = diffMcpInstructionsForConversation('conv-1')
    expect(delta.added).toHaveLength(2)
    expect(delta.changed).toHaveLength(0)
    expect(delta.removed).toHaveLength(0)
    expect(delta.added.find((a) => a.name === 'alpha')?.instructions).toBe(
      'a-instructions',
    )
  })

  it('subsequent call returns empty delta when nothing changed', () => {
    setMcpServerInstructions('alpha', 'a')
    diffMcpInstructionsForConversation('conv-1') // initial — surfaces alpha as added
    const delta = diffMcpInstructionsForConversation('conv-1')
    expect(delta.added).toHaveLength(0)
    expect(delta.changed).toHaveLength(0)
    expect(delta.removed).toHaveLength(0)
  })

  it('surfaces server as `changed` when instructions text updates', () => {
    setMcpServerInstructions('alpha', 'v1')
    diffMcpInstructionsForConversation('conv-1')
    setMcpServerInstructions('alpha', 'v2')
    const delta = diffMcpInstructionsForConversation('conv-1')
    expect(delta.changed).toEqual([
      { name: 'alpha', previous: 'v1', current: 'v2' },
    ])
    expect(delta.added).toHaveLength(0)
    expect(delta.removed).toHaveLength(0)
  })

  it('surfaces server as `removed` when cleared after being seen', () => {
    setMcpServerInstructions('alpha', 'v1')
    diffMcpInstructionsForConversation('conv-1')
    clearMcpServerInstructions('alpha')
    const delta = diffMcpInstructionsForConversation('conv-1')
    expect(delta.removed).toEqual([{ name: 'alpha', previous: 'v1' }])
  })

  it('isolates snapshots per conversation', () => {
    setMcpServerInstructions('alpha', 'a')
    const first = diffMcpInstructionsForConversation('conv-1')
    expect(first.added).toHaveLength(1)
    // conv-2 has never been queried — should see alpha as added too.
    const second = diffMcpInstructionsForConversation('conv-2')
    expect(second.added).toHaveLength(1)
    expect(second.added[0]!.name).toBe('alpha')
    // conv-1 has already absorbed alpha into its snapshot — next query is empty.
    const third = diffMcpInstructionsForConversation('conv-1')
    expect(third.added).toHaveLength(0)
  })

  it('returns empty delta for empty conversationId (defensive)', () => {
    setMcpServerInstructions('alpha', 'x')
    const delta = diffMcpInstructionsForConversation('')
    expect(delta.added).toHaveLength(0)
    expect(delta.changed).toHaveLength(0)
    expect(delta.removed).toHaveLength(0)
  })

  it('handles a sequence: add → change → remove → re-add', () => {
    setMcpServerInstructions('alpha', 'v1')
    expect(diffMcpInstructionsForConversation('c').added).toHaveLength(1)
    setMcpServerInstructions('alpha', 'v2')
    expect(diffMcpInstructionsForConversation('c').changed).toHaveLength(1)
    clearMcpServerInstructions('alpha')
    expect(diffMcpInstructionsForConversation('c').removed).toHaveLength(1)
    setMcpServerInstructions('alpha', 'v3')
    expect(diffMcpInstructionsForConversation('c').added).toEqual([
      { name: 'alpha', instructions: 'v3' },
    ])
  })

  it('resetMcpInstructionsSnapshotForConversation forces re-surface', () => {
    setMcpServerInstructions('alpha', 'v1')
    diffMcpInstructionsForConversation('conv-1') // absorbed
    resetMcpInstructionsSnapshotForConversation('conv-1')
    const delta = diffMcpInstructionsForConversation('conv-1')
    expect(delta.added).toHaveLength(1) // re-surfaced
  })
})
