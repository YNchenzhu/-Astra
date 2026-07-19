/**
 * `DefaultToolRuntimePort` — the kernel's `ToolRuntimePort` adapter.
 *
 * Wires every tool batch through the toolRuntime subsystem so global snapshot,
 * unregister cascades, repeat-failure history, and PolicyEngine accounting all
 * see the same execution flow. Was split out of `defaultAdapters.ts` in Chunk 11
 * so the adapter lives next to the modules it consumes (`state`, `history`, etc.).
 */

import type { PermissionRulePayload } from '../../ai/permissionRuleMatch'
import {
  runAgenticToolUseBatch,
  toolResultBlockIndicatesFailure,
  type AgenticToolBatchCallbacks,
} from '../../ai/agenticToolBatch'
import type { InlineSkillSessionState } from '../../ai/runAgenticToolUse'
import { getAgentContext } from '../../agents/agentContext'
import { asAgentId } from '../../tools/ids'
import { toolRegistry } from '../../tools/registry'
import type {
  PermissionPort,
  PermissionPreflightRequest,
  PermissionPreflightResult,
  ToolBatchOutcome,
  ToolRuntimePort,
  ToolUseCall,
  TransportPort,
} from '../ports'
import type { KernelLoopState } from '../kernelTypes'
import { emitPhaseEvent } from '../transport'
import {
  getToolEffectiveInput,
  getToolEntry,
  markToolFailed,
  markToolUnblocked,
} from './state'
import { getGlobalToolCallHistory } from './history'
import { getToolRuntimeMetrics } from './metrics'
import {
  getToolScheduler,
  ToolPriority,
  isSchedulerShadowEnabled,
} from './scheduler'
import {
  getToolAdmissionCoordinator,
  type ToolInvocationLease,
} from './admission'
import { planToolExecution, type ToolUseItem } from '../toolPipeline'
import {
  buildPermissionDeniedPhase,
  buildPreemptionPhase,
  buildSchedulerBackpressurePhase,
} from '../transport'

export class DefaultToolRuntimePort implements ToolRuntimePort {
  private readonly skillSession: {
    get: () => InlineSkillSessionState
    set: (s: InlineSkillSessionState) => void
  }
  /**
   * Optional pre-flight policy. When supplied, `executeToolBatch` calls
   * `permissionPort.preflight` for every pending tool_use and synthesizes a denial failure
   * `tool_result` block for denied tools (skipping their execution) while still invoking
   * `runAgenticToolUseBatch` for the allowed subset.
   */
  private readonly permissionPort?: PermissionPort
  /** Optional transport so denial events surface to UI / telemetry. */
  private readonly transport?: TransportPort

  constructor(
    skillSession: {
      get: () => InlineSkillSessionState
      set: (s: InlineSkillSessionState) => void
    },
    options?: {
      permissionPort?: PermissionPort
      transport?: TransportPort
    },
  ) {
    this.skillSession = skillSession
    this.permissionPort = options?.permissionPort
    this.transport = options?.transport
  }

