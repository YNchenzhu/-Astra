/**
 * In-process active agents (background + foreground sub-agents) for SendMessage / pending queue.
 *
 * P1: concurrent cap, per-agent timeout, token budget, stale cleanup.
 */

import type { ActiveAgent } from './types'
import type { AgentId } from '../tools/ids'
import { recordAgentTerminal } from './activeAgentHistory'
import { recordAgentExperience } from './agentExperienceMemory'
import { getWorkspacePath } from '../tools/workspaceState'
import { readDiskSettings } from '../settings/settingsAccess'
// Audit A-5 wire-up — switched from lazy `require()` to static import.
// `multiAgentOrchestratorSingleton.ts` does NOT import back from this file
// (verified: it only imports from `../orchestration/multiAgent` and
// `../orchestration/toolRuntime/orchestrator`, neither of which imports
// `activeAgentRegistry`). The lazy-require comment originally cited a
// cycle but there is no cycle today, and the lazy form caused vitest
// test environments to see a different singleton instance than the
// statically-imported one (the e2e fan-out test broke as a result).
import { getMultiAgentOrchestrator } from './multiAgentOrchestratorSingleton'
import { bufferUndeliveredSubAgentOutput } from './undeliveredSubAgentBuffer'

export const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000
/**
 * PROCESS-WIDE ceiling on simultaneously-running agents (foreground +
 * background, every lineage combined). Enforced inside {@link registerActiveAgent}
 * via {@link countRunningAgents}, so EVERY spawn path that registers an agent
 * is gated by it — including any caller that bypasses the
 * `spawnAndTrackAgent` facade.
 *
 * Do NOT confuse this with `MultiAgentOrchestrator.maxConcurrentChildren`
 * (= `MAX_PARALLEL_AGENT_TOOL_CALLS`, currently 6). They are orthogonal axes,
 * not two copies of one limit:
 *   - MAX_CONCURRENT_AGENTS    (10, here)        → global total, all parents.
 *   - maxConcurrentChildren    (6, orchestrator) → one parent's direct fan-out.
 *
 * A spawn must satisfy BOTH. Because per-parent caps can sum past the global
 * cap when several parents are active (2 × 6 = 12 > 10), THIS global cap is
 * the hard backstop that ultimately fails a spawn once the process is
 * saturated; the per-parent cap merely shapes the tree so no single parent
 * hogs the budget. See the field doc on
 * `MultiAgentOrchestrator.maxConcurrentChildren` for the mirror note.
 */
export const MAX_CONCURRENT_AGENTS = 10
export const DEFAULT_MAX_AGENT_TOKEN_BUDGET = 2_560_000

/**
 * Sprint 3.3 — capacity-based terminal cleanup.
 *
 * Before: terminal agents (completed / failed / killed) were dropped
 * `STALE_TERMINAL_MS` (120s) after entering a terminal state. That
 * made the Running Agents panel's history view useless for anything
 * older than 2 minutes.
 *
 * Now: keep up to N most-recent terminal entries indefinitely (until
 * the process restarts — no on-disk persistence yet; that'd be a
 * larger sprint). Override via env var.
 *
 * Running agents still get the failsafe "2× timeout → mark failed"
 * path (see `cleanupStaleAgents`); only the terminal-row eviction
 * strategy changed.
 */
const TERMINAL_HISTORY_MAX = Math.max(
  16,
  Math.min(10_000, Number(process.env.POLE_AGENT_TERMINAL_HISTORY_MAX ?? '500')),
)

/**
 * Sprint 6: cached view of the "agent experience memory enabled"
 * setting. Reading settings on every teardown is cheap but adds
 * disk IO; since agents can terminate in bursts, we keep a 5-second
 * TTL cache. The setting changes rarely (user toggle) so a stale
 * read is at worst a 5-second delay in behavior change.
 */
let cachedExpMemoryEnabled: { value: boolean; fetchedAt: number } | null = null
function isAgentExperienceMemoryEnabled(): boolean {
  const now = Date.now()
  if (cachedExpMemoryEnabled && now - cachedExpMemoryEnabled.fetchedAt < 5000) {
    return cachedExpMemoryEnabled.value
  }
  let value = false
  try {
    const s = readDiskSettings() as Record<string, unknown>
    value = s.agentExperienceMemoryEnabled === true
  } catch {
    /* default to disabled on any read error — safer */
  }
  cachedExpMemoryEnabled = { value, fetchedAt: now }
  return value
}

