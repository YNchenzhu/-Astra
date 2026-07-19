/**
 * Resource Quota & Backpressure — global resource governance for tool execution.
 *
 * Why this exists:
 *   - Legacy limits are static constants (MAX_PARALLEL_TOOL_CALLS = 10).
 *   - Tool Orchestration needs *dynamic* limits that adapt to actual load:
 *     token burn rate, disk I/O, network saturation, shell child count.
 *   - When limits are approached, the system should exert backpressure
 *     (queue / downgrade / pause) rather than hard-failing.
 */

import type { AgentId } from '../../tools/ids'
import { getAllToolEntries, getToolEntry } from './state'
import { toolRegistry } from '../../tools/registry'

export interface ResourceQuotaConfig {
  /** Max concurrent shell processes across ALL agents. */
  maxGlobalShellChildren: number
  /** Max concurrent network requests (WebFetch/WebSearch). */
  maxGlobalNetworkRequests: number
  /**
   * Max disk write bytes per second (soft limit).
   *
   * Audit fix M-4 — now ENFORCED: the file-write tools (`write_file`,
   * `edit_file`, `multi_edit_file`) already feed `recordDiskWrite(bytes)`, and
   * `admit()` now throttles new MUTATION-tool admissions (`reason:
   * 'disk_quota'`) once the rolling 1s write rate reaches this ceiling.
   * Default 50 MB/s is generous; the gate only bites on pathological
   * write storms.
   */
  maxDiskWriteBytesPerSecond: number
  /**
   * Max model-token consumption rate (tokens per minute) across the process.
   *
   * Audit fix M-4 — this is now ENFORCED against the live recorded burn rate
   * (`recordTokenUsage`, fed by `streamHandler` after every stream pass), not
   * just the per-call estimate. When the rolling 60s rate reaches this ceiling
   * `admit()` throttles new tool admissions (`reason: 'token_rate'`) so the
   * backpressure loop waits instead of piling on more work. Default is very
   * high (10M/min) so behaviour is unchanged until an operator tunes it down.
   */
  maxTokenRatePerMinute: number
  /** Max parallel read-only tools across all agents. */
  maxGlobalReadOnlyParallel: number
  /** Max parallel mutation tools across all agents. */
  maxGlobalMutationParallel: number
  /** When true, preempt low-priority tools instead of queuing. */
  enablePreemption: boolean
  /** Cooldown ms after preemption before a paused tool can resume. */
  preemptionCooldownMs: number
  /**
   * P2-5 (2026-06) — total backpressure wait budget per tool batch, in ms.
   *
   * When `admit()` rejects a tool, `DefaultToolRuntimePort` no longer
   * hard-fails immediately: it marks the tool `'blocked'` (reason
   * `'backpressure'`) and re-attempts admission at `retryAfterMs` intervals
   * until either a slot frees up or this budget (shared across the whole
   * batch) is exhausted. Only then does the denial `tool_result` fire.
   * Set to 0 to restore the legacy instant-deny behaviour.
   */
  backpressureMaxWaitMs: number
}

const DEFAULT_CONFIG: ResourceQuotaConfig = {
  maxGlobalShellChildren: 8,
  maxGlobalNetworkRequests: 6,
  maxDiskWriteBytesPerSecond: 50 * 1024 * 1024, // 50 MB/s
  maxTokenRatePerMinute: 10_000_000,
  maxGlobalReadOnlyParallel: 16,
  maxGlobalMutationParallel: 10,
  enablePreemption: true,
  preemptionCooldownMs: 2_000,
  backpressureMaxWaitMs: 8_000,
}

export interface ResourceSnapshot {
  activeShellChildren: number
  activeNetworkRequests: number
  diskWriteBytesPerSecond: number
  tokensPerMinute: number
  activeReadOnlyTools: number
  activeMutationTools: number
}

export interface AdmissionDecision {
  allowed: boolean
  /** If false, the reason code. */
  reason?: 'shell_quota' | 'network_quota' | 'disk_quota' | 'token_rate' | 'mutation_concurrency' | 'readonly_concurrency'
  /** Suggested delay before retry (ms). */
  retryAfterMs?: number
  /** If preemption is possible, the victim toolUseId to pause. */
  preemptionTarget?: string
}

