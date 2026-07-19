/**
 * TryRunDrawer —— 工作台里的试跑抽屉（Phase 3 Sprint 2d.a）
 *
 * 用户改完某个智能体的 system prompt / 字段 / 工具白名单后,想快速
 * 看"AI 会怎么回我"—— 这个抽屉提供沙盒式验证:
 *
 *   ✓ 单次 LLM 调用,使用 `effectiveAgent`(baseline + draft) 的合成
 *     system prompt;不需要先保存
 *   ✓ 流式渲染 token
 *   ✓ 支持多轮对话(历史存在本组件的 local state,不污染真实对话)
 *   ✓ 取消/清空重来
 *   ✓ 走 agentic loop(最多 5 轮),但仅使用只读工具(不碰文件系统)
 *   ✗ 不执行写入 / Bash 等副作用工具
 *
 * 这是"行为预览"而非"完整验证"。要测工具链路需在主对话里测。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  X,
  Send,
  StopCircle,
  Trash2,
  Loader2,
  AlertTriangle,
  PlayCircle,
  CheckCircle2,
  Sparkles,
} from 'lucide-react'
import type { AgentBundleEntry, Bundle } from '../../../electron/agents/bundles/types'
import { useT } from '../../i18n'
import './TryRunDrawer.css'

export interface TryRunDrawerProps {
  bundle: Bundle
  agent: AgentBundleEntry
  /** 合成后的 system prompt(已经把 draft 应用过),直接丢给后端 */
  effectiveSystemPrompt: string
  onClose: () => void
}

interface ChatTurn {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 仅 assistant: 流式中 */
  pending?: boolean
  /** 仅 assistant: 运行时 usage(结束后填) */
  usage?: {
    inputTokens?: number
    outputTokens?: number
  } | null
  /** 仅 assistant: 本轮发生错误则填,pending=false */
  error?: string
}

