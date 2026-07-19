/**
 * Unit tests for ChatInteractionMode related pure logic — constants and
 * mode-transition invariants that must hold regardless of the Zustand
 * middleware or IPC transport.
 *
 * These tests run in node (no DOM), relying only on the exported types.
 */

import { describe, expect, it } from 'vitest'
import { CHAT_MODE_OPTIONS, type ChatInteractionMode } from './types'

describe('CHAT_MODE_OPTIONS', () => {
  it('has exactly three modes: agent, plan, ask', () => {
    const ids = CHAT_MODE_OPTIONS.map((o) => o.id)
    expect(ids).toEqual(['agent', 'plan', 'ask'])
  })

  it('every mode has a non-empty label and hint', () => {
    for (const opt of CHAT_MODE_OPTIONS) {
      expect(opt.label.trim().length).toBeGreaterThan(0)
      expect(opt.hint.trim().length).toBeGreaterThan(0)
    }
  })

  it('no duplicate ids', () => {
    const ids = CHAT_MODE_OPTIONS.map((o) => o.id)
    expect(ids.length).toBe(new Set(ids).size)
  })

  // Mode transition safety: "ask" mode must not enable tools (validated at
  // send time in sendSlice.ts). This test just confirms the constant shape.
  it('ask mode exists as a valid ChatInteractionMode', () => {
    expect(CHAT_MODE_OPTIONS.some((o) => o.id === 'ask')).toBe(true)
  })
})

describe('ChatInteractionMode type safety', () => {
  it('accepts all valid mode strings', () => {
    const valid: ChatInteractionMode[] = ['agent', 'plan', 'ask']
    for (const v of valid) {
      const mode: ChatInteractionMode = v
      expect(mode).toBe(v)
    }
  })
})
