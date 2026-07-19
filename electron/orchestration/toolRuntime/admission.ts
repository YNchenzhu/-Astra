import { mergeAbortSignals } from '../../ai/toolExecutionScope'
import type { AgentId } from '../../tools/ids'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  DuplicateActiveToolUseIdError,
  getToolPreemptSignal,
  markToolAborted,
  markToolCompleted,
  markToolFailed,
  markToolRunning,
  preemptTool,
  registerToolInvocation,
} from './state'
import { waitForQuotaSlotWithBackpressure, waitForSchedulerHoldRelease } from './backpressure'
import { getResourceQuotaManager } from './quota'
import {
  getToolScheduler,
  isSchedulerDriveEnabled,
  getToolSchedulerMode,
  ToolPriority,
} from './scheduler'

export interface ToolAdmissionRequest {
  toolUseId: string
  toolName: string
  agentId: AgentId
  parentAgentId?: AgentId
  conversationId?: string
  input: Record<string, unknown>
  isReadOnly: boolean
  priority: number
  preemptible?: boolean
  signal: AbortSignal
  /** `none` is the transition adapter for callers not yet migrated off legacy quota. */
  quotaMode?: 'none' | 'deny' | 'wait'
  logTag?: string
  onBackpressure?: (event: {
    kind: 'scheduler_hold' | 'quota_backpressure'
    reason?: string
    waitedMs?: number
  }) => void
  onPreempt?: (event: {
    victimToolUseId: string
    resource: 'shell' | 'network' | 'mutation'
  }) => void
}

export type ToolAdmissionResult =
  | { admitted: true; lease: ToolInvocationLease }
  | { admitted: false; reason: string; ruleId?: string }

export interface ToolInvocationLease {
  toolUseId: string
  priority: number
  effectiveSignal: AbortSignal
  /** Resolves immediately outside authoritative mode. */
  waitUntilGranted(): Promise<void>
  start(): void
  finish(outcome: 'completed' | 'failed' | 'aborted', reason?: string): void
}

export interface ToolAdmissionPort {
  acquire(request: ToolAdmissionRequest): Promise<ToolAdmissionResult>
}

class AuthoritativeToolDispatcher {
  private readonly pending = new Map<
    string,
    { resolve: () => void; reject: (reason: unknown) => void; signal: AbortSignal }
  >()
  private readonly granted = new Set<string>()
  private pumpQueued = false

  waitForGrant(toolUseId: string, signal: AbortSignal): Promise<void> {
    if (getToolSchedulerMode() !== 'authoritative') return Promise.resolve()
    if (this.granted.has(toolUseId)) return Promise.resolve()
    const existing = this.pending.get(toolUseId)
    if (existing) {
      return Promise.reject(new Error(`duplicate grant waiter: ${toolUseId}`))
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(toolUseId)
        reject(signal.reason ?? new Error('tool grant wait aborted'))
        this.queuePump()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(toolUseId, {
        signal,
        resolve: () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
        reject,
      })
      this.queuePump()
    })
  }

  isGranted(toolUseId: string): boolean {
    return getToolSchedulerMode() !== 'authoritative' || this.granted.has(toolUseId)
  }

  finish(toolUseId: string): void {
    this.granted.delete(toolUseId)
    const pending = this.pending.get(toolUseId)
    if (pending) {
      this.pending.delete(toolUseId)
      pending.reject(new Error(`tool lease finished before grant: ${toolUseId}`))
    }
    this.queuePump()
  }

  private queuePump(): void {
    if (this.pumpQueued) return
    this.pumpQueued = true
    queueMicrotask(() => {
      this.pumpQueued = false
      this.pump()
    })
  }

  private pump(): void {
    if (getToolSchedulerMode() !== 'authoritative') {
      for (const [id, waiter] of this.pending) {
        this.pending.delete(id)
        waiter.resolve()
      }
      return
    }
    if (this.granted.size > 0 || this.pending.size === 0) return

    const plan = getToolScheduler().planNextWaves({ markScheduled: false })
    for (const wave of plan.waves) {
      const parallel = wave.parallelTools.filter((tool) => this.pending.has(tool.toolUseId))
      const serial = wave.serialTools.filter((tool) => this.pending.has(tool.toolUseId))
      const selected = parallel.length > 0 ? parallel : serial.slice(0, 1)
      if (selected.length === 0) continue
      for (const tool of selected) {
        const waiter = this.pending.get(tool.toolUseId)
        if (!waiter || waiter.signal.aborted) continue
        this.pending.delete(tool.toolUseId)
        this.granted.add(tool.toolUseId)
        waiter.resolve()
      }
      return
    }
  }
}

