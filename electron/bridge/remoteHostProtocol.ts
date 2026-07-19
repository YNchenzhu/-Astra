import {
  fingerprintTranscript,
  type TranscriptSnapshot,
} from '../orchestration/kernelTypes'
import type {
  RemoteHostParentMessage,
  RemoteHostWorkerMessage,
  TranscriptSnapshotWire,
} from './sessionMessages'

export class RemoteAgentLoopHostController {
  private readonly send: (message: RemoteHostWorkerMessage) => void
  private paused = false
  private resumeWaiters: Array<() => void> = []
  private readonly pendingAcks = new Map<
    number,
    { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
  >()
  private latestRevision = 0
  private latestAckPromise: Promise<void> = Promise.resolve()

  constructor(send: (message: RemoteHostWorkerMessage) => void) {
    this.send = send
  }

  onTranscriptCommit(snapshot: TranscriptSnapshot): void {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    // Keep a handled observer attached even when an ack arrives before the
    // next iteration calls awaitLatestAck(); the original promise still
    // rejects for the boundary caller.
    void promise.catch(() => undefined)
    this.latestAckPromise = promise
    this.latestRevision = snapshot.revision
    this.pendingAcks.set(snapshot.revision, { promise, resolve, reject })
    this.send({ kind: 'transcript_commit', snapshot })
  }

  handleParentMessage(message: RemoteHostParentMessage): void {
    if (message.kind === 'pause') {
      this.paused = true
      return
    }
    if (message.kind === 'resume') {
      this.paused = false
      const waiters = this.resumeWaiters.splice(0)
      for (const resume of waiters) resume()
      return
    }
    const pending = this.pendingAcks.get(message.revision)
    if (!pending) return
    this.pendingAcks.delete(message.revision)
    if (message.accepted) {
      pending.resolve()
    } else {
      pending.reject(
        new Error(
          message.reason ??
            `remote transcript conflict: revision=${message.revision} actual=${message.actualRevision ?? 'unknown'}`,
        ),
      )
    }
  }

  async iterationBoundary(iteration: number): Promise<void> {
    await this.awaitLatestAck()
    this.send({
      kind: 'iteration_boundary',
      iteration,
      revision: this.latestRevision,
    })
    if (!this.paused) return
    await new Promise<void>((resolve) => this.resumeWaiters.push(resolve))
  }

  async awaitLatestAck(): Promise<void> {
    await this.latestAckPromise
  }

  failOutstanding(error: Error): void {
    for (const pending of this.pendingAcks.values()) pending.reject(error)
    this.pendingAcks.clear()
    this.paused = false
    const waiters = this.resumeWaiters.splice(0)
    for (const resume of waiters) resume()
  }
}

export function createEmptyAcceptedTranscript(): TranscriptSnapshotWire {
  const messages: Array<Record<string, unknown>> = []
  return {
    revision: 0,
    fingerprint: fingerprintTranscript(messages),
    messages,
  }
}

export function acceptRemoteTranscriptCommit(
  accepted: TranscriptSnapshotWire,
  incoming: TranscriptSnapshotWire,
):
  | { ok: true; snapshot: TranscriptSnapshotWire }
  | { ok: false; actualRevision: number; reason: string } {
  if (incoming.revision !== accepted.revision + 1) {
    return {
      ok: false,
      actualRevision: accepted.revision,
      reason: `revision_conflict expected=${accepted.revision + 1} incoming=${incoming.revision}`,
    }
  }
  const computed = fingerprintTranscript(incoming.messages)
  if (computed !== incoming.fingerprint) {
    return {
      ok: false,
      actualRevision: accepted.revision,
      reason: `fingerprint_mismatch revision=${incoming.revision}`,
    }
  }
  return { ok: true, snapshot: structuredClone(incoming) }
}