  async executeToolBatch(params: {
    state: KernelLoopState
    toolUses: ToolUseCall[]
    signal: AbortSignal
    diffPermissionMode: 'default' | 'bypassPermissions'
    permissionDefaultMode: 'allow' | 'ask' | 'deny'
    permissionRules?: PermissionRulePayload[]
    discoveryExclude: Set<string>
    inlineSkillSession?: {
      get: () => InlineSkillSessionState
      set: (s: InlineSkillSessionState) => void
    }
    toolCallbacks?: AgenticToolBatchCallbacks
    noteToolInvocation?: (toolName: string) => void
    /**
     * P1 (audit §5.2) — optional third positional `toolUseId` lets the
     * adapter merge per-tool preempt signals from `ToolRuntimeState`.
     * Aligned with the `ToolRuntimePort.executeToolBatch` interface
     * signature in `../ports.ts`.
     */
    resolveToolSignal?: (
      toolName: string,
      input: Record<string, unknown>,
      toolUseId?: string,
    ) => AbortSignal | undefined
  }): Promise<ToolBatchOutcome> {
    void params.state
    const skill = params.inlineSkillSession ?? this.skillSession
    const noopCb = { onToolStart: () => {}, onToolResult: () => {} }
    const callbacks = params.toolCallbacks ?? noopCb

    // ── Phase 1: caller's per-tool invocation notify hook ──
    fireNoteToolInvocations(params.noteToolInvocation, params.toolUses)

    // ── Phase 2: derive batch-wide context from ALS-scoped AgentContext.
    //    `conversationId`, `isPreemptible`, and `effectivePriority` are
    //    consumed inside `registerBatchInRuntimeState` / `runQuotaAdmit
    //    AndPreemptPhase`, both of which take `batchCtx` directly. We
    //    destructure just the fields the trackedCallbacks closure (still
    //    inline below) reads. ──
    const batchCtx = resolveBatchContext()
    const { agentCtx, agentId, parentAgentId, conversationId } = batchCtx

    // ── Phase 3: register every tool in ToolRuntimeState so cross-agent
    //    snapshot / quota / unregister cascades see them ──
    // Runtime/Scheduler registration is deferred until policy/history preflight.

    // ── Phase 4: enqueue batch in process-wide ToolScheduler + sync
    //    blocked-on-deps tools to ToolRuntimeState ──

    // ── Phase 5 (optional): scheduler dual-run validation when
    //    `POLE_TOOL_SCHEDULER_ACTIVE=1` is set. Off in production; emits
    //    `scheduler-disagrees` warn lines when the future scheduler
    //    planner disagrees with the live `planToolExecution`. ──

    // ── Phase 6: PolicyEngine preflight pass.
    //    Fail-closed by default; `POLE_PREFLIGHT_FAIL_OPEN=1` reverses. ──
    const denied = new Map<string, PermissionPreflightResult>()
    await this.runPreflightPhase(params.toolUses, denied)

    // ── Phase 7: cross-agent repeat-failure history guard.
    //    Skips entries already denied above. Lineage registered eagerly. ──
    const history = getGlobalToolCallHistory()
    this.runHistoryCheckPhase(history, params.toolUses, denied, batchCtx)

    const scheduler = getToolScheduler()
    const leases = new Map<string, ToolInvocationLease>()
    const candidates = params.toolUses.filter((tu) => !denied.has(tu.id))
    for (const tu of candidates) {
      const callerSignal =
        params.resolveToolSignal?.(tu.name, tu.input, tu.id) ?? params.signal
      const admission = await getToolAdmissionCoordinator().acquire({
        toolUseId: tu.id,
        toolName: tu.name,
        agentId,
        ...(parentAgentId ? { parentAgentId } : {}),
        ...(conversationId ? { conversationId } : {}),
        input: tu.input,
        isReadOnly: toolRegistry.get(tu.name)?.isReadOnly ?? false,
        priority: batchCtx.effectivePriority,
        preemptible: batchCtx.isPreemptible,
        signal: callerSignal,
        quotaMode: 'wait',
        logTag: 'DefaultToolRuntimePort',
        onBackpressure: (event) => {
          getToolRuntimeMetrics().recordBackpressureWait()
          if (!this.transport) return
          emitPhaseEvent(
            this.transport,
            buildSchedulerBackpressurePhase({
              iteration: 0,
              schedulerBackpressure: {
                toolName: tu.name,
                toolUseId: tu.id,
                kind: event.kind,
                ...(event.reason ? { reason: event.reason } : {}),
                ...(typeof event.waitedMs === 'number'
                  ? { waitedMs: event.waitedMs }
                  : {}),
              },
            }),
          )
        },
        onPreempt: ({ victimToolUseId, resource }) => {
          getToolRuntimeMetrics().recordPreemption()
          if (!this.transport) return
          const victimEntry = getToolEntry(victimToolUseId)
          emitPhaseEvent(
            this.transport,
            buildPreemptionPhase({
              iteration: 0,
              preemption: {
                victimToolUseId,
                ...(victimEntry?.toolName
                  ? { victimToolName: victimEntry.toolName }
                  : {}),
                incomingToolUseId: tu.id,
                incomingToolName: tu.name,
                resource,
                ...(typeof victimEntry?.priority === 'number'
                  ? { victimPriority: victimEntry.priority }
                  : {}),
                incomingPriority: batchCtx.effectivePriority,
              },
            }),
          )
        },
      })
      if (admission.admitted) {
        leases.set(tu.id, admission.lease)
      } else {
        denied.set(tu.id, {
          decision: 'deny',
          reason: admission.reason,
          matchedRule: admission.ruleId,
        })
        if (admission.ruleId?.startsWith('quota:')) {
          getToolRuntimeMetrics().recordQuotaDenial(
            admission.ruleId.slice('quota:'.length),
          )
        }
        if (this.transport) {
          emitPhaseEvent(
            this.transport,
            buildPermissionDeniedPhase({
              iteration: 0,
              permissionDenial: {
                toolName: tu.name,
                toolUseId: tu.id,
                reason: admission.reason,
                ...(admission.ruleId ? { matchedRule: admission.ruleId } : {}),
              },
            }),
          )
        }
      }
    }
    if (isSchedulerShadowEnabled()) {
      runSchedulerDualRunComparison(
        scheduler,
        candidates.filter((tu) => leases.has(tu.id)),
        batchCtx,
      )
    }

    // ── Phase 8: cross-agent resource quota admission + preempt firing.
    //    Skips entries already denied. Preempt victim's `AbortController`
    //    fires so in-flight work unwinds (P1 §5.2 + F-3 wire-up).
    //    P2-5 (2026-06): quota rejections now back-pressure (blocked +
    //    retry within `backpressureMaxWaitMs`) before hard-denying. ──
    // ── Phase 9: synthesize denial `tool_result` blocks + fire scheduler
    //    cascade for denied entries (keeps Anthropic API tool_use ↔
    //    tool_result pairing valid in the persisted transcript). ──
    const toolInputById = new Map<string, Record<string, unknown>>(
      params.toolUses.map((tu) => [tu.id, tu.input]),
    )
    const toolNameById = new Map<string, string>(
      params.toolUses.map((tu) => [tu.id, tu.name]),
    )
    const allowed = params.toolUses.filter((tu) => !denied.has(tu.id))
    const deniedBlocks = synthesizeDeniedBlocks(
      params.toolUses,
      denied,
      callbacks,
      scheduler,
    )

    // Chunk 5a — wrap the per-tool callbacks so runAgenticToolUseBatch transitions
    // tools from 'queued' → 'running' (onToolStart) → 'completed' or 'failed'
    // (onToolResult) in ToolRuntimeState as they execute. The wrap delegates to the
    // caller's original callbacks; tracking failures are swallowed.
    //
    // Chunk 5b — also record the outcome into the global history so subsequent
    // cross-agent batches with the same fingerprint get hint/block advice.
    const trackedCallbacks: AgenticToolBatchCallbacks = {
      onToolStart: (tu) => {
        try {
          leases.get(tu.id)?.start()
        } catch (e) {
          console.warn('[DefaultToolRuntimePort] lease.start failed:', e)
        }
        try {
          callbacks.onToolStart(tu)
        } catch (e) {
          console.warn('[DefaultToolRuntimePort] onToolStart delegate threw:', e)
        }
      },
      onToolResult: (result) => {
        try {
          leases
            .get(result.id)
            ?.finish(result.success ? 'completed' : 'failed', result.error)
        } catch (e) {
          console.warn('[DefaultToolRuntimePort] lease.finish threw:', e)
        }
        // Hook 3b — keep the scheduler's DAG state aligned with reality so
        // `markCompleted` unblocks any dependents and `markFailed` cascades
        // failure. Tracking failures are swallowed.
        // Audit §3.2 wire-up — when `scheduler.markCompleted` cascades and
        // any dependent we previously marked `'blocked'` becomes `'ready'`,
        // flip its runtime status with `markToolUnblocked` so the registry
        // view stays consistent with the DAG view. Bounded by current
        // batch size (we only check tools we registered above), so cost
        // is O(batchSize) per completion — fine for typical 1-10 tool
        // batches. Only runs on success because failure already cascades
        // via `scheduler.markFailed` and the dependents get `'failed'`
        // (not `'ready'`), which means they should stay blocked.
        if (result.success) {
          for (const tu of params.toolUses) {
            if (tu.id === result.id) continue
            try {
              const status = scheduler.getNodeStatus(tu.id)
              if (status === 'ready') {
                markToolUnblocked(tu.id)
              }
            } catch (e) {
              console.warn(
                '[DefaultToolRuntimePort] markToolUnblocked cascade threw:',
                e,
              )
            }
          }
        }
        try {
          // Audit A-6 wire-up — prefer the middleware-substituted
          // (effective) input over the original. This keeps cross-agent
          // repeat-failure fingerprints aligned with what was REALLY
          // executed: a middleware that rewrote `npm install left-pad`
          // to `npm install left-pad@1.0.0` will produce a fingerprint
          // for the pinned version, so an unrelated agent's plain
          // `left-pad` call isn't falsely treated as a recently-failed
          // duplicate. When no middleware substituted, the getter
          // returns undefined and we fall back to the original input.
          const effectiveInput = getToolEffectiveInput(result.id)
          const input = effectiveInput ?? toolInputById.get(result.id)
          const name = toolNameById.get(result.id) ?? result.name
          if (input) {
            // Audit fix H4 — also forward parentAgentId + agentType so
            // the lineage registry can scope future checks. Both
            // resolved once at the top of this method from `agentCtx`.
            const agentType = agentCtx?.sessionAgentType
            history.record(name, input, {
              success: result.success,
              ...(result.error ? { errorSummary: result.error } : {}),
              agentId,
              ...(parentAgentId ? { parentAgentId } : {}),
              ...(agentType ? { agentType } : {}),
              // Audit fix H-1 — record under the conversation scope so the
              // matching Phase-7 `history.check` (scoped above) finds it.
              ...(conversationId ? { conversationId } : {}),
            })
          }
        } catch (e) {
          console.warn('[DefaultToolRuntimePort] history.record threw:', e)
        }
        try {
          callbacks.onToolResult(result)
        } catch (e) {
          console.warn('[DefaultToolRuntimePort] onToolResult delegate threw:', e)
        }
      },
    }

    // P1 (audit §5.2 wire-up) — wrap the caller's resolveToolSignal so each
    // tool's per-tool preempt signal (from `ToolRuntimeState.preemptController`)
    // is merged with whatever signal the caller picked (kernel soft/hard).
    // This means: when `preemptTool(victimId, ...)` fires above, ONLY the
    // victim's effective signal aborts — concurrent batch peers keep running.
    const leaseAwareResolveToolSignal = (
      toolName: string,
      input: Record<string, unknown>,
      toolUseId?: string,
    ): AbortSignal | undefined => {
      if (toolUseId) return leases.get(toolUseId)?.effectiveSignal
      return params.resolveToolSignal?.(toolName, input, toolUseId)
    }

    let executedBlocks: Array<Record<string, unknown>> = []
    try {
      executedBlocks =
        allowed.length > 0
          ? await runAgenticToolUseBatch({
              toolUseBlocks: allowed,
              signal: params.signal,
              beforeToolStart: async (toolUse) => {
                await leases.get(toolUse.id)?.waitUntilGranted()
              },
              callbacks: trackedCallbacks,
              diffPermissionMode: params.diffPermissionMode,
              permissionDefaultMode: params.permissionDefaultMode,
              permissionRules: params.permissionRules,
              discoveryExclude: params.discoveryExclude,
              getInlineSkillSession: () => skill.get(),
              setInlineSkillSession: (s) => skill.set(s),
              resolveToolSignal: leaseAwareResolveToolSignal,
            })
          : []
    } finally {
      // Chunk 5a — sweep: any allowed tool that didn't reach a terminal state
      // (e.g. runAgenticToolUseBatch threw, or onToolResult never fired for it)
      // gets marked aborted so the runtime registry doesn't leak 'queued'/'running'
      // entries until the 120s cleanup timer fires.
      for (const tu of allowed) {
        const entry = getToolEntry(tu.id)
        if (!entry) continue
        if (
          entry.status === 'queued' ||
          entry.status === 'preparing' ||
          entry.status === 'running' ||
          entry.status === 'paused' ||
          entry.status === 'blocked'
        ) {
          try {
            leases.get(tu.id)?.finish(
              'aborted',
              params.signal.aborted ? 'signal aborted' : 'batch ended without result',
            )
          } catch (e) {
            console.warn('[DefaultToolRuntimePort] sweep lease.finish threw:', e)
          }
          // Hook 3c — same cleanup for the scheduler's DAG node so the entry
          // doesn't linger in `'ready'` / `'scheduled'` state for 120s after
          // a crashing batch.
        }
      }
    }

    // Merge denied blocks + executed blocks preserving original `toolUses` order.
    const mergedById = new Map<string, Record<string, unknown>>()
    for (const b of deniedBlocks) {
      const id = String((b as { tool_use_id?: string }).tool_use_id ?? '')
      if (id) mergedById.set(id, b)
    }
    for (const b of executedBlocks) {
      const id = String((b as { tool_use_id?: string }).tool_use_id ?? '')
      if (id) mergedById.set(id, b)
    }
    const blocks: Array<Record<string, unknown>> = []
    for (const tu of params.toolUses) {
      const b = mergedById.get(tu.id)
      if (b) blocks.push(b)
    }
    // Defensive: include any blocks without matching ids (shouldn't normally happen).
    for (const b of executedBlocks) {
      const id = String((b as { tool_use_id?: string }).tool_use_id ?? '')
      if (!id || !params.toolUses.some((tu) => tu.id === id)) {
        blocks.push(b)
      }
    }

    const hadFailure = blocks.some((b) => toolResultBlockIndicatesFailure(b))
    return { toolResultBlocks: blocks, hadFailure }
  }

