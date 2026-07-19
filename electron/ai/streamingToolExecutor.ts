/**
 * upstream `StreamingToolExecutor` — full implementation (report §4.3 / Phase 4).
 *
 * Starts tool execution during API stream (before `message_stop`), yielding results
 * in-order as they complete. Concurrency rules:
 * - Non-concurrent-safe tools execute exclusively (serial)
 * - Multiple concurrent-safe tools may overlap
 * - Sibling error cascade: Bash/PowerShell failures abort co-running siblings
 * - Interrupt behavior: 'cancel' allows user new input to abort; 'block' forces completion
 */


import { toolRegistry } from '../tools/registry'
import {
  extractWorkspaceFilePathFromToolInput,
  isAgenticWorkspaceFileMutationTool,
  isBuiltinFullFileWriteTool,
} from '../tools/builtinToolAliases'
import { preflightWriteTool } from '../tools/writeToolPreflightGate'
import { runAgenticToolUse, type InlineSkillSessionState, type ToolResultEventPayload } from './runAgenticToolUse'
import type { PermissionRulePayload } from './permissionRuleMatch'
import { mergeAbortSignals } from './toolExecutionScope'
import {
  attachAdvisoryToToolResult,
  extractErrorSummaryFromToolResult,
  type ToolCallHistory,
} from './toolCallHistory'
import {
  createSiblingShellFailureReason,
  isSiblingShellFailureReason,
  formatParallelToolSiblingCancelError,
} from './siblingShellAbortReason'
import type { AppendixAFlowReporter } from '../orchestration/appendixAFlow'
import { getGlobalToolCallHistory } from '../orchestration/toolRuntime/history'
import { getAgentContext } from '../agents/agentContext'
import { getToolScheduler, ToolPriority } from '../orchestration/toolRuntime/scheduler'
import { getPolicyEngine } from '../orchestration/toolRuntime/policy'
import {
  getToolAdmissionCoordinator,
  type ToolInvocationLease,
} from '../orchestration/toolRuntime/admission'
import type { ChatMode } from '../orchestration/chatMode'
import {
  buildPermissionDeniedPhase,
  createTransportAdapter,
  emitPhaseEvent,
} from '../orchestration/transport'
import { emitStreamEventForConversation } from './interactionState'
import {
  getToolEntry,
  markToolAborted,
  markToolCompleted as markToolCompletedInState,
  markToolFailed as markToolFailedInState,
} from '../orchestration/toolRuntime/state'
import { asAgentId, type AgentId } from '../tools/ids'
import { TOOL_INTERRUPTED_BY_USER_MESSAGE } from './queryTermination'

export type StreamingToolExecutorPhase = 'queued' | 'executing' | 'completed' | 'yielded'

export const STREAMING_TOOL_EXECUTOR_EDGES: Record<
  StreamingToolExecutorPhase,
  readonly StreamingToolExecutorPhase[]
> = {
  queued: ['executing'],
  executing: ['completed'],
  completed: ['yielded'],
  yielded: [],
}

function isValidTransition(from: StreamingToolExecutorPhase, to: StreamingToolExecutorPhase): boolean {
  return (STREAMING_TOOL_EXECUTOR_EDGES[from] as readonly string[]).includes(to)
}

export class StreamingToolBatchTracer {
  phase: StreamingToolExecutorPhase = 'queued'
  settled = 0
  executionStarted = false
  totalToolUses: number
  strict: boolean

  constructor(
    totalToolUses: number,
    strict: boolean = process.env.ASTRA_TOOL_BATCH_TRACER_STRICT === '1',
  ) {
    this.totalToolUses = totalToolUses
    this.strict = strict
  }

  getPhase(): StreamingToolExecutorPhase {
    return this.phase
  }

  transition(to: StreamingToolExecutorPhase): void {
    if (this.phase === to) return
    if (!isValidTransition(this.phase, to)) {
      const msg = `[StreamingToolBatchTracer] illegal transition ${this.phase} -> ${to}`
      if (this.strict) throw new Error(msg)
      console.warn(msg)
    }
    this.phase = to
  }

  notifyExecutionBegun(): void {
    if (!this.executionStarted) {
      this.transition('executing')
      this.executionStarted = true
    }
  }

  notifyToolSettled(): void {
    if (!this.executionStarted) this.notifyExecutionBegun()
    this.settled += 1
    if (this.settled >= this.totalToolUses) {
      this.transition('completed')
    }
  }

  notifyResultsHandedOff(): void {
    if (this.totalToolUses === 0) {
      this.phase = 'yielded'
      return
    }
    if (this.phase === 'completed') {
      this.transition('yielded')
    }
  }
}

// ─── Full StreamingToolExecutor (upstream Phase 4) ───

type InterruptBehavior = 'cancel' | 'block'

interface ToolUseBlock {
  id: string
  name: string
  input: Record<string, unknown>
  thoughtSignature?: string
  /**
   * Stream-time pre-baked rejection error from the C-grade watcher's
   * `content-before-filePath` early-abort branch. When present, the
   * Write-tool fast-path in {@link StreamingToolExecutor.addTool} skips
   * the disk-based preflight (which would fail-open on the empty input
   * the watcher left behind) and surfaces this message directly as the
   * tool_result. Matches the same-named field on the broader
   * {@link import('./client').ToolUseBlock} — declared independently here
   * because this module's local interface deliberately omits unrelated
   * Anthropic PTC fields like `caller`.
   */
  preflightError?: string
}

