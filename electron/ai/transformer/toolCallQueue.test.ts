import { describe, it, expect } from 'vitest'
import {
  enqueuePendingToolCall,
  dequeuePendingToolCallByName,
  peekPendingToolCallByName,
} from './toolCallQueue'
import { createTransformContext } from './index'

describe('toolCallQueue — same-name FIFO (R3 regression)', () => {
  it('preserves ids when the same tool is called twice in a turn', () => {
    const ctx = createTransformContext()
    enqueuePendingToolCall(ctx, 'Read', 'call_read_1')
    enqueuePendingToolCall(ctx, 'Read', 'call_read_2')

    // Dequeue in order: first response matches first call.
    expect(dequeuePendingToolCallByName(ctx, 'Read')).toBe('call_read_1')
    expect(dequeuePendingToolCallByName(ctx, 'Read')).toBe('call_read_2')
    expect(dequeuePendingToolCallByName(ctx, 'Read')).toBeUndefined()
  })

  it('different names are tracked in independent queues', () => {
    const ctx = createTransformContext()
    enqueuePendingToolCall(ctx, 'Read', 'r1')
    enqueuePendingToolCall(ctx, 'Write', 'w1')
    enqueuePendingToolCall(ctx, 'Read', 'r2')

    expect(dequeuePendingToolCallByName(ctx, 'Write')).toBe('w1')
    expect(dequeuePendingToolCallByName(ctx, 'Read')).toBe('r1')
    expect(dequeuePendingToolCallByName(ctx, 'Read')).toBe('r2')
  })

  it('peek is non-destructive', () => {
    const ctx = createTransformContext()
    enqueuePendingToolCall(ctx, 'Bash', 'b1')
    expect(peekPendingToolCallByName(ctx, 'Bash')).toBe('b1')
    expect(peekPendingToolCallByName(ctx, 'Bash')).toBe('b1')
    expect(dequeuePendingToolCallByName(ctx, 'Bash')).toBe('b1')
    expect(peekPendingToolCallByName(ctx, 'Bash')).toBeUndefined()
  })

  it('ordinal increments monotonically across all names', () => {
    const ctx = createTransformContext()
    const a = enqueuePendingToolCall(ctx, 'A', 'id-a')
    const b = enqueuePendingToolCall(ctx, 'B', 'id-b')
    const c = enqueuePendingToolCall(ctx, 'A', 'id-a2')
    expect(a).toBe(1)
    expect(b).toBe(2)
    expect(c).toBe(3)
  })

  it('registers id → name in toolUseIDToName map for stream-time lookup', () => {
    const ctx = createTransformContext()
    enqueuePendingToolCall(ctx, 'Read', 'call_xyz')
    expect(ctx.toolUseIDToName.get('call_xyz')).toBe('Read')
  })
})
