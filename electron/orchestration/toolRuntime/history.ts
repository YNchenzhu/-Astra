/**
 * Global Tool Call History — cross-agent deduplication and failure guard.
 *
 * Why this exists:
 *   - Legacy `toolCallHistory` (agenticToolBatch.ts) is scoped to a single
 *     agentic loop. Agent A can fail `npm install`, then Agent B retries it
 *     blindly because the history is invisible across agents.
 *   - Tool Orchestration elevates this to a process-wide cache so the
 *     orchestrator can reject redundant or known-bad calls before they spawn.
 *
 * Features:
 *   - Cross-agent fingerprinting (tool name + normalized input).
 *   - Configurable TTL (default 10 min) so transient failures don't block forever.
 *   - Advisory / block levels identical to the loop-scoped history.
 *
 * Audit fix H4 (2026-05) — dual-track lineage scoping:
 *   1. **Isolation between sibling agents** — A failure recorded by Explore
 *      no longer blocks an unrelated Plan running in parallel. The previous
 *      behaviour was a single process-wide singleton where any agent's
 *      failure blocked any other agent's same call. Sibling agents now see
 *      isolated views because the lineage filter (see `sharesLineage`)
 *      requires the recording agent to be on the caller's parent-or-child
 *      chain.
 *   2. **Bubble-up within the parent-child chain** — A child agent's
 *      failure IS still visible to its parent (and vice versa), so the
 *      parent does not redo work its child just proved is broken.
 *   3. **Richer block messages** — when an entry's failure is surfaced,
 *      the block notification names the agent TYPE (`Explore`, `Debug`,
 *      etc.) in addition to the opaque UUID, so the main agent can judge
 *      whether the sibling's context was related to its own.
 *
 * The lineage is computed from a small `parentOf` registry populated
 * automatically on `record()` — callers pass `parentAgentId` once and
 * the chain is reconstructed on demand. Backward-compatible: outcomes
 * that omit lineage info still count everywhere (legacy behaviour).
 */

import type { AgentId } from '../../tools/ids'
import {
  DROPPED_TOOL_ARGS_ERROR_MARKER,
  TRUNCATED_TOOL_ARGS_ERROR_MARKER,
  LENIENT_REPAIRED_TOOL_ARGS_ERROR_MARKER,
} from '../../tools/toolInputZod'

export type ToolCallOutcome = {
  success: boolean
  /** Short error bucket for fingerprinting. */
  errorSummary?: string
  /** When this outcome was recorded. */
  timestamp: number
  /**
   * Audit fix H-1 (2026-06) — conversation scope. When set, the outcome is
   * recorded in a per-conversation fingerprint bucket so two unrelated
   * top-level conversations (separate chat tabs) never cross-block each
   * other on an identical tool call. Sub-agents inherit the parent's
   * `streamConversationId` (see `subAgentRunner.ts`), so intra-conversation
   * cross-agent dedup (scoped further by H4 lineage) is unaffected.
   *
   * Undefined → the legacy process-wide `'*'` bucket (tests / headless
   * callers that don't track a conversation id).
   */
  conversationId?: string
  /** Which agent recorded it. */
  agentId?: AgentId
  /**
   * Audit fix H4 — parent agent id (when known). Used to populate the
   * lineage map automatically so subsequent `check()` calls can compute
   * the recording agent's full ancestor chain.
   */
  parentAgentId?: AgentId
  /**
   * Audit fix H4 — human-readable agent type label (e.g. `"Explore"`,
   * `"Debug"`, `"Plan"`). Cached so future block messages can surface
   * the agent's role next to its opaque uuid, helping the main agent
   * judge whether a sibling's failure is contextually relevant.
   */
  agentType?: string
}

export type ToolCallFingerprint = {
  toolName: string
  inputHash: string
}

export type HistoryAdvice =
  | { level: 'allow' }
  | { level: 'hint'; message: string; previousFailures: number }
  | { level: 'block'; message: string; previousFailures: number }

interface GlobalHistoryEntry {
  fingerprint: ToolCallFingerprint
  outcomes: ToolCallOutcome[]
  /** Last time this entry was touched (for TTL eviction). */
  lastTouched: number
}

export interface GlobalToolCallHistoryOptions {
  /** How many identical consecutive failures before blocking (default 2). */
  blockThreshold?: number
  /** How many failures before adding a hint advisory (default 1). */
  hintThreshold?: number
  /** Max age of an entry in ms (default 10 minutes). */
  ttlMs?: number
  /** Max entries to prevent unbounded growth (default 5000). */
  maxEntries?: number
}