  // ── Phase 6 helper — PolicyEngine preflight pass ────────────────────────
  /**
   * Phase 6 (audit D2 follow-up extraction) — PolicyEngine preflight.
   *
   * Iterates `toolUses`, calls `permissionPort.preflight(req)` for each, and
   * populates `denied` with deny decisions. Emits `permission_denied_preflight`
   * phase events when transport is wired.
   *
   * Fail-closed on preflight throws by default; set
   * `POLE_PREFLIGHT_FAIL_OPEN=1` to allow throwing preflight checks to pass
   * (documented anti-pattern, off in production). A throw under fail-closed
   * synthesizes a `'preflight-error'` matched-rule denial.
   *
   * Mutates `denied`; otherwise side-effect-free at the class level (uses
   * `this.permissionPort` + `this.transport` directly).
   */
  private async runPreflightPhase(
    toolUses: ToolUseCall[],
    denied: Map<string, PermissionPreflightResult>,
  ): Promise<void> {
    if (!this.permissionPort?.preflight) return
    const failOpen = process.env.POLE_PREFLIGHT_FAIL_OPEN === '1'
    for (const tu of toolUses) {
      try {
        const req: PermissionPreflightRequest = {
          toolName: tu.name,
          toolUseId: tu.id,
          toolInput: tu.input,
        }
        const res = await this.permissionPort.preflight(req)
        if (res && res.decision === 'deny') {
          denied.set(tu.id, res)
          getToolRuntimeMetrics().recordPermissionDenial() // L-2
          markToolFailed(tu.id, res.reason ?? 'denied by preflight')
          if (this.transport) {
            // iteration=0 sentinel: DefaultToolRuntimePort owns no kernel
            // counters; renderer groups by toolUseId.
            emitPhaseEvent(
              this.transport,
              buildPermissionDeniedPhase({
                iteration: 0,
                permissionDenial: {
                  toolName: tu.name,
                  toolUseId: tu.id,
                  reason: res.reason ?? 'denied by preflight',
                  ...(res.matchedRule ? { matchedRule: res.matchedRule } : {}),
                },
              }),
            )
          }
        }
      } catch (e) {
        const errText = e instanceof Error ? e.message : String(e)
        console.warn(
          `[DefaultToolRuntimePort] preflight threw for ${tu.name} — ${failOpen ? 'allowing (fail-open mode)' : 'denying (fail-closed)'}:`,
          e,
        )
        if (!failOpen) {
          const failReason = `Permission preflight failed: ${errText}. Set POLE_PREFLIGHT_FAIL_OPEN=1 to override.`
          denied.set(tu.id, {
            decision: 'deny',
            reason: failReason,
            matchedRule: 'preflight-error',
          })
          markToolFailed(tu.id, failReason)
        }
      }
    }
  }

