/**
 * Policy Engine — centralized policy enforcement point (PEP) for tool execution.
 *
 * Why this exists:
 *   - Legacy permission checks are scattered across `subAgentRunner.ts`
 *     (tool allowlists), `agentTool.ts` (pre-agent gate),
 *     `runAgenticToolUse.ts` (diffPermissionMode, permissionRules),
 *     and Bundle capability overlay.
 *   - Tool Orchestration requires a SINGLE point where all policy decisions
 *     converge: permissions, quotas, dependency checks, and global history.
 *   - This lets the orchestrator make scheduling decisions based on policy
 *     rather than discovering violations after a tool has already spawned.
 */

import type { AgentId } from '../../tools/ids'
import { getResourceQuotaManager, type ResourceQuotaManager } from './quota'
import { getGlobalToolCallHistory, type GlobalToolCallHistory } from './history'
import { getAllToolEntries } from './state'
import { countToolInvocationsSince } from './rateLimitRing'
import type { AdmissionDecision } from './quota'
import type { HistoryAdvice } from './history'
import { isPlanModeBlockingTool, type ChatMode } from '../chatMode'
import {
  resolveToolPermissionMode,
  toolNameMatchesRulePattern,
  type PermissionRulePayload,
  type PermissionRuleContext,
} from '../../ai/permissionRuleMatch'

export type PolicyRule =
  | { kind: 'allow'; toolPattern: string | RegExp; reason?: string }
  | { kind: 'deny'; toolPattern: string | RegExp; reason: string }
  | { kind: 'rateLimit'; toolPattern: string | RegExp; maxCallsPerMinute: number; reason: string }
  | { kind: 'quota'; toolPattern: string | RegExp; maxTokensPerCall: number; reason: string }

export interface PolicyContext {
  agentId: AgentId
  parentAgentId?: AgentId
  agentType?: string
  conversationId?: string
  permissionMode?: 'default' | 'plan' | 'bypassPermissions' | 'acceptEdits' | 'dontAsk' | 'auto' | 'bubble'
  bundleRules?: PolicyRule[]
  /** Explicit tool whitelist for this agent (undefined = all). */
  toolAllowlist?: string[]
  /** Explicit tool blacklist for this agent. */
  toolDenylist?: string[]
  /**
   * Chunk 6 — chat interaction mode. `'ask'` denies every tool; `'plan'` denies mutating tools
   * (resolved via {@link isPlanModeBlockingTool}); `'agent'` is the default and imposes no
   * chat-mode-level restriction.
   */
  chatMode?: ChatMode
  /**
   * Chunk 6 — workspace permission rule patterns (the `PermissionRulePayload[]` previously
   * handled by `createRulePermissionPort`). Pure tool-name deny patterns are enforced here;
   * shell/path-qualified deny rules are skipped because they need the request's resolved
   * context (which lives inside `runAgenticToolUse` — see Chunk 7).
   */
  permissionRules?: PermissionRulePayload[]
  /**
   * Chunk 6 — default permission mode used by {@link resolveToolPermissionMode} when no rule
   * pattern matches. `'deny'` triggers a fail-closed deny here.
   */
  permissionDefaultMode?: 'allow' | 'ask' | 'deny'
}

export interface PolicyDecision {
  allowed: boolean
  /** Human-readable explanation (shown to model when blocked). */
  reason?: string
  /** Quota manager admission result (if checked). */
  admission?: AdmissionDecision
  /** Global history advice (if checked). */
  historyAdvice?: HistoryAdvice
  /** Policy rules that matched. */
  matchedRules?: string[]
}

class PolicyEngine {
  private globalRules: PolicyRule[] = []
  private quotaManager: ResourceQuotaManager
  private globalHistory: GlobalToolCallHistory

  constructor(quotaManager: ResourceQuotaManager, globalHistory: GlobalToolCallHistory) {
    this.quotaManager = quotaManager
    this.globalHistory = globalHistory
  }

  /** Replace the global rule set (e.g. loaded from Settings / Bundle). */
  setGlobalRules(rules: PolicyRule[]): void {
    this.globalRules = rules
  }

