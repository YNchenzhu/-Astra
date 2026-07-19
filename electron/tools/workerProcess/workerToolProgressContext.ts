/**
 * Optional mid-flight `emitToolProgress` bridge for utilityProcess executors.
 * `web_fetch` maps string notes into {@link ToolProgressEvent} entries; the
 * worker entry wraps each RPC with this ALS when `enableHostProgress` is set.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { ToolProgressEvent } from '../toolExecContext'

type ProgressFn = (e: ToolProgressEvent) => void

const progressAls = new AsyncLocalStorage<ProgressFn | undefined>()

export function runWithWorkerToolProgressAsync<T>(
  emit: ProgressFn | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return progressAls.run(emit, fn)
}

export function getWorkerToolProgressEmitter(): ProgressFn | undefined {
  return progressAls.getStore()
}
