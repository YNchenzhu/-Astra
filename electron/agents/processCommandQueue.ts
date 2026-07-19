/**
 * FIFO commands that must run only while the main chat ALS chain is active (upstream-style drain).
 */

import { getAgentContext } from './agentContext'
import { isMainThreadAgentForCompact } from './postCompactCleanup'
import type { AgentId } from '../tools/ids'

export type ProcessCommandEntry = {
  /**
   * When set to a non-main id, the entry is retained until {@link drainProcessCommandQueueForAgent}
   * runs for that agent (e.g. end of sub-agent lifecycle) or {@link drainMainThreadProcessCommandQueue} clears main-only work.
   */
  agentId?: string
  label: string
  run: () => void | Promise<void>
}

const queue: ProcessCommandEntry[] = []
/**
 * P2-3: enforce a hard cap so a never-drained agentId can't grow the queue
 * forever. The default is generous (most queues stay below 100); callers
 * should set their own limit only when they know better. When we drop,
 * we prefer the oldest **main-thread** entry first — sub-agent entries
 * (`agentId` set to a non-main id) typically carry post-compact resource
 * cleanup that *must* run when the sub-agent finalizes (file locks, MCP
 * leases, shell tasks). Dropping those silently leaks resources and can
 * later cause file-lock conflicts that surface as UI hangs. Only when the
 * entire queue is sub-agent work do we drop the oldest sub-agent entry as
 * a last resort, and we log it at error level so the leak is visible.
 */
const PROCESS_COMMAND_QUEUE_MAX = 1000
let droppedMainOverflow = 0
let droppedSubAgentOverflow = 0

function isMainEntry(entry: ProcessCommandEntry): boolean {
  return entry.agentId == null || entry.agentId === 'main'
}

export function enqueueProcessCommand(entry: ProcessCommandEntry): void {
  queue.push(entry)
  if (queue.length <= PROCESS_COMMAND_QUEUE_MAX) return

  // Phase 1: try to evict the oldest main-thread entry — those are
  // "freshness wins" supervisor bookkeeping (transcript flush nudges,
  // log forwarding) and a stale one is genuinely worse than skipping.
  let evictIdx = -1
  for (let i = 0; i < queue.length; i++) {
    if (isMainEntry(queue[i])) {
      evictIdx = i
      break
    }
  }

  if (evictIdx >= 0) {
    const dropped = queue.splice(evictIdx, 1)[0]
    droppedMainOverflow++
    if (droppedMainOverflow === 1 || droppedMainOverflow % 50 === 0) {
      console.warn(
        `[processCommandQueue] queue exceeded ${PROCESS_COMMAND_QUEUE_MAX}; ` +
          `dropped oldest main-thread entry "${dropped.label}". ` +
          `Total main drops this session: ${droppedMainOverflow}.`,
      )
    }
    return
  }

  // Phase 2: queue is entirely sub-agent post-compact work that has not
  // been drained. We can't grow the queue forever, but dropping cleanup
  // tasks leaks resources (file locks, MCP leases, shell tasks). Surface
  // it at error level so the underlying never-draining sub-agent shows up
  // in operator logs.
  const dropped = queue.shift()
  droppedSubAgentOverflow++
  if (dropped) {
    console.error(
      `[processCommandQueue] LEAK: queue exceeded ${PROCESS_COMMAND_QUEUE_MAX} with only ` +
        `sub-agent cleanup pending; dropped oldest entry "${dropped.label}" ` +
        `(agentId=${dropped.agentId}). This typically means a sub-agent finalize was ` +
        `never invoked. Total sub-agent drops: ${droppedSubAgentOverflow}.`,
    )
  }
}

/** @internal */
export function clearProcessCommandQueueForTests(): void {
  queue.length = 0
}

/**
 * BUG-S5 fix: per-item timeout so a single stuck command can't block the
 * remaining drain. We bound each `run()` at a generous 30s — enough for
 * legitimate flush-to-disk / IPC roundtrips, short enough that a hung
 * cleanup doesn't strand subsequent post-compact tasks. On timeout we
 * log at warn level (the work was almost certainly partial) and move on.
 */
const PROCESS_COMMAND_RUN_TIMEOUT_MS = 30_000

async function runWithTimeout(entry: ProcessCommandEntry): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<void>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `[processCommandQueue] entry "${entry.label}" exceeded ${PROCESS_COMMAND_RUN_TIMEOUT_MS}ms; skipping to next.`,
        ),
      )
    }, PROCESS_COMMAND_RUN_TIMEOUT_MS)
  })
  try {
    await Promise.race([Promise.resolve().then(() => entry.run()), timeoutPromise])
  } catch (err) {
    console.warn(
      `[processCommandQueue] entry "${entry.label}" failed:`,
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Run queued work for `agentId` omitted or `main` only, preserving order of retained entries.
 */
export async function drainMainThreadProcessCommandQueue(): Promise<void> {
  if (!isMainThreadAgentForCompact(getAgentContext())) return
  if (queue.length === 0) return
  const snapshot = queue.splice(0, queue.length)
  const retained: ProcessCommandEntry[] = []
  for (const item of snapshot) {
    if (item.agentId != null && item.agentId !== 'main') {
      retained.push(item)
      continue
    }
    await runWithTimeout(item)
  }
  queue.push(...retained)
}

/**
 * Run queued commands targeted at `agentId` (upstream-style per-agent drain after sub-agent completes).
 * Preserves relative order among remaining entries.
 */
export async function drainProcessCommandQueueForAgent(agentId: AgentId): Promise<void> {
  const id = typeof agentId === 'string' ? agentId.trim() : ''
  if (!id) return
  if (queue.length === 0) return
  const snapshot = queue.splice(0, queue.length)
  const retained: ProcessCommandEntry[] = []
  for (const item of snapshot) {
    if (item.agentId === id) {
      await runWithTimeout(item)
      continue
    }
    retained.push(item)
  }
  queue.push(...retained)
}