/**
 * Sliding-window sum with cached total — O(1) amortised reads.
 *
 * Replaces the previous `Array.shift()` + `Array.reduce()` pattern that was O(n) per `snapshot()`
 * and could accumulate hundreds of entries during high-frequency tool bursts (e.g. parallel
 * `Read` calls). The cached sum and head-pointer eviction give O(1) amortised cost regardless
 * of burst size.
 */
class SlidingWindowSum {
  private entries: Array<{ value: number; timestamp: number }> = []
  private head = 0
  private cachedSum = 0
  private readonly maxAgeMs: number

  constructor(maxAgeMs: number) {
    this.maxAgeMs = maxAgeMs
  }

  add(value: number, timestamp: number = Date.now()): void {
    this.entries.push({ value, timestamp })
    this.cachedSum += value
  }

  /** Trim aged-out entries and return the current sum. Amortised O(1). */
  sum(now: number = Date.now()): number {
    const cutoff = now - this.maxAgeMs
    while (this.head < this.entries.length && this.entries[this.head].timestamp < cutoff) {
      this.cachedSum -= this.entries[this.head].value
      this.head++
    }
    // Compact when the dead-head region dominates the array, keeping live memory ~O(active items).
    if (this.head > 64 && this.head * 2 > this.entries.length) {
      this.entries = this.entries.slice(this.head)
      this.head = 0
    }
    if (this.cachedSum < 0) this.cachedSum = 0 // float drift safety
    return this.cachedSum
  }

  reset(): void {
    this.entries = []
    this.head = 0
    this.cachedSum = 0
  }
}

/**
 * Audit fix SA-4 (TOCTOU) — a pending admission slot.
 *
 * `admit()` reads the ToolRuntimeState snapshot (`status === 'running'`)
 * but callers only call `markToolRunning` AFTER admit returns. Between the
 * two, any number of interleaved `admit()` calls (parallel batches,
 * parallel agents) saw the same stale "running" count and could all pass,
 * briefly exceeding the concurrency caps. Since `admit()` is synchronous,
 * registering a reservation inside the same call closes the window: the
 * next `admit()` in the same tick already counts it.
 */
interface AdmissionReservation {
  toolUseId: string
  toolName: string
  isReadOnly: boolean
  createdAt: number
}

/**
 * Audit fix SA-4 — TTL safety net for reservations whose tool never reaches
 * `markToolRunning` (caller crashed between admit and start, or admitted a
 * tool that was later dropped without an explicit `release()`). 30s is far
 * above any sane admit→start latency, so a live reservation is never
 * evicted prematurely.
 */
const RESERVATION_TTL_MS = 30_000

class ResourceQuotaManager {
  private config: ResourceQuotaConfig
  private tokenWindow = new SlidingWindowSum(60_000)
  private diskWindow = new SlidingWindowSum(1_000)
  /** Audit fix SA-4 — unconsumed admissions, keyed by toolUseId. */
  private reservations = new Map<string, AdmissionReservation>()
  /**
   * P2-10 — wall-clock ms of the most recent preemption decision per resource
   * lane (`shell` / `network` / `mutation`). Enforces {@link
   * ResourceQuotaConfig.preemptionCooldownMs}: within the cooldown window we
   * refuse to evict a SECOND victim in the same lane, so a burst of
   * higher-priority newcomers can't thrash the in-flight population (abort N
   * running tools back-to-back). During the cooldown the newcomer falls back
   * to the normal throttle + backpressure-retry path instead. Previously this
   * config field was defined but never consulted.
   */
  private lastPreemptionAtByResource = new Map<string, number>()