const DEFAULT_OPTIONS: Required<GlobalToolCallHistoryOptions> = {
  blockThreshold: 2,
  hintThreshold: 1,
  ttlMs: 10 * 60 * 1000,
  maxEntries: 5_000,
}

/**
 * Audit fix H4 — true when two agent lineages share a parent-child chain.
 *
 * Lineages are root-first arrays of agent ids, e.g.
 *   `['main']`
 *   `['main', 'coordinator-1']`
 *   `['main', 'coordinator-1', 'explore-2']`
 *
 * Two lineages "share" iff one is a prefix of the other. Example:
 *   - `['main']` and `['main', 'explore-1']` → share (parent ↔ child)
 *   - `['main', 'explore-1']` and `['main', 'plan-1']` → do NOT share (siblings)
 *
 * Empty / single-element arrays still work because the shorter array's
 * elements are all checked against the longer one's prefix.
 */
function sharesLineage(a: ReadonlyArray<AgentId>, b: ReadonlyArray<AgentId>): boolean {
  if (a.length === 0 || b.length === 0) return false
  const shorter = a.length <= b.length ? a : b
  const longer = a.length <= b.length ? b : a
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] !== longer[i]) return false
  }
  return true
}

/**
 * Recursively sort object keys so JSON serialization is order-stable at every
 * nesting level. Arrays keep element order (it is semantically meaningful).
 * Depth-capped at 32 so a cyclic input cannot recurse forever — the leftover
 * cycle then makes `JSON.stringify` throw, which `makeKey` already catches.
 */
function sortKeysDeep(value: unknown, depth = 0): unknown {
  if (depth > 32 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => sortKeysDeep(v, depth + 1))
  const src = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(src).sort()) {
    out[k] = sortKeysDeep(src[k], depth + 1)
  }
  return out
}

/**
 * Audit fix H4 — short, human-readable description of the tool call for
 * inclusion in cross-agent block messages. The full input is already
 * hashed into the fingerprint; this is only for the model-facing string.
 *
 * Truncated to 80 characters because the surrounding message is already
 * verbose, and a long input dump would distract from the actionable
 * `Override by …` guidance at the tail.
 */
function describeToolInput(toolName: string, input: Record<string, unknown>): string {
  let body: string
  try {
    body = JSON.stringify(input)
  } catch {
    body = '<unserializable input>'
  }
  if (body.length > 80) body = body.slice(0, 77) + '...'
  return `${toolName} ${body}`
}

class GlobalToolCallHistory {
  private entries = new Map<string, GlobalHistoryEntry>()
  private opts: Required<GlobalToolCallHistoryOptions>
  /**
   * Audit fix H4 — parent registry; lets `lineage(agentId)` walk up the
   * ancestor chain. Populated automatically on `record()` when the
   * outcome carries `parentAgentId`. Bounded by `maxEntries` indirectly
   * (entries that evict don't clear these maps, but that's fine — they
   * are small key→value strings and bounded by total agent count, not
   * call count).
   */
  private parentOf = new Map<AgentId, AgentId>()
  /** Audit fix H4 — agentId → human-readable agent type label. */
  private typeOf = new Map<AgentId, string>()

  constructor(options?: GlobalToolCallHistoryOptions) {
    this.opts = { ...DEFAULT_OPTIONS, ...options }
  }

  updateOptions(options: Partial<GlobalToolCallHistoryOptions>): void {
    this.opts = { ...this.opts, ...options }
  }

