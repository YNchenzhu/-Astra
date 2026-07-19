/**
 * Sub-agent worker RPC bridge — main-process handlers for the worker's
 * tool RPC + scheduler-admission protocol.
 *
 * Extracted verbatim from `runSubAgentInWorker`'s `worker.on('message')`
 * handler (the first three `msg.kind` branches): `tool_call`,
 * `admit_request`, and `admit_done`. The bodies are byte-for-byte the same;
 * the only change is that the closure variables they used are now passed
 * explicitly via {@link WorkerRpcDeps}.
 */

import type { Worker } from 'node:worker_threads'
import { asAgentId } from '../tools/ids'
import type { AgentId } from '../tools/ids'
import { toolRegistry } from '../tools/registry'
import { createToolUseContext } from '../tools/toolExecContext'
import type {
  ToolPermissionDefault,
  ToolPermissionMode,
} from '../tools/toolExecContext'
import type { PermissionRulePayload } from '../ai/permissionRuleMatch'
import { runWithSubAgentRpcGateAsync } from './subAgentRpcGateContext'
import { ToolPriority } from '../orchestration/toolRuntime/scheduler'
import {
  acquireSchedulerAdmission,
  createWorkerToolUseId,
  releaseSchedulerAdmission,
} from './subAgentWorkerScheduler'
import type { WorkerRunCtx } from './subAgentWorkerRunContext'
import type {
  WorkerToolCall,
  WorkerToolResult,
  WorkerToolError,
} from './subAgentWorkerProtocol'

export interface WorkerRpcDeps {
  worker: Worker
  wctx: WorkerRunCtx
  workerSessionId: string
  effectiveAgentId: AgentId
  workerParentAgentId: string | undefined
  workerPriority: number | undefined
  signal: AbortSignal
  onToolActivity?: () => void
  rpcPermissionMode: ToolPermissionMode | undefined
  rpcPermissionDefaultMode: ToolPermissionDefault | undefined
  rpcPermissionRules: ReadonlyArray<PermissionRulePayload> | undefined
  rpcSessionAgentType: string | undefined
  rpcSessionMemoryWritableTargetPath: string | undefined
  agentDef: { agentType: string; maxTurns?: number; tools?: string[]; disallowedTools?: string[]; mcpServers?: string[] }
}

