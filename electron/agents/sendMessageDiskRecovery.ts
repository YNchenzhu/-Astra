/**
 * upstream report §7.7 — when no live {@link getActiveAgent} row exists, recover context from
 * on-disk sidechain snapshot and start a new `runSubAgent` (same `agentId` when possible).
 */

import type { ProviderConfig } from '../ai/client'
import type { SubAgentEvent } from './types'
import type { AgentId } from '../tools/ids'
import {
  findSubAgentDiskSnapshot,
  formatSidechainSnapshotForRecoveryPrompt,
} from './subAgentSidechainDisk'
// `tools/registry` is statically imported by many other production modules
// (subAgentRunner, agenticLoop, streamHandler, …) so it always lands in the
// main bundle anyway. Promoting this from `await import(...)` removes a
// rolldown INEFFECTIVE_DYNAMIC_IMPORT warning. The module is only touched
// inside `tryResumeFromDiskTranscript` (a function body), so any import
// cycle resolves harmlessly through ESM live bindings.
//
// `subAgentRunner` is kept on the dynamic path below — it pulls in the
// full agentic-loop graph and disk recovery is a rare cold path.
import { getAllAgentDefinitions } from '../tools/registry'

export type DiskTranscriptResumeStart = {
  agentId: AgentId
  teamName?: string
}

/**
 * P1-6: per-id mutex set. Disk-recovery is fire-and-forget; without this set,
 * two SendMessages arriving at the same offline agentId during the
 * recovery's "still booting, not yet registered" window would both call
 * `runSubAgent({ agentIdOverride })`, spawning two runners under the same
 * id (which subsequently fight for the same mailbox / sidechain snapshot).
 * The lock is released when the recovery run settles.
 */
const diskRecoveryInFlight = new Set<string>()

function recoveryLockKey(workspaceRoot: string, lookupId: string): string {
  return `${workspaceRoot}::${lookupId}`
}

/**
 * Fire-and-forget sub-agent restart from disk snapshot (mirrors `resumeAgentBackground` scheduling).
 * @returns metadata when a run was started, otherwise `null`.
 */
export async function tryResumeFromDiskTranscript(params: {
  workspaceRoot: string
  lookupId: string
  inboundBody: string
  config: ProviderConfig
  model: string
  /** Prefer parent ALS signal so parent abort tears down recovery runs. */
  signal?: AbortSignal
  onEvent?: (e: SubAgentEvent) => void
}): Promise<DiskTranscriptResumeStart | null> {
  const lockKey = recoveryLockKey(params.workspaceRoot, params.lookupId)
  // P1-6: refuse to spawn a parallel recovery for the same lookup id.
  if (diskRecoveryInFlight.has(lockKey)) {
    return null
  }

  const snap = findSubAgentDiskSnapshot(params.workspaceRoot, params.lookupId)
  if (!snap?.entries?.length) return null

  const { runSubAgent, findAgentDefinition } = await import('./subAgentRunner')

  const defs = getAllAgentDefinitions()
  const def =
    findAgentDefinition(snap.agentType || 'general-purpose', defs) ??
    findAgentDefinition('general-purpose', defs)
  if (!def) return null

  const prompt = formatSidechainSnapshotForRecoveryPrompt(snap, params.inboundBody)

  const abort = new AbortController()
  const ext = params.signal
  // P2-1: keep a reference to the listener so we can detach it on completion.
  // Previously the `addEventListener` wired below was never removed; long-
  // lived parent signals would slowly accrete listeners across recoveries.
  const onParentAbort = (): void => {
    abort.abort()
  }
  if (ext) {
    if (ext.aborted) {
      abort.abort()
    } else {
      ext.addEventListener('abort', onParentAbort, { once: true })
    }
  }

  diskRecoveryInFlight.add(lockKey)
  // P1-6: claim the lock BEFORE the (async) runSubAgent kick-off, and release
  // in the runner's settle handler. We intentionally do NOT clear it inside
  // a `setTimeout`-style heuristic — the registry itself signals completion.
  const releaseLock = (): void => {
    diskRecoveryInFlight.delete(lockKey)
    if (ext) ext.removeEventListener('abort', onParentAbort)
  }

  void runSubAgent({
    config: params.config,
    model: params.model,
    agentDef: def,
    prompt,
    description: `Disk transcript recovery (${snap.agentId})`,
    name: snap.name,
    teamName: snap.teamName,
    agentIdOverride: snap.agentId,
    signal: abort.signal,
    onEvent: params.onEvent ?? (() => {}),
    stayRunningForSendMessage: Boolean(snap.teamName?.trim()),
  })
    .catch((err) => {
      console.warn('[SendMessage] disk transcript recovery run failed:', err)
    })
    .finally(releaseLock)

  return { agentId: snap.agentId, teamName: snap.teamName?.trim() || undefined }
}
