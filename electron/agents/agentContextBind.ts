/**
 * Cross-`await` callback binding for AgentContext + AsyncLocalStorage.
 *
 * Why this exists (audit P3):
 *   Node's `AsyncLocalStorage` (used by {@link agentContext.agentContextStorage})
 *   automatically propagates context across `await` and microtask boundaries.
 *   However, the propagation chain can be **broken** in three patterns the
 *   agent loop uses frequently:
 *
 *   1. `setTimeout(() => ...)` / `setImmediate(() => ...)` — the callback
 *      runs in a fresh AsyncResource. If the scheduling happened inside a
 *      `runWithAgentContext` scope but the scope exited before the timer
 *      fired, the callback sees `getAgentContext() === null`.
 *
 *   2. `void promise.then(...).catch(...).finally(...)` fire-and-forget
 *      chains — when the parent function returns synchronously (without
 *      `await`-ing the chain), the .then/.catch/.finally handlers may run
 *      after the ALS scope has exited.
 *
 *   3. `EventEmitter.on('event', handler)` — the emit happens in whatever
 *      async context the emitter is in (typically the producer's), not the
 *      registrant's.
 *
 *   `AsyncResource.bind(fn)` returns a wrapped function that re-enters the
 *   original AsyncResource (and therefore the ALS scope) before calling the
 *   inner `fn`. This is the canonical Node pattern.
 *
 * Usage rule (enforce in new code):
 *
 *   - If you write `setTimeout(handler, ms)`: use `setTimeoutBound`.
 *   - If you write `setImmediate(handler)`: use `setImmediateBound`.
 *   - If you write `void promise.then(handler)`: wrap `handler` in
 *     {@link bindAgentContext} (or pass through `.then(bindAgentContext(h))`).
 *   - For `EventEmitter.on('foo', handler)`: wrap the handler too.
 *
 *   When the callback never reads `getAgentContext()` (e.g. a pure cleanup
 *   that touches only module-level state), binding is harmless and the
 *   small overhead is worth the defensive shield against future code that
 *   adds context reads.
 */

import { AsyncResource } from 'node:async_hooks'

/**
 * Bind a callback to the current async resource (and therefore the current
 * AgentContext / AsyncLocalStorage scope). The returned function carries
 * the same call signature as `fn`.
 *
 * Implementation note: `AsyncResource.bind` is preferred over manually
 * snapshotting `agentContextStorage.getStore()` because it preserves the
 * **entire** ALS chain (Cls hooks, OpenTelemetry, etc. — anything else
 * using async_hooks in the same Electron main process), not just our
 * `AgentContext` ALS instance.
 *
 * If binding throws (e.g. running outside Node — which doesn't happen in
 * Electron main but we keep the safety net), we fall back to the raw
 * function so the caller's behaviour is preserved.
 */
export function bindAgentContext<TArgs extends unknown[], TRet>(
  fn: (...args: TArgs) => TRet,
): (...args: TArgs) => TRet {
  try {
    return AsyncResource.bind(fn)
  } catch {
    return fn
  }
}

/**
 * Bound replacement for `setTimeout`. The callback fires inside the
 * caller's AsyncResource so `getAgentContext()` returns the same value
 * the caller observed when scheduling.
 *
 * Returns the timer handle so callers can `clearTimeout` it.
 */
export function setTimeoutBound(
  handler: () => void,
  ms: number,
): ReturnType<typeof setTimeout> {
  return setTimeout(bindAgentContext(handler), ms)
}

/**
 * Bound replacement for `setImmediate`. Same contract as
 * {@link setTimeoutBound}.
 */
export function setImmediateBound(
  handler: () => void,
): ReturnType<typeof setImmediate> {
  return setImmediate(bindAgentContext(handler))
}
