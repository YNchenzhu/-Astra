/**
 * Stage 4.1 — IDE-style orchestration kernel activity timeline.
 *
 * Renders a horizontal phase breadcrumb (PrepareContext → CallModel → Terminal)
 * + iteration counter + paused state + a context menu on each node for
 * "snapshot here" / "rewind to here" (Stage 4.6).
 *
 * State source: `useChatStore` orchestration slice (mirrored from
 * `electron/orchestration/` phase events via `mainStreamRouter`).
 *
 * Behaviour:
 *   - Hidden when there's no active orchestration (phase null, iteration 0)
 *     so legacy `runAgenticLoop` chats don't see an empty placeholder.
 *   - Paused state pulses the current phase node so the user knows the kernel
 *     is awaiting `resume()`.
 *   - Checkpoint menu lazily fetches via `orchestration:list-checkpoints` on
 *     first open. Rewind cascades through `orchestration:rewind` IPC.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, Pause as PauseIcon, Camera, RotateCcw, AlertCircle } from 'lucide-react'
import { useChatStore } from '../../stores/useChatStore'
import { reportUserActionError } from '../../utils/reportUserActionError'
import './OrchestrationTimeline.css'

const PHASE_ORDER: ReadonlyArray<string> = [
  'PrepareContext',
  'CallModel',
  'Terminal',
]

const PHASE_LABEL: Record<string, string> = {
  PrepareContext: '准备',
  CallModel: '模型调用',
  Terminal: '收尾',
  Error: '错误',
}

export const OrchestrationTimeline: React.FC = () => {
  const phase = useChatStore((s) => s.orchestrationPhase)
  const iteration = useChatStore((s) => s.orchestrationIteration)
  const innerIteration = useChatStore((s) => s.orchestrationInnerIteration)
  const paused = useChatStore((s) => s.orchestrationPaused)
  const conversationId = useChatStore((s) => s.currentConversationId)
  const checkpointList = useChatStore((s) => s.checkpointList)
  const setCheckpointList = useChatStore((s) => s.setCheckpointList)

  const [menuOpen, setMenuOpen] = useState(false)
  // Bug F fix — container ref used by the click-outside listener so any
  // pointerdown outside the timeline pill (and its dropdown) closes the menu.
  // Without this the only way to dismiss the dropdown was to click the "..."
  // button again, which is unexpected per platform menu conventions.
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: PointerEvent) => {
      const root = containerRef.current
      if (!root) return
      if (e.target instanceof Node && root.contains(e.target)) return
      setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // Contract audit (2026-07) — snapshot / rewind are user-initiated actions,
  // and rewind in particular mutates kernel state. A silent catch made a
  // failed rewind indistinguishable from a successful one (the "dead button"
  // class of bug). Route failures through `reportUserActionError`:
  //   - listCheckpoints refresh → silent log (background-ish, fires on menu
  //     open; a popup would be disproportionate)
  //   - snapshot / rewind → visible alert (the user clicked and expects an
  //     observable result)
  const refreshCheckpoints = useCallback(async () => {
    const api = window.electronAPI?.orchestration
    if (!api || !conversationId) return
    try {
      const res = await api.listCheckpoints({ conversationId })
      if (res.ok) setCheckpointList(res.checkpoints)
      else reportUserActionError('加载检查点列表', '主进程返回失败', { silent: true })
    } catch (e) {
      reportUserActionError('加载检查点列表', e, { silent: true })
    }
  }, [conversationId, setCheckpointList])

  const openMenu = useCallback(() => {
    if (!menuOpen) void refreshCheckpoints()
    setMenuOpen((v) => !v)
  }, [menuOpen, refreshCheckpoints])

  const snapshotHere = useCallback(async () => {
    const api = window.electronAPI?.orchestration
    if (!api || !conversationId) return
    try {
      const res = await api.snapshot({ conversationId, tag: `manual_${Date.now()}` })
      if (!res.ok) {
        reportUserActionError('创建检查点', res.error ?? '主进程返回失败')
        return
      }
      void refreshCheckpoints()
    } catch (e) {
      reportUserActionError('创建检查点', e)
    }
  }, [conversationId, refreshCheckpoints])

  const rewindTo = useCallback(
    async (checkpointId: string) => {
      const api = window.electronAPI?.orchestration
      if (!api || !conversationId) return
      try {
        const res = await api.rewind({ conversationId, checkpointId })
        if (!res.ok) {
          reportUserActionError('回滚到检查点', '内核拒绝了回滚（检查点可能已失效）')
        } else {
          void refreshCheckpoints()
        }
      } catch (e) {
        reportUserActionError('回滚到检查点', e)
      }
      setMenuOpen(false)
    },
    [conversationId, refreshCheckpoints],
  )

  // Hide when there's no orchestration signal yet — legacy path shows no
  // indicator at all instead of an empty placeholder.
  if (!phase || iteration === 0) return null

  // P2 — `Error` is not part of the linear PHASE_ORDER breadcrumb; when the
  // kernel transitions to it, `PHASE_ORDER.indexOf('Error')` is -1 so no node
  // would highlight. Render a distinct red error badge instead so a failed
  // turn is visible on the timeline rather than showing an all-inactive strip.
  const isError = phase === 'Error'

  return (
    <div
      className={'orchestration-timeline' + (isError ? ' orchestration-timeline--error' : '')}
      title={isError ? '编排内核阶段（本轮出错）' : '编排内核阶段'}
      ref={containerRef}
    >
      <span className="orchestration-timeline-icon">
        {isError ? (
          <AlertCircle size={11} color="var(--color-error-fg, #e05252)" />
        ) : paused ? (
          <PauseIcon size={11} />
        ) : (
          <Activity size={11} />
        )}
      </span>
      {PHASE_ORDER.map((p, idx) => {
        const isActive = p === phase
        const isPassed = PHASE_ORDER.indexOf(phase) > idx
        return (
          <React.Fragment key={p}>
            <span
              className={
                'orchestration-timeline-node' +
                (isActive ? ' orchestration-timeline-node--active' : '') +
                (isPassed ? ' orchestration-timeline-node--passed' : '') +
                (isActive && paused ? ' orchestration-timeline-node--paused' : '')
              }
            >
              {PHASE_LABEL[p] ?? p}
            </span>
            {idx < PHASE_ORDER.length - 1 && (
              <span className="orchestration-timeline-arrow">›</span>
            )}
          </React.Fragment>
        )
      })}
      {isError && (
        <span
          className="orchestration-timeline-node orchestration-timeline-node--error"
          style={{
            color: 'var(--color-error-fg, #e05252)',
            fontWeight: 600,
          }}
        >
          {PHASE_LABEL.Error}
        </span>
      )}
      <span className="orchestration-timeline-counter">
        t{iteration}/i{innerIteration}
      </span>
      <button
        type="button"
        className="orchestration-timeline-menu-btn"
        onClick={openMenu}
        title="检查点 (Snapshot / Rewind)"
        aria-label="检查点菜单"
      >
        …
      </button>
      {menuOpen && (
        <div className="orchestration-timeline-menu" role="menu">
          <button
            type="button"
            className="orchestration-timeline-menu-item"
            onClick={snapshotHere}
          >
            <Camera size={11} /> Snapshot here
          </button>
          <div className="orchestration-timeline-menu-divider" />
          {checkpointList.length === 0 ? (
            <div className="orchestration-timeline-menu-empty">
              暂无检查点
            </div>
          ) : (
            checkpointList.slice().reverse().slice(0, 12).map((cp) => (
              <button
                type="button"
                key={cp.id}
                className="orchestration-timeline-menu-item"
                onClick={() => void rewindTo(cp.id)}
                title={`Rewind to ${cp.tag} (${new Date(cp.at).toLocaleTimeString()})`}
              >
                <RotateCcw size={11} />
                <span className="orchestration-timeline-menu-tag">{cp.tag}</span>
                <span className="orchestration-timeline-menu-time">
                  {new Date(cp.at).toLocaleTimeString()}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