const EXPERIENCE_MEMORY_QUEUE_MAX = Math.max(
  1,
  Math.min(500, Number(process.env.POLE_AGENT_EXPERIENCE_QUEUE_MAX ?? '50')),
)
let experienceMemoryQueueDepth = 0
let experienceMemoryChain: Promise<void> = Promise.resolve()

function enqueueAgentExperienceRecord(agent: ActiveAgent): void {
  if (experienceMemoryQueueDepth >= EXPERIENCE_MEMORY_QUEUE_MAX) {
    console.warn(
      `[activeAgentRegistry] experience record skipped: queue full (${EXPERIENCE_MEMORY_QUEUE_MAX})`,
    )
    return
  }
  experienceMemoryQueueDepth++
  const workspace = getWorkspacePath()
  experienceMemoryChain = experienceMemoryChain
    .catch(() => {
      /* keep the queue alive after a previous failure */
    })
    .then(async () => {
      try {
        await recordAgentExperience(agent, workspace, { enabled: true })
      } catch (err) {
        console.warn('[activeAgentRegistry] experience record failed:', err)
      } finally {
        experienceMemoryQueueDepth = Math.max(0, experienceMemoryQueueDepth - 1)
      }
    })
}

const activeAgents = new Map<string, ActiveAgent>()

/** Resolvers waiting for {@link sendToAgent} to enqueue mail (event-driven vs polling). */
const mailboxWaiters = new Map<string, Array<{ check: () => void; reject: (reason: Error) => void }>>()

/**
 * Wake any pending {@link waitForAgentMailboxOrAbort} waiters for `agentId`.
 *
 * Exported so producers that bypass {@link sendToAgent} (e.g. the SendMessage
 * tool, which builds its own envelope/persist sequence and pushes directly
 * into `pendingMessages`) can still cooperatively unblock background agents
 * that idle on `waitForAgentMailboxOrAbort`. Without this, a SendMessage
 * targeting a `stayRunningForSendMessage` worker would land in the queue but
 * never wake the consumer.
 */
export function notifyMailboxWaiters(agentId: AgentId): void {
  const s = mailboxWaiters.get(agentId)
  if (!s?.length) return
  for (const waiter of [...s]) {
    try {
      waiter.check()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Wait until `pendingMessages` is non-empty or `signal` aborts.
 * Pair with {@link sendToAgent}, which wakes waiters after enqueue.
 */
export function waitForAgentMailboxOrAbort(agentId: AgentId, signal: AbortSignal): Promise<void> {
  const agent = getActiveAgent(agentId)
  if (agent && agent.pendingMessages.length > 0) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
      const arr = mailboxWaiters.get(agentId)
      if (arr) {
        const idx = arr.findIndex(w => w.check === check)
        if (idx >= 0) arr.splice(idx, 1)
        if (arr.length === 0) mailboxWaiters.delete(agentId)
      }
    }

    const onAbort = () => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }

    const check = () => {
      if (signal.aborted) return
      const ag = getActiveAgent(agentId)
      if (ag && ag.pendingMessages.length > 0) {
        cleanup()
        resolve()
      }
    }

    const waiter = { check, reject }
    signal.addEventListener('abort', onAbort, { once: true })
    let arr = mailboxWaiters.get(agentId)
    if (!arr) {
      arr = []
      mailboxWaiters.set(agentId, arr)
    }
    arr.push(waiter)
  })
}

function countRunningAgents(): number {
  let n = 0
  for (const a of activeAgents.values()) {
    if (a.status === 'running') n++
  }
  return n
}

function clearAgentTimeout(agent: ActiveAgent): void {
  if (agent.timeoutHandle !== undefined) {
    clearTimeout(agent.timeoutHandle)
    agent.timeoutHandle = undefined
  }
}

/**
 * Arm or re-arm the wall-clock timeout for a running agent.
 */
