/**
 * Agent context — AsyncLocalStorage (ALS) for concurrent sub-agents / background agents.
 *
 * Electron main is single-threaded but multiple agentic loops can run in overlapping
 * async turns; module-level context would race. ALS scopes context per async chain.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { ProviderConfig } from '../ai/client'
import type { SystemPromptLayers } from '../ai/systemPrompt'
import type { AsyncAgentLifecyclePhase } from './asyncAgentLifecycle'
import type { AgentId } from '../tools/ids'
import type { AgentDefinitionPermissionMode, AgentHookSpec } from './types'
import type { QuerySource } from './querySource'
import type { TeammateRuntimeContext } from './teammateIdentity'

import type { PermissionRulePayload } from '../ai/permissionRuleMatch'
import type { ToolRuntimePort } from '../orchestration/ports'

export type AgentPolicyTier = 'inherit' | 'restricted' | 'isolated'

export interface AgentContext {
  config: ProviderConfig
  model: string
  systemPrompt: string
  /**
   * AC-6.3：与 {@link systemPrompt} 同源拆分（`mergeSystemPromptLayers` 合并后与 `systemPrompt` 一致）。
   * 自定义整段 `systemPrompt` 覆盖时可为「整段在 systemContext、userContext 空」。
   */
  systemPromptLayers?: SystemPromptLayers
  messages: Array<Record<string, unknown>>
  signal: AbortSignal
  agentId: AgentId
  /**
   * UI / stream session agent profile (e.g. Coordinator, general-purpose).
   * Used for orchestration gates and telemetry.
   */
  sessionAgentType?: string
  /**
   * Belt-and-suspenders for the `session-memory-internal` scribe: when set,
   * the host-side path gate (see {@link gateSessionMemoryInternalAgentPath})
   * rejects any mutate target that does not canonicalise to this exact
   * absolute path. Read access stays scoped to the whole session-memory tree
   * (the scribe may still consult sibling notes / README). Production scribe
   * runs always set this from {@link runSessionMemoryExtractFork}; the field
   * is left undefined for legacy / test callers, in which case the gate
   * falls back to the original "any .md under the tree" rule.
   */
  sessionMemoryWritableTargetPath?: string
  /** Sub-agent: {@link AgentDefinition.parentPolicy} effective for this run. */
  policyTier?: AgentPolicyTier
  /**
   * P1-2 — scheduling priority for this run's tool batches.
   *
   * Used by the orchestration kernel's `DefaultToolRuntimePort` when it
   * enqueues batches into the process-wide `ToolScheduler` (see
   * `electron/orchestration/toolRuntime/scheduler.ts`). Higher values get
   * scheduled first in the next wave, so a user-facing main chat batch
   * jumps ahead of a background memory-extract sub-agent that's already
   * holding parallel-slot quota.
   *
   * Canonical values (see `ToolPriority` enum in `scheduler.ts`):
   *   - CRITICAL = 100  — user-initiated explicit commands
   *   - HIGH     = 70   — main chat default (when this field is absent)
   *   - NORMAL   = 50   — generic sub-agent
   *   - LOW      = 30   — background reads, proactive exploration
   *   - BACKGROUND = 10 — telemetry, memory extract, dream, session-memory
   *
   * Absent on legacy / non-orchestrated paths; `DefaultToolRuntimePort`
   * falls back to NORMAL when this is undefined so behaviour stays
   * back-compatible. Sub-agents inherit this from their parent unless
   * overridden by the agent definition.
   */
  priority?: number
  /** Renderer chat session id for parallel main streams + IPC event routing */
  streamConversationId?: string
  parentAgentId?: string
  /** When set, sub-agent tool list only exposes MCP tools for these server names. */
  mcpServers?: string[]
  /** Active hook specs for this agent run (from definition). */
  runtimeHooks?: AgentHookSpec[]
  lifecyclePhase?: AsyncAgentLifecyclePhase
  /** Team id / name when operating inside a team (TeamFile). */
  teamId?: string
  /**
   * Report §7.6 — when {@link teamId} is set (TeamCreate / teammate runs), normalized teammate
   * identity for hooks / tools (upstream `TeammateContext` analogue).
   */
  teammate?: TeammateRuntimeContext
  /** Nesting depth for Debug/REPL-style tools (incremented per sub-agent run). */
  replDepth?: number
  /** Settings → 深度思考: Gemini 等路径请求结构化 thought 并与正文分流 */
  alwaysThinking?: boolean
  /**
   * §7.5 — effective wall-clock budget (ms) for nested sub-agents that omit `AgentDefinition.timeout`.
   * Set from the resolved timeout of the current run.
   */
  taskBudgetMs?: number
  /**
   * §7.5 — thinking token budget forwarded to Gemini / compatible Claude extended-thinking payloads.
   */
  thinkingBudgetTokens?: number
  /**
   * AC-6.5 — correlates main chat with fork child when model + inherited system prefix match
   * ({@link buildQueryContextCacheKey}).
   */
  queryContextCacheKey?: string
  /** CTX-7.4 — last prompt-cache fingerprint (`buildPromptCacheFingerprint`) for optional break logging */
  promptCacheFingerprintLast?: string
  /**
   * Report §3.1 — effective chat permission mode for tool policy inside this ALS run
   * ({@link getPermissionMode} in interactionState).
   */
  permissionModeOverride?: AgentDefinitionPermissionMode
  /**
   * P0-2 follow-up (renderer-spawned teammate path): when set, this run's
   * `ExitPlanMode` should route plan approval to this conversation id via
   * a stream event + IPC response cycle, INSTEAD of either the local
   * permission UI (would land on the teammate's silent stream channel and
   * hang) or the {@link teamPlanApprovalLeaderBridge} TeamFile mailbox
   * path (no TeamFile exists for renderer-spawned teammates).
   *
   * This is set by `teammateRunner.runTeammateInMain` when the renderer
   * spawned the teammate with `planModeRequired: true`; the value is the
   * main chat's `currentConversationId` captured at spawn time so the
   * approval card lands in the same chat that started the worker.
   *
   * Mutually exclusive with the TeamFile path: if {@link teamId} is also
   * set and a leader is resolvable, the worker is a real team member and
   * the mailbox bridge wins (see `ExitPlanModeTool` dispatch order).
   */
  planApprovalDelegateConversationId?: string
  /** §7.8 — inherited diff permission mode for sub-agents ('default' | 'bypassPermissions'). */
  diffPermissionMode?: 'default' | 'bypassPermissions'
  /** §7.8 — inherited default permission behavior for tool calls ('allow' | 'ask' | 'deny'). */
  permissionDefaultMode?: 'allow' | 'ask' | 'deny'
  /** §7.8 — inherited permission rules for automatic tool gating. */
  permissionRules?: PermissionRulePayload[]
  /**
   * Orchestration kernel ToolRuntimePort inherited from parent so sub-agents
   * participate in the same orchestrated tool execution path (snapshot/rewind
   * consistency, permission pre-flight, inline skill session).
   */
  toolRuntimePort?: ToolRuntimePort
  /**
   * Stage 1.4 — sub-agents that inherit the parent's `toolRuntimePort` previously
   * synthesized a frozen empty `KernelLoopState` and a no-op `noteToolInvocation`,
   * making PermissionPort calls in the child invisible to the parent kernel.
   * The parent now exposes its own `getState` and `noteToolInvocation` through
   * ALS so child `orchestratedToolExecution` wiring can forward truthfully.
   *
   * Both fields are eraseable: when the parent kernel ends, ALS scope exits and
   * they vanish — the sub-agent's next read sees `undefined` and falls back to
   * the legacy empty-state behaviour. No cross-process / cross-tab leakage.
   */
  parentKernelGetState?: () => import('../orchestration/kernelTypes').KernelLoopState
  parentNoteToolInvocation?: (toolName: string) => void
  /** §16.1 / §16.2 — logical query origin (defaults derived from {@link agentId} when unset). */
  querySource?: QuerySource
  /** §16.2 — stable id for this query chain (one per top-level send / fork). */
  queryChainId?: string
  /**
   * §16.4 — forked compact / memory extract: skip Anthropic message-level cache writes so fork
   * runs do not extend KV cache tails for the parent conversation.
   */
  skipPromptCacheWrite?: boolean
  /**
   * upstream §3.5 — optional **output** token ceiling from user text (`+500k`, `use 2m tokens`, …).
   * Main thread only.
   */
  poleOutputTokenBudgetCeiling?: number
  poleOutputTokenBudgetUsed?: number
  poleLastStreamOutputTokens?: number
  /**
   * §3.6 — cumulative **ceiling extension** from compactions: `allowedOutput ≈ ceiling + this`,
   * where `credit ≈ max(0, estimatedTokensBeforeCompact − after)` per compact.
   */
  poleCompactConsumedInputEstimate?: number
  /**
   * Out-of-band hook stop request. Set by tool execution body when a
   * PreToolUse / PostToolUse hook returns `continue: false` /
   * `preventContinuation: true` — semantically distinct from a per-tool
   * deny (which produces `tool_result: Error: ...` and lets the model
   * adapt). The agentic loop reads this after `executeToolBatch` and
   * terminates with `hook_stopped` when present. Cleared at the start
   * of each iteration.
   */
  pendingHookStopRequest?: { hookName?: string; reason: string } | null
  /**
   * Runtime tool-surface allowlist for sub-agents (canonical registry names
   * such as `read_file`, `Bash`, `mcp__server__tool`).
   *
   * Set by {@link runSubAgent} from `resolveAgentTools(agentDef)` so the
   * tool executor can second-gate the model — previously the agent's
   * `tools` whitelist was only honored when generating the prompt-side
   * tool list; an out-of-list `tool_use` (replay, hallucination, prompt
   * injection) still reached `toolRegistry.execute`. Empty / undefined
   * means "no per-agent allowlist" (main chat / legacy paths).
   */
  allowedToolNamesForRuntime?: ReadonlyArray<string>
}

