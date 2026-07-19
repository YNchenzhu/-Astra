/**
 * Sub-agent worker client — main-process manager for worker_threads sub-agents.
 *
 * Spawns subAgentWorker, proxies RPC tool calls to the global toolRegistry,
 * and exposes a runSubAgentInWorker() API compatible with the original runSubAgent.
 */

import path from 'node:path'
import fs from 'node:fs'
import { Worker } from 'node:worker_threads'
import type { ProviderConfig } from '../ai/client'
import type { LoopEvent } from '../ai/loopEvents'
// Canonical strict union — distinct from the local loose `SubAgentEvent`
// public type below (kept for backward compatibility with subAgentRunner's
// `import('./subAgentWorkerClient').SubAgentEvent` callback typing).
import type { SubAgentEvent as CanonicalSubAgentEvent, SubAgentResult } from './types'
import type { AgentDefinitionUnion } from './types'
import { asAgentId } from '../tools/ids'
import { getWorkspacePath } from '../tools/workspaceState'
import type { Tool } from '../tools/types'
import { resolveAgentTools } from './subAgentToolResolver'
import { getSubAgentWorkerPool } from './subAgentWorkerPool'
import { readDiskSettings } from '../settings/settingsAccess'
import {
  resolveSubAgentReportedOutputDetail,
  subAgentProducedUsableReport,
} from './subAgentOutputResolver'
import {
  resolveFinalSummaryRescueBudgetMs,
  runSubAgentFinalSummaryRescue,
  shouldRunFinalSummaryRescue,
} from './subAgentFinalSummary'
import { extractLastAssistantText } from './extractTranscriptText'
import { releaseOutstandingLocalAdmissions } from './subAgentWorkerScheduler'
import {
  handleWorkerToolCall,
  handleWorkerAdmitRequest,
  handleWorkerAdmitDone,
} from './subAgentWorkerRpcBridge'
import type { WorkerRpcDeps } from './subAgentWorkerRpcBridge'
import { READONLY_AGENT_TYPES } from './subAgentReadonlyBudget'
import { appendSubAgentSidechain } from './subAgentSidechainTranscript'
import { createWorkerRunCtx } from './subAgentWorkerRunContext'
import { taskRuntimeStore } from '../tools/TaskRuntimeStore'
import { trackActiveSubAgentWorker } from './activeSubAgentWorkers'
import type {
  ToolPermissionDefault,
  ToolPermissionMode,
} from '../tools/toolExecContext'
import type { PermissionRulePayload } from '../ai/permissionRuleMatch'
import type {
  WorkerToolCall,
  ParentMessage,
  InitPayload,
  WorkerMessage,
} from './subAgentWorkerProtocol'
import { parseRemoteHostWorkerMessage } from '../bridge/sessionMessages'
import {
  acceptRemoteTranscriptCommit,
  createEmptyAcceptedTranscript,
} from '../bridge/remoteHostProtocol'

// `loopEventToSubAgentEvent` and `deriveWorkerSubAgentSuccess` now live in
// `./subAgentWorkerEventBridge`. Re-exported below for backward compatibility
// with existing importers (tests + runner-side code).
export {
  loopEventToSubAgentEvent,
  deriveWorkerSubAgentSuccess,
  windDownMessageToSubAgentEvent,
} from './subAgentWorkerEventBridge'
import {
  handleWorkerLoopEvent,
  deriveWorkerSubAgentSuccess,
  windDownMessageToSubAgentEvent,
} from './subAgentWorkerEventBridge'

// Wire-protocol types now live in `./subAgentWorkerProtocol`.

// ─── State ───

// Active worker tracking (reserved for future multi-worker pool).

// ─── Worker path ───

function resolveWorkerPath(): string {
  // vite-plugin-electron emits `dist-electron/subAgentWorker.js` next to
  // the main bundle. `__dirname` resolves to `dist-electron/` at runtime.
  return path.join(__dirname, 'subAgentWorker.js')
}

// ─── Public API ───

/**
 * Re-export of the canonical strict {@link CanonicalSubAgentEvent} union under
 * the historical name expected by `subAgentRunner.ts`'s
 * `import('./subAgentWorkerClient').SubAgentEvent` typing. Earlier this was a
 * loose `{ type: string; [key: string]: unknown }` shape, which let bugs like
 * "worker forwards LoopEvent verbatim, renderer drops it" slip through
 * unchecked. Aliasing to the strict union now forces the translation.
 */
export type SubAgentEvent = CanonicalSubAgentEvent

/**
 * Build the message list handed to a worker-side sub-agent run.
 *
 * Two shapes:
 *   - **Fresh agent** (`parentMessages` empty / missing): a single
 *     `{role: 'user', content: prompt}` — nothing more.
 *   - **Fork** (`parentMessages` already terminates with the task): a
 *     `structuredClone` of `parentMessages` (or JSON fallback for very
 *     old runtimes; reused-by-reference as a last resort).
 *
 * Exported for direct unit testing — the previous inline version did a
 * separate "push prompt if not fork" step which duplicated the prompt
 * whenever the caller passed no `parentMessages` (team auto-launch,
 * background spawns without a fork). The single conditional below is
 * the regression fix; the test in `subAgentWorkerClient.test.ts` pins
 * the contract so it cannot silently come back.
 *
 * @internal — only `runSubAgentInWorker` and tests should depend on
 * this shape.
 */
