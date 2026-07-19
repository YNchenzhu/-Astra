/**
 * Bridge subsystem — public exports.
 *
 * P1-A boundary: this module exposes the worker-isolated agentic-loop
 * runner. Consumers spawn sessions through {@link spawnSession} and
 * consume {@link SessionHandle.events} the same way they would consume
 * `runAgenticLoopAsync` directly.
 *
 *   import { spawnSession } from '../bridge'
 *   const session = spawnSession({ init: {...} })
 *   for await (const event of session.events) { … }
 *   const status = await session.done
 *
 * For task-framework integration (renderer-visible task lifecycle, kill
 * routing, notifications), use
 * `registerForegroundRemoteAgent` / `registerBackgroundRemoteAgent` from
 * `../tools/tasks` instead — those wrap a SessionHandle and emit the
 * appropriate task notifications.
 */

export { spawnSession } from './sessionSpawner'
export type {
  SessionHandle,
  SessionDoneStatus,
  SpawnSessionOptions,
  SessionWorkerLike,
} from './sessionSpawner'

export {
  parseParentMessage,
  parseWorkerMessage,
  ParentMessageSchema,
  WorkerMessageSchema,
  SessionInitSchema,
} from './sessionMessages'
export type { ParentMessage, WorkerMessage, SessionInit } from './sessionMessages'

export {
  createActivityRing,
  createStderrRing,
  createBoundedRing,
  activityFromLoopEvent,
  DEFAULT_ACTIVITY_RING_SIZE,
  DEFAULT_STDERR_RING_SIZE,
} from './activityRing'
export type {
  Activity,
  ActivityKind,
  ActivityRing,
  StderrRing,
  BoundedRing,
} from './activityRing'
