/**
 * Reference-count MCP servers first connected during a sub-agent run (upstream §3.1 teardown).
 * Avoids disconnecting while another sub-agent still holds the same lease.
 */

import { fullResyncMcpRegistry } from './fullResyncMcpRegistry'
import { getSharedMcpManager } from './handlers'

/** serverName → concurrent sub-agent runs that acquired a lease for this server */
const leaseRefCount = new Map<string, number>()

/** Call after {@link ensureMcpServersConnected} returns newly connected server names. */
export function acquireSubAgentMcpLease(serverNames: string[]): void {
  for (const raw of serverNames) {
    const n = raw.trim()
    if (!n) continue
    leaseRefCount.set(n, (leaseRefCount.get(n) ?? 0) + 1)
  }
}

/** Call from {@link finalizeSubAgentLifecycle} with the same list passed to acquire for that run. */
export async function releaseSubAgentMcpLease(serverNames: string[]): Promise<void> {
  if (!serverNames.length) return
  const manager = getSharedMcpManager()
  let anyDisconnected = false
  for (const raw of serverNames) {
    const n = raw.trim()
    if (!n) continue
    const next = (leaseRefCount.get(n) ?? 0) - 1
    if (next <= 0) {
      leaseRefCount.delete(n)
      if (manager) {
        try {
          await manager.disconnect(n)
          anyDisconnected = true
        } catch {
          /* ignore */
        }
      }
    } else {
      leaseRefCount.set(n, next)
    }
  }
  if (anyDisconnected && manager) {
    fullResyncMcpRegistry(manager)
  }
}

/** Test helper */
export function resetSubAgentMcpLeaseForTests(): void {
  leaseRefCount.clear()
}
