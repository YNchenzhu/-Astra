import { describe, it, expect } from 'vitest'
import {
  normalizeMcpServerNameList,
  parseMcpServersFromUnknown,
} from './normalizeAgentMcpServers'

describe('normalizeMcpServerNameList', () => {
  it('extracts names from string and spec entries', () => {
    expect(
      normalizeMcpServerNameList([
        ' alpha ',
        { name: 'beta' },
        { name: 'gamma', config: { command: 'node' } },
      ]),
    ).toEqual(['alpha', 'beta', 'gamma'])
  })
})

describe('parseMcpServersFromUnknown', () => {
  it('parses mixed arrays', () => {
    const r = parseMcpServersFromUnknown(['x', { name: 'y', config: { a: 1 } }])
    expect(r).toEqual(['x', { name: 'y', config: { a: 1 } }])
  })
})
