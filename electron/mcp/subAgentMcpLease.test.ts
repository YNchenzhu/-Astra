import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { disconnect, fullResync } = vi.hoisted(() => ({
  disconnect: vi.fn(),
  fullResync: vi.fn(),
}))

vi.mock('./handlers', () => ({
  getSharedMcpManager: () => ({ disconnect }),
}))

vi.mock('./fullResyncMcpRegistry', () => ({
  fullResyncMcpRegistry: fullResync,
}))

import {
  acquireSubAgentMcpLease,
  releaseSubAgentMcpLease,
  resetSubAgentMcpLeaseForTests,
} from './subAgentMcpLease'

describe('subAgentMcpLease', () => {
  beforeEach(() => {
    disconnect.mockClear()
    fullResync.mockClear()
    resetSubAgentMcpLeaseForTests()
  })

  afterEach(() => {
    resetSubAgentMcpLeaseForTests()
  })

  it('disconnects when last lease for a server is released', async () => {
    acquireSubAgentMcpLease(['srv-a'])
    await releaseSubAgentMcpLease(['srv-a'])
    expect(disconnect).toHaveBeenCalledWith('srv-a')
    expect(fullResync).toHaveBeenCalled()
  })

  it('does not disconnect until all overlapping runs release', async () => {
    acquireSubAgentMcpLease(['srv-b'])
    acquireSubAgentMcpLease(['srv-b'])
    await releaseSubAgentMcpLease(['srv-b'])
    expect(disconnect).not.toHaveBeenCalled()
    await releaseSubAgentMcpLease(['srv-b'])
    expect(disconnect).toHaveBeenCalledWith('srv-b')
  })
})