export function buildSubAgentWorkerMessages(
  prompt: string,
  parentMessages: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> {
  if (!parentMessages || parentMessages.length === 0) {
    return [{ role: 'user' as const, content: prompt }]
  }
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(parentMessages)
    }
    return JSON.parse(JSON.stringify(parentMessages)) as Array<
      Record<string, unknown>
    >
  } catch (err) {
    console.warn(
      '[subAgentWorkerClient] Failed to clone parentMessages; reusing original reference:',
      err instanceof Error ? err.message : String(err),
    )
    return parentMessages
  }
}

export async function runSubAgentInWorker(params: {
  config: ProviderConfig
  model: string
  agentDef: { agentType: string; maxTurns?: number; tools?: string[]; disallowedTools?: string[]; mcpServers?: string[] }
  prompt: string
  systemPrompt?: string
  parentMessages?: Array<Record<string, unknown>>
  signal: AbortSignal
  onEvent: (event: SubAgentEvent) => void
  /**
   * SA-3 fix 2 — fired the moment the worker run shows ANY tool activity
   * (a `tool_start` loop event or an RPC `tool_call`). The runner uses
   * this to decide whether an in-process fallback after a worker failure
   * is still safe: once a tool may have executed (especially a write),
   * re-running the whole sub-agent would duplicate side effects.
   */
  onToolActivity?: () => void
  /** P1-5: real agent id assigned by the registry; reported back in {@link SubAgentResult}. */
  agentId?: string
  /** P1-4: forwarded to the worker so iteration budget matches the in-process path. */
  maxIterationsOverride?: number
  /**
   * Sub-agent permission ctx (Phase 1B matrix item 4 of 5).
   *
   * The worker route previously hard-coded the per-tool RPC ctx to
   * `permissionMode:'default'` / `permissionDefaultMode:'ask'` with no
   * `permissionRules`. That meant a parent session that had toggled
   * `bypassPermissions` (or installed allow/deny rules) saw all of
   * those overrides silently dropped the moment a sub-agent was
   * dispatched through the worker pool. In-process sub-agents already
   * applied the parent ctx (see `runAgenticToolUseBody.ts` around
   * L1100); the three fields below close the gap.
   *
   * Note: these values flow through main-process function arguments
   * only — they do NOT cross the worker_threads boundary. The worker
   * receives the agentic loop's own `permissionDefaultMode` /
   * `permissionRules` via `SessionInit.params` (separate concern, used
   * inside the worker's own agentic loop). The RPC ctx fixed here is
   * what the main process uses when the worker calls back over RPC to
   * execute a tool via the main `toolRegistry`.
   */
  permissionMode?: ToolPermissionMode
  permissionDefaultMode?: ToolPermissionDefault
  permissionRules?: ReadonlyArray<PermissionRulePayload>
  /**
   * P0 audit fix — child sub-agent's gate-relevant ALS fields, forwarded
   * through to the host RPC handler so `gateSessionMemoryInternalAgentToolUse`
   * (and any other gate keyed off `sessionAgentType`) sees the **child**'s
   * identity instead of the parent's. Without these, worker-path
   * `session-memory-internal` scribes would bypass their single-file
   * sandbox because `getAgentContext()` on the host returns the parent's
   * context. See {@link runWithSubAgentRpcGateAsync} for the install
   * point.
   */
  sessionAgentType?: string
  sessionMemoryWritableTargetPath?: string
  /**
   * P1-2 (audit Bug-7 fix) — agent's declared default scheduling
   * priority, threaded into the worker's `AgentContext` via
   * `SessionInit.priority`. Without this, worker-bound sub-agents
   * (READONLY_AGENT_TYPES + POLE_AGENT_WORKER) silently lose their
   * `BACKGROUND` / `LOW` tagging when their tools enqueue into the
   * cross-agent scheduler / quota manager.
   */
  priority?: number
  /**
   * P1-2 (audit Bug-7 follow-up B7-B) — externally-registered parent
   * agentId. Used by the worker's ALS-scoped AgentContext so
   * `globalToolCallHistory.registerAgentLineage` and any cross-agent
   * sibling-isolation check inside the worker's fallback path see the
   * real lineage. The existing `agentId` param (P1-5) is the child's
   * registered id and is also now forwarded into SessionInit.
   */
  parentAgentId?: string
  /**
   * Worktree isolation — absolute path the worker should treat as its
   * workspace root (instead of the parent's global workspace path). Set for
   * `isolation: 'worktree'` agents so the worker's own module-level
   * `workspacePath` (and thus its file tools) operate inside the worktree.
   */
  workspaceOverride?: string
  /** Last parent-acknowledged snapshot when restarting a crashed worker. */
  initialTranscriptSnapshot?: import('../orchestration/kernelTypes').TranscriptSnapshot
}): Promise<SubAgentResult> {
  const {
    config,
    model,
    agentDef,
    prompt,
    systemPrompt,
    parentMessages,
    signal,
    onEvent,
    onToolActivity,
    agentId: externalAgentId,
    maxIterationsOverride,
    workspaceOverride,
    initialTranscriptSnapshot,
    permissionMode: rpcPermissionMode,
    permissionDefaultMode: rpcPermissionDefaultMode,
    permissionRules: rpcPermissionRules,
    sessionAgentType: rpcSessionAgentType,
    sessionMemoryWritableTargetPath: rpcSessionMemoryWritableTargetPath,
    priority: workerPriority,
    parentAgentId: workerParentAgentId,
  } = params
  const sessionId = `sub-${Date.now()}`
  const startTime = Date.now()
  // P1-5: prefer the real, externally-registered agent id (matches what
  // active-agent-registry / agentTool / IPC events use). Fall back to the
  // internal session id only when no external id is supplied (e.g. tests
  // that drive the worker directly).
  const effectiveAgentId = asAgentId(
    typeof externalAgentId === 'string' && externalAgentId.trim()
      ? externalAgentId.trim()
      : `agent-${sessionId}`,
  )

  // Resolve filtered tools for this agent.
  //
  // The local `agentDef` shape is a deliberately narrow projection (only the
  // fields needed to cross the worker boundary), but `resolveAgentTools`
  // wants the full `AgentDefinitionUnion`.  In practice the resolver only
  // reads `agentType`, `tools`, `disallowedTools`, and `mcpServers` — all of
  // which the projection already supplies — so a `unknown` bridge is the
  // type-safe way to say "trust me, the runtime fields the resolver touches
  // are present" without falling back to `any`.
  const tools = resolveAgentTools(agentDef as unknown as AgentDefinitionUnion)
  const toolDefs = tools.map((t: Tool) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))

  const messages = buildSubAgentWorkerMessages(prompt, parentMessages)

  const initPayload: InitPayload = {
    sessionId,
    ...(initialTranscriptSnapshot ? { initialTranscriptSnapshot } : {}),
    // Worktree isolation: prefer the per-agent worktree root when provided so
    // the worker's file tools resolve inside the worktree, not the shared
    // global workspace. Falls back to the global path for non-isolated agents.
    workspacePath: workspaceOverride ?? getWorkspacePath(),
    params: {
      // `SessionInitSchema.params.config` uses `.passthrough()`, which
      // bakes a `[x: string]: unknown` index signature into the inferred
      // type. `ProviderConfig` is a strict type without that index
      // signature, so the assignment requires a structural narrow. The
      // runtime payload is identical (and structured-clone-safe);
      // `as unknown as ...` is the standard idiom for this passthrough
      // mismatch and keeps the schema as the single source of truth.
      config: config as unknown as InitPayload['params']['config'],
      model,
      // `buildSubAgentWorkerMessages` returns the loose `Record<string,
      // unknown>[]` helper shape; runtime values are always
      // `{ role, content, ... }` (sourced from LoopMessage). Cast here
      // rather than tightening every caller of the helper — see the
      // helper's JSDoc for why its signature stays loose.
      messages: messages as unknown as InitPayload['params']['messages'],
      systemPrompt: systemPrompt,
      enableTools: true,
      // P1-4: forward the resolved iteration budget so the worker enforces
      // the same `FORK_SUBAGENT_MAX_ITERATIONS` / `agentDef.maxTurns` cap
      // the in-process path uses. Without this the worker silently runs
      // the agentic loop's hard-coded default.
      ...(typeof maxIterationsOverride === 'number'
        ? { maxIterationsOverride }
        : {}),
    },
    toolDefinitions: toolDefs,
    // Sub-agent settings parity (see SessionInitSchema.diskSettingsSnapshot).
    // Snapshot at spawn time — sub-agent worker runs are one-shot so there
    // is no live-update channel like the utility worker's
    // `postLiveSettingsSnapshot`.
    diskSettingsSnapshot: readDiskSettings(),
    // P1-2 (audit Bug-7 fix) — forward declared priority into the worker
    // so its AgentContext-scoped tool batches carry the right priority
    // when they enqueue into the cross-agent scheduler / quota manager.
    ...(typeof workerPriority === 'number' ? { priority: workerPriority } : {}),
    // Scheduler-drive: tell the worker whether to request accounting-only
    // admission (admit_request/admit_grant/admit_done) before executing its
    // LOCAL in-thread tools, so they participate in cross-agent holding.
    schedulerDrive: true,
    // P1-2 (audit Bug-7 follow-up B7-B) — forward the REAL agentId
    // (effectiveAgentId resolved from externalAgentId above) so the
    // worker's ALS-scoped AgentContext.agentId matches activeAgentRegistry,
    // not an internal `sub-<timestamp>` mismatch.
    agentId: effectiveAgentId,
    ...(workerParentAgentId
      ? { parentAgentId: workerParentAgentId }
      : {}),
    // SA-3 fix 4(b) — tell the worker WHO it is running as, so its
    // `execLocal` can refuse local tool execution for the sandboxed
    // session-memory-internal scribe (gate only exists in main).
    ...(rpcSessionAgentType ? { sessionAgentType: rpcSessionAgentType } : {}),
  }

  return new Promise<SubAgentResult>((resolve, _reject) => {
    // Worker-pool fast path (Pool.2): if `initSubAgentWorkerPool` has run
    // at bootstrap, acquire a pre-warmed Worker so the caller skips the
    // ~1.5-3.5s cold-start tax (Worker thread spawn + module-graph
    // import). The pool returns `null` when it's disabled or
    // exhausted — fall through to the legacy synchronous spawn so the
    // behaviour is identical when the pool isn't initialised (tests,
    // first-call before bootstrap, opt-out via `POLE_AGENT_WORKER_POOL=0`).
    const workerPath = resolveWorkerPath()
    let worker: Worker
    let workerFromPool = false
    const pool = getSubAgentWorkerPool()
    const pooled = pool?.acquire() ?? null
    if (pooled) {
      worker = pooled
      workerFromPool = true
    } else {
      try {
        worker = new Worker(workerPath)
      } catch (err) {
        resolve({
          success: false,
          agentId: effectiveAgentId,
          agentType: agentDef.agentType,
          output: `Failed to spawn sub-agent worker: ${err instanceof Error ? err.message : String(err)}`,
          totalTokens: 0,
          totalDurationMs: Date.now() - startTime,
          totalToolUses: 0,
        })
        return
      }
    }
    // A pool-supplied worker has ALREADY emitted `kind: 'ready'` and the
    // pool consumed that message. We need to trigger the same init path
    // the legacy "wait for ready" handler would have run. Send `init`
    // immediately. Fresh (non-pool) workers still receive their first
    // `init` via the `case 'ready': postMessage init` branch below.
    //
    // `initPosted` guards against the pool SLOW path: `pool.acquire()`
    // with no warm worker spawns a raw Worker that has NOT yet emitted
    // `ready`. We still post `init` eagerly here (workerFromPool=true),
    // and when the worker's late `ready` arrives the `case 'ready'`
    // branch below must NOT post a second `init` — the worker would
    // reply `fail: 'session already running'` and the fail handler
    // would tear down a perfectly healthy session.
    let initPosted = false
    const untrackActiveWorker = trackActiveSubAgentWorker(worker)
    if (workerFromPool) {
      initPosted = true
      try {
        worker.postMessage({ kind: 'init', payload: initPayload } satisfies ParentMessage)
      } catch (err) {
        resolve({
          success: false,
          agentId: effectiveAgentId,
          agentType: agentDef.agentType,
          output: `Failed to init pooled sub-agent worker: ${err instanceof Error ? err.message : String(err)}`,
          totalTokens: 0,
          totalDurationMs: Date.now() - startTime,
          totalToolUses: 0,
        })
        // Hand the worker back to the pool's terminator (one-shot model);
        // the pool's refill will replenish.
        untrackActiveWorker()
        pool?.release(worker)
        return
      }
    }

    const pending = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
    void pending
    const wctx = createWorkerRunCtx(taskRuntimeStore.getCursor(effectiveAgentId))
    let acceptedTranscript = initialTranscriptSnapshot
      ? structuredClone(initialTranscriptSnapshot)
      : createEmptyAcceptedTranscript()
    // P1-5: count actual tool-use events instead of misreporting `turnCount`
    // (turn != tool-use). Mirrors the in-process path's `totalToolUses`
    // counter that increments on every `subagent_tool_use` event.

    // Output text accumulation — must mirror the in-process path so the
    // shared `resolveSubAgentReportedOutputDetail` picks the same text.
    // The state machine (`outputText` / `lastFinalText` / per-turn window
    // / streaming-fallback rollback) lives in `WorkerOutputAccumulator`;
    // see that module's JSDoc for the per-event semantics and the audit
    // note on why `streaming_fallback` MUST roll the buffer back (the
    // worker path previously ignored that event and returned duplicated
    // "half old + full new" text to the parent agent).
    // `taskRuntimeStore` write cursor at the start of the current turn —
    // mirrors `taskCursorBeforeThisStream` in the in-process runner so a
    // streaming fallback can also rewind the persistent buffer that
    // `TaskOutput` reads (otherwise the parent's TaskOutput view keeps
    // the duplicated partial deltas even after we fix `outputText`).
    // `null` when no runtime record exists for this agent (e.g. direct
    // test callers that never seeded the store).

    // Read-only budget enforcement (Phase 1B matrix item 3 of 5).
    // Worker path previously had **no** budget caps at all, so
    // Explore/Plan/Verification sub-agents dispatched through the
    // worker pool could exceed the in-process path's 120-tool-call /
    // 120k-token contract by an order of magnitude before the loop's
    // `maxIterationsOverride` finally tripped.
    //
    //   - `outputTokTotal`     summed across every `message_end.usage`;
    //                          matches in-process `outputTokTotal`.
    //   - `latestInputTokens`  last seen `usage.inputTokens` (input is
    //                          conversation-level, not per-message).
    //   - `budgetAbortReason`  set the first time we trip a cap so the
    //                          parent agent can show a meaningful note;
    //                          subsequent trips are ignored.
    //
    // When a cap trips we send `{kind:'abort'}` to the worker — the
    // worker's `abortController` then short-circuits the agentic loop
    // which sends back `kind:'fail'`. The fail-path handler (below)
    // composes the final output using the same accumulated
    // `outputText`/`lastFinalText` so the parent agent sees a real
    // (partial) report rather than the placeholder
    // `Worker failed: ...` string.
    const readonlyAgent = READONLY_AGENT_TYPES.has(agentDef.agentType)
    // Latch so the `warning` sidechain entry only fires once per run
    // (in-process path uses the same idempotency rule at
    // `subAgentRunner.ts:onToolStart`).
    const sendBudgetAbort = (reason: string) => {
      if (wctx.budgetAbortReason) return
      wctx.budgetAbortReason = reason
      try {
        worker.postMessage({ kind: 'abort', reason } satisfies ParentMessage)
      } catch {
        // Worker may already be terminating; ignore — the fail/done
        // event still arrives via the message handler we own here.
      }
    }

    // Track the abort listener so cleanup() can detach it from the
    // caller-owned AbortSignal. With `{ once: true }` it auto-removes only
    // when fired; on normal completion the closure stays attached to the
    // signal and pins this worker's state until the signal itself is GC'd.
    let abortListener: (() => void) | null = null
    // Granted-but-not-yet-`admit_done` LOCAL tool admissions. `finish()`
    // releases any survivors so a worker that exits / crashes mid-tool doesn't
    // leak 'running' slots until the 120s reaper. Empty unless scheduler-drive
    // is on. Mutated only from main-thread message callbacks (no race).
    const cleanup = () => {
      untrackActiveWorker()
      worker.removeAllListeners('message')
      worker.removeAllListeners('error')
      worker.removeAllListeners('exit')
      if (abortListener) {
        try { signal.removeEventListener('abort', abortListener) } catch { /* noop */ }
        abortListener = null
      }
    }

    const finish = (result: SubAgentResult) => {
      if (wctx.done) return
      wctx.done = true
      cleanup()
      // Graceful shutdown. When the worker came from the pool, route the
      // termination through `pool.release()` so the pool can trigger an
      // async refill — keeps a hot standby ready for the next acquire.
      // Non-pool workers (fallback path / pool disabled) are terminated
      // directly with the same one-shot semantics as before.
      if (workerFromPool && pool) {
        pool.release(worker)
      } else {
        worker.terminate().catch(() => { /* noop */ })
      }
      // Free any LOCAL admission slots the worker never reported `admit_done`
      // for (abnormal exit / crash mid-tool) instead of waiting for the reaper.
      if (wctx.outstandingLocalAdmissions.size > 0) {
        for (const cleanupAbortListener of wctx.localAdmissionAbortCleanups.values()) {
          cleanupAbortListener()
        }
        wctx.localAdmissionAbortCleanups.clear()
        releaseOutstandingLocalAdmissions(wctx.outstandingLocalAdmissions)
        wctx.outstandingLocalAdmissions.clear()
      }
      if (wctx.outstandingRpcAdmissions.size > 0) {
        releaseOutstandingLocalAdmissions(
          wctx.outstandingRpcAdmissions,
          'subAgentWorker.rpc',
        )
        wctx.outstandingRpcAdmissions.clear()
      }
      resolve({
        ...result,
        transcriptSnapshot: structuredClone(acceptedTranscript),
      })
    }

    // Last-resort terminal resolve. The `done`/`fail` branches run result
    // assembly inside an async IIFE (so the host-side rescue can await). If
    // anything in that assembly throws, the IIFE's rejection would otherwise
    // be swallowed and `finish()` never called — stranding the parent agent
    // until its wall-clock budget fires. `finish()` is idempotent (wctx.done
    // guard), so the happy path that already resolved makes this a no-op.
    const finishWithAssemblyError = (stage: string, err: unknown): void => {
      finish({
        success: false,
        agentId: effectiveAgentId,
        agentType: agentDef.agentType,
        output: `Sub-agent result assembly failed (${stage}): ${err instanceof Error ? err.message : String(err)}`,
        totalTokens: wctx.latestInputTokens + wctx.outputTokTotal,
        tokenUsage: { input: wctx.latestInputTokens, output: wctx.outputTokTotal },
        totalDurationMs: Date.now() - startTime,
        totalToolUses: wctx.totalToolUses,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    const rpcDeps: WorkerRpcDeps = {
      worker, wctx, workerSessionId: initPayload.sessionId,
      effectiveAgentId, workerParentAgentId, workerPriority, signal,
      onToolActivity, rpcPermissionMode, rpcPermissionDefaultMode, rpcPermissionRules,
      rpcSessionAgentType, rpcSessionMemoryWritableTargetPath, agentDef,
    }

    // Host-side final-summary rescue for the worker path — parity with the
    // in-process runner (`subAgentRunner.ts`). Worker-dispatched read-only
    // agents (Explore / Plan / Verification) hit the token / tool-call budget
    // abort and previously returned only whatever partial text had streamed,
    // because the rescue ran ONLY in-process. Now the worker ships its live
    // transcript (`finalApiMessages`) back and we run ONE no-tool report turn
    // here so the parent receives a complete structured report instead of a
    // truncated fragment. Promotes the report into `outputAcc.lastFinalText`
    // so the shared `resolveSubAgentReportedOutputDetail` picks it up.
    const runWorkerRescueIfNeeded = async (opts: {
      finalApiMessages: Array<Record<string, unknown>> | undefined
      reachedMaxIterations: boolean
      aborted: boolean
      abortReason: string | undefined
    }): Promise<void> => {
      const transcript = opts.finalApiMessages
      if (!transcript || transcript.length === 0) return
      const budgetMs = resolveFinalSummaryRescueBudgetMs()
      const transcriptLastAssistantText = extractLastAssistantText(transcript)
      if (
        !shouldRunFinalSummaryRescue({
          reachedMaxIterations: opts.reachedMaxIterations,
          aborted: opts.aborted,
          lastFinalText: wctx.outputAcc.lastFinalText,
          ...(transcriptLastAssistantText !== undefined
            ? { transcriptLastAssistantText }
            : {}),
          apiMessageCount: transcript.length,
          parentSignalAborted: signal.aborted,
          budgetMs,
        })
      ) {
        return
      }
      const rescueReason: 'max_iterations' | 'aborted' = opts.reachedMaxIterations
        ? 'max_iterations'
        : 'aborted'
      appendSubAgentSidechain(effectiveAgentId, {
        kind: 'limit',
        summary: `final_summary_rescue(worker) start reason=${rescueReason} budgetMs=${budgetMs}`,
      })
      const rescue = await runSubAgentFinalSummaryRescue({
        config,
        model,
        systemPrompt: systemPrompt ?? '',
        apiMessages: transcript,
        reason: rescueReason,
        ...(opts.abortReason ? { abortReason: opts.abortReason } : {}),
        toolCallsMade: wctx.totalToolUses,
        parentSignal: signal,
        budgetMs,
        onTextDelta: (text) => {
          onEvent?.({ type: 'subagent_text', agentId: effectiveAgentId, text })
        },
        onStreamUsage: (usage) => {
          wctx.latestInputTokens = Math.max(wctx.latestInputTokens, usage.inputTokens)
          wctx.outputTokTotal += usage.outputTokens
        },
      })
      if (rescue.text) wctx.outputAcc.setRescueFinalText(rescue.text)
      appendSubAgentSidechain(effectiveAgentId, {
        kind: 'limit',
        summary:
          `final_summary_rescue(worker) ` +
          `${rescue.timedOut ? 'timeout' : rescue.errored ? 'error' : 'completed'} ` +
          `chars=${rescue.text.length} durationMs=${rescue.durationMs}`,
      })
    }

    worker.on('message', (raw: unknown) => {
      const msg = raw as Record<string, unknown>

      // Handle RPC tool call from worker
      if (msg.kind === 'tool_call') {
        handleWorkerToolCall(msg as unknown as WorkerToolCall, rpcDeps)
        return
      }

      // Scheduler-drive: admission for a worker's LOCAL (in-thread) tool. The
      // worker requests admission BEFORE executing the tool locally; we
      // register + hold + run the full quota admission here, then reply
      // `admit_grant` (worker executes, then reports `admit_done` → terminal)
      // or `admit_deny` (worker returns a synthetic error WITHOUT executing;
      // the slot is already marked terminal here).
      if (msg.kind === 'admit_request') {
        handleWorkerAdmitRequest(msg, rpcDeps)
        return
      }
      if (msg.kind === 'admit_done') {
        handleWorkerAdmitDone(msg, rpcDeps)
        return
      }

      const remoteMessage = parseRemoteHostWorkerMessage(raw)
      if (remoteMessage.ok) {
        if (remoteMessage.value.kind === 'transcript_commit') {
          const decision = acceptRemoteTranscriptCommit(
            acceptedTranscript,
            remoteMessage.value.snapshot,
          )
          if (decision.ok) {
            acceptedTranscript = decision.snapshot
            worker.postMessage({
              kind: 'transcript_ack',
              revision: remoteMessage.value.snapshot.revision,
              accepted: true,
            } satisfies ParentMessage)
          } else {
            worker.postMessage({
              kind: 'transcript_ack',
              revision: remoteMessage.value.snapshot.revision,
              accepted: false,
              actualRevision: decision.actualRevision,
              reason: decision.reason,
            } satisfies ParentMessage)
          }
        }
        return
      }

      const typed = msg as WorkerMessage
      switch (typed.kind) {
        case 'ready':
          // Skip when the eager pool-path init already went out (slow-path
          // pool worker emitting its late `ready`) — see `initPosted` doc
          // at the spawn site above.
          if (!initPosted) {
            initPosted = true
            worker.postMessage({ kind: 'init', payload: initPayload } satisfies ParentMessage)
          }
          break
        case 'started':
          break
        case 'event': {
          handleWorkerLoopEvent(typed.event as LoopEvent, {
            wctx, onEvent, onToolActivity, effectiveAgentId, agentDef, readonlyAgent, sendBudgetAbort,
          })
          break
        }
        case 'winddown': {
          // Record for `SubAgentResult.windDown` (parity with in-process
          // `ctx.windDown`) AND re-emit as the typed renderer event.
          wctx.windDown = {
            trigger: typed.trigger,
            ...(typeof typed.iteration === 'number' ? { iteration: typed.iteration } : {}),
            ...(typeof typed.maxIterations === 'number'
              ? { maxIterations: typed.maxIterations }
              : {}),
          }
          onEvent?.(windDownMessageToSubAgentEvent(effectiveAgentId, typed))
          break
        }
        case 'done': {
          const result = typed.result
          // Sub-agent path parity: feed the same `resolveSubAgentReportedOutputDetail`
          // the in-process path uses (see `subAgentRunner.ts` around L1483)
          // so the parent agent receives the model's actual final text — not
          // a placeholder. `reachedMaxIterations` is derived from the
          // termination reason; aborted/abortReason are best-effort —
          // worker-side abort plumbing currently doesn't surface a reason
          // string through `AgenticLoopResult`.
          // `TerminationReason` uses the legacy `max_turns` literal for what
          // the agentic loop tracks as `reachedMaxIterations` (the
          // `LoopEvent.max_iterations` event corresponds 1:1 to this reason).
          const reachedMaxIterations = result.terminationResult.reason === 'max_turns'
          const doneFinalApiMessages =
            typed.finalApiMessages ?? acceptedTranscript.messages
          void (async () => {
          try {
          // Root-cause fix: run the host-side final-summary rescue (no-op when
          // a clean tool-free final turn already exists) so a budget-aborted /
          // max-iterations worker run returns a COMPLETE report, not a
          // truncated fragment. Async IIFE — `finish()` resolves the outer
          // promise once the (optional) rescue + result assembly complete.
          await runWorkerRescueIfNeeded({
            finalApiMessages: doneFinalApiMessages,
            reachedMaxIterations,
            aborted: signal.aborted || wctx.budgetAbortReason !== null,
            abortReason: wctx.budgetAbortReason ?? undefined,
          })
          // Parity with in-process: when the rescue was skipped because the
          // transcript already carries a usable assistant text block, prefer
          // it over the full `outputText` blob (resolver's 2nd-priority tier).
          const doneTranscriptLastText = extractLastAssistantText(doneFinalApiMessages)
          const reportedOutput = resolveSubAgentReportedOutputDetail({
            lastFinalText: wctx.outputAcc.lastFinalText,
            ...(doneTranscriptLastText !== undefined
              ? { transcriptLastAssistantText: doneTranscriptLastText }
              : {}),
            outputText: wctx.outputAcc.outputText,
            reachedMaxIterations,
            aborted: signal.aborted || wctx.budgetAbortReason !== null,
            ...(wctx.budgetAbortReason ? { abortReason: wctx.budgetAbortReason } : {}),
          })
          // P1 audit fix: align `success` with the in-process path
          // (`subAgentRunner.ts` ~L1526 — `!effectiveLoopSignal.aborted &&
          // !reachedMaxIterations`). The previous worker-path check was
          // `budgetAbortReason === null`, which silently reported `success:
          // true` for `max_turns` terminations and parent-aborted runs, so
          // `agentTool` / `teamAutoLauncher` etc. treated incomplete runs
          // as successful and injected partial output as "the answer".
          // See {@link deriveWorkerSubAgentSuccess} for the canonical
          // decision rule (unit-tested).
          const subAgentResult: SubAgentResult = {
            success: deriveWorkerSubAgentSuccess({
              signalAborted: signal.aborted,
              budgetAbortReason: wctx.budgetAbortReason,
              reachedMaxIterations,
              // Output-aware relaxation (parity with in-process): a run that
              // hit an iteration / token budget but still committed a usable
              // final report (directly, via wind-down, or via the rescue turn
              // above which promotes into `outputAcc.lastFinalText`) succeeds.
              producedReport: subAgentProducedUsableReport({
                lastFinalText: wctx.outputAcc.lastFinalText,
                ...(doneTranscriptLastText !== undefined
                  ? { transcriptLastAssistantText: doneTranscriptLastText }
                  : {}),
              }),
            }),
            agentId: effectiveAgentId,
            agentType: agentDef.agentType,
            output: reportedOutput.body,
            totalTokens: result.totalUsage.inputTokens + result.totalUsage.outputTokens,
            tokenUsage: {
              input: result.totalUsage.inputTokens,
              output: result.totalUsage.outputTokens,
            },
            totalDurationMs: Date.now() - startTime,
            totalToolUses: wctx.totalToolUses,
            reachedMaxIterations,
            ...(wctx.budgetAbortReason
              ? { aborted: true, abortReason: wctx.budgetAbortReason, truncated: true }
              : {}),
            ...(reportedOutput.charTruncated
              ? {
                  outputCharTruncated: true,
                  outputOriginalCharCount: reportedOutput.originalCharCount,
                }
              : {}),
            ...(wctx.windDown ? { windDown: wctx.windDown } : {}),
          }
          // Sidechain `complete` entry mirroring the in-process path
          // (`subAgentRunner.ts` around L1430). `terminationResult.reason`
          // is the same enum the in-process path reads.
          appendSubAgentSidechain(effectiveAgentId, {
            kind: 'complete',
            summary: `success=${subAgentResult.success} tools=${wctx.totalToolUses} reason=${result.terminationResult.reason ?? 'n/a'}`,
          })
          // Emit `subagent_complete` so the renderer can flip the
          // AgentBlock status from `running` → `completed` (the in-process
          // path emits this from `subAgentRunner.ts`; the worker path
          // previously skipped it, leaving the UI permanently stuck on a
          // running spinner even after the agent finished).
          onEvent?.({
            type: 'subagent_complete',
            agentId: effectiveAgentId,
            result: subAgentResult,
          })
          finish(subAgentResult)
          } catch (e) {
            finishWithAssemblyError('done', e)
          }
          })()
          break
        }
        case 'fail': {
          // Budget abort lands here (worker `abortController.abort()` →
          // loop throws → worker sends `kind:'fail'`). Compose the final
          // output from accumulated text, identical to the in-process
          // catch path in `subAgentRunner.ts` (around L1559). Without
          // this, even a budget-tripped sub-agent that produced a
          // legitimate partial report would be reduced to the placeholder
          // `Worker failed: ...` string at the parent agent.
          const aborted = signal.aborted || wctx.budgetAbortReason !== null
          const abortReason = wctx.budgetAbortReason ?? (typed.error || undefined)
          const failFinalApiMessages = typed.finalApiMessages
          void (async () => {
          try {
          // Root-cause fix (worker parity): budget-abort fails land here with
          // only partial streamed text. Run the host-side rescue so the parent
          // receives a COMPLETE report instead of a truncated fragment (no-op
          // for genuine non-abort errors — the rescue gate requires
          // aborted || reachedMaxIterations).
          await runWorkerRescueIfNeeded({
            finalApiMessages: failFinalApiMessages,
            reachedMaxIterations: false,
            aborted,
            abortReason,
          })
          const failTranscriptLastText = extractLastAssistantText(failFinalApiMessages)
          const failOutput = resolveSubAgentReportedOutputDetail({
            lastFinalText: wctx.outputAcc.lastFinalText,
            ...(failTranscriptLastText !== undefined
              ? { transcriptLastAssistantText: failTranscriptLastText }
              : {}),
            outputText: wctx.outputAcc.outputText,
            reachedMaxIterations: false,
            aborted,
            ...(abortReason ? { abortReason } : {}),
          })
          const errMessage = String(typed.error || 'Worker failed')
          const errParts = [errMessage.trim(), failOutput.body.trim()].filter(Boolean)
          const failResult: SubAgentResult = {
            success: false,
            agentId: effectiveAgentId,
            agentType: agentDef.agentType,
            output: errParts.join('\n\n') || errMessage,
            totalTokens: wctx.latestInputTokens + wctx.outputTokTotal,
            tokenUsage: { input: wctx.latestInputTokens, output: wctx.outputTokTotal },
            totalDurationMs: Date.now() - startTime,
            totalToolUses: wctx.totalToolUses,
            error: errMessage,
            ...(aborted ? { aborted: true } : {}),
            ...(abortReason ? { abortReason } : {}),
            ...(wctx.budgetAbortReason ? { truncated: true } : {}),
            ...(failOutput.charTruncated
              ? {
                  outputCharTruncated: true,
                  outputOriginalCharCount: failOutput.originalCharCount,
                }
              : {}),
          }
          // Sidechain `error` entry mirroring the in-process path
          // (`subAgentRunner.ts` around L1448). Budget-triggered fails
          // still get the error entry — the leading 300 chars carry
          // enough context for downstream debug consumers.
          appendSubAgentSidechain(effectiveAgentId, {
            kind: 'error',
            summary: errMessage.slice(0, 300),
          })
          onEvent?.({
            type: 'subagent_error',
            agentId: effectiveAgentId,
            error: errMessage,
          })
          // Audit Medium fix: also emit `subagent_complete` so the
          // renderer's AgentBlock flips from `running` → `completed`
          // (with `success: false`). The in-process path emits both
          // `subagent_error` AND `subagent_complete` from its
          // catch/finally; the worker path previously emitted only
          // `subagent_error`, leaving the AgentBlock stuck on a running
          // spinner for fail / budget-abort outcomes.
          onEvent?.({
            type: 'subagent_complete',
            agentId: effectiveAgentId,
            result: failResult,
          })
          finish(failResult)
          } catch (e) {
            finishWithAssemblyError('fail', e)
          }
          })()
          break
        }
        case 'log':
          // Silently ignore worker logs
          break
        default:
          break
      }
    })

    worker.on('error', (err) => {
      // Audit Medium fix: include accumulated token usage so a worker
      // crash mid-run doesn't reset the parent's bookkeeping to zero.
      // Previously `totalTokens: 0` here desynced the in-process and
      // worker error paths' usage reporting (parent agents saw "free"
      // failed runs).
      const errResult: SubAgentResult = {
        success: false,
        agentId: effectiveAgentId,
        agentType: agentDef.agentType,
        output: `Worker error: ${err.message}`,
        totalTokens: wctx.latestInputTokens + wctx.outputTokTotal,
        tokenUsage: { input: wctx.latestInputTokens, output: wctx.outputTokTotal },
        totalDurationMs: Date.now() - startTime,
        totalToolUses: wctx.totalToolUses,
        error: err.message,
      }
      onEvent?.({
        type: 'subagent_error',
        agentId: effectiveAgentId,
        error: `Worker error: ${err.message}`,
      })
      onEvent?.({
        type: 'subagent_complete',
        agentId: effectiveAgentId,
        result: errResult,
      })
      finish(errResult)
    })

    worker.on('exit', (code) => {
      if (!wctx.done) {
        const exitMsg = `Worker exited with code ${code}`
        const exitResult: SubAgentResult = {
          success: false,
          agentId: effectiveAgentId,
          agentType: agentDef.agentType,
          output: exitMsg,
          totalTokens: wctx.latestInputTokens + wctx.outputTokTotal,
          tokenUsage: { input: wctx.latestInputTokens, output: wctx.outputTokTotal },
          totalDurationMs: Date.now() - startTime,
          totalToolUses: wctx.totalToolUses,
          error: exitMsg,
        }
        onEvent?.({
          type: 'subagent_error',
          agentId: effectiveAgentId,
          error: exitMsg,
        })
        onEvent?.({
          type: 'subagent_complete',
          agentId: effectiveAgentId,
          result: exitResult,
        })
        finish(exitResult)
      }
    })

    // Handle abort
    abortListener = () => {
      if (!wctx.done) {
        worker.postMessage({ kind: 'abort', reason: 'Parent aborted' } satisfies ParentMessage)
        // Grace period before force kill. Route pool-supplied workers
        // through `pool.release` so the pool can refill regardless of
        // whether the worker exited via graceful abort or force kill.
        setTimeout(() => {
          if (!wctx.done) {
            if (workerFromPool && pool) {
              pool.release(worker)
            } else {
              worker.terminate().catch(() => { /* noop */ })
            }
          }
        }, 2000)
      }
    }
    signal.addEventListener('abort', abortListener, { once: true })
  })
}

/** Check if the sub-agent worker is available. */
export function subAgentWorkerAvailable(): boolean {
  try {
    const wp = resolveWorkerPath()
    return fs.existsSync(wp)
  } catch {
    return false
  }
}
