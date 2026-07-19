import { describe, it, expect } from 'vitest'
import { mapStopReasonToClaude } from './stopReasonMap'

describe('mapStopReasonToClaude', () => {
  describe('openai (chat + compat)', () => {
    it('stop → end_turn, or tool_use when tool blocks present', () => {
      expect(mapStopReasonToClaude('openai-compat', 'stop')).toBe('end_turn')
      expect(
        mapStopReasonToClaude('openai-compat', 'stop', { hasToolUseBlocks: true }),
      ).toBe('tool_use')
    })

    it('length → max_tokens (preserves agenticLoop recovery)', () => {
      expect(mapStopReasonToClaude('openai-compat', 'length')).toBe('max_tokens')
    })

    it('tool_calls / function_call → tool_use', () => {
      expect(mapStopReasonToClaude('openai-compat', 'tool_calls')).toBe('tool_use')
      expect(mapStopReasonToClaude('openai-compat', 'function_call')).toBe('tool_use')
    })

    it('content_filter → refusal', () => {
      expect(mapStopReasonToClaude('openai-compat', 'content_filter')).toBe('refusal')
    })
  })

  describe('gemini (native + compat)', () => {
    it('STOP → end_turn (was the fundamental bug pre-fix)', () => {
      expect(mapStopReasonToClaude('gemini-native', 'STOP')).toBe('end_turn')
    })

    it('MAX_TOKENS (uppercase) → max_tokens', () => {
      // Before the unified mapper, this value flowed through untouched and
      // agenticLoop's `lastStreamStopReason === 'max_tokens'` check failed
      // for every Gemini request.
      expect(mapStopReasonToClaude('gemini-compat', 'MAX_TOKENS')).toBe('max_tokens')
    })

    it('SAFETY / BLOCKLIST → refusal', () => {
      expect(mapStopReasonToClaude('gemini-native', 'SAFETY')).toBe('refusal')
      expect(mapStopReasonToClaude('gemini-native', 'BLOCKLIST')).toBe('refusal')
    })

    it('STOP with tool_use blocks → tool_use', () => {
      expect(
        mapStopReasonToClaude('gemini-native', 'STOP', { hasToolUseBlocks: true }),
      ).toBe('tool_use')
    })
  })

  describe('openai2 (Responses API)', () => {
    it('completed + tool blocks → tool_use', () => {
      expect(
        mapStopReasonToClaude('openai2-native', 'completed', { hasToolUseBlocks: true }),
      ).toBe('tool_use')
    })

    it('incomplete → max_tokens (most common cause)', () => {
      expect(mapStopReasonToClaude('openai2-compat', 'incomplete')).toBe('max_tokens')
    })
  })

  describe('anthropic pass-through', () => {
    it('native end_turn / tool_use / max_tokens survive unchanged', () => {
      expect(mapStopReasonToClaude('anthropic', 'end_turn')).toBe('end_turn')
      expect(mapStopReasonToClaude('anthropic', 'tool_use')).toBe('tool_use')
      expect(mapStopReasonToClaude('anthropic', 'max_tokens')).toBe('max_tokens')
    })

    it('empty / null → end_turn', () => {
      expect(mapStopReasonToClaude('anthropic', '')).toBe('end_turn')
      expect(mapStopReasonToClaude('anthropic', null)).toBe('end_turn')
      expect(mapStopReasonToClaude('anthropic', undefined)).toBe('end_turn')
    })
  })

  describe('unknown reason', () => {
    it('falls back to end_turn', () => {
      expect(mapStopReasonToClaude('openai-compat', 'mystery')).toBe('end_turn')
      expect(mapStopReasonToClaude('gemini-compat', 'MYSTERY')).toBe('end_turn')
    })
  })
})
