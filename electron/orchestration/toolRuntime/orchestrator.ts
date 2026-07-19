/**
 * Tool Orchestrator — main entry point for the Tool-Orchestration architecture.
 *
 * Bridges the legacy MultiAgentOrchestrator (agent-level) with the new
 * tool-level subsystems:
 *   - ToolRuntimeState  (visibility into every tool invocation)
 *   - ToolScheduler     (priority + DAG + cross-agent wave planning)
 *   - ResourceQuota     (dynamic admission + backpressure)
 *   - GlobalToolCallHistory (cross-agent anti-repeat)
 *   - PolicyEngine      (centralized permission/quota/rules)
 *
 * Migration path:
 *   1. Existing callers keep using MultiAgentOrchestrator for agent spawn/kill.
 *   2. New callers (and internal refactors) route tool execution through
 *      ToolOrchestrator so the scheduler can see and order them globally.
 *   3. Over time, agent-level concurrency limits become derived from
 *      tool-level resource pressure rather than static constants.
 */

import type { AgentId } from '../../tools/ids'
import { MultiAgentOrchestrator } from '../multiAgent'
import type { CancellableKernelLike, KernelAffinity } from '../multiAgent'
import { getToolScheduler, type ToolExecutionPlan, type ToolScheduler } from './scheduler'
import { getResourceQuotaManager, type ResourceQuotaConfig, type ResourceQuotaManager } from './quota'
import { getGlobalToolCallHistory, type GlobalToolCallHistoryOptions, type GlobalToolCallHistory } from './history'
import { getPolicyEngine, type PolicyContext, type PolicyDecision, type PolicyRule, type PolicyEngine } from './policy'
import {
  getToolRuntimeSnapshot,
  abortAllToolsForAgent,
  abortToolsInTree,
  agentHasRunningTools,
  type ToolRuntimeSnapshot,
} from './state'
import { snapshotToolRuntimeMetrics, type ToolRuntimeMetricsSnapshot } from './metrics'

export interface ToolOrchestratorOptions {
  /** Inherit or wrap an existing MultiAgentOrchestrator. */
  agentOrchestrator?: MultiAgentOrchestrator
  /** Resource quota settings. */
  quotaConfig?: Partial<ResourceQuotaConfig>
  /** Global history settings. */
  historyOptions?: GlobalToolCallHistoryOptions
  /** Global policy rules. */
  policyRules?: PolicyRule[]
}

export interface SpawnAgentOptions {
  agentId: AgentId
  agentType: string
  parentAgentId?: AgentId
  conversationId?: string
  affinity?: 'main_process' | 'background_worker'
  useWorktree?: boolean
  /** Agent-level tool allowlist. */
  toolAllowlist?: string[]
  /** Agent-level tool denylist. */
  toolDenylist?: string[]
}

export interface ToolOrchestratorStatus {
  agents: {
    totalRegistered: number
    maxConcurrentChildren: number
  }
  tools: ToolRuntimeSnapshot
  /** Audit fix L-2 — process-wide ToolRuntime metrics rollup (cross-conversation). */
  metrics: ToolRuntimeMetricsSnapshot
}

class ToolOrchestrator {
  private agentOrch: MultiAgentOrchestrator
  private scheduler: ToolScheduler
  private quota: ResourceQuotaManager
  private history: GlobalToolCallHistory
  private policy: PolicyEngine

  constructor(options?: ToolOrchestratorOptions) {
    this.agentOrch =
      options?.agentOrchestrator ??
      new MultiAgentOrchestrator({ maxConcurrentChildren: 6 })
    this.scheduler = getToolScheduler()
    this.quota = getResourceQuotaManager()
    this.history = getGlobalToolCallHistory()
    this.policy = getPolicyEngine(this.quota, this.history)
    if (options?.quotaConfig) {
      this.quota.updateConfig(options.quotaConfig)
    }
    if (options?.historyOptions) {
      this.history.updateOptions(options.historyOptions)
    }
    if (options?.policyRules) {
      this.policy.setGlobalRules(options.policyRules)
    }
  }

  // ===== Agent lifecycle (delegated to MultiAgentOrchestrator) =====

  registerAgent(
    kernelId: string,
    kernel: CancellableKernelLike,
    meta: {
      parentKernelId?: string
      conversationId?: string
      agentType: string
      affinity?: KernelAffinity
      worktreePath?: string
    },
  ): void {
    this.agentOrch.register(kernelId, kernel, {
      ...meta,
      affinity: meta.affinity ?? 'main_process',
    })
  }

  unregisterAgent(kernelId: string): void {
    // Cascade: abort all tools owned by this agent before unregistering
    abortAllToolsForAgent(kernelId as AgentId, 'agent_unregistered')
    this.agentOrch.unregister(kernelId)
  }

  enforceAgentConcurrencyLimit(parentKernelId: string): void {
    this.agentOrch.enforceConcurrencyLimit(parentKernelId)
  }