  /**
   * Audit fix H4 — build the full lineage (root → leaf) for `agentId`
   * by walking the `parentOf` registry. Cycle-safe via a 100-step
   * watchdog (we never realistically nest agents that deeply; a higher
   * number would suggest a corrupt registry).
   *
   * Self-audit fix R2-H (2026-05) — orphan-agent fallback: if an
   * `agentId` has no entry in `parentOf` AND is not `'main'`, treat
   * it as if it were a child of the implicit root `'main'`. This
   * prevents the (rare) case where a spawned ad-hoc agent records an
   * outcome without ever calling `registerAgentLineage` — pre-fix
   * such an agent's failures were invisible to `main` (siblings of
   * an unrelated singleton). Post-fix, orphans share lineage with
   * `main`, so their failures bubble correctly. The fallback only
   * kicks in for agents NOT explicitly registered; agents that
   * register `parentAgentId: 'something-else'` still chain to that
   * something-else, not to `'main'`.
   */
  private lineage(agentId: AgentId): AgentId[] {
    const chain: AgentId[] = [agentId]
    let cur = agentId
    for (let safety = 0; safety < 100; safety++) {
      const parent = this.parentOf.get(cur)
      if (!parent || chain.includes(parent)) break
      chain.unshift(parent)
      cur = parent
    }
    // Self-audit R2-H (2026-05, revised) — implicitly root every
    // chain at `'main'` unless it already starts there. Two failure
    // modes the earlier "length === 1 only" version did NOT cover:
    //   (a) two unregistered agents both record outcomes — each
    //       gets promoted under `main`, so their chains share
    //       lineage with `main` AND each other appropriately.
    //   (b) a chain that has SOME parent links but never reaches
    //       `main` (e.g. agent-B → agent-A, where agent-A has no
    //       parent registered) would otherwise have a root of
    //       `agent-A` and never share lineage with `main`. After
    //       this normalization, BOTH agent-A and agent-B have
    //       `main` as their root, so cross-chain blocks fire
    //       symmetrically.
    // No-op for `main` itself (which already starts at `'main'`).
    if (chain[0] !== ('main' as AgentId)) {
      chain.unshift('main' as AgentId)
    }
    return chain
  }

  /**
   * Check before calling a tool.
   *
   * Audit fix H4: when `callerAgentId` is provided, outcomes from
   * sibling agents (lineage that diverges from the caller's chain) are
   * filtered out — only failures recorded by the caller, its
   * ancestors, or its descendants count. Pass `undefined` to keep the
   * legacy "all outcomes count" behaviour (used by tests and any
   * caller that doesn't track its own lineage yet).
   *
   * Audit fix H-1: when `conversationId` is provided, the lookup is
   * scoped to that conversation's fingerprint bucket (different
   * conversations are physically separate, so a failure in tab A never
   * blocks the same call in tab B). It MUST match the `conversationId`
   * passed to `record()` for the same call to see prior outcomes.
   */
  check(
    toolName: string,
    input: Record<string, unknown>,
    options?: { callerAgentId?: AgentId; conversationId?: string },
  ): HistoryAdvice {
    const key = this.makeKey(toolName, input, options?.conversationId)
    this.evictStale()
    const entry = this.entries.get(key)
    if (!entry || entry.outcomes.length === 0) {
      return { level: 'allow' }
    }

    const callerLineage = options?.callerAgentId
      ? this.lineage(options.callerAgentId)
      : null

    const relevantOutcomes = callerLineage
      ? entry.outcomes.filter((o) => {
          // Legacy entries (no recorded agentId) count everywhere — they
          // pre-date the lineage tracking and would otherwise vanish.
          if (!o.agentId) return true
          const recordLineage = this.lineage(o.agentId)
          return sharesLineage(recordLineage, callerLineage)
        })
      : entry.outcomes

    // Audit fix (2026-06) — count CONSECUTIVE trailing failures, matching the
    // documented "identical consecutive failures before blocking" contract.
    // The previous total-failure count meant a success never reset the
    // streak: "fail ×2 → user fixes env → succeed" still blocked the next
    // identical call for the rest of the TTL window.
    let failures = 0
    for (let i = relevantOutcomes.length - 1; i >= 0; i--) {
      if (relevantOutcomes[i].success) break
      failures++
    }
    const lastFailure = [...relevantOutcomes].reverse().find((o) => !o.success)
    const lastErrSnippet = lastFailure?.errorSummary?.slice(0, 160)
    // Audit fix H4 — richer "last agent" label: show the type label
    // (`Explore`, `Debug`) when we have it cached, plus the opaque id.
    let lastAgentLabel = ''
    if (lastFailure?.agentId) {
      const typeLabel = this.typeOf.get(lastFailure.agentId)
      lastAgentLabel = typeLabel
        ? ` (last agent: ${typeLabel} "${lastFailure.agentId}")`
        : ` (last agent: ${lastFailure.agentId})`
    }
    const callDesc = describeToolInput(toolName, input)
    if (failures >= this.opts.blockThreshold) {
      return {
        level: 'block',
        message:
          `[Cross-agent block] \`${callDesc}\` — failed ${failures}× across this agent's ancestry${lastAgentLabel}. ` +
          (lastErrSnippet ? `Last error: ${lastErrSnippet}. ` : '') +
          `The orchestrator is blocking further attempts to avoid waste — change arguments materially, fix the root cause, or use a different tool. ` +
          `If your context differs from the previous agent's, override by calling with different inputs; do NOT retry the same call.`,
        previousFailures: failures,
      }
    }
    if (failures >= this.opts.hintThreshold) {
      return {
        level: 'hint',
        message:
          `[Cross-agent advisory] \`${callDesc}\` — failed ${failures} time(s) recently in this agent's ancestry${lastAgentLabel}. ` +
          (lastErrSnippet ? `Last error: ${lastErrSnippet}. ` : '') +
          `If it fails again it will be blocked.`,
        previousFailures: failures,
      }
    }
    return { level: 'allow' }
  }