  // ── Phase 7 helper — cross-agent repeat-failure history guard ───────────
  /**
   * Phase 7 (audit D2 follow-up extraction) — cross-agent history check.
   *
   * Pre-registers agent lineage (audit fix H4) so the very first check
   * against unrelated-agent failures scopes correctly. Then for every
   * not-yet-denied tool, asks `globalToolCallHistory.check(...)` with
   * caller lineage. `level === 'block'` populates `denied`; `'hint'` is
   * logged as a console advisory.
   *
   * Mutates `denied`.
   */
  private runHistoryCheckPhase(
    history: ReturnType<typeof getGlobalToolCallHistory>,
    toolUses: ToolUseCall[],
    denied: Map<string, PermissionPreflightResult>,
    ctx: BatchContext,
  ): void {
    if (ctx.parentAgentId || ctx.agentCtx?.sessionAgentType) {
      history.registerAgentLineage(ctx.agentId, {
        ...(ctx.parentAgentId ? { parentAgentId: ctx.parentAgentId } : {}),
        ...(ctx.agentCtx?.sessionAgentType ? { agentType: ctx.agentCtx.sessionAgentType } : {}),
      })
    }
    for (const tu of toolUses) {
      if (denied.has(tu.id)) continue
      let advice
      try {
        advice = history.check(tu.name, tu.input, {
        callerAgentId: ctx.agentId,
        // Audit fix H-1 — conversation-scope so a different chat tab's
        // identical failing call can't cross-block this one.
        ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
      })
      } catch (e) {
        console.warn('[DefaultToolRuntimePort] history.check threw:', e)
        continue
      }
      if (advice.level === 'block') {
        const matchedRule = `global_history:${advice.previousFailures}_failures`
        denied.set(tu.id, {
          decision: 'deny',
          reason: advice.message,
          matchedRule,
        })
        getToolRuntimeMetrics().recordHistoryBlock() // L-2
        markToolFailed(tu.id, advice.message)
        // Audit P1 — emit the permission-denied telemetry that previously
        // fired from the preflight's `engine.evaluate` history.check. Now
        // that the orchestrated preflight skips history (Phase 7 owns it with
        // the real caller `agentId`), this is the sole emit site for
        // history-block denials, mirroring the quota-denial emit in Phase 8.
        if (this.transport) {
          try {
            emitPhaseEvent(
              this.transport,
              buildPermissionDeniedPhase({
                iteration: 0,
                permissionDenial: {
                  toolName: tu.name,
                  toolUseId: tu.id,
                  reason: advice.message,
                  matchedRule,
                },
              }),
            )
          } catch (e) {
            console.warn('[DefaultToolRuntimePort] history block emitPhaseEvent threw:', e)
          }
        }
      } else if (advice.level === 'hint') {
        getToolRuntimeMetrics().recordHistoryHint() // L-2
        console.warn(`[ToolRuntime] ${tu.name} advisory: ${advice.message}`)
      }
    }
  }

