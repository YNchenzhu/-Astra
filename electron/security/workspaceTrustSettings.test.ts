import { describe, it, expect } from 'vitest'
import { parseWorkspaceTrustMode } from './workspaceTrustSettings'

describe('parseWorkspaceTrustMode', () => {
  it('defaults to legacy', () => {
    expect(parseWorkspaceTrustMode(undefined)).toBe('legacy')
    expect(parseWorkspaceTrustMode(null)).toBe('legacy')
    expect(parseWorkspaceTrustMode('')).toBe('legacy')
    expect(parseWorkspaceTrustMode('legacy')).toBe('legacy')
  })

  it('accepts strict', () => {
    expect(parseWorkspaceTrustMode('strict')).toBe('strict')
  })
})
