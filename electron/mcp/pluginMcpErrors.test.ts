import { describe, it, expect } from 'vitest'
import { PLUGIN_MCP_ERROR_CODE_COUNT, PluginMcpErrorCodes, describePluginMcpError } from './pluginMcpErrors'

describe('pluginMcpErrors §8.9', () => {
  it('exports at least 24 distinct error codes (OpenClaude report)', () => {
    expect(PLUGIN_MCP_ERROR_CODE_COUNT).toBeGreaterThanOrEqual(24)
  })

  it('describePluginMcpError covers every code', () => {
    for (const code of Object.values(PluginMcpErrorCodes)) {
      const msg = describePluginMcpError(code)
      expect(msg.length).toBeGreaterThan(2)
    }
  })
})