  /**
   * Evaluate ALL policy dimensions for a proposed tool invocation.
   * This is the single entry point the orchestrator calls before scheduling.
   */
  evaluate(params: {
    toolName: string
    toolInput: Record<string, unknown>
    toolUseId: string
    context: PolicyContext
    isReadOnly: boolean
    priority: number
    estimatedTokens?: number
    /**
     * Audit P1 — skip the resource-quota admission step (4). The orchestrated
     * preflight (`policyEnginePermissionPort`) sets this because
     * `DefaultToolRuntimePort` runs the authoritative quota admission in its
     * Phase 8 with the REAL `isReadOnly` + `priority` (the preflight adapter
     * only has the conservative `isReadOnly:false` / `priority:NORMAL`
     * defaults, which misclassify read-only tools into the mutation quota and
     * downgrade main-chat priority). The fallback batch path (`toolExec.ts`)
     * also sets this since audit SA-1: its own quota pass admits with
     * backpressure (`waitForQuotaSlotWithBackpressure`), so the inline check
     * here would instant-deny before that wait loop is reached. Direct
     * callers that own no quota pass of their own leave this unset so quota
     * stays enforced.
     */
    skipQuota?: boolean
    /**
     * Audit P1 — skip the cross-agent history check (step 5). The orchestrated
     * preflight sets this because `DefaultToolRuntimePort` Phase 7 runs the
     * history check with the REAL caller `agentId` (the preflight adapter
     * resolves `agentId:'main'` for the legacy main-chat port, which collapses
     * H4 sibling-isolation back into "all outcomes count" mode). Fallback /
     * direct callers that own no Phase 7 leave this unset.
     */
    skipHistory?: boolean
  }): PolicyDecision {
    const { toolName, toolInput, toolUseId, context, isReadOnly, priority, estimatedTokens } = params
    const matchedRules: string[] = []

    // Chunk 6 — Chat mode (highest priority). Ask blocks every tool; Plan blocks mutating
    // ones (the registry-driven predicate in `isPlanModeBlockingTool`).
    if (context.chatMode === 'ask') {
      return {
        allowed: false,
        reason: `Ask mode: tool calls are disabled. Describe the answer in plain text.`,
        matchedRules: ['chat_mode:ask'],
      }
    }
    if (context.chatMode === 'plan' && isPlanModeBlockingTool(toolName)) {
      return {
        allowed: false,
        reason: `Plan mode: ${toolName} is a mutating or restricted tool. Present the plan, then call ExitPlanMode to continue.`,
        matchedRules: ['chat_mode:plan'],
      }
    }

    // Chunk 6 — Workspace permission rule patterns (formerly `createRulePermissionPort`).
    // Pure tool-name deny patterns are enforced here; shell/path-qualified rules are skipped
    // and re-checked inside `runAgenticToolUse` where the resolved context is available.
    if (context.permissionRules?.length) {
      for (const rule of context.permissionRules) {
        if (rule.mode !== 'deny') continue
        if (!toolNameMatchesRulePattern(toolName, rule.pattern)) continue
        if (rule.shellPattern?.trim() || rule.pathPattern?.trim()) continue
        return {
          allowed: false,
          reason: `Tool ${toolName} denied by permission policy (pattern="${rule.pattern}").`,
          matchedRules: [`rule:${rule.pattern}`],
        }
      }
      const { effectiveMode } = resolveToolPermissionMode(
        toolName,
        context.permissionDefaultMode ?? 'ask',
        context.permissionRules,
      )
      if (effectiveMode === 'deny') {
        return {
          allowed: false,
          reason: `Tool ${toolName} denied by default permission policy (mode=deny).`,
          matchedRules: ['default-deny'],
        }
      }
    } else if (context.permissionDefaultMode === 'deny') {
      // Default-mode deny without any rules: every tool is denied.
      return {
        allowed: false,
        reason: `Tool ${toolName} denied by default permission policy (mode=deny).`,
        matchedRules: ['default-deny'],
      }
    }

    // 1. Agent-level allowlist / denylist
    if (context.toolAllowlist && context.toolAllowlist.length > 0) {
      const allowed = context.toolAllowlist.some((p) => matchPattern(toolName, p))
      if (!allowed) {
        return {
          allowed: false,
          reason: `Tool "${toolName}" is not in the agent's allowlist ([${context.toolAllowlist.join(', ')}]).`,
          matchedRules: ['agent_allowlist'],
        }
      }
    }
    if (context.toolDenylist && context.toolDenylist.length > 0) {
      const denied = context.toolDenylist.some((p) => matchPattern(toolName, p))
      if (denied) {
        return {
          allowed: false,
          reason: `Tool "${toolName}" is in the agent's denylist ([${context.toolDenylist.join(', ')}]).`,
          matchedRules: ['agent_denylist'],
        }
      }
    }

    // 2. Global policy rules (allow / deny / rateLimit / quota)
    for (const rule of this.globalRules) {
      if (!matchPattern(toolName, rule.toolPattern)) continue
      if (rule.kind === 'deny') {
        matchedRules.push(`global_deny:${rule.reason}`)
        return { allowed: false, reason: rule.reason, matchedRules }
      }
      if (rule.kind === 'rateLimit') {
        // Audit fix (2026-06): the limit is "calls per MINUTE", so the
        // counting window is always 1 minute. Previously this passed
        // `rule.maxCallsPerMinute` as the window, so a `30/min` rule
        // counted calls over the last 30 minutes — over-restricting by
        // a factor of the limit value. (Tests with limit=1 couldn't
        // catch it because window == limit there.)
        const recent = this.countRecentCalls(toolName, 1)
        if (recent >= rule.maxCallsPerMinute) {
          matchedRules.push(`global_rateLimit:${rule.reason}`)
          return {
            allowed: false,
            reason: `${rule.reason} (limit: ${rule.maxCallsPerMinute}/min, current: ${recent}).`,
            matchedRules,
          }
        }
      }
      if (rule.kind === 'quota') {
        if (estimatedTokens && estimatedTokens > rule.maxTokensPerCall) {
          matchedRules.push(`global_quota:${rule.reason}`)
          return {
            allowed: false,
            reason: `${rule.reason} (limit: ${rule.maxTokensPerCall} tokens, estimated: ${estimatedTokens}).`,
            matchedRules,
          }
        }
      }
      if (rule.kind === 'allow') {
        matchedRules.push(`global_allow:${rule.reason ?? 'default'}`)
      }
    }

    // 3. Bundle rules (lower priority than global, but still enforced)
    if (context.bundleRules) {
      for (const rule of context.bundleRules) {
        if (!matchPattern(toolName, rule.toolPattern)) continue
        if (rule.kind === 'deny') {
          matchedRules.push(`bundle_deny:${rule.reason}`)
          return { allowed: false, reason: rule.reason, matchedRules }
        }
        if (rule.kind === 'allow') {
          matchedRules.push(`bundle_allow:${rule.reason ?? 'default'}`)
        }
      }
    }

    // 4. Resource quota admission
    //
    // Audit P1 — skippable: the orchestrated preflight defers this to
    // `DefaultToolRuntimePort` Phase 8, which admits with the real
    // `isReadOnly` + `priority` instead of the preflight adapter's
    // conservative defaults.
    let admission: AdmissionDecision | undefined
    if (!params.skipQuota) {
      admission = this.quotaManager.admit({
        toolName,
        toolUseId,
        agentId: context.agentId,
        isReadOnly,
        priority,
        estimatedTokens,
      })
      if (!admission.allowed) {
        return {
          allowed: false,
          reason: `Resource quota exceeded: ${admission.reason}. Retry after ${admission.retryAfterMs ?? 1000}ms.`,
          admission,
          matchedRules: [...matchedRules, `quota:${admission.reason}`],
        }
      }
    }

    // 5. Global tool call history (anti-repeat)
    //
    // Self-audit fix (2026-05): H4 sibling isolation lives in the
    // `callerAgentId` option on `history.check`. Without passing it
    // here, this fallback/batch hot path (called from
    // `toolExec.ts:551` BEFORE the toolExec.ts direct check) would
    // run in legacy "all outcomes count" mode and silently block a
    // sibling agent from a different sub-agent's failures. Forward
    // the caller agent so PolicyEngine and the direct check use the
    // same lineage scope.
    //
    // Audit P1 — skippable: the orchestrated preflight defers this to
    // `DefaultToolRuntimePort` Phase 7, which checks with the real caller
    // `agentId` rather than the preflight adapter's `'main'` default (which
    // would collapse H4 isolation into "all outcomes count").
    let historyAdvice: HistoryAdvice | undefined
    if (!params.skipHistory) {
      historyAdvice = this.globalHistory.check(toolName, toolInput, {
        callerAgentId: context.agentId,
        // Audit fix H-1 — scope to the conversation so separate chat tabs
        // don't cross-block on an identical tool call. `context.conversationId`
        // is already part of `PolicyContext`; threading it here keeps the
        // fallback `toolExec` path (which evaluates through this engine) and
        // the orchestrated Phase-7 check (which scopes directly) aligned.
        ...(context.conversationId ? { conversationId: context.conversationId } : {}),
      })
      if (historyAdvice.level === 'block') {
        return {
          allowed: false,
          reason: historyAdvice.message,
          historyAdvice,
          matchedRules: [...matchedRules, 'global_history:block'],
        }
      }
    }

    return {
      allowed: true,
      ...(admission ? { admission } : {}),
      historyAdvice: historyAdvice?.level === 'hint' ? historyAdvice : undefined,
      matchedRules,
    }
  }

