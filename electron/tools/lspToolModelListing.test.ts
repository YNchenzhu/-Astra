import { describe, it, expect, vi, afterEach } from 'vitest'
import * as lspManager from '../lsp/manager'
import { getToolDefinitions, resetToolDefinitionsSessionCacheForTests } from './schema'

describe('LSP tool model listing (isLspConnected gate)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetToolDefinitionsSessionCacheForTests()
  })

  it('excludes LSP from getToolDefinitions when connected flag is false', () => {
    vi.spyOn(lspManager, 'getInitializationStatus').mockReturnValue({ status: 'success' })
    vi.spyOn(lspManager, 'isLspConnected').mockReturnValue(false)
    expect(getToolDefinitions().some((t) => t.name === 'LSP')).toBe(false)
  })
})
