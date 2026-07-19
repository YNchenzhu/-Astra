import { describe, it, expect } from 'vitest'
import {
  extractThoughtDeltaFromGeminiPart,
  geminiRequestsStructuredThoughtParts,
} from './geminiNativeThinking'

describe('geminiNativeThinking', () => {
  it('requests structured thoughts when alwaysThinking or thinking-style model id', () => {
    expect(geminiRequestsStructuredThoughtParts('claude-3', false)).toBe(false)
    expect(geminiRequestsStructuredThoughtParts('gemini-1.5-flash', false)).toBe(false)
    expect(geminiRequestsStructuredThoughtParts('gemini-2.5-flash', false)).toBe(true)
    expect(geminiRequestsStructuredThoughtParts('models/gemini-2.5-flash-preview-05-20', false)).toBe(
      true,
    )
    expect(geminiRequestsStructuredThoughtParts('google/gemini-2.5-pro', false)).toBe(true)
    expect(geminiRequestsStructuredThoughtParts('gemini-1.5-flash', true)).toBe(true)
  })

  it('extracts thought from part.thought or part.thinking', () => {
    expect(extractThoughtDeltaFromGeminiPart({ text: 'x' })).toBeUndefined()
    expect(extractThoughtDeltaFromGeminiPart({ thought: 'a' })).toBe('a')
    expect(extractThoughtDeltaFromGeminiPart({ thinking: 'b' })).toBe('b')
  })
})