  /**
   * Chunk 7 — context-aware rule resolution for the in-tool deep check.
   *
   * Differs from {@link evaluate} in that it returns a tri-state `effectiveMode`
   * (`allow`/`ask`/`deny`) instead of binary `allowed`, so the caller can still drive
   * the "ask user" UI branch downstream. Internally delegates to the shared
   * {@link resolveToolPermissionMode} matcher that `evaluate` also uses; the indirection
   * is so every rule lookup in the codebase enters through the engine — matching the
   * INVARIANTS.md "single permission enforcement point" claim end-to-end.
   *
   * Use this from `runAgenticToolUse` (the only caller today) when shell/path-qualified
   * patterns need to be resolved against actual `bashCommand` / `filePath` / `skillInvocationName`.
   */
  evaluateRules(
    toolName: string,
    defaultMode: 'allow' | 'ask' | 'deny',
    rules: PermissionRulePayload[] | undefined,
    ctx?: PermissionRuleContext,
  ): { effectiveMode: 'allow' | 'ask' | 'deny'; matchedRule: boolean } {
    return resolveToolPermissionMode(toolName, defaultMode, rules, ctx)
  }

  private countRecentCalls(toolName: string, windowMinutes: number): number {
    const cutoff = Date.now() - windowMinutes * 60_000
    // Per-tool timestamp ring is the fast path (amortised O(1) per query). The ring is
    // populated by {@link markToolRunning} (`toolRuntimeState.ts`) so any tool that runs
    // through the standard adapter is counted automatically.
    const fromRing = countToolInvocationsSince(toolName, cutoff)
    if (fromRing > 0) return fromRing
    // Fallback to the global registry scan when the ring is empty (e.g. tests that call
    // `markToolRunning` directly without going through the adapter, or callers that bypass
    // the runtime state hooks). Bounded by `TOOL_RUNTIME_CLEANUP_DELAY_MS` = 120s of entries.
    //
    // P3 fix (2026-06) — count every STARTED invocation regardless of how it
    // ended, matching the ring's semantics (the ring records once per
    // `markToolRunning` and never un-records on failure/abort). The previous
    // `running || completed` filter excluded failed/aborted/paused calls, so
    // the two code paths disagreed: a burst of failing calls rate-limited via
    // the ring but sailed through the fallback. `startedAt` is only set by
    // `markToolRunning`, so never-started (queued/blocked) entries stay out.
    let count = 0
    for (const t of getAllToolEntries()) {
      if (t.toolName === toolName && (t.startedAt ?? 0) > cutoff) {
        count++
      }
    }
    return count
  }
}