const authoritativeDispatcher = new AuthoritativeToolDispatcher()

class DefaultToolInvocationLease implements ToolInvocationLease {
  private started = false
  private finished = false
  readonly toolUseId: string
  readonly priority: number
  readonly effectiveSignal: AbortSignal

  constructor(
    toolUseId: string,
    priority: number,
    effectiveSignal: AbortSignal,
  ) {
    this.toolUseId = toolUseId
    this.priority = priority
    this.effectiveSignal = effectiveSignal
  }

  waitUntilGranted(): Promise<void> {
    return authoritativeDispatcher.waitForGrant(this.toolUseId, this.effectiveSignal)
  }

  start(): void {
    if (this.started || this.finished) return
    if (!authoritativeDispatcher.isGranted(this.toolUseId)) {
      throw new Error(`authoritative scheduler has not granted ${this.toolUseId}`)
    }
    this.started = true
    markToolRunning(this.toolUseId)
    getToolScheduler().markRunning(this.toolUseId)
  }

  finish(outcome: 'completed' | 'failed' | 'aborted', reason?: string): void {
    if (this.finished) return
    this.finished = true
    authoritativeDispatcher.finish(this.toolUseId)
    getResourceQuotaManager().release(this.toolUseId)
    const scheduler = getToolScheduler()
    if (outcome === 'completed') {
      markToolCompleted(this.toolUseId)
      scheduler.markCompleted(this.toolUseId)
      return
    }
    if (outcome === 'aborted') {
      markToolAborted(this.toolUseId, reason ?? 'tool aborted')
    } else {
      markToolFailed(this.toolUseId, reason ?? 'tool failed')
    }
    scheduler.markFailed(this.toolUseId)
  }
}