export function scheduleActiveAgentTimeout(agent: ActiveAgent): void {
  clearAgentTimeout(agent)
  if (agent.status !== 'running') return
  const ms = agent.agentDef.timeout ?? DEFAULT_AGENT_TIMEOUT_MS
  agent.timeoutHandle = setTimeout(() => {
    if (agent.status !== 'running') return
    markAgentFailedInPlace(agent, `Agent timed out after ${ms}ms`)
  }, ms)
}

export function clearActiveAgentTimeout(agent: ActiveAgent): void {
  clearAgentTimeout(agent)
}

/**
 * Centralized terminal transition for EVERY in-place terminal path:
 *   - `failed`: wall-clock timeout, token-budget exhaustion, stale-run failsafe.
 *   - `killed`: user-initiated hard stop via the `agents:abort-active` IPC.
 *
 * Single source of truth so the call sites cannot drift apart:
 *   1. Abort the controller BEFORE flipping status (P1-9 / P1-10 ordering):
 *      any observer that sees a terminal `status` is guaranteed the abort
 *      signal has already fired — no "stopped on the surface but still
 *      consuming tokens" window.
 *   2. Stamp `endedAt` for history / cleanup ordering.
 *   3. Clear the armed wall-clock timer. Without this a terminal row left a
 *      pending no-op timeout dangling (it would fire later, see the
 *      `status !== 'running'` guard, and no-op) — holding the agent closure
 *      and an event-loop timer until capacity eviction. Depth-audit finding.
 */
function markAgentTerminalInPlace(
  agent: ActiveAgent,
  status: 'failed' | 'killed',
  error?: string,
): void {
  // A user-initiated kill is intentional, not an error — only stamp
  // `terminalError` when a failure reason is supplied.
  if (error) agent.terminalError = error
  try {
    agent.abortController.abort()
  } catch {
    // ignore
  }
  agent.status = status
  agent.endedAt = Date.now()
  clearAgentTimeout(agent)
}

function markAgentFailedInPlace(agent: ActiveAgent, error: string): void {
  markAgentTerminalInPlace(agent, 'failed', error)
}

/**
 * User-initiated hard stop (the `agents:abort-active` IPC path). Same terminal
 * invariant as the failure transitions — abort → status → endedAt → clear timer
 * — but with status `'killed'` and no `terminalError` (a deliberate stop).
 *
 * The IPC handler runs its orchestration-layer notifications
 * (`kernel.interrupt`, `interruptTree`) BEFORE calling this, while the agent is
 * still `'running'`, then delegates the registry mutation here so the ordering
 * + timer cleanup live in exactly one place (depth-audit finding R4). The
 * handler intentionally does NOT unregister — the agentic loop that owns the
 * entry handles its own teardown.
 */
export function markActiveAgentKilled(agent: ActiveAgent): void {
  markAgentTerminalInPlace(agent, 'killed')
}

export function registerActiveAgent(
  agent: ActiveAgent,
): { ok: true } | { ok: false; error: string } {
  if (agent.status === 'running' && countRunningAgents() >= MAX_CONCURRENT_AGENTS) {
    return {
      ok: false,
      error: `Too many concurrent agents (maximum ${MAX_CONCURRENT_AGENTS}). Stop or wait for one to finish.`,
    }
  }
  activeAgents.set(agent.agentId, agent)
  if (agent.status === 'running') {
    scheduleActiveAgentTimeout(agent)
  }
  return { ok: true }
}

