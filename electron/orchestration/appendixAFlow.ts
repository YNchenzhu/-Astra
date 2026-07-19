/**
 * 附录 A：核心数据流 — Electron 等价阶段 ID 与遥测（doc/系统工作流编排深度分析报告.txt）。
 * 架构与 Ink REPL 不同：阶段在 `handleSendMessage` + `runAgenticLoop` 锚点上报，语义对齐报告阶段二 queryLoop（粗粒度 + 可扩展细粒度）。
 *
 * `P0_*` stages are bootstrap-only (logged via console.debug; not on the session IPC stream).
 */

/** 报告「阶段零」— 无会话流时仅主进程结构化日志（附录 A L933–970 等价锚点）。 */
export type AppendixABootstrapStageId =
  | 'P0_app_when_ready'
  | 'P0_ipc_handlers_registered'
  | 'P0_agent_tools_initialized'

/** 报告「阶段一」— 桌面端入口与路由提示（附录 A L973–1049）。 */
export type AppendixAStagePhase1 =
  | 'P1_send_message_entry'
  | 'P1_route_text_prompt'
  | 'P1_route_slash_like'

/**
 * 报告「阶段二：queryLoop」在 `runAgenticLoop` 内的等价锚点。
 */
export type AppendixAQueryLoopStageId =
  | 'P2_Q_iteration_open'
  | 'P2_Q_command_queue_drain'
  | 'P2_Q_inter_agent_inject'
  /**
   * @deprecated Emitted only by the deleted 80%-iteration wrap-up
   * directive injectors. Kept in the union so dashboards parsing
   * historical transcripts don't break; no live emitter remains.
   * See `P2_Q_compaction_reminder` for the upstream-aligned replacement.
   */
  | 'P2_Q_subagent_stop_directive'
  /**
   * upstream-style `compaction_reminder` injection — fires once per
   * session on the main chat when context usage crosses 50% of the
   * effective window. Body reassures the model that auto-compaction
   * will handle context pressure, so it should not rush or summarise
   * prematurely (opposite of the deleted wrap-up directives).
   */
  | 'P2_Q_compaction_reminder'
  | 'P2_Q_skill_discovery_prefetch'
  | 'P2_Q_preprocess_pipeline'
  | 'P2_Q_query_tracking_attach'
  | 'P2_Q_stream_request_start'
  | 'P2_Q_stream_request_api'
  | 'P2_Q_stream_complete'
  | 'P2_Q_stream_idle_warning'
  | 'P2_Q_stream_idle_abort'
  | 'P2_Q_stream_stall'
  | 'P2_Q_prompt_cache_break'
  | 'P2_Q_max_output_recovery'
  | 'P2_Q_context_length_reactive'
  // Lightweight drain-only recovery layer (collapse_drain transition) — fires
  // before the full reactive_compact path; distinguished so dashboards can
  // separate the free drain layer from the LLM-call compact layer.
  | 'P2_Q_context_length_drain_only_recovery'
  | 'P2_Q_no_tools_branch'
  // Token-delta stall guard fired inside the no-tool-use branch and
  // terminated the loop. Reported once per stall termination.
  | 'P2_Q_iteration_stalled'
  | 'P2_Q_stop_hooks'
  | 'P2_Q_decide_after_no_tool_use'
  | 'P2_Q_tools_partition_execute'
  | 'P2_Q_tool_results_user_message'
  | 'P2_Q_post_tool_context_manage'
  | 'P2_Q_loop_continue'
  // Recovery / fallback stages reported from `agenticLoop/stream.ts`.
  | 'P2_Q_anthropic_overload_fallback'
  // Audit fix (2026-06, P1) — per-iteration model-call budget tripped; no
  // further stream attempts are made this iteration (see stream.ts
  // POLE_MAX_MODEL_ATTEMPTS_PER_ITERATION).
  | 'P2_Q_model_call_budget_exhausted'
  | 'P2_Q_strip_retry_image'

/** 报告「阶段三：runTools」— 工具编排细分（附录 A L1441+）。 */
export type AppendixAToolOrchestrationStageId =
  | 'P3_tool_partition_done'
  | 'P3_tool_batch_serial'
  | 'P3_tool_batch_parallel'
  | 'P3_tool_batch_complete'
  | 'P3_tool_repeat_block'
  | 'P3_tool_repeat_hint'
  // Repetition guard — cross-agent consecutive-identical-call detector.
  // Fires independent of the failure-driven `P3_tool_repeat_*` stages so
  // dashboards can distinguish "AI is in a no-op loop" (repetition) from
  // "AI keeps retrying a failing call" (repeat).
  | 'P3_tool_repetition_warn'
  | 'P3_tool_repetition_halt'

export type AppendixAStageId =
  | AppendixABootstrapStageId
  | AppendixAStagePhase1
  | AppendixAQueryLoopStageId
  | AppendixAToolOrchestrationStageId

