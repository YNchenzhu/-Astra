/**
 * PlanApprovalCard — slim, single-row plan approval bar for the **main
 * chat** agent.
 *
 * The full plan content no longer lives inside this card. It is opened in
 * an editor tab (markdown-rendered, live progress) via "查看计划" — see
 * `src/services/planTab.ts`. This card stays one row tall so it never
 * covers the chat input box, regardless of how large the plan is.
 *
 * Reads `pendingPlanApproval` (parked by `handlePlanApprovalRequestEvent`
 * in `permissionStreamEvents.ts`) and resolves the bridge's pending
 * Promise via `respondToPlanApproval(outcome, detail?)` → IPC
 * `ai:respond-plan-approval`.
 *
 * Tri-state outcomes:
 *   - Approve  → `outcome: 'accepted'`  (continue implementation)
 *   - Reject   → `outcome: 'rejected'`  (+ optional reason; stay in plan mode)
 *   - Cancel   → `outcome: 'cancelled'` (abort the turn)
 */
import React, { useEffect, useState } from 'react'
import type { PlanApprovalRequestDisplay } from '../../types'
import { useChatStore } from '../../stores/useChatStore'
import { openPlanPreviewTab, closePlanPreviewTab } from '../../services/planTab'
import { useT } from '../../i18n'
import './PlanApprovalCard.css'

interface PlanApprovalCardProps {
  request: PlanApprovalRequestDisplay
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}m ${rem.toString().padStart(2, '0')}s`
}

function planItemCount(request: PlanApprovalRequestDisplay): number {
  if (request.phases && request.phases.length > 0) {
    return request.phases.reduce((n, ph) => n + ph.todos.length, 0)
  }
  return request.todos?.length ?? 0
}

export const PlanApprovalCard: React.FC<PlanApprovalCardProps> = ({ request }) => {
  const t = useT()
  const respondToPlanApproval = useChatStore((s) => s.respondToPlanApproval)
  const [pending, setPending] = useState<'accepted' | 'rejected' | 'cancelled' | null>(null)
  const [rejectDetail, setRejectDetail] = useState<string>('')
  const [showRejectInput, setShowRejectInput] = useState(false)

  const elapsed = formatElapsed(Date.now() - request.receivedAt)
  const itemCount = planItemCount(request)

  // Close the in-memory preview tab once this request is gone from screen
  // (unmount). On approval the real plan file tab takes over (plan:active);
  // on reject/cancel there is nothing left to preview.
  useEffect(() => {
    return () => closePlanPreviewTab()
  }, [])

  const submit = async (
    outcome: 'accepted' | 'rejected' | 'cancelled',
    detail?: string,
  ) => {
    if (pending) return
    setPending(outcome)
    try {
      await respondToPlanApproval({
        requestId: request.requestId,
        outcome,
        ...(detail && detail.trim() ? { detail: detail.trim() } : {}),
      })
    } finally {
      setPending(null)
    }
  }

  const handleApprove = () => submit('accepted')
  const handleReject = () => {
    if (!showRejectInput) {
      setShowRejectInput(true)
      return
    }
    void submit('rejected', rejectDetail)
  }
  const handleCancel = () => submit('cancelled')
  const handleViewPlan = () => openPlanPreviewTab(request)

  const title = request.name?.trim() || t.planApproval.titleDefault

  return (
    <div className="plan-approval-bar">
      {showRejectInput ? (
        <div className="plan-approval-reject-detail">
          <textarea
            id={`reject-${request.requestId}`}
            value={rejectDetail}
            onChange={(e) => setRejectDetail(e.target.value)}
            placeholder={t.planApproval.rejectPlaceholder}
            rows={2}
            maxLength={2000}
            disabled={pending !== null}
          />
        </div>
      ) : null}

      <div className="plan-approval-row">
        <span className="plan-approval-mode">{t.planApproval.mode}</span>
        <span className="plan-approval-title" title={request.overview || title}>
          {title}
        </span>
        {request.overview ? (
          <span className="plan-approval-overview">{request.overview}</span>
        ) : null}
        {itemCount > 0 ? (
          <span className="plan-approval-count">{t.planApproval.itemCount(itemCount)}</span>
        ) : null}
        {elapsed ? <span className="plan-approval-elapsed">{elapsed}</span> : null}

        <button
          type="button"
          className="plan-approval-view"
          onClick={handleViewPlan}
          title={t.planApproval.viewPlanTitle}
        >
          {t.planApproval.viewPlan}
        </button>

        <div className="plan-approval-actions">
          <button
            type="button"
            className="plan-approval-btn cancel"
            onClick={handleCancel}
            disabled={pending !== null}
            title={t.planApproval.cancelTitle}
          >
            {pending === 'cancelled' ? t.planApproval.cancelling : t.planApproval.cancel}
          </button>
          <button
            type="button"
            className="plan-approval-btn reject"
            onClick={handleReject}
            disabled={pending !== null}
            title={t.planApproval.rejectTitle}
          >
            {pending === 'rejected'
              ? t.planApproval.rejecting
              : showRejectInput
                ? rejectDetail.trim()
                  ? t.planApproval.confirmReject
                  : t.planApproval.rejectDirect
                : t.planApproval.reject}
          </button>
          <button
            type="button"
            className="plan-approval-btn approve"
            onClick={handleApprove}
            disabled={pending !== null}
            title={t.planApproval.approveTitle}
          >
            {pending === 'accepted' ? t.planApproval.approving : t.planApproval.approve}
          </button>
        </div>
      </div>
    </div>
  )
}