export function unregisterActiveAgent(agentId: AgentId): void {
  const agent = activeAgents.get(agentId)
  if (agent) {
    clearAgentTimeout(agent)
    // Depth-audit finding R3 — unregistering a still-`running` agent would
    // otherwise orphan its agentic loop: the registry row vanishes but the
    // loop's AbortController never fired, so it keeps consuming tokens with no
    // way to reach it (it's gone from the registry, so kill/abort can't find
    // it). Normal teardown unregisters only AFTER the loop reaches a terminal
    // state, so this is a defensive backstop — abort so the owning loop
    // unwinds. Idempotent: aborting an already-finished controller is a no-op.
    if (agent.status === 'running') {
      try {
        agent.abortController.abort()
      } catch {
        // ignore
      }
    }
    // Sprint 3.4: snapshot terminal state to disk *before* we lose the
    // in-memory entry. The history store dedupes by agentId so double-
    // recording (cleanupStaleAgents -> unregister) is safe.
    if (agent.status !== 'running') {
      try {
        recordAgentTerminal(agent)
      } catch (err) {
        console.warn('[activeAgentRegistry] history record failed:', err)
      }
      // Sprint 6/8: 经验沉淀。仅在 agent 顺利完成且用户显式启用设置时
      // 写入 memory。模块内部还会有 token/tool 次数等阈值二次过滤,
      // LLM 总结路径经由串行队列执行,避免大量 agent 同时结束时
      // fire-and-forget 触发成百上千个并发 LLM 请求。
      if (agent.status === 'completed' && isAgentExperienceMemoryEnabled()) {
        enqueueAgentExperienceRecord(agent)
      }
      // Audit 2026-06 — park anything the MAIN parent has not seen yet
      // before the registry row disappears (the injection collector only
      // reads live rows; without this, results finishing after the main
      // turn ended were lost to the model once the 5s unregister fired).
      // Same parent filter as `shouldIncludeAgentForMainInjection`.
      const parentIsMain =
        agent.parentAgentId === undefined || agent.parentAgentId === 'main'
      if (parentIsMain) {
        const full = agent.latestTextOutput ?? ''
        const offset = Math.min(agent.mainContextDeliveryOffset ?? 0, full.length)
        const undeliveredText = full.slice(offset)
        const terminalNoticePending = agent.terminalNotifiedToMain !== true
        try {
          bufferUndeliveredSubAgentOutput({
            agentId: String(agent.agentId),
            agentType: agent.agentType,
            ...(agent.name ? { name: agent.name } : {}),
            status: agent.status,
            ...(agent.terminalError ? { terminalError: agent.terminalError } : {}),
            undeliveredText,
            terminalNoticePending,
          })
        } catch {
          /* parking is best-effort — never block unregister */
        }
      }
    }
  }

  // Reject all pending mailbox waiters so they don't hang forever
  const waiters = mailboxWaiters.get(agentId)
  if (waiters) {
    for (const waiter of [...waiters]) {
      try {
        waiter.reject(new Error(`Agent ${agentId} was unregistered while waiting`))
      } catch {
        /* ignore */
      }
    }
    mailboxWaiters.delete(agentId)
  }
  activeAgents.delete(agentId)
}

export function getActiveAgents(): Map<string, ActiveAgent> {
  return activeAgents
}

export function getActiveAgent(idOrName: string): ActiveAgent | undefined {
  const r = lookupActiveAgent(idOrName)
  return r.kind === 'found' ? r.agent : undefined
}

/**
 * Discriminated lookup result so callers (e.g. SendMessage) can distinguish
 * "no such agent" from "name matched ≥2 running agents" — the latter used
 * to be silently collapsed to `undefined` (P1-7), causing misleading
 * "agent not found" errors and a falsely-triggered disk-recovery path.
 */
export type ActiveAgentLookup =
  | { kind: 'found'; agent: ActiveAgent }
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; count: number; candidates: ActiveAgent[] }

export function lookupActiveAgent(idOrName: string): ActiveAgentLookup {
  // Exact id match wins over name match.
  const byId = activeAgents.get(idOrName)
  if (byId) return { kind: 'found', agent: byId }
  // Name-based resolution. Sprint 3.3: only running entries are eligible
  // — terminal namesakes must not be reached by SendMessage/sendToAgent.
  const candidates: ActiveAgent[] = []
  for (const agent of activeAgents.values()) {
    if (agent.name === idOrName && agent.status === 'running') candidates.push(agent)
  }
  if (candidates.length === 0) return { kind: 'not_found' }
  if (candidates.length === 1) return { kind: 'found', agent: candidates[0] }
  console.warn(
    `[activeAgentRegistry] Ambiguous agent name "${idOrName}": ${candidates.length} running instances. Use agentId to disambiguate.`,
  )
  return { kind: 'ambiguous', count: candidates.length, candidates }
}