  interruptAgentTree(rootKernelId: string, reason: 'user' | 'timeout' | 'fork_replaced' | 'superseded' | 'shutdown' = 'user'): number {
    abortToolsInTree(rootKernelId as AgentId, `tree_interrupt:${reason}`)
    return this.agentOrch.interruptTree(rootKernelId, reason)
  }

  pauseAgentTree(rootKernelId: string): number {
    return this.agentOrch.pauseTree(rootKernelId)
  }

  resumeAgentTree(rootKernelId: string): number {
    return this.agentOrch.resumeTree(rootKernelId)
  }

  allocateWorktree(params: { parentConversationId?: string; childKernelId: string; agentType: string }): Promise<string | undefined> {
    return this.agentOrch.allocateWorktreeFor(params)
  }

  // ===== Tool scheduling (new — tool-level orchestration) =====

  /** Re-plan after a wave completes (dependencies may have unlocked). */
  replanTools(): ToolExecutionPlan {
    return this.scheduler.planNextWaves({
      maxParallelChunkSize: this.quota.getConfig().maxGlobalReadOnlyParallel,
      maxParallelMutationChunkSize: this.quota.getConfig().maxGlobalMutationParallel,
    })
  }

  /** Mark a tool as completed so dependents can proceed. */
  markToolCompleted(toolUseId: string): void {
    this.scheduler.markCompleted(toolUseId)
  }

  /** Mark a tool as failed (cascades to dependents). */
  markToolFailed(toolUseId: string): void {
    this.scheduler.markFailed(toolUseId)
  }

  /** Cancel all pending/ready tools for an agent. */
  cancelAgentTools(agentId: AgentId): number {
    return this.scheduler.cancelAgent(agentId)
  }

  // ===== Policy (single entry point) =====

  evaluatePolicy(params: {
    toolName: string
    toolInput: Record<string, unknown>
    toolUseId: string
    context: PolicyContext
    isReadOnly: boolean
    priority: number
    estimatedTokens?: number
  }): PolicyDecision {
    return this.policy.evaluate(params)
  }

  setPolicyRules(rules: PolicyRule[]): void {
    this.policy.setGlobalRules(rules)
  }

  // ===== Quota & backpressure =====

  getQuotaConfig(): Readonly<ResourceQuotaConfig> {
    return this.quota.getConfig()
  }

  updateQuotaConfig(partial: Partial<ResourceQuotaConfig>): void {
    this.quota.updateConfig(partial)
  }

  /** Current resource pressure snapshot. */
  getResourceSnapshot() {
    return this.quota.snapshot()
  }

  recordTokenUsage(tokens: number): void {
    this.quota.recordTokenUsage(tokens)
  }

  recordDiskWrite(bytes: number): void {
    this.quota.recordDiskWrite(bytes)
  }

  // ===== History =====

  /**
   * Self-audit fix R2-G (2026-05) — thread `callerAgentId` through the
   * facade so H4 sibling isolation (lineage scoping) applies for any
   * future external caller. The previous signature silently dropped
   * the H4 context, locking facade users into legacy "all outcomes
   * count" mode. The parameter is optional so the existing zero
   * external callers stay source-compatible.
   */
  getHistoryAdvice(
    toolName: string,
    input: Record<string, unknown>,
    options?: { callerAgentId?: AgentId; conversationId?: string },
  ) {
    return this.history.check(toolName, input, options)
  }

  /**
   * Self-audit fix R2-G (2026-05) — accept `parentAgentId` and
   * `agentType` so outcomes recorded through the facade populate the
   * H4 lineage registry. Without these, the facade was a quiet H4
   * escape hatch for future callers.
   */
  recordHistoryOutcome(
    toolName: string,
    input: Record<string, unknown>,
    outcome: {
      success: boolean
      errorSummary?: string
      agentId?: AgentId
      parentAgentId?: AgentId
      agentType?: string
      /** Audit fix H-1 — conversation scope so the facade isn't an escape hatch. */
      conversationId?: string
    },
  ): void {
    this.history.record(toolName, input, outcome)
  }

  // ===== Telemetry / Status =====

  getStatus(): ToolOrchestratorStatus {
    const agentStatus = this.agentOrch.getRuntimeStatus()
    return {
      agents: {
        totalRegistered: agentStatus.kernels.length,
        maxConcurrentChildren: agentStatus.maxConcurrentChildren,
      },
      tools: getToolRuntimeSnapshot(),
      metrics: snapshotToolRuntimeMetrics(),
    }
  }

  /** Has this agent (or any of its children) running tools? */
  isAgentBusy(agentId: AgentId): boolean {
    return agentHasRunningTools(agentId)
  }
}

let instance: ToolOrchestrator | undefined

export function getToolOrchestrator(options?: ToolOrchestratorOptions): ToolOrchestrator {
  if (!instance) {
    instance = new ToolOrchestrator(options)
  }
  return instance
}

export function resetToolOrchestratorForTests(): void {
  instance = undefined
}

export type { ToolOrchestrator, ToolExecutionPlan }