  /**
   * Audit fix H4 — opportunistically populate the lineage registry from an
   * outcome so future `check()` calls can compute the recording agent's
   * full ancestor chain. Idempotent; safe to call from both the recorded
   * and the skipped (not-recorded) paths.
   */
  private registerLineageFromOutcome(
    outcome: Pick<ToolCallOutcome, 'agentId' | 'parentAgentId' | 'agentType'>,
  ): void {
    if (outcome.agentId && outcome.parentAgentId) {
      this.parentOf.set(outcome.agentId, outcome.parentAgentId)
    }
    if (outcome.agentId && outcome.agentType) {
      this.typeOf.set(outcome.agentId, outcome.agentType)
    }
  }

  /** Record an outcome after execution. */
  record(
    toolName: string,
    input: Record<string, unknown>,
    outcome: Omit<ToolCallOutcome, 'timestamp'>,
  ): void {
    // Audit fix R3 (2026-05) — `session-memory-internal` is a HARD-sandboxed
    // sub-agent (`~/.claude/session-memory/*.md` only). Its
    // `gateSessionMemoryInternalAgentToolUse` rejections are caused by a
    // per-agent sandbox no other agent shares, so they have ZERO predictive
    // value for cross-agent decisions. Recording them caused spurious
    // [Cross-agent block] errors on the main agent's identical calls
    // (e.g. main is blocked from `read_file` of a Desktop path because a
    // session-memory-internal child hallucinated the same call and was
    // sandbox-denied). The `[session-memory-internal]` prefix is emitted
    // exclusively by that gate, so prefix-matching is both precise and
    // forward-compatible. We still register lineage metadata so unrelated
    // future records keep correct ancestry.
    if (
      outcome.success === false &&
      typeof outcome.errorSummary === 'string' &&
      outcome.errorSummary.startsWith('[session-memory-internal]')
    ) {
      this.registerLineageFromOutcome(outcome)
      return
    }

    // Empty / truncated argument validation failures carry ZERO cross-agent
    // predictive value: they are transport / generation glitches (a model
    // emitting a `tool_use` with an empty or partial `input_json_delta`
    // stream — notably DeepSeek on the Anthropic-compat endpoint), NOT a
    // signal that this specific call is broken. Recording them caused
    // spurious `[Cross-agent block]` dead-ends after just two identical
    // empty calls (`write_file {}` → blocked). The markers are emitted by
    // `formatZodToolInputError` in `tools/toolInputZod.ts`:
    //   - DROPPED: empty-object / missing-required shapes;
    //   - TRUNCATED: write/edit recovered from a max_tokens-truncated payload.
    // Both are non-deterministic and excluded here. Lineage is still recorded.
    if (
      outcome.success === false &&
      typeof outcome.errorSummary === 'string' &&
      (outcome.errorSummary.includes(DROPPED_TOOL_ARGS_ERROR_MARKER) ||
        outcome.errorSummary.includes(TRUNCATED_TOOL_ARGS_ERROR_MARKER) ||
        outcome.errorSummary.includes(LENIENT_REPAIRED_TOOL_ARGS_ERROR_MARKER))
    ) {
      this.registerLineageFromOutcome(outcome)
      return
    }

    const key = this.makeKey(toolName, input, outcome.conversationId)
    const now = Date.now()
    let entry = this.entries.get(key)
    if (!entry) {
      entry = {
        fingerprint: { toolName, inputHash: key },
        outcomes: [],
        lastTouched: now,
      }
      this.entries.set(key, entry)
    }
    entry.outcomes.push({ ...outcome, timestamp: now })
    entry.lastTouched = now

    // Audit fix H4 — opportunistically populate the lineage registry
    // from this outcome so future `check()` calls can compute the
    // recording agent's full ancestor chain. Same-call lifecycle: the
    // first time an agent records anything, its parent (and type) are
    // cached process-wide for as long as the singleton lives.
    this.registerLineageFromOutcome(outcome)

    // Trim old outcomes outside TTL
    const cutoff = now - this.opts.ttlMs
    entry.outcomes = entry.outcomes.filter((o) => o.timestamp > cutoff)

    this.enforceMaxEntries()
  }

