import { describe, it, expect } from 'vitest'
import {
  initSubAgentSidechain,
  appendSubAgentSidechain,
  getSubAgentSidechainTranscript,
  clearSubAgentSidechain,
} from './subAgentSidechainTranscript'

describe('subAgentSidechainTranscript', () => {
  it('records entries and clears', () => {
    const id = 'test-agent-sidechain'
    initSubAgentSidechain(id)
    appendSubAgentSidechain(id, { kind: 'tool_start', summary: 'read_file(x)' })
    const rows = getSubAgentSidechainTranscript(id)
    expect(rows.length).toBe(1)
    expect(rows[0]?.kind).toBe('tool_start')
    clearSubAgentSidechain(id)
    expect(getSubAgentSidechainTranscript(id).length).toBe(0)
  })
})
