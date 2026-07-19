/**
 * stripInlineThinkingXml — 覆盖 4 个 regex 的所有重要分支。
 */

import { describe, expect, it } from 'vitest'
import { stripInlineThinkingXml } from './stripInlineThinkingXml'

describe('stripInlineThinkingXml', () => {
  describe('passthrough', () => {
    it('returns empty string unchanged', () => {
      expect(stripInlineThinkingXml('')).toBe('')
    })

    it('returns text without thinking tags unchanged', () => {
      expect(stripInlineThinkingXml('hello world')).toBe('hello world')
    })

    it('preserves leading/trailing whitespace when no tags', () => {
      expect(stripInlineThinkingXml('  hi  ')).toBe('  hi  ')
    })

    it('is a no-op on non-string defensively', () => {
      // @ts-expect-error - intentional bad input to verify defensive return
      expect(stripInlineThinkingXml(null)).toBe(null)
      // @ts-expect-error - intentional bad input to verify defensive return
      expect(stripInlineThinkingXml(undefined)).toBe(undefined)
    })
  })

  describe('closed <thinking> tags', () => {
    it('strips a single closed <thinking> block', () => {
      const input = 'before<thinking>reasoning here</thinking>after'
      expect(stripInlineThinkingXml(input)).toBe('beforeafter')
    })

    it('strips multiple closed <thinking> blocks', () => {
      const input = '<thinking>a</thinking>x<thinking>b</thinking>y'
      expect(stripInlineThinkingXml(input)).toBe('xy')
    })

    it('strips multiline closed <thinking> blocks', () => {
      const input = 'pre<thinking>line1\nline2\nline3</thinking>post'
      expect(stripInlineThinkingXml(input)).toBe('prepost')
    })

    it('preserves the answer when thinking contains decoy keywords', () => {
      // 这是为什么要 strip 的根本原因 — 不 strip 的话 regex 会被思考里的关键字匹配到。
      const input = '<thinking>maybe the answer is yes</thinking><block>no</block>'
      const stripped = stripInlineThinkingXml(input)
      expect(stripped).toBe('<block>no</block>')
      // 模拟下游解析器
      const match = stripped.match(/<block>(yes|no)<\/block>/)
      expect(match?.[1]).toBe('no')
    })
  })

  describe('closed <think> tags (DeepSeek-R1 / Qwen-QwQ style)', () => {
    it('strips a single closed <think> block', () => {
      const input = 'before<think>r1 reasoning</think>after'
      expect(stripInlineThinkingXml(input)).toBe('beforeafter')
    })

    it('strips multiple closed <think> blocks', () => {
      const input = '<think>a</think>x<think>b</think>y'
      expect(stripInlineThinkingXml(input)).toBe('xy')
    })

    it('strips closed <think> with multiline content', () => {
      const input = 'pre<think>a\nb</think>post'
      expect(stripInlineThinkingXml(input)).toBe('prepost')
    })
  })

  describe('unclosed tail (stream cut mid-block)', () => {
    it('strips unclosed <thinking> from opening tag to end of string', () => {
      const input = 'visible<thinking>cut off here without close'
      expect(stripInlineThinkingXml(input)).toBe('visible')
    })

    it('strips unclosed <think> from opening tag to end of string', () => {
      const input = 'visible<think>cut off here without close'
      expect(stripInlineThinkingXml(input)).toBe('visible')
    })

    it('strips a closed block but also unclosed tail after it', () => {
      const input = '<thinking>done</thinking>middle<thinking>oops cut'
      expect(stripInlineThinkingXml(input)).toBe('middle')
    })
  })

  describe('mixed tag forms', () => {
    it('strips both <thinking> and <think> in same string', () => {
      const input = 'a<thinking>x</thinking>b<think>y</think>c'
      expect(stripInlineThinkingXml(input)).toBe('abc')
    })
  })

  describe('known limitations (documented behavior)', () => {
    it('nested thinking → inner content escapes (non-greedy match)', () => {
      // 文档说明：嵌套的 thinking 不被支持，外层 wrapper 的内容会被错误地匹配到第一个 </thinking>。
      // 模型不会真的产生嵌套结构；这里只是把当前实现的行为固化进测试。
      const input = '<thinking>outer<thinking>inner</thinking>still outer</thinking>after'
      const result = stripInlineThinkingXml(input)
      // 第一个 </thinking> 提前结束了外层匹配，剩下 "still outer</thinking>after"
      // 然后 thinking 的"未闭合 tail"和"closed"regex 都不会再触发（因为已经没 <thinking> 开头了）
      expect(result).toBe('still outer</thinking>after')
    })

    it('does NOT strip <thought> tags (not in vendor list)', () => {
      const input = '<thought>some other vendor</thought>kept'
      expect(stripInlineThinkingXml(input)).toBe('<thought>some other vendor</thought>kept')
    })

    it('does NOT strip case-variant tags like <Thinking>', () => {
      const input = '<Thinking>not lowercased</Thinking>kept'
      expect(stripInlineThinkingXml(input)).toBe('<Thinking>not lowercased</Thinking>kept')
    })
  })
})