/** IPC payload — 与 renderer `StreamEvent` 对齐；避免从 `streamHandler` 回引造成环依赖。 */
export type AppendixAStreamPayload = {
  type: 'orchestration_phase'
  conversationId?: string
  orchestrationPhase?: string
  /** outer turn counter (from kernel `KernelLoopState.iteration`). */
  orchestrationIteration?: number
  /** inner model-call counter within the current outer turn. */
  orchestrationInnerIteration?: number
  appendixAStage: AppendixAStageId
  appendixADocRef: string
  appendixADetail?: Record<string, unknown>
}


const BOOTSTRAP_STAGES = new Set<AppendixAStageId>([
  'P0_app_when_ready',
  'P0_ipc_handlers_registered',
  'P0_agent_tools_initialized',
])

/**
 * 跨阶段治理 — runtime-only stage id: anything a regular `AppendixAFlowReporter.report` call may
 * emit. P0 bootstrap stages are structurally excluded so callers who only have a reporter in hand
 * cannot accidentally emit a bootstrap stage via IPC (the right channel is
 * {@link logAppendixABootstrapPhase}).
 */
export type AppendixARuntimeStageId = Exclude<AppendixAStageId, AppendixABootstrapStageId>

export type AppendixAFlowReporter = {
  report(stage: AppendixARuntimeStageId, detail?: Record<string, unknown>): void
}

/**
 * optional hook a reporter can call each emission to fetch the current outer/inner
 * iteration counters from the owning kernel. Injected by `createAppendixAFlowReporter` callers
 * that live alongside the kernel.
 */
export type AppendixAIterationGetter = () => {
  outer: number
  inner: number
}

/**
 * Default-on in development, default-off in packaged builds.
 *
 * Rationale: the AppendixA flow stages (`P2_Q_*`, `P3_*`, …) drive the
 * renderer-side phase indicator and the per-iteration timeline that powers
 * `mainStreamRouter`'s `orchestration_phase` reducer. In dev these are
 * essential for debugging the orchestration kernel; in packaged builds
 * they cost ~8–15 IPC messages per turn and ship telemetry that production
 * users don't need (yet). Env override wins either way:
 *
 *   - `POLE_APPENDIX_A_FLOW=0|false|no`       → force off
 *   - `POLE_APPENDIX_A_FLOW=1|true|yes|on`    → force on
 *   - unset, packaged                          → off
 *   - unset, dev / vitest / non-electron host  → on
 */
export function isAppendixAFlowTelemetryEnabled(): boolean {
  const v = process.env.POLE_APPENDIX_A_FLOW?.trim().toLowerCase()
  if (v === '0' || v === 'false' || v === 'no') return false
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron')
    if (typeof app?.isPackaged === 'boolean' && app.isPackaged) return false
  } catch {
    /* vitest / non-electron */
  }
  return true
}

/**
 * 阶段零：无 `conversationId` 流通道时写入结构化 debug 行（主进程）。
 */
export function logAppendixABootstrapPhase(
  stage: AppendixABootstrapStageId,
  detail?: Record<string, unknown>,
): void {
  if (!isAppendixAFlowTelemetryEnabled()) return
  try {
    const line = {
      type: 'appendix_a_bootstrap',
      stage,
      appendixADocRef: stage,
      ...(detail && Object.keys(detail).length > 0 ? { appendixADetail: detail } : {}),
    }
    console.debug('[appendix_a]', JSON.stringify(line))
  } catch {
    /* ignore */
  }
}

/**
 * Emits `orchestration_phase` with `appendixAStage` / `appendixADocRef` for UI or log consumers.
 * P0_* stages must use {@link logAppendixABootstrapPhase} instead (no IPC stream).
 *
 * pass `iterationGetter` so every payload is stamped with the current outer/inner
 * counters; downstream log consumers can then correlate `P2_Q_*` events with the owning turn.
 */
export function createAppendixAFlowReporter(
  emit: (ev: AppendixAStreamPayload) => void,
  conversationId?: string,
  iterationGetter?: AppendixAIterationGetter,
): AppendixAFlowReporter {
  return {
    report(stage: AppendixARuntimeStageId, detail?: Record<string, unknown>) {
      // 跨阶段治理 — type system already excludes P0_* via `AppendixARuntimeStageId`, but keep a
      // defensive runtime guard for legacy `any` call sites that bypass the type check.
      if (BOOTSTRAP_STAGES.has(stage as AppendixAStageId)) {
        if (process.env.NODE_ENV !== 'test') {
          console.debug('[appendixAFlow] P0_* use logAppendixABootstrapPhase:', stage)
        }
        return
      }
      try {
        const iterFields: {
          orchestrationIteration?: number
          orchestrationInnerIteration?: number
        } = {}
        if (iterationGetter) {
          try {
            const it = iterationGetter()
            if (it && typeof it.outer === 'number') {
              iterFields.orchestrationIteration = it.outer
            }
            if (it && typeof it.inner === 'number') {
              iterFields.orchestrationInnerIteration = it.inner
            }
          } catch {
            /* ignore getter failures */
          }
        }
        emit({
          type: 'orchestration_phase',
          ...(conversationId?.trim() ? { conversationId: conversationId.trim() } : {}),
          orchestrationPhase: 'appendix_a',
          appendixAStage: stage,
          appendixADocRef: stage,
          appendixADetail: detail,
          ...iterFields,
        })
      } catch {
        /* ignore */
      }
    },
  }
}
