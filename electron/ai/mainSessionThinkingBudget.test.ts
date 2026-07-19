import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../settings/settingsAccess', () => ({
  readDiskSettings: vi.fn(() => ({})),
}))

import { resolveMainChatThinkingBudgetTokens } from './mainSessionThinkingBudget'
import { readDiskSettings } from '../settings/settingsAccess'

describe('resolveMainChatThinkingBudgetTokens', () => {
  beforeEach(() => {
    vi.mocked(readDiskSettings).mockReturnValue({})
  })

  it('uses explicit IPC override when > 0', () => {
    expect(
      resolveMainChatThinkingBudgetTokens({
        maxTokens: 1024,
        alwaysThinking: false,
        explicitOverride: 4000,
      }),
    ).toBe(4000)
  })

  it('uses disk settings when > 0 and no override', () => {
    vi.mocked(readDiskSettings).mockReturnValue({ thinkingBudgetTokens: 9000 })
    expect(
      resolveMainChatThinkingBudgetTokens({
        maxTokens: 8192,
        alwaysThinking: false,
      }),
    ).toBe(9000)
  })

  it('uses a conservative default when alwaysThinking and no disk/override', () => {
    expect(
      resolveMainChatThinkingBudgetTokens({
        maxTokens: 1000,
        alwaysThinking: true,
      }),
    ).toBe(1000)
  })

  it('caps the implicit alwaysThinking budget at 8192', () => {
    expect(
      resolveMainChatThinkingBudgetTokens({
        maxTokens: 20000,
        alwaysThinking: true,
      }),
    ).toBe(8192)
  })

  it('returns undefined when no budget applies', () => {
    expect(
      resolveMainChatThinkingBudgetTokens({
        maxTokens: 4096,
        alwaysThinking: false,
      }),
    ).toBeUndefined()
  })

  it('caps at 32768', () => {
    expect(
      resolveMainChatThinkingBudgetTokens({
        maxTokens: 20000,
        alwaysThinking: true,
        explicitOverride: 999999,
      }),
    ).toBe(32768)
  })
})