export class ToolAdmissionCoordinator implements ToolAdmissionPort {
  async acquire(request: ToolAdmissionRequest): Promise<ToolAdmissionResult> {
    const scheduler = getToolScheduler()
    const logTag = request.logTag ?? 'ToolAdmissionCoordinator'
    let lease: DefaultToolInvocationLease | null = null

    try {
      registerToolInvocation({
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        agentId: request.agentId,
        ...(request.parentAgentId ? { parentAgentId: request.parentAgentId } : {}),
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        input: request.input,
        isReadOnly: request.isReadOnly,
        priority: request.priority,
        preemptible: request.preemptible ?? request.priority < ToolPriority.HIGH,
      })
      scheduler.enqueueBatch([
        {
          toolUseId: request.toolUseId,
          toolName: request.toolName,
          agentId: request.agentId,
          ...(request.parentAgentId ? { parentAgentId: request.parentAgentId } : {}),
          input: request.input,
          readOnly: request.isReadOnly,
          priority: request.priority,
        },
      ])
      const preemptSignal = getToolPreemptSignal(request.toolUseId)
      lease = new DefaultToolInvocationLease(
        request.toolUseId,
        request.priority,
        preemptSignal ? mergeAbortSignals(request.signal, preemptSignal) : request.signal,
      )
    } catch (error) {
      const duplicate = error instanceof DuplicateActiveToolUseIdError
      const reason = duplicate
        ? error.message
        : `Tool admission registration failed: ${error instanceof Error ? error.message : String(error)}`
      console.warn(`[${logTag}] ${reason}`)
      return {
        admitted: false,
        reason,
        ruleId: duplicate ? 'duplicate_active_tool_use_id' : 'runtime-registration-error',
      }
    }

    const reject = (
      outcome: 'failed' | 'aborted',
      reason: string,
      ruleId: string,
    ): ToolAdmissionResult => {
      lease!.finish(outcome, reason)
      return { admitted: false, reason, ruleId }
    }

    if (lease.effectiveSignal.aborted) {
      return reject('aborted', 'Tool execution was interrupted.', 'signal_aborted')
    }

    const quotaMode = request.quotaMode ?? 'wait'
    if (quotaMode === 'none') return { admitted: true, lease }

    const quota = getResourceQuotaManager()
    const waitBudgetMs = Math.max(0, quota.getConfig().backpressureMaxWaitMs ?? 0)
    const phaseDeadline = Date.now() + waitBudgetMs
    if (isSchedulerDriveEnabled() && waitBudgetMs > 0) {
      const hold = await waitForSchedulerHoldRelease({
        scheduler,
        agentId: request.agentId,
        selfPriority: request.priority,
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        phaseDeadline,
        signal: lease.effectiveSignal,
        logTag,
      })
      if (hold.held) {
        request.onBackpressure?.({
          kind: 'scheduler_hold',
          ...(hold.reason ? { reason: hold.reason } : {}),
          waitedMs: hold.waitedMs,
        })
      }
    }
    if (lease.effectiveSignal.aborted) {
      return reject('aborted', 'Tool execution was interrupted.', 'signal_aborted')
    }

    const admitInput = {
      toolName: request.toolName,
      toolUseId: request.toolUseId,
      agentId: request.agentId,
      isReadOnly: request.isReadOnly,
      priority: request.priority,
    }
    let decision: ReturnType<typeof quota.admit>
    try {
      decision = quota.admit(admitInput)
    } catch (error) {
      const reason = `Resource quota check threw: ${error instanceof Error ? error.message : String(error)}`
      return reject('failed', reason, 'quota:exception')
    }

    if (!decision.allowed && quotaMode === 'wait' && waitBudgetMs > 0) {
      request.onBackpressure?.({
        kind: 'quota_backpressure',
        ...(decision.reason ? { reason: decision.reason } : {}),
      })
      decision = await waitForQuotaSlotWithBackpressure({
        quota,
        admitInput,
        initialDecision: decision,
        phaseDeadline,
        signal: lease.effectiveSignal,
        logTag,
      })
    }
    if (lease.effectiveSignal.aborted && !decision.allowed) {
      return reject('aborted', 'Tool execution was interrupted.', 'signal_aborted')
    }
    if (!decision.allowed) {
      const reason = `Resource quota exceeded: ${decision.reason ?? 'unknown'}. Retry on the next turn.`
      return reject('failed', reason, `quota:${decision.reason ?? 'unknown'}`)
    }
    if (decision.preemptionTarget) {
      const victim = decision.preemptionTarget
      const resource =
        decision.reason === 'shell_quota'
          ? 'shell'
          : decision.reason === 'network_quota'
            ? 'network'
            : 'mutation'
      const fired = preemptTool(
        victim,
        `preempted by ${request.toolName} (toolUseId=${request.toolUseId}, priority=${request.priority})`,
      )
      if (fired) scheduler.markFailed(victim)
      if (fired) request.onPreempt?.({ victimToolUseId: victim, resource })
    }
    return { admitted: true, lease }
  }
}

let coordinator: ToolAdmissionCoordinator | undefined
const admissionPortStorage = new AsyncLocalStorage<ToolAdmissionPort>()

export function getToolAdmissionCoordinator(): ToolAdmissionPort {
  const hosted = admissionPortStorage.getStore()
  if (hosted) return hosted
  coordinator ??= new ToolAdmissionCoordinator()
  return coordinator
}

export function runWithToolAdmissionPort<T>(
  port: ToolAdmissionPort,
  run: () => T,
): T {
  return admissionPortStorage.run(port, run)
}
