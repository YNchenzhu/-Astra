/**
 * PlanTabApprovalBanner — secondary approval entry shown at the top of the
 * plan markdown tab. Mirrors the slim PlanApprovalCard bar so the user can
 * approve / reject / cancel while reading the full plan in the tab.
 *
 * Both entries resolve the same `pendingPlanApproval` request, so acting in
 * either place clears both. Renders nothing when no approval is pending.
 */
import React, { useState } from 'react'
import { useChatStore } from '../../stores/useChatStore'
import './PlanTabApprovalBanner.css'

export const PlanTabApprovalBanner: React.FC = () => {
  const pendingPlanApproval = useChatStore((s) => s.pendingPlanApproval)
  const respondToPlanApproval = useChatStore((s) => s.respondToPlanApproval)
  const [pending, setPending] = useState<'accepted' | 'rejected' | 'cancelled' | null>(null)

  if (!pendingPlanApproval) return null
  const requestId = pendingPlanApproval.requestId

  const submit = async (outcome: 'accepted' | 'rejected' | 'cancelled') => {
    if (pending) return
    setPending(outcome)
    try {
      await respondToPlanApproval({ requestId, outcome })
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="plan-tab-banner">
      <span className="plan-tab-banner-text">
        此计划等待你审批 · 批准后定稿到 .cursor/plans/
      </span>
      <div className="plan-tab-banner-actions">
        <button
          type="button"
          className="plan-tab-banner-btn cancel"
          onClick={() => submit('cancelled')}
          disabled={pending !== null}
          title="中止当前任务"
        >
          {pending === 'cancelled' ? '中止中…' : '中止'}
        </button>
        <button
          type="button"
          className="plan-tab-banner-btn reject"
          onClick={() => submit('rejected')}
          disabled={pending !== null}
          title="让模型重新出方案"
        >
          {pending === 'rejected' ? '拒绝中…' : '拒绝'}
        </button>
        <button
          type="button"
          className="plan-tab-banner-btn approve"
          onClick={() => submit('accepted')}
          disabled={pending !== null}
          title="批准并开始实施"
        >
          {pending === 'accepted' ? '批准中…' : '批准并实施'}
        </button>
      </div>
    </div>
  )
}
