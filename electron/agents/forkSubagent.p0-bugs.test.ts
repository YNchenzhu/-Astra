/**
 * P0 Bug 验证测试 — Fork 子系统问题
 *
 * FORK-01: forkPrompt 为空字符串时仍创建 fork — 空任务浪费资源
 *
 * buildForkedMessages(forkPrompt: string) 内部调用 getAgentContext()，
 * 需要 mock agent context 来提供父消息上下文。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// FORK-01: 空 forkPrompt 仍创建 fork
// ---------------------------------------------------------------------------

describe('FORK-01: empty forkPrompt now correctly rejected', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('buildForkedMessages 在空 prompt 时拒绝 — 修复确认', async () => {
    // Mock getAgentContext — buildForkedMessages 内部调用此函数
    vi.doMock('./agentContext', () => ({
      getAgentContext: vi.fn().mockReturnValue({
        messages: [
          { role: 'user', content: 'original question' },
          { role: 'assistant', content: 'original answer' },
        ],
      }),
    }))

    const { buildForkedMessages } = await import('./forkSubagent')

    const result = buildForkedMessages('')

    // FIX 验证: 空 prompt 现在被拒绝
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('non-empty prompt')
    }
  })

  it('forkPrompt 仅含空白字符时也被拒绝', async () => {
    vi.doMock('./agentContext', () => ({
      getAgentContext: vi.fn().mockReturnValue({
        messages: [
          { role: 'user', content: 'test' },
          { role: 'assistant', content: 'response' },
        ],
      }),
    }))

    const { buildForkedMessages } = await import('./forkSubagent')

    const result = buildForkedMessages('   \n  \t  ')

    // FIX 验证: 空白 prompt 被拒绝
    expect(result.ok).toBe(false)
  })

  it('修复后: 空 prompt 应被拒绝（描述期望行为）', () => {
    // 这个测试描述期望的正确行为
    // 修复应该在 buildForkedMessages 开头添加:
    //   if (!forkPrompt.trim()) return { ok: false, error: '...' }

    const expectedFix = (forkPrompt: string) => {
      if (!forkPrompt.trim()) {
        return { ok: false, error: 'Fork requires non-empty prompt' }
      }
      return { ok: true, messages: [] }
    }

    expect(expectedFix('')).toMatchObject({ ok: false })
    expect(expectedFix('   ')).toMatchObject({ ok: false })
    expect(expectedFix('real task')).toMatchObject({ ok: true })
  })
})
