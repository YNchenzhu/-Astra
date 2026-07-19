/**
 * Per-request agent gate context inside the tool utilityProcess.
 *
 * Session-memory and other gates in `fileToolValidation` / `advancedToolUtils`
 * read `getAgentContext()?.sessionAgentType`. That AsyncLocalStorage is
 * empty in the child process, so the host forwards
 * `sessionAgentType` on each {@link ToolRpcRequest} and we install it here
 * for the duration of the executor (nested tool calls see the same store).
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export type WorkerAgentGateSnapshot = {
  sessionAgentType?: string
  /** See {@link AgentContext.sessionMemoryWritableTargetPath}. */
  sessionMemoryWritableTargetPath?: string
}

const workerAgentGateAls = new AsyncLocalStorage<WorkerAgentGateSnapshot>()

export function runWithWorkerAgentGateAsync<T>(
  snap: WorkerAgentGateSnapshot,
  fn: () => Promise<T>,
): Promise<T> {
  return workerAgentGateAls.run(snap, fn)
}

export function getWorkerAgentGateSnapshot(): WorkerAgentGateSnapshot | undefined {
  return workerAgentGateAls.getStore()
}
