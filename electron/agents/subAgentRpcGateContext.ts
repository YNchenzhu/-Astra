/**
 * Per-RPC ALS for sub-agent worker_threads host side.
 *
 * Why this exists
 * ---------------
 * When a sub-agent runs in a `worker_threads` worker (`subAgentWorkerClient`),
 * every tool call from the worker is dispatched as an RPC back to the main
 * process where it is executed via `toolRegistry.execute(...)`. The host-side
 * handler runs in the same process as the parent agent's own ALS scope, so
 * `getAgentContext()` returns the **parent**'s `AgentContext`, not the
 * child's. Gates that key off `sessionAgentType` (notably
 * `gateSessionMemoryInternalAgentToolUse`) therefore fail to recognise that
 * a `session-memory-internal` scribe is the actual caller — the gate sees
 * 'main' (or whichever parent type) and **skips entirely**, allowing the
 * scribe to write outside its single-file sandbox.
 *
 * The in-process sub-agent path avoids this because it wraps the whole
 * child loop in `runWithAgentContextAsync(childContextBase, …)` so
 * `sessionAgentType: 'session-memory-internal'` and
 * `sessionMemoryWritableTargetPath` are visible to gates. The worker path
 * has no equivalent because the child loop runs in a different thread.
 *
 * This module is the host-side equivalent: just before invoking
 * `toolRegistry.execute` for a worker RPC, the client wraps the call in
 * {@link runWithSubAgentRpcGateAsync} with the **child's** gate-relevant
 * fields. The session-memory bridge consults this as a third data source
 * (see `electron/tools/sessionMemoryGateBridge.ts`).
 *
 * Scope is deliberately narrow — only fields needed by sandbox gates. We do
 * NOT synthesise a full `AgentContext` here because that would risk
 * shadowing the parent's context for unrelated reads inside `toolRegistry.execute`.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface SubAgentRpcGateSnapshot {
  /** Child sub-agent's effective {@link AgentContext.sessionAgentType}. */
  sessionAgentType?: string
  /** Child sub-agent's {@link AgentContext.sessionMemoryWritableTargetPath}. */
  sessionMemoryWritableTargetPath?: string
}

const subAgentRpcGateAls = new AsyncLocalStorage<SubAgentRpcGateSnapshot>()

export function runWithSubAgentRpcGateAsync<T>(
  snap: SubAgentRpcGateSnapshot,
  fn: () => Promise<T>,
): Promise<T> {
  return subAgentRpcGateAls.run(snap, fn)
}

export function getSubAgentRpcGateSnapshot(): SubAgentRpcGateSnapshot | undefined {
  return subAgentRpcGateAls.getStore()
}