interface AssistantMessage {
  role: 'assistant'
  content: Array<Record<string, unknown>>
  uuid?: string
}

interface ProgressMessage {
  type: 'tool_progress'
  toolUseId: string
  data: unknown
}

interface TrackedTool {
  toolUse: ToolUseBlock
  assistantMessage: AssistantMessage | null
  status: StreamingToolExecutorPhase
  isConcurrencySafe: boolean
  interruptBehavior: InterruptBehavior
  promise: Promise<void> | null
  results: Array<Record<string, unknown>>
  pendingProgress: ProgressMessage[]
  error: Error | null
  thisToolErrored: boolean
  lease: ToolInvocationLease | null
}

const NON_PARALLEL_TOOLS = new Set<string>(['Skill', 'AskUserQuestion', 'SendMessage'])

function isShellTool(name: string): boolean {
  const n = name.toLowerCase()
  return n === 'bash' || n === 'powershell'
}

function resolveIsConcurrencySafe(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (NON_PARALLEL_TOOLS.has(toolName)) return false
  if (isAgenticWorkspaceFileMutationTool(toolName)) return false
  const tool = toolRegistry.get(toolName)
  if (!tool) return false
  const ics = tool.isConcurrencySafe
  if (typeof ics === 'function') {
    try { return ics(toolInput) } catch { return false }
  }
  if (typeof ics === 'boolean') return ics
  return false
}

function resolveInterruptBehavior(
  toolName: string,
  input: Record<string, unknown>,
): InterruptBehavior {
  const tool = toolRegistry.get(toolName)
  if (!tool) return 'block'
  if (typeof tool.interruptBehavior === 'function') {
    try {
      return (tool.interruptBehavior as (i?: Record<string, unknown>) => InterruptBehavior)(input)
    } catch {
      return 'block'
    }
  }
  if (typeof tool.interruptBehavior === 'string') return tool.interruptBehavior
  return 'block'
}

export interface StreamingToolExecutorCallbacks {
  onToolStart: (toolUse: { id: string; name: string; input: Record<string, unknown> }) => void
  onToolResult: (toolResult: ToolResultEventPayload) => void
}

/**
 * Audit fix A-4 helper — emit the UI `onToolStart` + `onToolResult` pair
 * for a write-preflight rejection so the renderer sees the attempted
 * call and its synthetic failure, matching the model-side transcript.
 *
 * Wrapped in try/catch because the listeners are caller-supplied; a
 * listener that throws here would otherwise leave the tool in an
 * inconsistent UI state and break later registry sync calls.
 */
function emitPreflightRejectionCallbacks(
  callbacks: StreamingToolExecutorCallbacks,
  toolUse: { id: string; name: string; input: Record<string, unknown> },
  errorMessage: string,
): void {
  try {
    callbacks.onToolStart({ id: toolUse.id, name: toolUse.name, input: toolUse.input })
  } catch (e) {
    console.warn('[StreamingToolExecutor] onToolStart (write-preflight) threw:', e)
  }
  try {
    callbacks.onToolResult({
      id: toolUse.id,
      name: toolUse.name,
      success: false,
      error: errorMessage,
      toolErrorClass: 'write_preflight',
      errorWhat: errorMessage,
    })
  } catch (e) {
    console.warn('[StreamingToolExecutor] onToolResult (write-preflight) threw:', e)
  }
}

export interface StreamingToolExecutorParams {
  signal: AbortSignal
  callbacks: StreamingToolExecutorCallbacks
  diffPermissionMode: 'default' | 'bypassPermissions'
  permissionDefaultMode: 'allow' | 'ask' | 'deny'
  permissionRules?: PermissionRulePayload[]
  /**
   * Chat interaction mode (Agent / Plan / Ask). Forwarded into the
   * `PolicyEngine.evaluate` context in {@link StreamingToolExecutor.executeToolUse}
   * so the streaming path enforces the same chat-mode gate as the batch path
   * (`'ask'` denies all tools, `'plan'` denies mutating tools).
   *
   * Defense in depth, NOT the primary gate: in production a plan/ask turn is
   * routed to the orchestrated batch path entirely by
   * `shouldBypassStreamingExecutorForPolicy` (it short-circuits on
   * `chatMode !== 'agent'` BEFORE any tool is added, regardless of
   * `POLE_STREAMING_TOOL_EXECUTOR`), so this gate only fires for a caller that
   * constructs the executor directly with a non-agent `chatMode` (tests today)
   * or as a regression guard if that bypass ordering ever changes. Defaults to
   * `'agent'`.
   */
  chatMode?: ChatMode
  discoveryExclude: Set<string>
  getInlineSkillSession: () => InlineSkillSessionState
  setInlineSkillSession: (s: InlineSkillSessionState) => void
  appendixAFlow?: AppendixAFlowReporter
  /**
   * Same tracker as {@link RunAgenticToolBatchParams.toolCallHistory}.
   * Shared across streaming + non-streaming tool-batch paths so a repeat
   * that spans a streaming → batch fallback is still detected.
   */
  toolCallHistory?: ToolCallHistory
}