export function handleWorkerToolCall(call: WorkerToolCall, deps: WorkerRpcDeps): void {
  const {
    worker,
    wctx,
    workerSessionId,
    effectiveAgentId,
    workerParentAgentId,
    workerPriority,
    signal,
    onToolActivity,
    rpcPermissionMode,
    rpcPermissionDefaultMode,
    rpcPermissionRules,
    rpcSessionAgentType,
    rpcSessionMemoryWritableTargetPath,
    agentDef,
  } = deps
  // SA-3 fix 2 — an RPC tool call is about to execute on the host.
  // Belt-and-suspenders alongside the `tool_start` notification
  // below (the loop emits tool_start before dispatch, but don't
  // rely on event ordering for a side-effect-safety signal).
  onToolActivity?.()
  void (async () => {
    const rpcToolUseId = createWorkerToolUseId(
      'rpc',
      workerSessionId,
      effectiveAgentId,
      call.reqId,
    )
    const admission = await acquireSchedulerAdmission({
      toolUseId: rpcToolUseId,
      toolName: call.toolName,
      agentId: asAgentId(effectiveAgentId),
      ...(workerParentAgentId ? { parentAgentId: asAgentId(workerParentAgentId) } : {}),
      input: call.toolInput,
      isReadOnly: toolRegistry.get(call.toolName)?.isReadOnly ?? false,
      priority: typeof workerPriority === 'number' ? workerPriority : ToolPriority.NORMAL,
      signal,
      logTag: 'subAgentWorker.rpc',
    })
    if (!admission.admitted) {
      worker.postMessage({
        kind: 'tool_result',
        reqId: call.reqId,
        result: { success: false, error: admission.reason ?? 'denied by scheduler' } as unknown as Record<string, unknown>,
      } satisfies WorkerToolResult)
      return
    }
    wctx.outstandingRpcAdmissions.add(rpcToolUseId)
    try {
      // P0-2 fix (upstream alignment audit): worker RPC was previously
      // calling `toolRegistry.execute(call.toolName, call.toolInput)`
      // without a `ToolUseContext`. That meant worker-mode sub-agents
      // ran every tool with `ctx === undefined`, which collapses to:
      //   - `TodoWrite` keys off `'__default__'`, so all worker
      //     sub-agents shared one todo bucket and trampled each
      //     other's lists.
      //   - `web_fetch` (and any future progress-emitting tool)
      //     silently disabled its `emitToolProgress` branch.
      //   - `ctx.abortSignal` was unavailable to tools that wanted
      //     to honour cooperative cancellation mid-execution.
      //
      // Construct the same lightweight ctx the in-process path does
      // (see `runAgenticToolUseBody`). Phase 1B matrix item 4 of 5:
      // forward the caller's permission mode / rules / default
      // through the closure variables captured at function entry
      // (`rpcPermissionMode` / `rpcPermissionDefaultMode` /
      // `rpcPermissionRules`). When the caller omits them we fall
      // back to the historical `default`/`ask` pair so the failure
      // mode of an under-plumbed caller stays "safe (prompts)"
      // rather than "wide open".
      //
      // `toolUseId` uses the RPC `reqId` (worker-local monotonic
      // counter; sufficient for downstream `streamingProgress`
      // de-duplication purposes if a chunk emitter is ever wired
      // through worker.postMessage).
      const toolExecCtx = createToolUseContext({
        toolUseId: rpcToolUseId,
        toolName: call.toolName,
        abortSignal: admission.effectiveSignal ?? signal,
        agentId: effectiveAgentId,
        agentType: agentDef.agentType,
        isSubAgent: true,
        permissionMode: rpcPermissionMode ?? 'default',
        permissionDefaultMode: rpcPermissionDefaultMode ?? 'ask',
        ...(rpcPermissionRules ? { permissionRules: rpcPermissionRules } : {}),
        discoveryExclude: new Set<string>(),
        // No `emitToolProgress` wired across worker boundary yet —
        // tools that consume it (`web_fetch`) gracefully fall back
        // to silent execution. Future work: forward progress chunks
        // through `worker.postMessage` and back into `onEvent` as
        // a `subagent_tool_progress` event.
      })
      // P0 audit fix: install the child sub-agent's gate-relevant
      // ALS fields for the duration of `toolRegistry.execute` so
      // `gateSessionMemoryInternalAgentToolUse` (and the in-tool
      // belt-and-suspenders gates inside Write / Edit / MultiEdit)
      // see the child's `sessionAgentType` rather than the parent's.
      // Without this, worker-path `session-memory-internal` scribes
      // bypassed their single-file sandbox because the RPC handler
      // runs in the parent's ALS scope.
      const result = await runWithSubAgentRpcGateAsync(
        {
          ...(rpcSessionAgentType
            ? { sessionAgentType: rpcSessionAgentType }
            : {}),
          ...(rpcSessionMemoryWritableTargetPath
            ? { sessionMemoryWritableTargetPath: rpcSessionMemoryWritableTargetPath }
            : {}),
        },
        () => toolRegistry.execute(call.toolName, call.toolInput, { ctx: toolExecCtx }),
      )
      const ranOk = (result as { success?: boolean } | null)?.success !== false
      wctx.outstandingRpcAdmissions.delete(rpcToolUseId)
      releaseSchedulerAdmission(rpcToolUseId, ranOk, { logTag: 'subAgentWorker.rpc' })
      worker.postMessage({ kind: 'tool_result', reqId: call.reqId, result: result as unknown as Record<string, unknown> } satisfies WorkerToolResult)
    } catch (err) {
      wctx.outstandingRpcAdmissions.delete(rpcToolUseId)
      releaseSchedulerAdmission(rpcToolUseId, false, {
        reason: err instanceof Error ? err.message : String(err),
        logTag: 'subAgentWorker.rpc',
      })
      worker.postMessage({
        kind: 'tool_error',
        reqId: call.reqId,
        error: err instanceof Error ? err.message : String(err),
      } satisfies WorkerToolError)
    }
  })()
}

