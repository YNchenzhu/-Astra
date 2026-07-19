/**
 * TerminationRecoveryBanner — Layer-E surface for recoverable agentic-loop
 * terminations.
 *
 * Renders right under the messages list when the most recent
 * `task_terminated` event indicates a recoverable failure (`max_turns`,
 * `model_error`, `aborted_streaming`, `aborted_tools`,
 * `output_budget_exhausted`, `iteration_boundary_stopped`, `hook_stopped`,
 * `stop_hook_prevented`). Reasons that are either clean
 * completions or non-recoverable (`completed`, `blocking_limit`,
 * `prompt_too_long`, `image_error`) are filtered out at the call site.
 *
 * Clicking "继续未完成的任务" populates the chat input with a continuation
 * directive and immediately invokes `sendMessage()`. The synthetic user
 * message is identical to what a user would type by hand — by design, so
 * the recovery path is auditable in the conversation transcript and the
 * existing send pipeline handles persistence, retries, etc. without a new
 * code path.
 *
 * The banner auto-hides on the next stream activity (because
 * `latestTerminationReason` is cleared by `sendSlice.sendMessage` and
 * repopulated only when a fresh failure event arrives).
 */
import React, { useCallback, useMemo } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { useChatStore } from '../../stores/useChatStore'

const RECOVERABLE_REASONS = new Set<string>([
  'max_turns',
  'model_error',
  'output_budget_exhausted',
  'aborted_streaming',
  'aborted_tools',
  'iteration_boundary_stopped',
  'hook_stopped',
  'stop_hook_prevented',
])

const REASON_DESCRIPTIONS: Record<string, string> = {
  max_turns: '已达到本轮迭代上限，任务可能未完成。',
  model_error: 'API 返回了不可恢复的错误。',
  output_budget_exhausted: '输出 token 预算已耗尽。',
  aborted_streaming: '上一轮在流式响应中被中止。',
  aborted_tools: '上一轮在工具执行中被中止。',
  iteration_boundary_stopped: '内核迭代边界钩子主动结束了任务。',
  hook_stopped: '工具执行钩子结束了任务。',
  stop_hook_prevented: 'Stop 钩子阻止了继续执行。',
}

const CONTINUATION_PROMPT = '继续未完成的任务'

interface Props {
  reason: string
}

export const TerminationRecoveryBanner: React.FC<Props> = ({ reason }) => {
  const isRecoverable = useMemo(() => RECOVERABLE_REASONS.has(reason), [reason])
  const description = REASON_DESCRIPTIONS[reason] ?? '上一轮提前结束。'
  const setInputText = useChatStore((s) => s.setInputText)
  const isTyping = useChatStore((s) => s.isTyping)

  const handleRetry = useCallback(async () => {
    if (isTyping) return
    const store = useChatStore.getState()
    setInputText(CONTINUATION_PROMPT)
    try {
      await store.sendMessage()
    } catch (err) {
      console.warn('[TerminationRecoveryBanner] sendMessage failed:', err)
    }
  }, [isTyping, setInputText])

  if (!isRecoverable) return null

  return (
    <div
      className="termination-recovery-banner"
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 8px',
        margin: '4px 12px',
        borderRadius: 'var(--radius-sm, 4px)',
        border: '1px solid rgba(var(--accent-peach-rgb), 0.28)',
        background: 'rgba(var(--accent-peach-rgb), 0.07)',
        color: 'var(--text-secondary)',
        fontSize: 12,
        lineHeight: 1.3,
      }}
    >
      <AlertCircle
        size={13}
        aria-hidden
        style={{ flexShrink: 0, color: 'var(--accent-peach)' }}
      />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {description}
      </span>
      <button
        type="button"
        onClick={handleRetry}
        disabled={isTyping}
        title="发送 “继续未完成的任务” 让 AI 接着干"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 8px',
          borderRadius: 'var(--radius-sm, 4px)',
          border: '1px solid rgba(var(--accent-peach-rgb), 0.35)',
          background: 'transparent',
          color: 'var(--accent-peach)',
          fontSize: 11,
          fontWeight: 500,
          cursor: isTyping ? 'not-allowed' : 'pointer',
          opacity: isTyping ? 0.5 : 1,
          flexShrink: 0,
          whiteSpace: 'nowrap',
        }}
      >
        <RefreshCw size={11} aria-hidden />
        继续
      </button>
    </div>
  )
}
