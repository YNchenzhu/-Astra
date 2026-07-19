import { describe, expect, it } from 'vitest'
import { fingerprintTranscript } from '../orchestration/kernelTypes'
import {
  acceptRemoteTranscriptCommit,
  createEmptyAcceptedTranscript,
  RemoteAgentLoopHostController,
} from './remoteHostProtocol'
import type {
  RemoteHostWorkerMessage,
  TranscriptSnapshotWire,
} from './sessionMessages'

function snapshot(
  revision: number,
  text: string,
): TranscriptSnapshotWire {
  const messages = [{ role: 'assistant', content: text }]
  return {
    revision,
    fingerprint: fingerprintTranscript(messages),
    messages,
  }
}

describe('remote host transcript CAS', () => {
  it('accepts the next valid revision and rejects stale or forged commits', () => {
    const initial = createEmptyAcceptedTranscript()
    const first = acceptRemoteTranscriptCommit(initial, snapshot(1, 'one'))
    expect(first.ok).toBe(true)
    if (!first.ok) return

    expect(acceptRemoteTranscriptCommit(first.snapshot, snapshot(1, 'stale'))).toMatchObject({
      ok: false,
      actualRevision: 1,
    })
    expect(
      acceptRemoteTranscriptCommit(first.snapshot, {
        ...snapshot(2, 'two'),
        fingerprint: '0'.repeat(64),
      }),
    ).toMatchObject({ ok: false, actualRevision: 1 })
  })

  it('waits for transcript ack and applies pause only at an iteration boundary', async () => {
    const sent: RemoteHostWorkerMessage[] = []
    const controller = new RemoteAgentLoopHostController((message) => sent.push(message))
    controller.onTranscriptCommit(snapshot(1, 'one'))
    controller.handleParentMessage({ kind: 'pause', reason: 'rewind' })

    let boundaryPassed = false
    const boundary = controller.iterationBoundary(2).then(() => {
      boundaryPassed = true
    })
    await Promise.resolve()
    expect(boundaryPassed).toBe(false)

    controller.handleParentMessage({
      kind: 'transcript_ack',
      revision: 1,
      accepted: true,
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(sent.some((message) => message.kind === 'iteration_boundary')).toBe(true)
    expect(boundaryPassed).toBe(false)

    controller.handleParentMessage({ kind: 'resume' })
    await boundary
    expect(boundaryPassed).toBe(true)
  })

  it('rejects continuation when the parent rejects a commit', async () => {
    const controller = new RemoteAgentLoopHostController(() => {})
    controller.onTranscriptCommit(snapshot(1, 'one'))
    controller.handleParentMessage({
      kind: 'transcript_ack',
      revision: 1,
      accepted: false,
      actualRevision: 4,
      reason: 'revision_conflict',
    })
    await expect(controller.iterationBoundary(2)).rejects.toThrow('revision_conflict')
  })
})