  /**
   * Audit fix H4 — explicit registration for agents that may not record
   * any tool calls themselves (e.g. a parent that delegates everything
   * to children but still wants its children's failures attributed to
   * its own lineage). Idempotent.
   */
  registerAgentLineage(
    agentId: AgentId,
    options: { parentAgentId?: AgentId; agentType?: string },
  ): void {
    if (options.parentAgentId) this.parentOf.set(agentId, options.parentAgentId)
    if (options.agentType) this.typeOf.set(agentId, options.agentType)
  }

  /** Invalidate a specific fingerprint (e.g. user confirmed the environment changed). */
  invalidate(toolName: string, input: Record<string, unknown>, conversationId?: string): void {
    const key = this.makeKey(toolName, input, conversationId)
    this.entries.delete(key)
  }

  /** Invalidate all entries for a tool name. */
  invalidateTool(toolName: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.fingerprint.toolName === toolName) {
        this.entries.delete(key)
      }
    }
  }

  /** Peek at raw outcomes for telemetry. */
  getOutcomes(
    toolName: string,
    input: Record<string, unknown>,
    conversationId?: string,
  ): ToolCallOutcome[] {
    const key = this.makeKey(toolName, input, conversationId)
    return this.entries.get(key)?.outcomes.slice() ?? []
  }

  /**
   * Approximate fingerprint: `<conversation scope>::toolName::deep-key-sorted JSON of input`.
   *
   * Audit fix H-1 — the leading conversation scope (`conversationId` when
   * present, else `'*'` for the legacy process-wide bucket) keeps separate
   * top-level conversations from sharing a fingerprint, so a repeated
   * failure in one chat tab cannot cross-block the same call in another.
   */
  private makeKey(
    toolName: string,
    input: Record<string, unknown>,
    conversationId?: string,
  ): string {
    const scope = conversationId?.trim() || '*'
    try {
      // Audit fix (2026-06): the previous
      // `JSON.stringify(input, Object.keys(input).sort())` used a replacer
      // ARRAY, which filters keys at EVERY nesting level — any nested key
      // not also present at the top level was silently dropped, so
      // `{cmd:{tool:'grep'}}` fingerprinted as `{"cmd":{}}`. All calls to a
      // tool with nested input (multi_edit_file `edits`, todo_write `todos`,
      // MCP nested `arguments`) collapsed onto one fingerprint and two
      // unrelated failures could [Cross-agent block] a materially different
      // third call. Deep-sort the keys instead so the fingerprint is stable
      // AND faithful to the full input.
      const stable = JSON.stringify(sortKeysDeep(input))
      return `${scope}::${toolName}::${stable}`
    } catch {
      return `${scope}::${toolName}::${Date.now()}`
    }
  }

  private evictStale(): void {
    const cutoff = Date.now() - this.opts.ttlMs
    for (const [key, entry] of this.entries) {
      if (entry.lastTouched < cutoff) {
        this.entries.delete(key)
      }
    }
  }

  private enforceMaxEntries(): void {
    if (this.entries.size <= this.opts.maxEntries) return
    // Evict oldest by lastTouched
    const sorted = Array.from(this.entries.entries()).sort(
      (a, b) => a[1].lastTouched - b[1].lastTouched,
    )
    const toDrop = sorted.slice(0, sorted.length - this.opts.maxEntries)
    for (const [key] of toDrop) {
      this.entries.delete(key)
    }
  }
}

let instance: GlobalToolCallHistory | undefined

export function getGlobalToolCallHistory(options?: GlobalToolCallHistoryOptions): GlobalToolCallHistory {
  if (!instance) {
    instance = new GlobalToolCallHistory(options)
  } else if (options) {
    instance.updateOptions(options)
  }
  return instance
}

export function resetGlobalToolCallHistoryForTests(): void {
  instance = undefined
}

export type { GlobalToolCallHistory }