  constructor(config?: Partial<ResourceQuotaConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  updateConfig(partial: Partial<ResourceQuotaConfig>): void {
    this.config = { ...this.config, ...partial }
  }

  getConfig(): Readonly<ResourceQuotaConfig> {
    return this.config
  }

  /** Admit a new tool based on current global resource pressure. */
  admit(params: {
    toolName: string
    toolUseId: string
    agentId: AgentId
    isReadOnly: boolean
    estimatedDurationMs?: number
    estimatedTokens?: number
    priority: number
  }): AdmissionDecision {
    // Audit fix SA-4 — reconcile reservations first, then layer the
    // unconsumed ones on top of the 'running' snapshot. Counting both
    // (after reconciliation removed every reservation whose tool already
    // shows up as running) closes the admit→markToolRunning TOCTOU window
    // without ever double-counting a toolUseId.
    const now = Date.now()
    this.reconcileReservations(now)
    const snap = this.snapshot()
    const reserved = this.countReservations(params.toolUseId)

    // 1. Shell quota
    if (isShellTool(params.toolName) && snap.activeShellChildren + reserved.shell >= this.config.maxGlobalShellChildren) {
      const victim = this.tryPreempt('shell', params, now)
      if (victim) return { allowed: true, preemptionTarget: victim }
      return { allowed: false, reason: 'shell_quota', retryAfterMs: 1_000 }
    }

    // 2. Network quota
    if (isNetworkTool(params.toolName) && snap.activeNetworkRequests + reserved.network >= this.config.maxGlobalNetworkRequests) {
      const victim = this.tryPreempt('network', params, now)
      if (victim) return { allowed: true, preemptionTarget: victim }
      return { allowed: false, reason: 'network_quota', retryAfterMs: 2_000 }
    }

    // 3. Mutation concurrency
    if (!params.isReadOnly && snap.activeMutationTools + reserved.mutation >= this.config.maxGlobalMutationParallel) {
      const victim = this.tryPreempt('mutation', params, now)
      if (victim) return { allowed: true, preemptionTarget: victim }
      return { allowed: false, reason: 'mutation_concurrency', retryAfterMs: 500 }
    }

    // 4. Read-only concurrency (generous, but still capped)
    if (params.isReadOnly && snap.activeReadOnlyTools + reserved.readOnly >= this.config.maxGlobalReadOnlyParallel) {
      return { allowed: false, reason: 'readonly_concurrency', retryAfterMs: 200 }
    }

    // 4b. Disk write rate — Audit fix M-4: gate MUTATION tools on the LIVE
    //     recorded write rate (`recordDiskWrite`, fed by write_file /
    //     edit_file / multi_edit_file). Read-only tools never write, so they
    //     skip this. No preemption (a byte-rate isn't a per-victim slot like
    //     shell/network concurrency); a simple throttle + retry, matching the
    //     token-rate gate below.
    if (
      !params.isReadOnly &&
      snap.diskWriteBytesPerSecond >= this.config.maxDiskWriteBytesPerSecond
    ) {
      return { allowed: false, reason: 'disk_quota', retryAfterMs: 500 }
    }

    // 5. Token rate — Audit fix M-4: gate on the LIVE recorded burn rate
    //    (`recordTokenUsage`, fed by `streamHandler`) so the knob is enforced
    //    even when no per-tool estimate is supplied. An explicit
    //    `estimatedTokens` (when a caller has one) is projected on top.
    //    `>=` so a process already at the ceiling throttles the next tool.
    if (snap.tokensPerMinute + (params.estimatedTokens ?? 0) >= this.config.maxTokenRatePerMinute) {
      return { allowed: false, reason: 'token_rate', retryAfterMs: 5_000 }
    }

    this.reserve(params, now)
    return { allowed: true }
  }

  /**
   * Audit fix SA-4 — explicitly release an admission reservation.
   *
   * Not required for correctness on the existing call paths (reservations
   * self-release via reconciliation once the tool reaches 'running' or a
   * terminal state, and via TTL otherwise), but exported so callers that
   * admit a tool and then decide NOT to run it (e.g. a later preflight
   * gate denies it) can free the slot immediately instead of waiting for
   * the TTL.
   */
  release(toolUseId: string): void {
    this.reservations.delete(toolUseId)
  }

  /**
   * Audit fix SA-4 — drop reservations that are consumed or expired.
   *
   * A reservation is *consumed* once its registry entry leaves the
   * pre-running states ('queued' / 'preparing' / 'blocked'): either it is
   * now 'running' (the snapshot counts it, so keeping the reservation
   * would double-count the same toolUseId) or it reached 'paused' / a
   * terminal state (slot freed or intentionally not counted). Entries
   * never registered with ToolRuntimeState fall back to the TTL.
   */
  private reconcileReservations(now: number): void {
    for (const [id, r] of this.reservations) {
      if (now - r.createdAt > RESERVATION_TTL_MS) {
        this.reservations.delete(id)
        continue
      }
      const entry = getToolEntry(id)
      if (!entry) continue
      if (entry.status !== 'queued' && entry.status !== 'preparing' && entry.status !== 'blocked') {
        this.reservations.delete(id)
      }
    }
  }

  /**
   * Audit fix SA-4 — bucket the unconsumed reservations the same way
   * `snapshot()` buckets running tools. The candidate's own toolUseId is
   * excluded so a re-admit of the same tool (e.g. the backpressure retry
   * loop in `DefaultToolRuntimePort`) never denies itself — re-admission
   * of an already-reserved id is idempotent.
   */
  private countReservations(excludeToolUseId: string): {
    shell: number
    network: number
    readOnly: number
    mutation: number
  } {
    let shell = 0
    let network = 0
    let readOnly = 0
    let mutation = 0
    for (const r of this.reservations.values()) {
      if (r.toolUseId === excludeToolUseId) continue
      if (isShellTool(r.toolName)) shell++
      if (isNetworkTool(r.toolName)) network++
      if (r.isReadOnly) readOnly++
      else mutation++
    }
    return { shell, network, readOnly, mutation }
  }

  /** Audit fix SA-4 — register (or refresh) a reservation for an admitted tool. */
  private reserve(
    params: { toolUseId: string; toolName: string; isReadOnly: boolean },
    now: number,
  ): void {
    this.reservations.set(params.toolUseId, {
      toolUseId: params.toolUseId,
      toolName: params.toolName,
      isReadOnly: params.isReadOnly,
      createdAt: now,
    })
  }

  /** Record actual token consumption for rate-window tracking. */
  recordTokenUsage(tokens: number): void {
    this.tokenWindow.add(tokens)
  }

  /** Record actual disk write for rate tracking (fed by the file-write tools). */
  recordDiskWrite(bytes: number): void {
    this.diskWindow.add(bytes)
  }

  /** Current resource pressure snapshot. */
  snapshot(): ResourceSnapshot {
    const tools = getAllToolEntries()
    return {
      activeShellChildren: tools.filter(
        (t) => t.status === 'running' && isShellTool(t.toolName),
      ).length,
      activeNetworkRequests: tools.filter(
        (t) => t.status === 'running' && isNetworkTool(t.toolName),
      ).length,
      diskWriteBytesPerSecond: this.diskWindow.sum(),
      tokensPerMinute: this.tokenWindow.sum(),
      // P2 audit fix: prefer the registry-derived `isReadOnly` captured at
      // registration time (`ToolRuntimeEntry.isReadOnly`) over the local
      // name allowlist. `admit()` callers pass
      // `toolRegistry.get(name)?.isReadOnly` and the entry persists that
      // truth so the two views agree. Legacy entries without the field
      // (older sites that never plumbed it through) keep the heuristic to
      // avoid silently changing classification.
      activeReadOnlyTools: tools.filter(
        (t) => t.status === 'running' && entryIsReadOnly(t),
      ).length,
      activeMutationTools: tools.filter(
        (t) => t.status === 'running' && !entryIsReadOnly(t),
      ).length,
    }
  }

  /**
   * P2-10 — resolve a preemption victim for a contended lane, honoring
   * `enablePreemption` AND the `preemptionCooldownMs` anti-thrash window.
   *
   * Returns the victim toolUseId and records the preemption timestamp +
   * reservation when a victim is chosen; returns `undefined` when preemption
   * is disabled, on cooldown, or no eligible victim exists (caller then falls
   * back to throttle + backpressure-retry).
   *
   * The cooldown is per-lane so a shell preemption doesn't gate a mutation
   * preemption. `preemptionCooldownMs: 0` disables the window (every eligible
   * newcomer may preempt), restoring the pre-P2-10 behaviour.
   */
  private tryPreempt(
    resourceType: 'shell' | 'network' | 'mutation',
    params: { toolName: string; toolUseId: string; isReadOnly: boolean; priority: number },
    now: number,
  ): string | undefined {
    if (!this.config.enablePreemption) return undefined
    const cooldown = this.config.preemptionCooldownMs
    if (cooldown > 0) {
      const last = this.lastPreemptionAtByResource.get(resourceType)
      if (last !== undefined && now - last < cooldown) {
        // Within the anti-thrash window — decline to evict another victim in
        // this lane. The newcomer waits via the normal backpressure loop.
        return undefined
      }
    }
    const victim = this.findPreemptionVictim(resourceType, params.priority)
    if (!victim) return undefined
    this.lastPreemptionAtByResource.set(resourceType, now)
    this.reserve(params, now)
    return victim
  }

  /**
   * Find a running tool that can be preempted to make room.
   * Only preempts lower-priority, preemptible tools.
   */
  private findPreemptionVictim(resourceType: 'shell' | 'network' | 'mutation', incomingPriority: number): string | undefined {
    const tools = getAllToolEntries().filter(
      (t) =>
        t.status === 'running' &&
        t.preemptible &&
        t.priority < incomingPriority &&
        matchesResourceType(t.toolName, resourceType),
    )
    if (tools.length === 0) return undefined
    // Preempt the lowest-priority, longest-running tool
    tools.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      return (a.startedAt ?? 0) - (b.startedAt ?? 0)
    })
    return tools[0]?.toolUseId
  }

}