  // ── Phase 8 helper — quota admission + preempt firing ───────────────────
  /**
   * Phase 8 (audit D2 follow-up extraction) — cross-agent resource quota
   * admission AND preempt-victim firing.
   *
   * For each not-yet-denied tool:
   *   1. Calls `quota.admit({...})` which may throw.
   *   2. On throw — treat as quota:exception deny (audit P2: silently
   *      bypassing quota was a back-pressure correctness bug).
   *   3. On `decision.allowed === false` — P2-5 (2026-06): back-pressure
   *      first. The tool is marked `'blocked'` (reason `'backpressure'`)
   *      and admission is re-attempted at `decision.retryAfterMs`
   *      intervals until a slot frees up OR the batch-wide
   *      `backpressureMaxWaitMs` budget runs out. Only on budget
   *      exhaustion does the typed denial fire (`permission_denied_preflight`
   *      with `matchedRule: quota:<reason>`); a signal abort during the
   *      wait exits quietly and lets the batch's abort path own the
   *      tool_use ↔ tool_result pairing.
   *   4. On `decision.preemptionTarget` non-empty — fire victim's
   *      per-tool `AbortController` (audit P1 §5.2 wire-up), mark the
   *      victim aborted in `ToolRuntimeState`, cascade through scheduler
   *      DAG, emit `tool_preempted` phase event.
   *
   * Mutates `denied`. Uses `this.transport` for typed events.
   */
}

