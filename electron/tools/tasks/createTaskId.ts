/**
 * Task ID generator with type-prefix discriminator.
 *
 * Mirrors upstream's prefix + base36 random scheme:
 *   - Single-letter prefix lets log-grep instantly tell tasks apart by type.
 *   - 8 bytes of crypto random encoded as base36 → ~2.8e12 distinct IDs per
 *     prefix; sufficient to avoid collisions over the lifetime of a session.
 *   - base36 (no `-` / `_`) is safe to embed in file paths, XML attributes,
 *     URLs, and `<task-notification>` blocks without escaping.
 *
 * Prefix table (upstream §6.2 parity):
 *   - `b` → local_bash      (shell execution)
 *   - `a` → local_agent     (sub-agent run)
 *   - `s` → main_session    (root user-driven session — upstream's `m` clashes with
 *                            monitor_mcp; we use `s` for "session" instead)
 *   - `r` → remote_agent    (cross-process / cross-host agent)
 *   - `w` → local_workflow  (declarative workflow execution)
 *   - `m` → monitor_mcp     (MCP server liveness monitor)
 *   - `d` → dream           (proactive idle-time agent)
 *
 * Pre-existing IDs minted before this module landed remain valid: every
 * consumer reads `task.id` as opaque, never parses the prefix.
 */

import { randomBytes } from 'node:crypto'
import type { TaskType } from './taskInterface'

const TYPE_PREFIXES: Record<TaskType, string> = {
  local_bash: 'b',
  local_agent: 'a',
  main_session: 's',
  remote_agent: 'r',
  local_workflow: 'w',
  monitor_mcp: 'm',
  dream: 'd',
}

const RANDOM_BYTES = 8
const BASE36_RADIX = 36

/**
 * Generate a fresh task id of the form `<prefix><10-12 base36 chars>`.
 * The prefix is a single ASCII letter chosen by {@link TaskType}; the suffix
 * is BigInt-encoded base36 from {@link RANDOM_BYTES} of crypto random.
 */
export function createTaskId(type: TaskType): string {
  const prefix = TYPE_PREFIXES[type]
  if (!prefix) {
    throw new Error(`createTaskId: unknown task type "${String(type)}"`)
  }
  // Read 8 random bytes as a 64-bit unsigned BigInt, then base36.
  // Length of suffix: log36(2^64) ≈ 12.4 → 12–13 chars.
  const buf = randomBytes(RANDOM_BYTES)
  let n = 0n
  for (const byte of buf) {
    n = (n << 8n) | BigInt(byte)
  }
  return `${prefix}${n.toString(BASE36_RADIX)}`
}

/**
 * Recover the {@link TaskType} from a task id minted by {@link createTaskId}.
 * Returns `undefined` for legacy ids that weren't prefixed (callers should
 * fall back to looking up `taskStateManager.getTaskState(id)?.type`).
 */
export function inferTaskTypeFromId(id: string): TaskType | undefined {
  if (!id || id.length < 2) return undefined
  const prefix = id[0]
  for (const [type, p] of Object.entries(TYPE_PREFIXES) as [TaskType, string][]) {
    if (p === prefix) return type
  }
  return undefined
}

/** Exposed for unit tests. */
export const __TEST_ONLY__ = {
  TYPE_PREFIXES,
  RANDOM_BYTES,
  BASE36_RADIX,
}