const agentContextStorage = new AsyncLocalStorage<AgentContext>()

export function getAgentContext(): AgentContext | null {
  return agentContextStorage.getStore() ?? null
}

export function runWithAgentContext<T>(ctx: AgentContext, fn: () => T): T {
  return agentContextStorage.run(ctx, fn)
}

export function runWithAgentContextAsync<T>(ctx: AgentContext, fn: () => Promise<T>): Promise<T> {
  return agentContextStorage.run(ctx, fn)
}

/** Keep ALS `messages` in sync with the agentic loop transcript (fork / tools see fresh history). */
export function syncAgentContextConversation(
  messages: Array<Record<string, unknown>>,
): void {
  const s = agentContextStorage.getStore()
  if (!s) return
  // P1-1: deep-clone messages here. The previous `{...m}` was a shallow
  // copy that left `content` (typically an array of tool_use / tool_result
  // / text blocks) and `_pole*` metadata sub-objects shared by reference
  // between the parent agent's `state.apiMessages` and the child ALS
  // snapshot. A child fork or tool that mutates a block in-place could
  // therefore corrupt the parent's transcript silently. `structuredClone`
  // is the right tool for these JSON-like trees; the JSON fallback covers
  // any (rare) runtime that lacks it.
  let cloned: Array<Record<string, unknown>>
  try {
    cloned = (typeof structuredClone === 'function'
      ? structuredClone(messages)
      : (JSON.parse(JSON.stringify(messages)) as typeof messages)) as Array<
      Record<string, unknown>
    >
  } catch {
    // Last resort: keep the prior (shallow) shape so a non-cloneable
    // payload never crashes the loop — matches legacy behaviour.
    cloned = messages.map((m) => ({ ...m }))
  }
  s.messages = cloned
}