export const TryRunDrawer: React.FC<TryRunDrawerProps> = ({
  bundle,
  agent,
  effectiveSystemPrompt,
  onClose,
}) => {
  const t = useT()
  const tr = t.workbench.tryRun
  const [draft, setDraft] = useState('')
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)

  // Body 滚到底:每次 assistant 流式追加 token 时保持可视化在底部
  const bodyRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [turns])

  // 订阅三个事件通道。只需注册一次,通过闭包和 activeRunId 过滤
  // 其它运行的残余事件(虽然这个抽屉每次只发一个 run,但保险)。
  useEffect(() => {
    const bridge =
      typeof window !== 'undefined'
        ? (window as unknown as { electronAPI?: Window['electronAPI'] }).electronAPI
            ?.bundle
        : undefined
    if (!bridge?.onTryRunDelta || !bridge?.onTryRunEnd || !bridge?.onTryRunError) return

    const unsubDelta = bridge.onTryRunDelta((payload) => {
      setTurns((prev) => {
        const idx = prev.findIndex(
          (t) => t.role === 'assistant' && t.id === payload.runId && t.pending,
        )
        if (idx < 0) return prev
        const next = prev.slice()
        next[idx] = { ...next[idx], content: next[idx].content + payload.text }
        return next
      })
    })
    const unsubEnd = bridge.onTryRunEnd((payload) => {
      setTurns((prev) =>
        prev.map((t) =>
          t.role === 'assistant' && t.id === payload.runId && t.pending
            ? {
                ...t,
                pending: false,
                usage: {
                  inputTokens: (payload.usage as { inputTokens?: number })?.inputTokens,
                  outputTokens: (payload.usage as { outputTokens?: number })?.outputTokens,
                },
              }
            : t,
        ),
      )
      setActiveRunId((cur) => (cur === payload.runId ? null : cur))
    })
    const unsubError = bridge.onTryRunError((payload) => {
      setTurns((prev) =>
        prev.map((t) =>
          t.role === 'assistant' && t.id === payload.runId && t.pending
            ? { ...t, pending: false, error: payload.error }
            : t,
        ),
      )
      setActiveRunId((cur) => (cur === payload.runId ? null : cur))
    })

    return () => {
      unsubDelta()
      unsubEnd()
      unsubError()
    }
  }, [])

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const canSend =
    draft.trim().length > 0 && activeRunId === null

  const handleSend = useCallback(async () => {
    if (!canSend) return
    const userMsg = draft.trim()
    setDraft('')

    const bridge =
      typeof window !== 'undefined'
        ? (window as unknown as { electronAPI?: Window['electronAPI'] }).electronAPI
            ?.bundle
        : undefined
    if (!bridge?.tryRunAgent) {
      setSetupError(tr.noInterface)
      return
    }

    // 往历史里追加一个 user turn,同时先占位一个 assistant pending turn
    // (id 暂用时间戳,等 runId 返回后再替换为正式的 runId 以便后续
    // delta 事件定位)
    const tempAssistantId = `temp-${Date.now()}`
    const nextUserTurn: ChatTurn = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: userMsg,
    }
    const pendingAssistantTurn: ChatTurn = {
      id: tempAssistantId,
      role: 'assistant',
      content: '',
      pending: true,
    }
    const historyForCall = [...turns, nextUserTurn].map((t) => ({
      role: t.role,
      content: t.content,
    }))
    setTurns((prev) => [...prev, nextUserTurn, pendingAssistantTurn])
    setSetupError(null)

    try {
      // 只有 draft/saved 里确实有 prompt 内容时才传 override;
      // 传空串会短路掉后端的"内置 agent 默认 prompt"回退。
      const payload: Parameters<
        NonNullable<NonNullable<Window['electronAPI']['bundle']>['tryRunAgent']>
      >[0] = {
        bundleId: bundle.meta.id,
        agentType: agent.agentType,
        messages: historyForCall,
      }
      if (effectiveSystemPrompt.trim().length > 0) {
        payload.systemPromptOverride = effectiveSystemPrompt
      }
      const result = await bridge.tryRunAgent(payload)
      if (!result.ok) {
        // Setup 失败(没 API Key 之类)—— 把 pending assistant turn 换成 error
        setTurns((prev) =>
          prev.map((t) =>
            t.id === tempAssistantId ? { ...t, pending: false, error: result.error } : t,
          ),
        )
        setSetupError(result.error)
        return
      }
      // 成功:把 pending turn 的 id 从 temp 换成 runId(让后续 delta 事件命中)
      setTurns((prev) =>
        prev.map((t) => (t.id === tempAssistantId ? { ...t, id: result.runId } : t)),
      )
      setActiveRunId(result.runId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setTurns((prev) =>
        prev.map((t) =>
          t.id === tempAssistantId ? { ...t, pending: false, error: msg } : t,
        ),
      )
    }
  }, [canSend, draft, turns, bundle.meta.id, agent.agentType, effectiveSystemPrompt, tr])

  const handleStop = useCallback(async () => {
    if (!activeRunId) return
    const bridge =
      typeof window !== 'undefined'
        ? (window as unknown as { electronAPI?: Window['electronAPI'] }).electronAPI
            ?.bundle
        : undefined
    if (!bridge?.tryRunCancel) return
    try {
      await bridge.tryRunCancel({ runId: activeRunId })
    } catch {
      /* ignore */
    }
    setTurns((prev) =>
      prev.map((turn) =>
        turn.id === activeRunId && turn.pending
          ? { ...turn, pending: false, error: tr.manualStopped }
          : turn,
      ),
    )
    setActiveRunId(null)
  }, [activeRunId, tr])

  const handleClear = useCallback(() => {
    if (activeRunId) {
      void handleStop()
    }
    setTurns([])
    setSetupError(null)
  }, [activeRunId, handleStop])

  // 关闭抽屉时若有 run 在跑,应该取消
  useEffect(() => {
    return () => {
      if (activeRunId) {
        const bridge =
          typeof window !== 'undefined'
            ? (window as unknown as { electronAPI?: Window['electronAPI'] }).electronAPI
                ?.bundle
            : undefined
        try {
          bridge?.tryRunCancel?.({ runId: activeRunId })
        } catch {
          /* ignore */
        }
      }
    }
  }, [activeRunId])

  const agentTitle = useMemo(
    () => agent.displayName ?? agent.agentType,
    [agent.displayName, agent.agentType],
  )

  return (
    <div className="try-run-drawer" role="complementary" aria-label={tr.titleAria(agentTitle)}>
      <header className="try-run-drawer-header">
        <div className="try-run-drawer-title">
          <PlayCircle size={14} className="try-run-drawer-title-icon" />
          <span>{tr.title(agentTitle)}</span>
          <span className="try-run-drawer-subtitle">{tr.subtitle}</span>
        </div>
        <div className="try-run-drawer-actions">
          <button
            type="button"
            className="try-run-drawer-icon-btn"
            onClick={handleClear}
            title={tr.clearChat}
            disabled={turns.length === 0 && !activeRunId}
          >
            <Trash2 size={12} />
          </button>
          <button
            type="button"
            className="try-run-drawer-icon-btn"
            onClick={onClose}
            title={t.workbench.closeEsc}
            aria-label={t.workbench.close}
          >
            <X size={14} />
          </button>
        </div>
      </header>

      {setupError ? (
        <div className="try-run-drawer-setup-error">
          <AlertTriangle size={12} />
          <span>{setupError}</span>
        </div>
      ) : null}

      <div className="try-run-drawer-body" ref={bodyRef}>
        {turns.length === 0 ? (
          <div className="try-run-drawer-empty">
            <Sparkles size={22} strokeWidth={1.3} />
            <p>{tr.emptyBody}</p>
            <p className="try-run-drawer-empty-hint">
              {tr.emptyHint}
            </p>
          </div>
        ) : (
          turns.map((turn) => <ChatBubble key={turn.id} turn={turn} />)
        )}
      </div>

      <div className="try-run-drawer-composer">
        <textarea
          className="try-run-drawer-textarea"
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          placeholder={tr.placeholder}
          rows={3}
          disabled={activeRunId !== null}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault()
              void handleSend()
            }
          }}
        />
        <div className="try-run-drawer-composer-actions">
          {activeRunId ? (
            <button
              type="button"
              className="try-run-drawer-btn try-run-drawer-btn-stop"
              onClick={() => void handleStop()}
            >
              <StopCircle size={12} />
              <span>{tr.stop}</span>
            </button>
          ) : (
            <button
              type="button"
              className="try-run-drawer-btn try-run-drawer-btn-send"
              onClick={() => void handleSend()}
              disabled={!canSend}
            >
              <Send size={12} />
              <span>{tr.send}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

const ChatBubble: React.FC<{ turn: ChatTurn }> = ({ turn }) => {
  const t = useT()
  const tr = t.workbench.tryRun
  const roleLabel = turn.role === 'user' ? tr.roleUser : tr.roleAssistant
  return (
    <div className={`try-run-bubble try-run-bubble-${turn.role}`}>
      <div className="try-run-bubble-meta">
        <span className="try-run-bubble-role">{roleLabel}</span>
        {turn.pending ? (
          <span className="try-run-bubble-state try-run-bubble-state-pending">
            <Loader2 size={10} className="is-spinning" /> {tr.generating}
          </span>
        ) : turn.error ? (
          <span className="try-run-bubble-state try-run-bubble-state-error">
            <AlertTriangle size={10} />
            {turn.error}
          </span>
        ) : turn.role === 'assistant' && turn.usage ? (
          <span className="try-run-bubble-state try-run-bubble-state-done">
            <CheckCircle2 size={10} />
            {turn.usage.inputTokens ?? 0} + {turn.usage.outputTokens ?? 0} tokens
          </span>
        ) : null}
      </div>
      <div className="try-run-bubble-body">
        {turn.content ? (
          turn.content
        ) : turn.pending ? (
          <span className="try-run-bubble-dim">{tr.waitingFirstToken}</span>
        ) : (
          <span className="try-run-bubble-dim">{tr.emptyReply}</span>
        )}
      </div>
    </div>
  )
}