function isShellTool(name: string): boolean {
  const n = name.toLowerCase()
  return n === 'bash' || n === 'powershell' || n === 'shell'
}

function isNetworkTool(name: string): boolean {
  // P2-5 — prefer the registry-driven capability flag over a name heuristic.
  // Web tools (`web_fetch`, `WebSearch`) and MCP bridge tools set
  // `networkBound: true` at registration; a local-compute tool can declare
  // `false` to opt out. This replaces the previous `name.startsWith('mcp__')`
  // coupling, which (a) blanket-throttled every MCP tool as network even when
  // it was pure local compute, and (b) did not even match the real web tool
  // names (`web_fetch` / `WebSearch`).
  const flagged = toolRegistry.get(name)?.networkBound
  if (typeof flagged === 'boolean') return flagged
  // Fallback name heuristic for callers that bypass the registry (tests, ad-hoc
  // entries) — cover the actual web tool names + their alias.
  const n = name.toLowerCase()
  return n === 'web_fetch' || n === 'webfetch' || n === 'websearch' || n === 'web_search'
}

function isReadOnlyTool(name: string): boolean {
  // Best-effort name heuristic, kept as a fallback for callers that did
  // not pass `isReadOnly` to `registerToolInvocation`. `entryIsReadOnly`
  // (below) is the canonical accessor — prefer the registry truth when
  // available.
  const n = name.toLowerCase()
  return (
    n === 'read_file' ||
    n === 'read' ||
    n === 'grep' ||
    n === 'glob' ||
    n === 'list_files' ||
    n === 'webfetch' ||
    n === 'web_search'
  )
}

