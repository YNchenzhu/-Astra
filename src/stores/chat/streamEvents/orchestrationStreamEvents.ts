/**
 * `orchestration_phase` kernel-telemetry dispatch split out of
 * `mainStreamRouter.ts`. Each phase tag lands on a dedicated store field that
 * downstream UI subscribes to; the active conversation also gets a top-level
 * `ChatState` mirror so the UI doesn't re-read `currentConversationId` per render.
 */
import type { StreamEvent } from '../../../types'
import type { OrchestrationKernelDiagnostic } from '../types'
import type { MainRouterContext } from './mainRouterShared'
import type { TerminationReason } from '../../../../shared/terminationReasons'

// Contract audit (2026-07) — bounded buffer for user-visible kernel
// diagnostics; same rationale as permissionDenials (toast strip may be
// unmounted, so the array must not grow forever).
const MAX_KERNEL_DIAGNOSTICS = 30
function capKernelDiagnostics(
  arr: OrchestrationKernelDiagnostic[],
): OrchestrationKernelDiagnostic[] {
  return arr.length > MAX_KERNEL_DIAGNOSTICS
    ? arr.slice(arr.length - MAX_KERNEL_DIAGNOSTICS)
    : arr
}

export type TranscriptDriftDetail = {
  agentContextLength: number
  kernelTranscriptLength: number
  resolvedWith: 'agent_context' | 'kernel'
  checkpoint?: 'terminal_commit' | 'iteration_boundary'
  agentContextFingerprintPrefix?: string
  kernelFingerprintPrefix?: string
}

export function formatTranscriptDriftDetail(d: TranscriptDriftDetail): string {
  const checkpoint = d.checkpoint === 'iteration_boundary' ? '迭代边界检测到' : '本轮收尾时'
  const mismatch =
    d.agentContextLength === d.kernelTranscriptLength
      ? '会话记录内容指纹不一致'
      : '会话记录消息数量不一致'
  return (
    `${checkpoint}${mismatch}` +
    `（AgentContext ${d.agentContextLength} 条 vs 内核 ${d.kernelTranscriptLength} 条），` +
    `以 ${d.resolvedWith === 'agent_context' ? 'AgentContext' : '内核'} 一侧为准`
  )
}