function matchPattern(toolName: string, pattern: string | RegExp): boolean {
  if (typeof pattern === 'string') {
    // Destructive-audit fix (2026-06, P1): support the trailing-`*` glob
    // convention used by every other allowlist matcher in this codebase
    // (`runAgenticToolUseBody` sub-agent gate, `resolveAgentTools` /
    // `resolvePrimaryChatTools` MCP patterns). Before this, an agent
    // allowlist entry like `mcp__server__*` never matched in
    // `PolicyEngine.evaluate`, so the preflight denied every tool the
    // entry was meant to admit.
    if (pattern === '*') return true
    if (pattern.endsWith('*') && pattern.length > 1) {
      const prefix = pattern.slice(0, -1)
      return (
        toolName.startsWith(prefix) ||
        toolName.toLowerCase().startsWith(prefix.toLowerCase())
      )
    }
    return toolName === pattern || toolName.toLowerCase() === pattern.toLowerCase()
  }
  return pattern.test(toolName)
}

// Singleton wiring (deferred so imports don't create cycles)
let instance: PolicyEngine | undefined

export function getPolicyEngine(
  quotaManager?: ResourceQuotaManager,
  globalHistory?: GlobalToolCallHistory,
): PolicyEngine {
  if (!instance) {
    instance = new PolicyEngine(
      quotaManager ?? getResourceQuotaManager(),
      globalHistory ?? getGlobalToolCallHistory(),
    )
  }
  return instance
}

export function resetPolicyEngineForTests(): void {
  instance = undefined
}

export type { PolicyEngine }