// ── Phase 9 helper — synthesize denial blocks ───────────────────────────
/**
 * Phase 9 (audit D2 follow-up extraction) — build the `tool_result` blocks
 * the assistant message needs to pair with denied `tool_use` blocks (the
 * Anthropic API requires every `tool_use` to have a matching `tool_result`
 * in the next user message).
 *
 * Side effects:
 *   - Fires `callbacks.onToolResult({ success:false, error })` per denial
 *     so renderer telemetry sees the same shape as a runtime failure.
 *   - Drives `scheduler.markFailed(id)` so DAG dependents (if any) cascade.
 *
 * Returns the synthesized block array (order matches `toolUses` for
 * downstream merge stability).
 */
function synthesizeDeniedBlocks(
  toolUses: ToolUseCall[],
  denied: Map<string, PermissionPreflightResult>,
  callbacks: AgenticToolBatchCallbacks,
  scheduler: ReturnType<typeof getToolScheduler>,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = []
  for (const tu of toolUses) {
    const d = denied.get(tu.id)
    if (!d) continue
    const reasonText = d.reason?.trim() || 'Tool call blocked by permission policy.'
    blocks.push({
      type: 'tool_result',
      tool_use_id: tu.id,
      content: `Error: ${reasonText}${d.matchedRule ? ` (matched: ${d.matchedRule})` : ''}`,
      is_error: true,
    })
    try {
      callbacks.onToolResult?.({
        id: tu.id,
        name: tu.name,
        success: false,
        error: reasonText,
      })
    } catch {
      /* ignore callback failures */
    }
    try {
      scheduler.markFailed(tu.id)
    } catch (e) {
      console.warn('[DefaultToolRuntimePort] scheduler.markFailed (denied) threw:', e)
    }
  }
  return blocks
}

