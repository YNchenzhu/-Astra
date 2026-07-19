/**
 * 阶段 3 — `createConductorBestOfNPort` factory tests.
 *
 *   1. returns undefined when the sub-agent worker is unavailable (best-of-N
 *      needs real worktree isolation → degrade to rewind).
 *   2. when available, returns a port that drives `runBestOfN` with a
 *      worktree-isolated sub-agent attempt and surfaces `integrated`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const runBestOfNMock = vi.fn()
const createSubAgentRunAttemptMock = vi.fn(() => 'RUN_ATTEMPT_FN')
const subAgentWorkerAvailableMock = vi.fn()

vi.mock('./bestOfN', () => ({
  runBestOfN: (args: unknown) => runBestOfNMock(args),
}))
vi.mock('./bestOfNSubAgent', () => ({
  createSubAgentRunAttempt: () => createSubAgentRunAttemptMock(),
}))
vi.mock('../agents/subAgentWorkerClient', () => ({
  subAgentWorkerAvailable: () => subAgentWorkerAvailableMock(),
}))

import { createConductorBestOfNPort } from './conductorBestOfNPort'

beforeEach(() => {
  runBestOfNMock.mockReset()
  createSubAgentRunAttemptMock.mockClear()
  subAgentWorkerAvailableMock.mockReset()
})

describe('createConductorBestOfNPort', () => {
  it('returns undefined when the sub-agent worker is unavailable', () => {
    subAgentWorkerAvailableMock.mockReturnValue(false)
    expect(createConductorBestOfNPort()).toBeUndefined()
    expect(runBestOfNMock).not.toHaveBeenCalled()
  })

  it('returns a port that runs best-of-N and surfaces integrated', async () => {
    subAgentWorkerAvailableMock.mockReturnValue(true)
    runBestOfNMock.mockResolvedValue({ integrated: true, ranked: [], attempts: [], notes: [] })

    const port = createConductorBestOfNPort({ n: 4, conversationId: 'conv-1' })
    expect(port).toBeDefined()

    const ac = new AbortController()
    const out = await port!.run({ task: 'refactor X', signal: ac.signal })

    expect(out).toEqual({ integrated: true })
    expect(runBestOfNMock).toHaveBeenCalledTimes(1)
    const args = runBestOfNMock.mock.calls[0]![0] as {
      task: string
      n: number
      runAttempt: unknown
      integrateWinner: boolean
      conversationId?: string
      signal?: AbortSignal
    }
    expect(args.task).toBe('refactor X')
    expect(args.n).toBe(4)
    expect(args.integrateWinner).toBe(true)
    expect(args.runAttempt).toBe('RUN_ATTEMPT_FN')
    expect(args.conversationId).toBe('conv-1')
    expect(args.signal).toBe(ac.signal)
  })

  it('defaults n to 3 when not specified', async () => {
    subAgentWorkerAvailableMock.mockReturnValue(true)
    runBestOfNMock.mockResolvedValue({ integrated: false, ranked: [], attempts: [], notes: [] })

    const port = createConductorBestOfNPort()
    await port!.run({ task: 't' })

    const args = runBestOfNMock.mock.calls[0]![0] as { n: number }
    expect(args.n).toBe(3)
  })
})
