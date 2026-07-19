import { describe, it, expect } from 'vitest'
import type { Tool } from './types'
import { buildModelFacingToolDescription } from './schema'

describe('buildModelFacingToolDescription', () => {
  it('appends modelDescriptionExtension', () => {
    const tool = {
      name: 'demo',
      description: 'Base text.',
      modelDescriptionExtension: 'Extra guidance for the model.',
      inputSchema: [],
      isReadOnly: true,
      execute: async () => ({ success: true }),
    } as unknown as Tool
    expect(buildModelFacingToolDescription(tool)).toBe(
      'Base text.\n\nExtra guidance for the model.',
    )
  })

  it('returns base when extension missing', () => {
    const tool = {
      name: 'demo',
      description: 'Only base',
      inputSchema: [],
      isReadOnly: true,
      execute: async () => ({ success: true }),
    } as unknown as Tool
    expect(buildModelFacingToolDescription(tool)).toBe('Only base')
  })
})