/**
 * Full upstream-style StreamingToolExecutor.
 *
 * Tools are registered via `addTool()` as tool_use blocks arrive during API streaming.
 * Eligible tools begin execution immediately (before the stream finishes).
 * Results are yielded in insertion order via `getCompletedResults()`.
 */
export class StreamingToolExecutor {
  tracked: TrackedTool[] = []
  siblingAbortController = new AbortController()
  params: StreamingToolExecutorParams
  interrupted = false

  constructor(params: StreamingToolExecutorParams) {
    this.params = params
  }

  /**
   * Register a tool_use block. If concurrency rules allow, execution starts immediately.
   * Called during API stream as each tool_use content block completes.
   *
   * Write-preflight path: a `Write` tool_use that targets an existing
   * non-trivial file is rejected HERE — before `tryExecute` would fire
   * the executor's main `onToolStart` flow. The synthetic `tool_result` is
   * stored on `tracked.results` so the model sees the "use Edit instead"
   * error on its next API turn.
   *
   * Audit fix A-4 (2026-05) — previously this path also skipped the
   * `onToolStart` / `onToolResult` UI callbacks ("silent path"). The
   * intent was to keep the renderer clean when the model self-corrects
   * Write→Edit, but it left a split between what the model "did"
   * (a failed tool call in transcript) and what the UI showed (nothing).
   * Now both callbacks fire so the renderer and the model agree on the
   * timeline; the renderer can still elide self-correction loops in
   * post-processing if it wants a quieter UX.
   *
   * PolicyEngine preflight on the streaming path is now closed: audit fix
   * SA-4 added a per-tool `getPolicyEngine().evaluate(...)` gate in
   * {@link StreamingToolExecutor.executeToolUse} (workspace permission rules,
   * default-mode, global rules), and `chatMode` is now threaded through
   * {@link StreamingToolExecutorParams} so Plan/Ask chat-mode denials apply
   * here too. Denials emit `permission_denied_preflight` via `denyTool`. Plan/
   * Ask turns additionally route through the orchestrated batch path entirely
   * (see `shouldBypassStreamingExecutorForPolicy`).
   *
   * Defense-in-depth for the rare path that still reaches `executeToolUse`
   * lives in {@link runAgenticToolUse}'s `toolWriteFile` (gate A).
   */
  addTool(toolUse: ToolUseBlock, assistantMessage: AssistantMessage | null = null): void {
    const isConcurrencySafe = resolveIsConcurrencySafe(toolUse.name, toolUse.input)
    const interruptBehavior = resolveInterruptBehavior(toolUse.name, toolUse.input)

    const tracked: TrackedTool = {
      toolUse,
      assistantMessage,
      status: 'queued',
      isConcurrencySafe,
      interruptBehavior,
      promise: null,
      results: [],
      pendingProgress: [],
      error: null,
      thisToolErrored: false,
      lease: null,
    }

    this.tracked.push(tracked)

    // Hook 1a — register this tool in the process-wide ToolRuntimeState so
    // `quota.snapshot()` and `abortAllToolsForAgent` / cross-agent sees it.
    // Without this, streaming-path tools are invisible to the global resource
    // manager and `quota.admit()` (below in executeToolUse) sees only the
    // batch-path workload.
    // RuntimeState + Scheduler admission happens asynchronously inside
    // executeToolUse, after PolicyEngine approval. Keeping the wait inside the
    // tool promise means model-token streaming remains unblocked.

    if (isBuiltinFullFileWriteTool(toolUse.name)) {
      // Stream-time pre-baked rejection (C-grade `content-before-filePath`
      // branch). The watcher already decided the verdict; B-grade's
      // disk-based `preflightWriteTool` would fail-open on the empty
      // `input.filePath` left behind by the watcher, so we MUST surface
      // the pre-baked error directly and skip the disk check.
      const prebaked = toolUse.preflightError
      if (typeof prebaked === 'string' && prebaked.length > 0) {
        tracked.status = 'completed'
        tracked.results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Error: ${prebaked}`,
          is_error: true,
        })
        this.params.toolCallHistory?.record(toolUse.name, toolUse.input, {
          success: false,
          errorSummary: prebaked,
        })
        try {
          markToolFailedInState(toolUse.id, prebaked)
        } catch (e) {
          console.warn('[StreamingToolExecutor] markToolFailed (prebaked write-preflight) threw:', e)
        }
        try {
          getToolScheduler().markFailed(toolUse.id)
        } catch (e) {
          console.warn('[StreamingToolExecutor] scheduler.markFailed (prebaked write-preflight) threw:', e)
        }
        // Audit fix A-4 — emit the UI callbacks so the renderer sees the
        // attempted call + its synthetic failure, matching what's in the
        // model-side transcript. Callbacks are wrapped in try/catch so a
        // misbehaving listener can't mark this tool's state inconsistent.
        emitPreflightRejectionCallbacks(this.params.callbacks, toolUse, prebaked)
        return
      }

      const filePath = extractWorkspaceFilePathFromToolInput(toolUse.input)
      const preflight = preflightWriteTool({ filePath })
      if (!preflight.ok) {
        tracked.status = 'completed'
        tracked.results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Error: ${preflight.error}`,
          is_error: true,
        })
        this.params.toolCallHistory?.record(toolUse.name, toolUse.input, {
          success: false,
          errorSummary: preflight.error,
        })
        // Sync write-preflight rejection into both the runtime state and the
        // scheduler DAG so they don't linger as 'queued'/'ready' for 120s.
        try {
          markToolFailedInState(toolUse.id, preflight.error)
        } catch (e) {
          console.warn('[StreamingToolExecutor] markToolFailed (write-preflight) threw:', e)
        }
        try {
          getToolScheduler().markFailed(toolUse.id)
        } catch (e) {
          console.warn('[StreamingToolExecutor] scheduler.markFailed (write-preflight) threw:', e)
        }
        // Audit fix A-4 — same UI sync as the prebaked branch above.
        emitPreflightRejectionCallbacks(this.params.callbacks, toolUse, preflight.error)
        return
      }
    }

    this.tryExecute(tracked)
  }

  canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executing = this.tracked.filter(t => t.status === 'executing')
    if (executing.length === 0) return true
    if (!isConcurrencySafe) return false
    return executing.every(t => t.isConcurrencySafe)
  }

  tryExecute(tracked: TrackedTool): void {
    if (tracked.status !== 'queued') return
    if (!this.canExecuteTool(tracked.isConcurrencySafe)) return

    tracked.status = 'executing'
    // Note: do NOT transition ToolRuntimeState to 'running' here. We need
    // `quota.admit()` (called early in `executeToolUse`) to see this tool
    // as 'queued' so it doesn't deny ITSELF against the mutation cap. Mirrors
    // `DefaultToolRuntimePort.executeToolBatch` which does its quota.admit
    // pass BEFORE the trackedCallbacks `onToolStart` (which calls markRunning).
    // markRunning is now called inside `executeToolUse` immediately after
    // admit passes.
    this.params.callbacks.onToolStart(tracked.toolUse)

    const mergedSignal = mergeAbortSignals(
      this.params.signal,
      this.siblingAbortController.signal,
    )

    tracked.promise = this.executeToolUse(tracked, mergedSignal)
      .then(() => {
        tracked.status = 'completed'
      })
      .catch((err) => {
        tracked.error = err instanceof Error ? err : new Error(String(err))
        tracked.thisToolErrored = true
        tracked.status = 'completed'
        tracked.lease?.finish('failed', tracked.error.message)

        if (isShellTool(tracked.toolUse.name)) {
          if (!this.siblingAbortController.signal.aborted) {
            this.siblingAbortController.abort(
              createSiblingShellFailureReason(tracked.toolUse.id),
            )
          }
        }

        if (tracked.results.length === 0) {
          tracked.results.push({
            type: 'tool_result',
            tool_use_id: tracked.toolUse.id,
            content: `Error: ${tracked.error.message}`,
            is_error: true,
          })
        }
        // Defensive sync: if executeToolUse threw before its own
        // markCompleted/Failed could fire, sync BOTH the runtime state and
        // the scheduler DAG so neither lingers for the 120s cleanup window.
        // Both calls are idempotent if the inner sync already happened.
        try {
          const entry = getToolEntry(tracked.toolUse.id)
          if (entry && entry.status !== 'completed' && entry.status !== 'failed' && entry.status !== 'aborted') {
            markToolFailedInState(tracked.toolUse.id, tracked.error.message)
          }
        } catch (e) {
          console.warn('[StreamingToolExecutor] markToolFailed (catch) threw:', e)
        }
        try {
          getToolScheduler().markFailed(tracked.toolUse.id)
        } catch (e) {
          console.warn('[StreamingToolExecutor] scheduler.markFailed (catch) threw:', e)
        }
      })
      .finally(() => {
        this.tryExecuteQueued()
      })
  }

  tryExecuteQueued(): void {
    for (const t of this.tracked) {
      if (t.status === 'queued') {
        this.tryExecute(t)
      }
    }
  }

  async executeToolUse(
    tracked: TrackedTool,
    signal: AbortSignal,
  ): Promise<void> {
    // Write-preflight rejection happens in `addTool` (silent UI path) so we
    // do not re-check it here — by construction, a tool that reaches this
    // method has already passed the preflight gate. The gate-A defensive
    // copy inside `toolWriteFile` still catches any non-streaming entry
    // point (subagent direct calls, tests) that bypass `addTool`.

    // Audit fix SA-4 — shared context for the admission gates below
    // (PolicyEngine preflight + quota). Priority resolution mirrors
    // `toolExec.ts`'s `effectivePriority`: a declared AgentContext.priority
    // wins; otherwise main-chat batches run HIGH and sub-agents NORMAL.
    const admissionCtx = getAgentContext()
    const admissionAgentId = asAgentId(admissionCtx?.agentId ?? 'main')
    const admissionParent = admissionCtx?.parentAgentId
      ? asAgentId(admissionCtx.parentAgentId)
      : undefined
    const admissionConvId = admissionCtx?.streamConversationId?.trim() || undefined
    const effectivePriority: number =
      typeof admissionCtx?.priority === 'number'
        ? admissionCtx.priority
        : admissionAgentId === asAgentId('main')
          ? ToolPriority.HIGH
          : ToolPriority.NORMAL
    const isReadOnly = toolRegistry.get(tracked.toolUse.name)?.isReadOnly ?? false
    let admissionRegistered = false

    // Audit fix SA-4 — denial terminalisation shared by both gates.
    // Mirrors the fallback batch path in `toolExec.ts` (`markDenied` +
    // merged denial tool_result + `emitDenial`): onToolResult callback,
    // synthesized error tool_result carrying the matched rule, state +
    // scheduler markFailed, and the `permission_denied_preflight` phase
    // event. The phase event routes through interactionState's
    // main-process-wide sender because streaming callbacks do not expose
    // `onStreamEvent`.
    const denyTool = (reasonText: string, matchedRule: string): void => {
      this.params.callbacks.onToolResult({
        id: tracked.toolUse.id,
        name: tracked.toolUse.name,
        success: false,
        error: reasonText,
      })
      tracked.results.push({
        type: 'tool_result',
        tool_use_id: tracked.toolUse.id,
        content: `Error: ${reasonText} (matched: ${matchedRule})`,
        is_error: true,
      })
      this.params.toolCallHistory?.record(tracked.toolUse.name, tracked.toolUse.input, {
        success: false,
        errorSummary: reasonText,
      })
      if (admissionRegistered) {
        try {
          markToolFailedInState(tracked.toolUse.id, reasonText)
        } catch (e) {
          console.warn('[StreamingToolExecutor] markToolFailed (admission deny) threw:', e)
        }
        try {
          getToolScheduler().markFailed(tracked.toolUse.id)
        } catch (e) {
          console.warn('[StreamingToolExecutor] scheduler.markFailed (admission deny) threw:', e)
        }
      }
      try {
        if (admissionConvId) {
          const transport = createTransportAdapter((ev) =>
            emitStreamEventForConversation(
              admissionConvId,
              ev as unknown as Record<string, unknown>,
            ),
          )
          emitPhaseEvent(
            transport,
            buildPermissionDeniedPhase({
              // iteration=0 sentinel mirrors `DefaultToolRuntimePort` /
              // fallback preflight denials; renderer groups by toolUseId.
              iteration: 0,
              conversationId: admissionConvId,
              permissionDenial: {
                toolName: tracked.toolUse.name,
                toolUseId: tracked.toolUse.id,
                reason: reasonText,
                matchedRule,
              },
            }),
          )
        }
      } catch (e) {
        console.warn('[StreamingToolExecutor] emit permission_denied_preflight threw:', e)
      }
    }

    // Audit fix SA-4 — abort-aware admission. The whole gate below is
    // synchronous (evaluate + admit, no awaits before runAgenticToolUse),
    // so one check up front covers it. Terminalisation mirrors
    // `getAbortedResults` (markAborted + synthetic interrupted result).
    if (signal.aborted) {
      const errMsg = TOOL_INTERRUPTED_BY_USER_MESSAGE
      tracked.results.push({
        type: 'tool_result',
        tool_use_id: tracked.toolUse.id,
        content: `Error: ${errMsg}`,
        is_error: true,
      })
      return
    }

    // Audit fix SA-4 — PolicyEngine preflight for the streaming path.
    // Previously streaming tools started straight from the model stream,
    // bypassing chat-mode / workspace-permission-rule / allowlist / global
    // rule enforcement (see the once-per-process warning in
    // `agenticLoop/toolExec.ts`) — a permission deny could only happen
    // after the tool had already begun. Same gate as the fallback batch
    // path, run after `registerToolInvocation` (in addTool) and before the
    // tool body.
    try {
      const policyDecision = getPolicyEngine().evaluate({
        toolName: tracked.toolUse.name,
        toolInput: tracked.toolUse.input,
        toolUseId: tracked.toolUse.id,
        context: {
          agentId: admissionAgentId,
          ...(admissionParent ? { parentAgentId: admissionParent } : {}),
          ...(admissionConvId ? { conversationId: admissionConvId } : {}),
          ...(this.params.permissionRules ? { permissionRules: this.params.permissionRules } : {}),
          ...(this.params.permissionDefaultMode
            ? { permissionDefaultMode: this.params.permissionDefaultMode }
            : {}),
          // Chat-mode gate parity with the batch path (`kernel.ts` resolveContext):
          // `'ask'` denies every tool, `'plan'` denies mutating tools at preflight.
          ...(this.params.chatMode ? { chatMode: this.params.chatMode } : {}),
        },
        isReadOnly,
        priority: effectivePriority,
        // The authoritative quota admission runs just below with streaming
        // deny-not-wait semantics, and the lineage-aware history check
        // already lives further down in this method (per-loop + global
        // advice) — skip both here so neither runs twice.
        skipQuota: true,
        skipHistory: true,
      })
      if (!policyDecision.allowed) {
        const reasonText = policyDecision.reason?.trim() || 'Denied by policy engine.'
        const matched =
          policyDecision.matchedRules && policyDecision.matchedRules.length > 0
            ? policyDecision.matchedRules.join(',')
            : 'policyEngine'
        denyTool(reasonText, matched)
        return
      }
    } catch (e) {
      // Fail-closed by default (mirror `toolExec.fallback`): a thrown
      // evaluate must not silently skip the permission gates.
      if (process.env.POLE_PREFLIGHT_FAIL_OPEN === '1') {
        console.warn('[StreamingToolExecutor] policyEngine.evaluate threw (fail-open):', e)
      } else {
        const reasonText = `Policy engine evaluation failed: ${e instanceof Error ? e.message : String(e)}`
        console.warn('[StreamingToolExecutor] policyEngine.evaluate threw (fail-closed):', e)
        denyTool(reasonText, 'policyEngine:engine-error')
        return
      }
    }

    const admission = await getToolAdmissionCoordinator().acquire({
        toolUseId: tracked.toolUse.id,
        toolName: tracked.toolUse.name,
        agentId: admissionAgentId,
        ...(admissionParent ? { parentAgentId: admissionParent } : {}),
        ...(admissionConvId ? { conversationId: admissionConvId } : {}),
        input: tracked.toolUse.input,
        isReadOnly,
        priority: effectivePriority,
        preemptible: effectivePriority < ToolPriority.HIGH,
        signal,
        quotaMode: 'deny',
        logTag: 'StreamingToolExecutor',
      })
    if (!admission.admitted) {
      denyTool(admission.reason, admission.ruleId ?? 'tool_admission')
      return
    }
    tracked.lease = admission.lease
    admissionRegistered = true
    await admission.lease.waitUntilGranted()
    admission.lease.start()

    const history = this.params.toolCallHistory
    const advice = history?.checkBeforeCall(tracked.toolUse.name, tracked.toolUse.input) ?? null

    // Audit #5 (Patch B): also consult the process-wide cross-agent history.
    // Per-loop `history` is scoped to a single agentic loop, so a `teamAutoLauncher`
    // template firing 5 members at the same failing tool never hits per-loop hint/block
    // — each member has its own fresh per-loop history. Global history bridges that gap.
    let globalAdvice: ReturnType<ReturnType<typeof getGlobalToolCallHistory>['check']> | null = null
    try {
      // Audit fix H4 — pass caller agent id so the global history's
      // lineage filter scopes the failure count to this agent's
      // ancestry. A sibling agent's failures no longer block us.
      // First eagerly register the caller's lineage so the registry
      // knows about parent links even before this agent records any
      // outcomes itself (otherwise a check() that fires before the
      // first record() can't see the parent chain).
      const ctx = getAgentContext()
      const callerAgentId = ctx?.agentId
      const convId = ctx?.streamConversationId?.trim() || undefined
      if (callerAgentId && (ctx?.parentAgentId || ctx?.sessionAgentType)) {
        getGlobalToolCallHistory().registerAgentLineage(callerAgentId, {
          ...(ctx?.parentAgentId ? { parentAgentId: ctx.parentAgentId as AgentId } : {}),
          ...(ctx?.sessionAgentType ? { agentType: ctx.sessionAgentType } : {}),
        })
      }
      // Audit fix H-1 — conversation-scope the cross-agent check/record so a
      // different chat tab's identical failing call can't cross-block this one.
      globalAdvice = getGlobalToolCallHistory().check(
        tracked.toolUse.name,
        tracked.toolUse.input,
        callerAgentId || convId
          ? {
              ...(callerAgentId ? { callerAgentId } : {}),
              ...(convId ? { conversationId: convId } : {}),
            }
          : undefined,
      )
    } catch (e) {
      console.warn('[StreamingToolExecutor] globalHistory.check threw:', e)
    }

    // Per-loop block wins over global block when both fire (same fingerprint → same
    // message ballpark; per-loop is more specific). Either source produces an Error
    // tool_result and skips execution.
    const blockingAdvice =
      advice?.level === 'block'
        ? advice
        : globalAdvice?.level === 'block'
          ? globalAdvice
          : null

    // Hard block — do not spawn; surface via callbacks so UI + telemetry see it.
    if (blockingAdvice) {
      this.params.callbacks.onToolResult({
        id: tracked.toolUse.id,
        name: tracked.toolUse.name,
        success: false,
        error: blockingAdvice.message,
      })
      const synthetic: Record<string, unknown> = {
        type: 'tool_result',
        tool_use_id: tracked.toolUse.id,
        content: `Error: ${blockingAdvice.message}`,
        is_error: true,
      }
      history?.record(tracked.toolUse.name, tracked.toolUse.input, {
        success: false,
        errorSummary: blockingAdvice.message,
      })
      // Audit #5: mirror block decision into global history so subsequent agents
      // still see this fingerprint as "recently failed N times" + 1.
      try {
        // Audit fix H4 — also forward parentAgentId + agentType so the
        // lineage registry can be populated for sibling/ancestor scoping.
        const ctx = getAgentContext()
        const agentId = ctx?.agentId
        const parentAgentId = ctx?.parentAgentId
        const agentType = ctx?.sessionAgentType
        const convId = ctx?.streamConversationId?.trim() || undefined
        getGlobalToolCallHistory().record(tracked.toolUse.name, tracked.toolUse.input, {
          success: false,
          errorSummary: blockingAdvice.message,
          ...(agentId ? { agentId } : {}),
          ...(parentAgentId ? { parentAgentId: parentAgentId as AgentId } : {}),
          ...(agentType ? { agentType } : {}),
          // Audit fix H-1 — conversation scope (parity with the check above).
          ...(convId ? { conversationId: convId } : {}),
        })
      } catch (e) {
        console.warn('[StreamingToolExecutor] globalHistory.record (block) threw:', e)
      }
      // Block short-circuit also resolves the runtime state + scheduler DAG.
      admission.lease.finish('failed', blockingAdvice.message)
      try {
        markToolFailedInState(tracked.toolUse.id, blockingAdvice.message)
      } catch (e) {
        console.warn('[StreamingToolExecutor] markToolFailed (history-block) threw:', e)
      }
      try {
        getToolScheduler().markFailed(tracked.toolUse.id)
      } catch (e) {
        console.warn('[StreamingToolExecutor] scheduler.markFailed (history-block) threw:', e)
      }
      tracked.results.push(synthetic)
      return
    }

    // Audit F-3 wire-up — merge the per-tool preempt signal from
    // `ToolRuntimeState` with the caller's batch `signal` so a higher-
    // priority newcomer that `preemptTool(victimId)` fires can actually
    // interrupt a streaming tool's in-flight work. Without this merge
    // the preempt was bookkeeping-only on the streaming path (registry
    // marked aborted, real shell child / network request kept running).
    //
    // `getToolPreemptSignal` returns the per-tool controller's signal,
    // populated when `registerToolInvocation` ran at the top of the
    // streaming batch in `toolExec.ts` (audit P1 §5.1 wire-up). When the
    // entry has been cleaned up early (rare) it returns undefined and
    // we fall back to the caller's signal alone.
    const effectiveSignal = admission.lease.effectiveSignal

    const result = await runAgenticToolUse({
      toolUse: tracked.toolUse,
      signal: effectiveSignal,
      callbacks: {
        onToolStart: () => {},
        onToolResult: (toolResult) => {
          this.params.callbacks.onToolResult(toolResult)
        },
      },
      diffPermissionMode: this.params.diffPermissionMode,
      permissionDefaultMode: this.params.permissionDefaultMode,
      permissionRules: this.params.permissionRules,
      discoveryExclude: this.params.discoveryExclude,
      getInlineSkillSession: this.params.getInlineSkillSession,
      setInlineSkillSession: this.params.setInlineSkillSession,
    })

    // Record outcome for future repeat-detection.
    const indicatesFailure =
      typeof (result as { content?: unknown }).content === 'string' &&
      ((result as { content: string }).content).trimStart().startsWith('Error:')
    const errorSummary = indicatesFailure
      ? extractErrorSummaryFromToolResult(result)
      : undefined
    if (history) {
      history.record(tracked.toolUse.name, tracked.toolUse.input, {
        success: !indicatesFailure,
        errorSummary,
      })
    }
    // Audit #5 (Patch B): mirror outcome into process-wide history so the
    // cross-agent block guard fires on streaming-path failures (it was
    // effectively dead before the SA-4 streaming-path wiring — the streaming
    // executor used to bypass the cross-agent history entirely).
    try {
      // Audit fix H4 — same lineage-aware enrichment as the block path.
      const ctx = getAgentContext()
      const agentId = ctx?.agentId
      const parentAgentId = ctx?.parentAgentId
      const agentType = ctx?.sessionAgentType
      const convId = ctx?.streamConversationId?.trim() || undefined
      getGlobalToolCallHistory().record(tracked.toolUse.name, tracked.toolUse.input, {
        success: !indicatesFailure,
        ...(indicatesFailure && errorSummary ? { errorSummary } : {}),
        ...(agentId ? { agentId } : {}),
        ...(parentAgentId ? { parentAgentId: parentAgentId as AgentId } : {}),
        ...(agentType ? { agentType } : {}),
        // Audit fix H-1 — conversation scope (parity with the check above).
        ...(convId ? { conversationId: convId } : {}),
      })
    } catch (e) {
      console.warn('[StreamingToolExecutor] globalHistory.record (outcome) threw:', e)
    }

    admission.lease.finish(
      indicatesFailure ? 'failed' : 'completed',
      errorSummary ?? (indicatesFailure ? 'tool failed' : undefined),
    )
    // Terminal sync to BOTH the runtime state and the scheduler DAG.
    //   - `markToolCompleted/Failed` in state lets `quota.snapshot()` see this
    //     slot freed, so the next admission can proceed.
    //   - `scheduler.markCompleted/Failed` unblocks dependents (when DAG edges
    //     are populated) and cascades failure.
    try {
      if (indicatesFailure) {
        markToolFailedInState(tracked.toolUse.id, errorSummary ?? 'tool failed')
      } else {
        markToolCompletedInState(tracked.toolUse.id)
      }
    } catch (e) {
      console.warn('[StreamingToolExecutor] markToolCompleted/Failed (state) threw:', e)
    }
    try {
      if (indicatesFailure) {
        getToolScheduler().markFailed(tracked.toolUse.id)
      } else {
        getToolScheduler().markCompleted(tracked.toolUse.id)
      }
    } catch (e) {
      console.warn('[StreamingToolExecutor] scheduler.markCompleted/Failed threw:', e)
    }

    // On a hint-level retry that still failed, annotate the model-visible
    // result so the next turn sees the advisory. Per-loop hint takes
    // precedence (more specific); fall back to global hint when present.
    const hintForAdvisory =
      advice?.level === 'hint'
        ? advice
        : globalAdvice?.level === 'hint'
          ? globalAdvice
          : null
    const decorated =
      indicatesFailure && hintForAdvisory
        ? attachAdvisoryToToolResult(result, hintForAdvisory.message)
        : result

    tracked.results.push(decorated)
  }

  /**
   * Yield completed results in insertion order. Progress messages are yielded immediately
   * regardless of tool status. Stops at first non-completed, non-concurrent-safe tool to
   * preserve ordering guarantees.
   */
  *getCompletedResults(): Generator<{
    type: 'tool_result' | 'tool_progress'
    toolUseId: string
    data: Record<string, unknown>
  }> {
    for (const t of this.tracked) {
      for (const p of t.pendingProgress) {
        yield { type: 'tool_progress', toolUseId: p.toolUseId, data: p.data as Record<string, unknown> }
      }
      t.pendingProgress = []
    }

    for (const t of this.tracked) {
      if (t.status === 'yielded') continue
      if (t.status !== 'completed') {
        if (!t.isConcurrencySafe) break
        continue
      }

      for (const r of t.results) {
        yield {
          type: 'tool_result',
          toolUseId: t.toolUse.id,
          data: r,
        }
      }
      t.status = 'yielded'
    }
  }

  /**
   * After stream ends: wait for all remaining tools and yield their results in order.
   * This is called in the post-stream phase of queryLoop.
   */
  async *getRemainingResults(): AsyncGenerator<{
    type: 'tool_result' | 'tool_progress'
    toolUseId: string
    data: Record<string, unknown>
  }> {
    this.tryExecuteQueued()

    while (this.tracked.some(t => t.status !== 'yielded')) {
      const executing = this.tracked.filter(t => t.status === 'executing')
      if (executing.length > 0) {
        await Promise.race(executing.map(t => t.promise).filter(Boolean))
      }

      this.tryExecuteQueued()

      for (const item of this.getCompletedResults()) {
        yield item
      }
    }
  }

  /**
   * Generate synthetic tool_result blocks for tools still running when interrupted.
   */
  *getAbortedResults(): Generator<Record<string, unknown>> {
    for (const t of this.tracked) {
      if (t.status === 'yielded') continue
      const reason = this.params.signal.reason
      const errMsg = isSiblingShellFailureReason(reason)
        ? `Error: ${formatParallelToolSiblingCancelError(reason.sourceToolUseId)}`
        : `Error: ${TOOL_INTERRUPTED_BY_USER_MESSAGE}`

      // Hook 4 — abort path also has to release the runtime-state slot and
      // the scheduler DAG node, otherwise `quota.snapshot()` keeps counting
      // a tool that the user already cancelled. Both calls are idempotent;
      // completed tools (status === 'completed') already sync'd their state
      // in executeToolUse and the entry check skips them.
      try {
        const entry = getToolEntry(t.toolUse.id)
        if (entry && entry.status !== 'completed' && entry.status !== 'failed' && entry.status !== 'aborted') {
          t.lease?.finish('aborted', errMsg)
          markToolAborted(t.toolUse.id, errMsg)
        }
      } catch (e) {
        console.warn('[StreamingToolExecutor] markToolAborted (interrupt) threw:', e)
      }
      try {
        getToolScheduler().markFailed(t.toolUse.id)
      } catch (e) {
        console.warn('[StreamingToolExecutor] scheduler.markFailed (interrupt) threw:', e)
      }

      yield {
        type: 'tool_result',
        tool_use_id: t.toolUse.id,
        content: errMsg,
        is_error: true,
      }
      t.status = 'yielded'
    }
  }

  /** True when user abort should cancel this tool's execution (vs blocking until done). */
  shouldCancelOnInterrupt(toolUseId: string): boolean {
    const t = this.tracked.find(tr => tr.toolUse.id === toolUseId)
    return t?.interruptBehavior === 'cancel'
  }

  /** True when all registered tools have been yielded. */
  isFullyYielded(): boolean {
    return this.tracked.length > 0 && this.tracked.every(t => t.status === 'yielded')
  }

  /** True when at least one tool is still executing. */
  hasExecutingTools(): boolean {
    return this.tracked.some(t => t.status === 'executing')
  }

  /** True when there are tools waiting in the queue. */
  hasQueuedTools(): boolean {
    return this.tracked.some(t => t.status === 'queued')
  }

  /** Get all tool_result blocks for the user message in tool_use_id order. */
  getAllToolResultBlocks(): Array<Record<string, unknown>> {
    const blocks: Array<Record<string, unknown>> = []
    for (const t of this.tracked) {
      for (const r of t.results) {
        blocks.push(r)
      }
    }
    return blocks
  }

  /** Number of registered tool_use blocks. */
  get toolCount(): number {
    return this.tracked.length
  }

  /** Mark as interrupted — stops new tool execution. */
  markInterrupted(): void {
    this.interrupted = true
  }

  /** True when no tools have been registered. */
  isEmpty(): boolean {
    return this.tracked.length === 0
  }
}