/**
 * Hard cap on per-agent pending mailbox depth (audit Bug O7). Before this
 * the queue grew unbounded: a producer hammering `SendMessage` at a
 * sub-agent that couldn't keep up would eventually OOM the main process.
 * When the cap is hit we drop the *oldest* unread message (FIFO tail wins)
 * so the recipient still sees recent context — the alternative (drop the
 * new message) is worse since it silently breaks the user's intent.
 *
 * Tunable via `POLE_AGENT_MAILBOX_MAX`.
 */
const AGENT_MAILBOX_MAX = Math.max(
  8,
  Math.min(5000, Number(process.env.POLE_AGENT_MAILBOX_MAX ?? '256')),
)

export function enqueueAgentMailboxMessage(
  agent: ActiveAgent,
  message: string,
  options?: {
    /**
     * P1 (audit §3.1 wire-up) — sender kernel id, used to populate
     * {@link InterAgentMailboxPort.deliver} parameters. Optional because
     * legacy callers (`SendMessage` tool, teammate / coordinator paths)
     * don't always know their own kernel id at the call site; absent
     * senderKernelId still writes to `pendingMessages` correctly,
     * the port observer just sees an empty string.
     */
    senderKernelId?: string
  },
): { ok: true; droppedOldest: boolean; pendingLength: number; buffered?: boolean } {
  // Chunk 10 — wave subsystem removed. Mailbox messages always push directly into
  // `pendingMessages`; the buffered-wave routing branch was dead code (flag default off,
  // and the wave module has been deleted).
  let droppedOldest = false
  if (agent.pendingMessages.length >= AGENT_MAILBOX_MAX) {
    // Drop the oldest; keep FIFO order of remaining entries.
    agent.pendingMessages.shift()
    droppedOldest = true
    agent.mailboxDroppedCount = (agent.mailboxDroppedCount ?? 0) + 1
    agent.lastMailboxDropAt = Date.now()
  }
  agent.pendingMessages.push(message)
  notifyMailboxWaiters(agent.agentId)
  // P1 (audit §3.1 wire-up) — fan-out to the InterAgentMailboxPort so
  // plugins / telemetry / future durable-queue backends observe the
  // delivery. Goes through the singleton orchestrator's
  // `deliverMailboxLine` so the lookup matches every other access pattern
  // (no direct mailboxPort handle here to keep the dependency one-way:
  // activeAgentRegistry → orchestrator, never the reverse).
  try {
    getMultiAgentOrchestrator().deliverMailboxLine({
      senderKernelId: options?.senderKernelId ?? '',
      recipientKernelId: String(agent.agentId),
      line: message,
    })
  } catch (e) {
    // Port fan-out is observability only — never break the actual mailbox
    // delivery (the `pendingMessages.push` above already succeeded).
    console.warn('[activeAgentRegistry] mailbox port deliver fan-out threw:', e)
  }
  return { ok: true, droppedOldest, pendingLength: agent.pendingMessages.length }
}

export function sendToAgent(idOrName: string, message: string): boolean {
  // Audit P3 (2026-06) — route through the discriminated lookup so an
  // ambiguous NAME (≥2 running namesakes) fails with a distinct, logged
  // reason instead of being silently collapsed to "not found" by
  // `getActiveAgent`. We still refuse to deliver on ambiguity (picking a
  // namesake arbitrarily would mis-route the message); the caller must use
  // the agentId to disambiguate. `lookupActiveAgent` already emits the
  // detailed warn line for the ambiguous case.
  const lookup = lookupActiveAgent(idOrName)
  if (lookup.kind === 'ambiguous') {
    console.warn(
      `[activeAgentRegistry] sendToAgent("${idOrName}") refused: ${lookup.count} running namesakes — pass an agentId to disambiguate.`,
    )
    return false
  }
  if (lookup.kind !== 'found') return false
  const agent = lookup.agent
  if (agent.status !== 'running') return false
  enqueueAgentMailboxMessage(agent, message)
  return true
}

