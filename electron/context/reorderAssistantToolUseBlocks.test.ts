/**
 * reorderAssistantToolUseBlocks — 覆盖 upstream 移植算法的所有重要分支。
 */

import { describe, expect, it } from 'vitest'
import { reorderAssistantToolUseBlocks } from './reorderAssistantToolUseBlocks'

type Block = { type: string; id?: string; text?: string; thinking?: string }

describe('reorderAssistantToolUseBlocks', () => {
  describe('no-op fast paths (return same reference)', () => {
    it('returns same reference for empty content', () => {
      const c: Block[] = []
      expect(reorderAssistantToolUseBlocks(c)).toBe(c)
    })

    it('returns same reference for single block', () => {
      const c: Block[] = [{ type: 'text', text: 'hi' }]
      expect(reorderAssistantToolUseBlocks(c)).toBe(c)
    })

    it('returns same reference for zero tool_use blocks', () => {
      const c: Block[] = [
        { type: 'text', text: 'a' },
        { type: 'thinking', thinking: 'b' },
      ]
      expect(reorderAssistantToolUseBlocks(c)).toBe(c)
    })

    it('returns same reference for exactly one tool_use', () => {
      const c: Block[] = [
        { type: 'text', text: 'a' },
        { type: 'tool_use', id: 't1' },
        { type: 'text', text: 'c' },
      ]
      expect(reorderAssistantToolUseBlocks(c)).toBe(c)
    })

    it('returns same reference when tool_use cluster is already contiguous', () => {
      const c: Block[] = [
        { type: 'text', text: 'a' },
        { type: 'tool_use', id: 't1' },
        { type: 'tool_use', id: 't2' },
        { type: 'tool_use', id: 't3' },
        { type: 'text', text: 'tail' },
      ]
      expect(reorderAssistantToolUseBlocks(c)).toBe(c)
    })
  })

  describe('reorder cases', () => {
    it('moves text between two tool_use blocks to after the cluster', () => {
      const c: Block[] = [
        { type: 'tool_use', id: 't1' },
        { type: 'text', text: 'middle' },
        { type: 'tool_use', id: 't2' },
      ]
      const out = reorderAssistantToolUseBlocks(c)
      expect(out).toEqual([
        { type: 'tool_use', id: 't1' },
        { type: 'tool_use', id: 't2' },
        { type: 'text', text: 'middle' },
      ])
      expect(out).not.toBe(c)
    })

    it('preserves leading and trailing blocks, only reorders window', () => {
      const c: Block[] = [
        { type: 'text', text: 'head' },
        { type: 'thinking', thinking: 'pre-tool reasoning' },
        { type: 'tool_use', id: 't1' },
        { type: 'text', text: 'middle' },
        { type: 'tool_use', id: 't2' },
        { type: 'text', text: 'tail' },
      ]
      const out = reorderAssistantToolUseBlocks(c)
      expect(out).toEqual([
        // head/leading thinking 在 window 之外，原样保留
        { type: 'text', text: 'head' },
        { type: 'thinking', thinking: 'pre-tool reasoning' },
        // window 内的 tool_use 先拼出来
        { type: 'tool_use', id: 't1' },
        { type: 'tool_use', id: 't2' },
        // window 内的 displaced 跟在后面
        { type: 'text', text: 'middle' },
        // tail 原样
        { type: 'text', text: 'tail' },
      ])
    })

    it('thinking dropped between tool_use blocks gets pushed to after the cluster (cc-haha 行为)', () => {
      // 这是 upstream 算法的关键文档化行为：thinking 在 tool_use 簇 INSIDE
      // 时会被推到簇之后。位置变化不影响签名校验（按 message.id 分组）。
      const c: Block[] = [
        { type: 'tool_use', id: 't1' },
        { type: 'thinking', thinking: 'mid-cluster thought' },
        { type: 'tool_use', id: 't2' },
      ]
      const out = reorderAssistantToolUseBlocks(c)
      expect(out).toEqual([
        { type: 'tool_use', id: 't1' },
        { type: 'tool_use', id: 't2' },
        { type: 'thinking', thinking: 'mid-cluster thought' },
      ])
    })

    it('handles 3+ interleaved tool_use blocks and multiple displaced blocks', () => {
      const c: Block[] = [
        { type: 'tool_use', id: 't1' },
        { type: 'text', text: 'm1' },
        { type: 'tool_use', id: 't2' },
        { type: 'thinking', thinking: 'm2' },
        { type: 'tool_use', id: 't3' },
      ]
      const out = reorderAssistantToolUseBlocks(c)
      expect(out).toEqual([
        { type: 'tool_use', id: 't1' },
        { type: 'tool_use', id: 't2' },
        { type: 'tool_use', id: 't3' },
        { type: 'text', text: 'm1' },
        { type: 'thinking', thinking: 'm2' },
      ])
    })

    it('preserves block count exactly (no block is lost)', () => {
      const c: Block[] = [
        { type: 'tool_use', id: 't1' },
        { type: 'text', text: 'a' },
        { type: 'tool_use', id: 't2' },
        { type: 'thinking', thinking: 'b' },
        { type: 'tool_use', id: 't3' },
        { type: 'text', text: 'c' },
      ]
      const out = reorderAssistantToolUseBlocks(c)
      expect(out.length).toBe(c.length)
    })
  })

  describe('idempotency', () => {
    it('running twice on the same input gives the same result', () => {
      const c: Block[] = [
        { type: 'tool_use', id: 't1' },
        { type: 'text', text: 'mid' },
        { type: 'tool_use', id: 't2' },
      ]
      const once = reorderAssistantToolUseBlocks(c)
      const twice = reorderAssistantToolUseBlocks(once)
      // 第二次跑应该是 no-op（已经连续了），返回同一引用
      expect(twice).toBe(once)
    })
  })
})