export function handleWorkerAdmitRequest(msg: Record<string, unknown>, deps: WorkerRpcDeps): void {
  const {
    worker,
    wctx,
    workerSessionId,
    effectiveAgentId,
    workerParentAgentId,
    workerPriority,
    signal,
    onToolActivity,
  } = deps
  const reqId = typeof msg.reqId === 'number' ? msg.reqId : -1
  const toolName = typeof msg.toolName === 'string' ? msg.toolName : 'unknown'
  const isReadOnly = msg.isReadOnly === true
  const toolInput = msg.toolInput && typeof msg.toolInput === 'object' && !Array.isArray(msg.toolInput)
    ? msg.toolInput as Record<string, unknown>
    : {}
  onToolActivity?.()
  void (async () => {
    const localToolUseId = createWorkerToolUseId(
      'local',
      workerSessionId,
      effectiveAgentId,
      reqId,
    )
    let adm: Awaited<ReturnType<typeof acquireSchedulerAdmission>>
    try {
      adm = await acquireSchedulerAdmission({
        toolUseId: localToolUseId,
        toolName,
        agentId: asAgentId(effectiveAgentId),
        ...(workerParentAgentId ? { parentAgentId: asAgentId(workerParentAgentId) } : {}),
        input: toolInput,
        isReadOnly,
        priority: typeof workerPriority === 'number' ? workerPriority : ToolPriority.NORMAL,
        signal,
        logTag: 'subAgentWorker.local',
      })
    } catch (e) {
      // Admission is security/lifecycle authority: helper failures deny execution.
      console.warn('[subAgentWorkerClient] admit_request acquire threw:', e)
      adm = {
        admitted: false,
        reason: `tool admission failed: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
    if (adm.admitted) {
      // Track the granted (now 'running') slot so `finish()` can release
      // it if the worker exits before posting `admit_done`.
      wctx.outstandingLocalAdmissions.add(localToolUseId)
      const effectiveSignal = adm.effectiveSignal
      if (effectiveSignal) {
        const onAbort = () => {
          try {
            worker.postMessage({
              kind: 'admit_abort',
              reqId,
              reason: effectiveSignal.reason instanceof Error
                ? effectiveSignal.reason.message
                : String(effectiveSignal.reason ?? 'tool preempted'),
            })
          } catch {
            // Worker teardown releases the outstanding lease in finish().
          }
        }
        effectiveSignal.addEventListener('abort', onAbort, { once: true })
        wctx.localAdmissionAbortCleanups.set(localToolUseId, () => {
          effectiveSignal.removeEventListener('abort', onAbort)
        })
      }
      worker.postMessage({ kind: 'admit_grant', reqId })
    } else {
      // Denied → already terminal; nothing to track.
      worker.postMessage({ kind: 'admit_deny', reqId, reason: adm.reason ?? 'denied by scheduler quota' })
    }
  })()
}

export function handleWorkerAdmitDone(msg: Record<string, unknown>, deps: WorkerRpcDeps): void {
  const { wctx, workerSessionId, effectiveAgentId } = deps
  const reqId = typeof msg.reqId === 'number' ? msg.reqId : -1
  const success = msg.success !== false
  const localToolUseId = createWorkerToolUseId(
    'local',
    workerSessionId,
    effectiveAgentId,
    reqId,
  )
  // Reported done → drop from the outstanding set so `finish()` won't
  // double-release it.
  wctx.outstandingLocalAdmissions.delete(localToolUseId)
  wctx.localAdmissionAbortCleanups.get(localToolUseId)?.()
  wctx.localAdmissionAbortCleanups.delete(localToolUseId)
  releaseSchedulerAdmission(localToolUseId, success, { logTag: 'subAgentWorker.local' })
}