/** After TeamCreate, bind the current agent run to a team id (team name). */
export function patchAgentContextTeamId(teamId: string | undefined): void {
  const s = agentContextStorage.getStore()
  if (s && teamId !== undefined) {
    s.teamId = teamId.trim() || undefined
  }
}

/** §3.5 — extend or set main-thread output ceiling from parsed user directive. */
export function patchAgentContextOutputTokenBudgetCeiling(additionalCeiling: number): void {
  const s = agentContextStorage.getStore()
  if (!s || s.agentId !== 'main') return
  if (!Number.isFinite(additionalCeiling) || additionalCeiling <= 0) return
  const prev = s.poleOutputTokenBudgetCeiling ?? 0
  s.poleOutputTokenBudgetCeiling = prev + Math.floor(additionalCeiling)
}

export function recordAgentContextOutputBudgetUsage(outputTokensThisRound: number): void {
  const s = agentContextStorage.getStore()
  if (!s || s.agentId !== 'main') return
  if (!Number.isFinite(outputTokensThisRound) || outputTokensThisRound < 0) return
  s.poleOutputTokenBudgetUsed = (s.poleOutputTokenBudgetUsed ?? 0) + Math.floor(outputTokensThisRound)
  s.poleLastStreamOutputTokens = Math.floor(outputTokensThisRound)
}

/**
 * Record a `continue: false` / `preventContinuation: true` hook outcome
 * so the next agentic-loop checkpoint can terminate with `hook_stopped`.
 * Idempotent: the first call wins (subsequent hooks in the same batch
 * don't overwrite the originating hook's name / reason).
 */
export function setAgentContextPendingHookStop(req: {
  hookName?: string
  reason: string
}): void {
  const s = agentContextStorage.getStore()
  if (!s) return
  if (s.pendingHookStopRequest) return
  s.pendingHookStopRequest = {
    reason: req.reason,
    ...(req.hookName ? { hookName: req.hookName } : {}),
  }
}

export function consumeAgentContextPendingHookStop(): {
  hookName?: string
  reason: string
} | null {
  const s = agentContextStorage.getStore()
  if (!s) return null
  const cur = s.pendingHookStopRequest ?? null
  if (cur) s.pendingHookStopRequest = null
  return cur
}

/** §3.6 — fold pre-compact input estimate into cumulative compact credit.
 *
 * Previously gated to `agentId === 'main'`, which silently dropped credit
 * for sub-agents and async/background agents. Long-running sub-agents that
 * triggered compactions then ran out of "headroom" mid-task. ALS fields are
 * per-agent, so it's safe to write for any agent — the value is read back
 * by the same agent's loop.
 */
export function addAgentContextCompactConsumedInputEstimate(tokens: number): void {
  const s = agentContextStorage.getStore()
  if (!s) return
  if (!Number.isFinite(tokens) || tokens <= 0) return
  s.poleCompactConsumedInputEstimate = (s.poleCompactConsumedInputEstimate ?? 0) + Math.floor(tokens)
}