// ---------------------------------------------------------------------------
// Private helpers — extracted from `executeToolBatch` for readability.
//
// These are file-local free functions (NOT class methods) because every input
// they need is already passed explicitly OR comes from module-level
// singletons (`toolRegistry`, `getResourceQuotaManager`, etc.). Keeping them
// as free functions makes them trivially unit-testable without instantiating
// a `DefaultToolRuntimePort`.
// ---------------------------------------------------------------------------

/**
 * Audit P3 cleanup — shared batch-wide context derived once from the
 * ALS-scoped `AgentContext`. Held as a small struct so the `executeToolBatch`
 * phases can pass a single reference instead of 6 individual fields.
 */
interface BatchContext {
  /** Raw AgentContext snapshot (may be undefined when called outside a sub-agent). */
  agentCtx: ReturnType<typeof getAgentContext>
  /** Resolved AgentId; defaults to `'main'` when ALS has no context. */
  agentId: ReturnType<typeof asAgentId>
  /** Parent AgentId when this is a sub-agent batch; undefined for main chat. */
  parentAgentId: ReturnType<typeof asAgentId> | undefined
  /** Conversation id for renderer routing; undefined when no conversation bound. */
  conversationId: string | undefined
  /**
   * Effective tool-scheduling priority for this batch. Main chat defaults to
   * HIGH; other agents default to NORMAL; an explicit `AgentContext.priority`
   * always wins.
   */
  effectivePriority: number
  /**
   * Tools below HIGH are preemptible by default — a higher-priority newcomer
   * may take their resource slot.
   */
  isPreemptible: boolean
}

/**
 * Phase 1 helper — fire the caller's `noteToolInvocation` hook for each tool.
 * The hook is the older passive "count invocations" surface (kept on
 * `PermissionPort` for back-compat); it's allowed to throw.
 */
function fireNoteToolInvocations(
  note: ((toolName: string) => void) | undefined,
  toolUses: ToolUseCall[],
): void {
  if (!note) return
  for (const tu of toolUses) {
    try {
      note(tu.name)
    } catch {
      /* ignore: caller hooks must not break execution */
    }
  }
}

/**
 * Phase 2 helper — derive every batch-wide piece of context from the ALS-
 * scoped `AgentContext`. Pure (no side effects). The effective priority
 * fallback matches the audit P1-2 threading rationale: main chat → HIGH so
 * user-facing batches outrank generic NORMAL sub-agents; declared
 * `AgentContext.priority` from `AgentDefinition.defaultPriority` always wins.
 */
function resolveBatchContext(): BatchContext {
  const agentCtx = getAgentContext()
  const agentId = asAgentId(agentCtx?.agentId ?? 'main')
  const parentAgentId = agentCtx?.parentAgentId ? asAgentId(agentCtx.parentAgentId) : undefined
  const conversationId = agentCtx?.streamConversationId?.trim() || undefined
  const effectivePriority: number = (() => {
    const declared = agentCtx?.priority
    if (typeof declared === 'number') return declared
    return agentId === ('main' as typeof agentId) ? ToolPriority.HIGH : ToolPriority.NORMAL
  })()
  const isPreemptible = effectivePriority < ToolPriority.HIGH
  return {
    agentCtx,
    agentId,
    parentAgentId,
    conversationId,
    effectivePriority,
    isPreemptible,
  }
}

/**
 * Phase 3 helper — register every tool in this batch in `ToolRuntimeState`
 * so cross-agent visibility (snapshot / quota / `cancelAgent` / per-tool
 * preempt controller from audit P1 §5.2) sees them. P2 audit fix: pass the
 * registry-derived `isReadOnly` so `quota.snapshot()` and `quota.admit()`
 * agree on read/write classification. Errors are swallowed: runtime-state
 * bookkeeping must never break tool execution.
 */
/**
 * Phase 4 helper — enqueue the batch into the process-wide ToolScheduler so
 * `cancelAgent` / `markCompleted` / `markFailed` cascades + the priority-
 * aware preemption hunt inside `quota.admit` (see `findPreemptionVictim`)
 * have the truthful priority of every in-flight tool.
 *
 * After enqueueing, mirrors the scheduler's `'pending'` (unresolved-deps)
 * status into `ToolRuntimeState` via `markToolBlocked('dependency')` —
 * audit §3.2 wire-up so snapshot consumers + dashboards distinguish "waiting
 * on dep" from "waiting on thread". `markToolUnblocked` is fired during the
 * `markCompleted` cascade inside `executeToolBatch`'s tracked callbacks.
 */
