/**
 * TeamPlanApprovalCard — inline UI for resolving a teammate's pending
 * `team_plan_approval_request` (upstream §6.2 + P0-2 follow-up).
 *
 * When a teammate worker (spawned with `planModeRequired: true`, OR a
 * TeamFile member running in plan mode) calls `ExitPlanMode`, the main
 * process emits a `team_plan_approval_request` stream event into the
 * leader's main chat conversation. The renderer parks the request into
 * `pendingTeamPlanApproval` on the chat slice; this component reads it
 * and renders the plan + Approve/Deny buttons.
 *
 * Resolution wires through `respondToTeamPlanApproval` on the chat
 * store, which calls IPC `ai:respond-team-plan-approval`. The shared
 * `pendingTeamLeaderPlanApproval` map in the bridge covers BOTH the
 * TeamFile path and the renderer-spawned chat-leader path — one IPC
 * unblocks either worker.
 *
 * Visual style intentionally mirrors `PermissionPrompt` (same yellow
 * "needs your decision" pill, same Approve/Deny pair) so users learn
 * one approval idiom instead of two.
 */
import React, { useMemo, useState } from 'react'
import type { TeamPlanApprovalRequestDisplay } from '../../types'
import { useChatStore } from '../../stores/useChatStore'
import { useT } from '../../i18n'
import './TeamPlanApprovalCard.css'

interface TeamPlanApprovalCardProps {
  request: TeamPlanApprovalRequestDisplay
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}m ${rem.toString().padStart(2, '0')}s`
}

export const TeamPlanApprovalCard: React.FC<TeamPlanApprovalCardProps> = ({ request }) => {
  const t = useT()
  const respondToTeamPlanApproval = useChatStore((s) => s.respondToTeamPlanApproval)
  const [pending, setPending] = useState<'approve' | 'deny' | null>(null)
  const [denyDetail, setDenyDetail] = useState<string>('')
  const [showDenyInput, setShowDenyInput] = useState(false)

  // Plan markdown is already truncated to ≤24 KB in the bridge, but the
  // user might still want to scroll a long body without breaking layout.
  const planLines = useMemo(
    () => (request.planMarkdown || '').split('\n'),
    [request.planMarkdown],
  )

  // Naive elapsed indicator. Re-renders on parent ticks (chat store
  // updates frequently while the worker is alive); good enough for a
  // glance — no per-second timer needed.
  const elapsed = formatElapsed(Date.now() - request.receivedAt)

  const handleApprove = async () => {
    if (pending) return
    setPending('approve')
    try {
      await respondToTeamPlanApproval({
        requestId: request.requestId,
        approve: true,
      })
    } finally {
      setPending(null)
    }
  }

  const handleDeny = async () => {
    if (pending) return
    if (!showDenyInput) {
      // Two-step deny: first click expands an optional reason input so the
      // worker can tell the user (and any post-mortem viewer) why the plan
      // was rejected. A second click without typing still submits.
      setShowDenyInput(true)
      return
    }
    setPending('deny')
    try {
      await respondToTeamPlanApproval({
        requestId: request.requestId,
        approve: false,
        ...(denyDetail.trim() ? { detail: denyDetail.trim() } : {}),
      })
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="team-plan-approval-card">
      <div className="team-plan-approval-header">
        <span className="team-plan-approval-title">{t.teamPlanApproval.title}</span>
        <span className="team-plan-approval-mode">{t.teamPlanApproval.mode}</span>
      </div>

      <div className="team-plan-approval-body">
        <div className="team-plan-approval-meta">
          <span className="team-plan-approval-worker" title={t.teamPlanApproval.workerTitle}>
            {request.workerAgentId}
          </span>
          {request.teamName ? (
            <span className="team-plan-approval-team">team:{request.teamName}</span>
          ) : (
            <span className="team-plan-approval-team-none">{t.teamPlanApproval.directDispatch}</span>
          )}
          {elapsed ? (
            <span className="team-plan-approval-elapsed" title={t.teamPlanApproval.elapsedTitle}>
              {elapsed}
            </span>
          ) : null}
        </div>

        <pre className="team-plan-approval-plan">
          {planLines.length > 200
            ? `${planLines.slice(0, 200).join('\n')}\n${t.teamPlanApproval.planTruncated}`
            : request.planMarkdown}
        </pre>

        {Array.isArray(request.allowedPrompts) && request.allowedPrompts.length > 0 ? (
          <details className="team-plan-approval-prompts">
            <summary>{t.teamPlanApproval.extraPrompts(request.allowedPrompts.length)}</summary>
            <pre>{JSON.stringify(request.allowedPrompts, null, 2)}</pre>
          </details>
        ) : null}

        {showDenyInput ? (
          <div className="team-plan-approval-deny-detail">
            <label htmlFor={`deny-${request.requestId}`}>{t.teamPlanApproval.denyReasonLabel}</label>
            <textarea
              id={`deny-${request.requestId}`}
              value={denyDetail}
              onChange={(e) => setDenyDetail(e.target.value)}
              placeholder={t.teamPlanApproval.denyPlaceholder}
              rows={2}
              maxLength={2000}
              disabled={pending !== null}
            />
          </div>
        ) : null}
      </div>

      <div className="team-plan-approval-actions">
        <button
          type="button"
          className="team-plan-approval-btn deny"
          onClick={handleDeny}
          disabled={pending !== null}
        >
          {pending === 'deny'
            ? t.teamPlanApproval.denying
            : showDenyInput
              ? denyDetail.trim()
                ? t.teamPlanApproval.confirmDeny
                : t.teamPlanApproval.denyDirect
              : t.teamPlanApproval.deny}
        </button>
        <button
          type="button"
          className="team-plan-approval-btn approve"
          onClick={handleApprove}
          disabled={pending !== null}
        >
          {pending === 'approve' ? t.teamPlanApproval.approving : t.teamPlanApproval.approve}
        </button>
      </div>
    </div>
  )
}