/**
 * Single source of truth for "is this tool entry read-only?".
 * Prefers the registry-derived flag captured at registration time
 * (`ToolRuntimeEntry.isReadOnly`); falls back to the name heuristic for
 * legacy entries that never plumbed it through.
 */
function entryIsReadOnly(entry: { toolName: string; isReadOnly?: boolean }): boolean {
  if (typeof entry.isReadOnly === 'boolean') return entry.isReadOnly
  return isReadOnlyTool(entry.toolName)
}

function matchesResourceType(toolName: string, resourceType: 'shell' | 'network' | 'mutation'): boolean {
  if (resourceType === 'shell') return isShellTool(toolName)
  if (resourceType === 'network') return isNetworkTool(toolName)
  // Mutation match here keeps the legacy name-heuristic since the call
  // site (`findPreemptionVictim`) only has a tool name in hand. The
  // snapshot path above uses `entryIsReadOnly` for the entry-aware view.
  if (resourceType === 'mutation') return !isReadOnlyTool(toolName)
  return false
}

let instance: ResourceQuotaManager | undefined

export function getResourceQuotaManager(config?: Partial<ResourceQuotaConfig>): ResourceQuotaManager {
  if (!instance) {
    instance = new ResourceQuotaManager(config)
  } else if (config) {
    instance.updateConfig(config)
  }
  return instance
}

export function resetResourceQuotaManagerForTests(): void {
  instance = undefined
}

export type { ResourceQuotaManager }