/**
 * Phase 5 helper (audit P1 §5.3) — scheduler dual-run validation. Off in
 * production; gated on `POLE_TOOL_SCHEDULER_ACTIVE=1`.
 *
 * Two planners exist:
 *   - `toolPipeline.planToolExecution` — the live planner that
 *     `runAgenticToolUseBatch` actually consumes for serial/parallel wave
 *     dispatch (single-agent, single-batch granularity).
 *   - `ToolScheduler.planNextWaves` — the global DAG planner that knows
 *     about priority + cross-agent waves but is not actually consumed by
 *     execution today.
 *
 * Before any future cutover, we want evidence that they agree on the
 * common subset. This helper:
 *   1. Logs the scheduler's wave plan for this batch (`scheduler-dry-run`).
 *   2. Runs `planToolExecution` on the SAME batch and diffs the resulting
 *      layout against the scheduler's own-batch view.
 *   3. Emits a single `scheduler-disagrees` warn line ONLY when the two
 *      planners disagree — silent during long observation windows.
 *
 * Telemetry-only; never throws into the hot path.
 */
function runSchedulerDualRunComparison(
  scheduler: ReturnType<typeof getToolScheduler>,
  toolUses: ToolUseCall[],
  ctx: BatchContext,
): void {
  try {
    const plan = scheduler.planNextWaves({
      maxParallelChunkSize: 10,
      maxParallelMutationChunkSize: 3,
      markScheduled: false,
    })
    const ownIds = new Set(toolUses.map((t) => t.id))
    const schedulerLayout = plan.waves
      .map((w) => ({
        parallel: w.parallelTools.filter((t) => ownIds.has(t.toolUseId)).map((t) => t.toolName),
        serial: w.serialTools.filter((t) => ownIds.has(t.toolUseId)).map((t) => t.toolName),
      }))
      .filter((w) => w.parallel.length > 0 || w.serial.length > 0)
    const deferredOwn = plan.deferred
      .filter((t) => ownIds.has(t.toolUseId))
      .map((t) => t.toolName)
    if (schedulerLayout.length > 0 || deferredOwn.length > 0) {
      console.warn(
        `[DefaultToolRuntimePort] scheduler-dry-run agent=${String(ctx.agentId)} ` +
          `priority=${ctx.effectivePriority} batchSize=${toolUses.length} ` +
          `waves=${JSON.stringify(schedulerLayout)} deferred=${JSON.stringify(deferredOwn)}`,
      )
    }

    const liveInput: ToolUseItem[] = toolUses.map((t) => ({
      id: t.id,
      name: t.name,
      input: t.input,
      ...(typeof t.thoughtSignature === 'string' && t.thoughtSignature.length > 0
        ? { thoughtSignature: t.thoughtSignature }
        : {}),
    }))
    const livePlan = planToolExecution(liveInput)
    const liveLayout = livePlan.map((step) =>
      step.kind === 'serial'
        ? { parallel: [] as string[], serial: [step.item.name] }
        : { parallel: step.items.map((i) => i.name), serial: [] as string[] },
    )
    // Scheduler view normalised to the same per-step shape so signatures
    // compare apples-to-apples (the scheduler emits parallel+serial
    // separately per wave, which can flatten differently than the live
    // planner's one-step-per-chunk shape).
    const schedulerSteps: Array<{ parallel: string[]; serial: string[] }> = []
    for (const wave of schedulerLayout) {
      if (wave.parallel.length > 1) {
        schedulerSteps.push({ parallel: wave.parallel, serial: [] })
      } else if (wave.parallel.length === 1) {
        schedulerSteps.push({ parallel: [], serial: [wave.parallel[0]] })
      }
      for (const s of wave.serial) {
        schedulerSteps.push({ parallel: [], serial: [s] })
      }
    }
    const liveSig = JSON.stringify(liveLayout)
    const schedSig = JSON.stringify(schedulerSteps)
    if (liveSig !== schedSig) {
      console.warn(
        `[DefaultToolRuntimePort] scheduler-disagrees agent=${String(ctx.agentId)} ` +
          `batchSize=${toolUses.length} ` +
          `live=${liveSig} scheduler=${schedSig} ` +
          `deferred=${JSON.stringify(deferredOwn)}`,
      )
    }
  } catch (e) {
    console.warn('[DefaultToolRuntimePort] scheduler-dry-run failed:', e)
  }
}
