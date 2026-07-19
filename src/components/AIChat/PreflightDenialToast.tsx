/**
 * Orchestration transient-notification toast strip (bottom-right of the chat
 * panel). Surfaces three kinds of `orchestration_phase` events forwarded by
 * `electron/orchestration/transport.ts` (`buildPhaseStreamEvent`) and stored
 * via `src/stores/chat/streamEvents/orchestrationStreamEvents.ts`:
 *
 *   - `permission_denied_preflight` → red "policy blocked <tool>" toast.
 *     Emitted by the kernel's `DefaultToolRuntimePort.executeToolBatch`
 *     preflight gate.
 *   - `tool_preempted` (audit P1 §5.2) → amber "<tool> paused so <tool> could
 *     run" info toast.
 *   - `hitl_persistence_failed` (audit P2-1) → red "your answer wasn't saved —
 *     please re-submit" error toast (durable-HITL worst-case).
 *
 * Toasts auto-dismiss (denials/preemptions after 5–6s; HITL persistence
 * failures linger longer because losing a queued answer is the worst case).
 * The dismiss button clears earlier. A local "closed" set lets us auto-dismiss
 * without rewriting the store on every timer tick.
 */
import React, { useEffect, useState } from 'react'
import { X, ShieldAlert, Zap, AlertTriangle } from 'lucide-react'
import { useChatStore } from '../../stores/useChatStore'
import './PreflightDenialToast.css'

const AUTO_DISMISS_MS = 5000
const PREEMPTION_DISMISS_MS = 6000
// Longer: a lost AskUserQuestion answer is the worst durable-HITL failure, so
// keep the warning on screen long enough for the user to notice and re-submit.
const HITL_FAILURE_DISMISS_MS = 12000
const INTERRUPT_DISMISS_MS = 5000
// Contract audit (2026-07) — kernel diagnostics (transcript drift / clone
// degradation / outer-loop overflow-error). Longer than plain interrupts:
// these indicate state-integrity issues the user may want to read.
const KERNEL_DIAG_DISMISS_MS = 10000

/** Short zh-CN title per kernel-diagnostic kind. */
const KERNEL_DIAG_TITLE: Record<string, string> = {
  transcript_drift: '会话记录出现漂移',
  transcript_clone_degraded: '会话记录快照降级',
  outer_loop_overflow: '编排循环达到迭代上限',
  outer_loop_error: '编排循环异常退出',
  pause_partial: '暂停未覆盖全部子智能体',
  pause_failed: '暂停未生效',
  scheduler_backpressure: '工具调度出现背压',
}

// P0-3 — human-readable label for a non-HITL kernel interrupt reason. Reasons
// may carry a `:hard` / `:grace_expired` suffix (soft→hard escalation), which
// we surface as a parenthetical so a forced stop is distinguishable.
function interruptLabel(reason: string): string {
  const [base, suffix] = reason.split(':')
  const baseLabel: Record<string, string> = {
    user: '已停止本轮生成',
    timeout: '本轮因超时被中断',
    superseded: '本轮被新的请求取代',
    fork_replaced: '本轮被分叉会话替换',
    shutdown: '应用退出，本轮已中断',
    hitl: '等待你的回答',
  }
  const label = baseLabel[base] ?? `本轮已中断（${base}）`
  if (suffix === 'hard') return `${label}（已强制停止）`
  if (suffix === 'grace_expired') return `${label}（宽限超时，已强制停止）`
  return label
}