/**
 * Record a stream's reported usage onto an active agent for budget enforcement.
 *
 * **Anthropic API semantics** — `input_tokens` from `message_start.usage` is a
 * **per-turn cumulative** value (it covers the entire conversation prefix the
 * model saw on this turn, minus cache reads/writes which arrive in separate
 * fields). `output_tokens` is per-turn (only what this turn generated).
 *
 * The previous implementation accumulated input on every turn:
 *   ```
 *   tokenCount += (inputTokens + outputTokens)   // ❌ double-counts prefix
 *   ```
 * For a 5-turn agent where the model saw ~50K tokens by turn 5, the recorded
 * cumulative would be (10+20+30+40+50)K + sum(output) ≈ 150K-vs-actual 50K+sum.
 * That tripped `maxTokenBudget` 2-3× too early.
 *
 * Corrected accounting (upstream `ProgressTracker` parity):
 *   - {@link ActiveAgent.latestInputTokens} = max(input observed so far)
 *   - {@link ActiveAgent.cumulativeOutputTokens} = sum(output per turn)
 *   - {@link ActiveAgent.tokenCount} = latestInputTokens + cumulativeOutputTokens
 *
 * Single-call invocations are unaffected (`max([x]) === x`, `sum([x]) === x`).
 */
export function recordAgentTokenUsage(
  agentId: AgentId,
  inputTokens: number,
  outputTokens: number,
): void {
  const agent = activeAgents.get(agentId)
  if (!agent || agent.status !== 'running') return
  // Input is per-turn cumulative — take the max so we never under-count the prefix
  // a turn observed nor double-count it across turns.
  const prevInput = agent.latestInputTokens ?? 0
  agent.latestInputTokens = Math.max(prevInput, Math.max(0, inputTokens))
  // Output is per-turn — sum across turns.
  agent.cumulativeOutputTokens =
    (agent.cumulativeOutputTokens ?? 0) + Math.max(0, outputTokens)
  agent.tokenCount = agent.latestInputTokens + agent.cumulativeOutputTokens
  const budget = agent.agentDef.maxTokenBudget ?? DEFAULT_MAX_AGENT_TOKEN_BUDGET
  if (agent.tokenCount > budget) {
    agent.tokenBudgetExceeded = true
    // P1-10: abort BEFORE flipping status (mirrors the P1-9 ordering on
    // `agents:abort-active`). `markAgentFailedInPlace` enforces that ordering
    // and also clears the armed wall-clock timer so the terminal row leaves
    // no dangling timeout behind.
    markAgentFailedInPlace(
      agent,
      `Token budget exceeded (${agent.tokenCount} > ${budget})`,
    )
  }
}

/**
 * Failsafe: abort runs that exceed 2× their timeout without exiting,
 * and cap terminal-row retention at {@link TERMINAL_HISTORY_MAX}.
 *
 * Call from the main agentic loop once per iteration. Cheap — O(N)
 * where N is the number of registered agents; terminals get sorted
 * only when the cap is exceeded (otherwise no extra work).
 */
export function cleanupStaleAgents(): void {
  const now = Date.now()
  const terminals: { id: string; agent: ActiveAgent; ref: number }[] = []

  for (const [id, agent] of [...activeAgents.entries()]) {
    if (agent.status === 'running') {
      const limit = agent.agentDef.timeout ?? DEFAULT_AGENT_TIMEOUT_MS
      if (now - agent.startTime > limit * 2) {
        markAgentFailedInPlace(agent, `Agent stale timeout after ${limit * 2}ms`)
      }
      continue
    }
    // Terminal rows are deferred to the capacity cleanup below — we
    // want to preserve them so the Running Agents panel's history
    // view stays populated across long sessions.
    terminals.push({ id, agent, ref: agent.endedAt ?? agent.startTime })
  }

  // Sprint 3.4: snapshot every terminal to disk. Cheap — the history
  // store dedupes by agentId, so re-recording across polls is O(1).
  for (const { agent } of terminals) {
    try {
      recordAgentTerminal(agent)
    } catch (err) {
      console.warn('[activeAgentRegistry] history record failed:', err)
    }
  }

  if (terminals.length > TERMINAL_HISTORY_MAX) {
    // Drop the oldest terminals first (FIFO by terminal timestamp).
    terminals.sort((a, b) => a.ref - b.ref)
    const toDrop = terminals.slice(0, terminals.length - TERMINAL_HISTORY_MAX)
    for (const { id, agent } of toDrop) {
      clearAgentTimeout(agent)
      activeAgents.delete(id)
    }
  }
}