export function handleOrchestrationPhaseEvent({ event, convId, st0, apply }: MainRouterContext): void {
  // Phase payload shape mirrors `OrchestrationPhasePayload` in
  // `electron/orchestration/ports.ts` (forwarded through
  // `buildPhaseStreamEvent`). Casting once at the top so the per-tag
  // branches below stay terse.
  const ev = event as StreamEvent & {
    orchestrationPhase?: string
    orchestrationIteration?: number
    orchestrationInnerIteration?: number
    interruptReason?: string
    permissionDenial?: {
      toolName: string
      toolUseId: string
      reason: string
      matchedRule?: string
    }
    artifactManifest?: {
      turn: number
      entries: Array<{
        id: string
        kind: string
        label?: string
        producer: string
        producerTurn?: number
        producerInnerTurn?: number
        payload: Record<string, unknown>
        at: number
      }>
    }
    // Bug B fix — renamed from `_hitl` to `hitlPending` to match the
    // typed field added to `OrchestrationPhasePayload`. The legacy
    // `_hitl` cast was dropped by `buildPhaseStreamEvent`.
    hitlPending?: { toolUseId: string; question: unknown; kind: string }
    // Audit P1 §5.2 — `tool_preempted` payload (forwarded by transport.ts).
    preemption?: {
      victimToolUseId: string
      victimToolName?: string
      incomingToolUseId: string
      incomingToolName: string
      resource: 'shell' | 'network' | 'mutation'
      victimPriority?: number
      incomingPriority: number
    }
    // Audit P2-1 — `hitl_persistence_failed` payload.
    hitlPersistenceFailed?: {
      reason: 'disk_error' | 'cleanup_failed'
      error: string
      pendingHumanResumeCount: number
    }
    // Audit P2-2 — `transcript_clone_degraded` payload.
    transcriptCloneDegraded?: {
      mode: 'json' | 'frozen-shared'
      error: string
      secondaryError?: string
      messageCount: number
      occurrenceCount?: number
    }
    // Audit P2-1 — `outer_loop_complete` payload.
    outerLoopStats?: {
      iterations: number
      overflowed: boolean
      exitReason: 'completed' | 'aborted' | 'overflow' | 'error'
      terminationReason?: TerminationReason
      inboxRemaining: number
      maxOuterIterations: number
    }
    // Contract audit (2026-07) — `transcript_drift` payload.
    transcriptDrift?: TranscriptDriftDetail
    transcriptConflict?: {
      source: string
      expectedRevision: number
      actualRevision: number
      incomingFingerprintPrefix: string
      currentFingerprintPrefix: string
    }
    // Contract audit (2026-07) — `scheduler_backpressure` payload (tool
    // entered a scheduler hold / quota backpressure wait).
    schedulerBackpressure?: {
      toolName: string
      toolUseId: string
      kind: 'scheduler_hold' | 'quota_backpressure'
      reason?: string
      waitedMs?: number
    }
  }
  const phase = ev.orchestrationPhase
  if (!phase) return
  const isActive = convId === st0.currentConversationId
  switch (phase) {
    case 'PrepareContext':
    case 'CallModel':
    case 'Terminal':
    case 'Error': {
      const iter = ev.orchestrationIteration ?? 0
      const innerIter = ev.orchestrationInnerIteration ?? 0
      apply(
        (sl) => ({
          ...sl,
          orchestrationPhase: phase,
          orchestrationIteration: iter,
          orchestrationInnerIteration: innerIter,
        }),
        isActive
          ? {
              orchestrationPhase: phase,
              orchestrationIteration: iter,
              orchestrationInnerIteration: innerIter,
            }
          : undefined,
      )
      break
    }
    case 'paused': {
      apply(
        (sl) => ({ ...sl, orchestrationPaused: true }),
        isActive ? { orchestrationPaused: true } : undefined,
      )
      break
    }
    case 'resumed': {
      apply(
        (sl) => ({ ...sl, orchestrationPaused: false }),
        isActive ? { orchestrationPaused: false } : undefined,
      )
      break
    }
    case 'interrupt': {
      // HITL pause — the `hitlPending` payload (toolUseId / question / kind)
      // is emitted alongside `interruptReason: 'hitl'` from
      // `electron/ai/agenticLoop/toolExec.ts` and drives the AskUserQuestion
      // pause slot.
      if (ev.interruptReason === 'hitl' && ev.hitlPending) {
        const hitl = ev.hitlPending
        apply(
          (sl) => ({ ...sl, hitlPaused: hitl }),
          isActive ? { hitlPaused: hitl } : undefined,
        )
        break
      }
      // P0-3 — every OTHER interrupt reason (`user`, `timeout`, `superseded`,
      // `fork_replaced`, `shutdown`, `<reason>:hard`, `<reason>:grace_expired`)
      // used to fall through silently. Surface a lightweight transient toast
      // so a mid-turn cancel / supersede / shutdown has a visible cause.
      const reason = ev.interruptReason
      if (!reason) break
      const now = Date.now()
      const notice = { reason, id: `${reason}:${now}`, at: now }
      // Same bounded-buffer rationale as permissionDenials/toolPreemptions.
      const MAX_NOTICES = 30
      const cap = (arr: typeof notice[]) =>
        arr.length > MAX_NOTICES ? arr.slice(arr.length - MAX_NOTICES) : arr
      apply(
        (sl) => ({ ...sl, interruptNotices: cap([...(sl.interruptNotices ?? []), notice]) }),
        isActive ? { interruptNotices: cap([...st0.interruptNotices, notice]) } : undefined,
      )
      break
    }
    case 'rewound': {
      // Restored to a prior checkpoint — reset the UI phase tracker.
      apply(
        (sl) => ({ ...sl, orchestrationPhase: 'PrepareContext' }),
        isActive ? { orchestrationPhase: 'PrepareContext' } : undefined,
      )
      break
    }
    case 'permission_denied_preflight': {
      if (!ev.permissionDenial) break
      const denial = { ...ev.permissionDenial, at: Date.now() }
      // Bug G fix — cap denial buffer per conversation. PreflightDenialToast
      // auto-dismisses after 5s when mounted, but if the toast UI is
      // unmounted (different tab / chat hidden) denials would accumulate
      // unbounded. 50 is high enough to never truncate a legitimate
      // "policy blocked many tools in one batch" scenario yet keeps memory
      // bounded across long sessions.
      const MAX_DENIALS = 50
      const capped = (arr: typeof denial[]) =>
        arr.length > MAX_DENIALS ? arr.slice(arr.length - MAX_DENIALS) : arr
      apply(
        (sl) => ({
          ...sl,
          permissionDenials: capped([...(sl.permissionDenials ?? []), denial]),
        }),
        isActive
          ? { permissionDenials: capped([...st0.permissionDenials, denial]) }
          : undefined,
      )
      break
    }
    case 'artifact_manifest': {
      if (!ev.artifactManifest) break
      const manifest = ev.artifactManifest
      // Bug G fix — cap manifests buffer per conversation. Same rationale
      // as permissionDenials: ArtifactDrawer might be closed for a long
      // session, but the kernel keeps producing manifests on every Terminal
      // phase. Manifests can be larger than denials (carry artifact entries)
      // so we cap lower.
      const MAX_MANIFESTS = 20
      const capManifest = (arr: typeof manifest[]) =>
        arr.length > MAX_MANIFESTS ? arr.slice(arr.length - MAX_MANIFESTS) : arr
      apply(
        (sl) => ({
          ...sl,
          artifactManifests: capManifest([...(sl.artifactManifests ?? []), manifest]),
        }),
        isActive
          ? { artifactManifests: capManifest([...st0.artifactManifests, manifest]) }
          : undefined,
      )
      break
    }
    case 'tool_preempted': {
      // Audit P1 §5.2 — a higher-priority tool preempted a running one.
      // Surfaced as an amber info toast by `PreflightDenialToast`.
      if (!ev.preemption) break
      const p = ev.preemption
      const entry = {
        ...p,
        id: `${p.victimToolUseId}->${p.incomingToolUseId}`,
        at: Date.now(),
      }
      // Same bounded-buffer rationale as permissionDenials: the toast strip
      // may be unmounted (hidden tab), so cap to keep memory bounded.
      const MAX_PREEMPTIONS = 50
      const cap = (arr: typeof entry[]) =>
        arr.length > MAX_PREEMPTIONS ? arr.slice(arr.length - MAX_PREEMPTIONS) : arr
      apply(
        (sl) => ({ ...sl, toolPreemptions: cap([...(sl.toolPreemptions ?? []), entry]) }),
        isActive ? { toolPreemptions: cap([...st0.toolPreemptions, entry]) } : undefined,
      )
      break
    }
    case 'hitl_persistence_failed': {
      // Audit P2-1 — a queued AskUserQuestion answer is at risk because the
      // kernel couldn't persist its inbox. Surfaced as a red error toast so
      // the user knows to re-submit.
      if (!ev.hitlPersistenceFailed) break
      const f = ev.hitlPersistenceFailed
      const now = Date.now()
      const entry = { ...f, id: `${f.reason}:${now}`, at: now }
      const MAX_FAILURES = 20
      const cap = (arr: typeof entry[]) =>
        arr.length > MAX_FAILURES ? arr.slice(arr.length - MAX_FAILURES) : arr
      apply(
        (sl) => ({
          ...sl,
          hitlPersistenceFailures: cap([...(sl.hitlPersistenceFailures ?? []), entry]),
        }),
        isActive
          ? { hitlPersistenceFailures: cap([...st0.hitlPersistenceFailures, entry]) }
          : undefined,
      )
      break
    }
    case 'transcript_clone_degraded': {
      // Audit P2-2 — keep the latest snapshot for operators AND (contract
      // audit 2026-07) surface a transient toast: a frozen-shared fallback
      // means the kernel no longer owns an independent transcript copy, which
      // the user should know before trusting rewind/checkpoint state.
      if (!ev.transcriptCloneDegraded) break
      const now = Date.now()
      const entry = { ...ev.transcriptCloneDegraded, at: now }
      const diag: OrchestrationKernelDiagnostic = {
        id: `clone_degraded:${now}`,
        kind: 'transcript_clone_degraded',
        detail:
          entry.mode === 'frozen-shared'
            ? `会话记录深拷贝失败（共 ${entry.messageCount} 条消息），内核已降级为共享只读引用——检查点/回滚可能不可靠`
            : `会话记录深拷贝降级为 JSON 兜底（共 ${entry.messageCount} 条消息）`,
        at: now,
      }
      apply(
        (sl) => ({
          ...sl,
          lastTranscriptCloneDegradation: entry,
          kernelDiagnostics: capKernelDiagnostics([...(sl.kernelDiagnostics ?? []), diag]),
        }),
        isActive
          ? {
              lastTranscriptCloneDegradation: entry,
              kernelDiagnostics: capKernelDiagnostics([...st0.kernelDiagnostics, diag]),
            }
          : undefined,
      )
      break
    }
    case 'transcript_drift': {
      // Contract audit (2026-07) — Terminal-commit dual-source divergence.
      // Previously a main-process console.warn only; now user-visible so
      // rewind/audit trust issues have a renderer-side trace.
      if (!ev.transcriptDrift) break
      const d = ev.transcriptDrift
      const now = Date.now()
      const diag: OrchestrationKernelDiagnostic = {
        id: `drift:${now}`,
        kind: 'transcript_drift',
        detail: formatTranscriptDriftDetail(d),
        at: now,
      }
      apply(
        (sl) => ({
          ...sl,
          kernelDiagnostics: capKernelDiagnostics([...(sl.kernelDiagnostics ?? []), diag]),
        }),
        isActive
          ? { kernelDiagnostics: capKernelDiagnostics([...st0.kernelDiagnostics, diag]) }
          : undefined,
      )
      break
    }
    case 'transcript_conflict': {
      if (!ev.transcriptConflict) break
      const conflict = ev.transcriptConflict
      const now = Date.now()
      const diag: OrchestrationKernelDiagnostic = {
        id: `transcript_conflict:${now}`,
        kind: 'transcript_conflict',
        detail:
          `会话记录提交冲突：${conflict.source} 基于 revision ${conflict.expectedRevision}，` +
          `内核已推进到 ${conflict.actualRevision}；陈旧提交已拒绝。`,
        at: now,
      }
      apply(
        (sl) => ({
          ...sl,
          kernelDiagnostics: capKernelDiagnostics([...(sl.kernelDiagnostics ?? []), diag]),
        }),
        isActive
          ? { kernelDiagnostics: capKernelDiagnostics([...st0.kernelDiagnostics, diag]) }
          : undefined,
      )
      break
    }
    case 'outer_loop_complete': {
      // Audit P2-1 — keep the latest outer-loop telemetry snapshot AND
      // (contract audit 2026-07) toast the two states the user should not
      // have to discover via DevTools: overflow (inbox not draining) and
      // error (the turn ended by exception).
      if (!ev.outerLoopStats) break
      const now = Date.now()
      const entry = { ...ev.outerLoopStats, at: now }
      let diag: OrchestrationKernelDiagnostic | null = null
      if (entry.overflowed) {
        diag = {
          id: `outer_overflow:${now}`,
          kind: 'outer_loop_overflow',
          detail:
            `本轮外层循环达到上限 ${entry.maxOuterIterations} 次仍有 ${entry.inboxRemaining} 条待处理消息，` +
            '部分排队输入可能未被处理',
          at: now,
        }
      } else if (entry.exitReason === 'error') {
        diag = {
          id: `outer_error:${now}`,
          kind: 'outer_loop_error',
          detail: `本轮编排循环因异常退出（已执行 ${entry.iterations} 次迭代）`,
          at: now,
        }
      }
      apply(
        (sl) => ({
          ...sl,
          lastOuterLoopStats: entry,
          ...(diag
            ? {
                kernelDiagnostics: capKernelDiagnostics([
                  ...(sl.kernelDiagnostics ?? []),
                  diag,
                ]),
              }
            : {}),
        }),
        isActive
          ? {
              lastOuterLoopStats: entry,
              ...(diag
                ? {
                    kernelDiagnostics: capKernelDiagnostics([
                      ...st0.kernelDiagnostics,
                      diag,
                    ]),
                  }
                : {}),
            }
          : undefined,
      )
      break
    }
    case 'scheduler_backpressure': {
      // Contract audit (2026-07) — a tool is waiting (or waited) on the
      // cross-agent hold gate / quota backpressure. Previously visible only
      // via main-process console.log; users just saw the turn stall.
      if (!ev.schedulerBackpressure) break
      const b = ev.schedulerBackpressure
      const now = Date.now()
      const diag: OrchestrationKernelDiagnostic = {
        id: `backpressure:${b.toolUseId}:${now}`,
        kind: 'scheduler_backpressure',
        detail:
          b.kind === 'scheduler_hold'
            ? `工具 ${b.toolName} 为更高优先级智能体让路，等待了 ${b.waitedMs ?? 0}ms${b.reason ? `（${b.reason}）` : ''}`
            : `工具 ${b.toolName} 正在等待资源配额释放${b.reason ? `（${b.reason}）` : ''}，达到预算上限前会自动重试`,
        at: now,
      }
      apply(
        (sl) => ({
          ...sl,
          kernelDiagnostics: capKernelDiagnostics([...(sl.kernelDiagnostics ?? []), diag]),
        }),
        isActive
          ? { kernelDiagnostics: capKernelDiagnostics([...st0.kernelDiagnostics, diag]) }
          : undefined,
      )
      break
    }
    case 'appendix_a':
    default:
      // appendix_a is high-volume bootstrap-stage telemetry that no UI
      // currently surfaces; drop without warning. Unknown tags also fall
      // through — kernel additions land in `OrchestrationPhasePayload`
      // first, so this default never silently swallows a known shape.
      break
  }
}