export const PreflightDenialToast: React.FC = () => {
  const denials = useChatStore((s) => s.permissionDenials)
  const dismiss = useChatStore((s) => s.dismissPermissionDenial)
  const preemptions = useChatStore((s) => s.toolPreemptions)
  const dismissPreemption = useChatStore((s) => s.dismissToolPreemption)
  const failures = useChatStore((s) => s.hitlPersistenceFailures)
  const dismissFailure = useChatStore((s) => s.dismissHitlPersistenceFailure)
  const interruptNotices = useChatStore((s) => s.interruptNotices)
  const dismissInterruptNotice = useChatStore((s) => s.dismissInterruptNotice)
  const kernelDiagnostics = useChatStore((s) => s.kernelDiagnostics)
  const dismissKernelDiagnostic = useChatStore((s) => s.dismissKernelDiagnostic)
  // Local "user manually closed" set, layered on top of the store. This lets
  // us auto-dismiss without rewriting the store on every timer tick (store
  // mutation would trigger re-render of every toast). Keyed by toolUseId for
  // denials and by synthesized id for preemptions / failures (no collision —
  // denial keys are tool-use ids, the others are `a->b` / `reason:at`).
  const [closedIds, setClosedIds] = useState<Set<string>>(new Set())

  const close = (key: string, dispatch: (key: string) => void) => {
    setClosedIds((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
    dispatch(key)
  }

  // Auto-dismiss: each toast gets a timer; when it fires we filter it locally
  // AND drop it from the store so the array doesn't grow forever.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    const schedule = (key: string, at: number, ms: number, dispatch: (key: string) => void) => {
      if (closedIds.has(key)) return
      const remaining = Math.max(0, ms - (Date.now() - at))
      timers.push(setTimeout(() => close(key, dispatch), remaining))
    }
    for (const d of denials) schedule(d.toolUseId, d.at, AUTO_DISMISS_MS, dismiss)
    for (const p of preemptions) schedule(p.id, p.at, PREEMPTION_DISMISS_MS, dismissPreemption)
    for (const f of failures) schedule(f.id, f.at, HITL_FAILURE_DISMISS_MS, dismissFailure)
    for (const n of interruptNotices) schedule(n.id, n.at, INTERRUPT_DISMISS_MS, dismissInterruptNotice)
    for (const k of kernelDiagnostics) schedule(k.id, k.at, KERNEL_DIAG_DISMISS_MS, dismissKernelDiagnostic)
    return () => {
      for (const t of timers) clearTimeout(t)
    }
  }, [denials, preemptions, failures, interruptNotices, kernelDiagnostics, closedIds, dismiss, dismissPreemption, dismissFailure, dismissInterruptNotice, dismissKernelDiagnostic])

  const visibleDenials = denials.filter((d) => !closedIds.has(d.toolUseId))
  const visiblePreemptions = preemptions.filter((p) => !closedIds.has(p.id))
  const visibleFailures = failures.filter((f) => !closedIds.has(f.id))
  const visibleInterrupts = interruptNotices.filter((n) => !closedIds.has(n.id))
  const visibleKernelDiags = kernelDiagnostics.filter((k) => !closedIds.has(k.id))
  if (
    visibleDenials.length === 0 &&
    visiblePreemptions.length === 0 &&
    visibleFailures.length === 0 &&
    visibleInterrupts.length === 0 &&
    visibleKernelDiags.length === 0
  ) {
    return null
  }

  return (
    <div className="preflight-denial-toast-stack" role="alert" aria-live="polite">
      {visibleFailures.map((f) => (
        <div key={f.id} className="preflight-denial-toast preflight-denial-toast--error">
          <AlertTriangle size={14} className="preflight-denial-toast-icon" />
          <div className="preflight-denial-toast-body">
            <div className="preflight-denial-toast-title">回答可能未保存到磁盘</div>
            <div className="preflight-denial-toast-reason">
              内核无法持久化会话队列（{f.reason}）。请重新提交你的回答。
            </div>
            <div className="preflight-denial-toast-rule">
              受影响回答数：{f.pendingHumanResumeCount}
            </div>
          </div>
          <button
            type="button"
            className="preflight-denial-toast-close"
            onClick={() => close(f.id, dismissFailure)}
            title="关闭"
            aria-label="关闭"
          >
            <X size={12} />
          </button>
        </div>
      ))}
      {visibleDenials.map((d) => (
        <div key={d.toolUseId} className="preflight-denial-toast">
          <ShieldAlert size={14} className="preflight-denial-toast-icon" />
          <div className="preflight-denial-toast-body">
            <div className="preflight-denial-toast-title">
              工具 <code>{d.toolName}</code> 被策略拦截
            </div>
            <div className="preflight-denial-toast-reason">{d.reason}</div>
            {d.matchedRule && (
              <div className="preflight-denial-toast-rule">
                规则：{d.matchedRule}
              </div>
            )}
          </div>
          <button
            type="button"
            className="preflight-denial-toast-close"
            onClick={() => close(d.toolUseId, dismiss)}
            title="关闭"
            aria-label="关闭"
          >
            <X size={12} />
          </button>
        </div>
      ))}
      {visibleInterrupts.map((n) => (
        <div key={n.id} className="preflight-denial-toast preflight-denial-toast--warn">
          <AlertTriangle size={14} className="preflight-denial-toast-icon" />
          <div className="preflight-denial-toast-body">
            <div className="preflight-denial-toast-title">{interruptLabel(n.reason)}</div>
          </div>
          <button
            type="button"
            className="preflight-denial-toast-close"
            onClick={() => close(n.id, dismissInterruptNotice)}
            title="关闭"
            aria-label="关闭"
          >
            <X size={12} />
          </button>
        </div>
      ))}
      {visibleKernelDiags.map((k) => (
        <div key={k.id} className="preflight-denial-toast preflight-denial-toast--warn">
          <AlertTriangle size={14} className="preflight-denial-toast-icon" />
          <div className="preflight-denial-toast-body">
            <div className="preflight-denial-toast-title">
              {KERNEL_DIAG_TITLE[k.kind] ?? '编排内核诊断'}
            </div>
            <div className="preflight-denial-toast-reason">{k.detail}</div>
          </div>
          <button
            type="button"
            className="preflight-denial-toast-close"
            onClick={() => close(k.id, dismissKernelDiagnostic)}
            title="关闭"
            aria-label="关闭"
          >
            <X size={12} />
          </button>
        </div>
      ))}
      {visiblePreemptions.map((p) => (
        <div key={p.id} className="preflight-denial-toast preflight-denial-toast--warn">
          <Zap size={14} className="preflight-denial-toast-icon" />
          <div className="preflight-denial-toast-body">
            <div className="preflight-denial-toast-title">
              工具 <code>{p.victimToolName ?? p.victimToolUseId}</code> 被让位
            </div>
            <div className="preflight-denial-toast-reason">
              为更高优先级的 <code>{p.incomingToolName}</code> 释放{p.resource}资源
            </div>
          </div>
          <button
            type="button"
            className="preflight-denial-toast-close"
            onClick={() => close(p.id, dismissPreemption)}
            title="关闭"
            aria-label="关闭"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
