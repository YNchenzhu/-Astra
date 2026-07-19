/**
 * HookListEditor —— 钩子列表编辑器（Sprint 2b.3）
 *
 * 通用组件,可被两处复用:
 *   1. **工作台 Tab 6** ── 编辑 `AgentBundleEntry.agentHooks[]`
 *   2. **Settings 全局钩子** (后续把 SettingsDialog 里的 `renderHooks` 重写)
 *
 * 一条 Hook = `{ event, matcher, command, async?, executionKind? }`
 *
 * UX 决策:
 *   - 每条钩子用卡片展示,展开式字段(和 PromptSectionsEditor 一致)
 *   - event 是下拉(HOOK_EVENTS 常量列表);但允许输入自定义(插件扩展场景)
 *   - matcher 是单行 input,hint 提示"对 event 的细化匹配,支持正则"
 *   - command 是多行 textarea,支持脚本粘贴
 *   - async / executionKind 折叠在"高级选项"折叠区,避免一眼看花
 *   - 条目之间 ↑↓ 移动按钮,保留编写顺序(部分事件顺序有意义)
 *
 * 数据流: 父组件持有 `hooks: AgentHookSpec[]`,每次改动通过 onChange
 * 回调返回新数组,内部不维护状态(除了"哪些条目展开高级区"这个 UI 状态)。
 */

import React, { useCallback, useMemo, useRef, useState } from 'react'
import {
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  ChevronRight,
} from 'lucide-react'
import { HOOK_EVENTS, type HookEvent } from '../../types/hooks'
import './HookListEditor.css'

/** 与 `electron/agents/types.ts` 的 AgentHookSpec 对齐的渲染端类型。 */
export interface HookSpec {
  event: string
  matcher: string
  command: string
  async?: boolean
  executionKind?: 'command' | 'prompt' | 'agent' | 'http'
}

export interface HookListEditorProps {
  hooks: HookSpec[]
  onChange: (next: HookSpec[]) => void
  /** 自定义"添加"按钮文案,默认"添加钩子"。 */
  addLabel?: string
  /** 空状态提示文案。 */
  emptyText?: string
  readOnly?: boolean
}

const EXEC_KIND_OPTIONS: Array<{ value: HookSpec['executionKind'] | ''; label: string }> = [
  { value: '', label: '（默认 command）' },
  { value: 'command', label: '命令（Shell 执行）' },
  { value: 'prompt', label: '提示词注入' },
  { value: 'agent', label: '触发智能体' },
  { value: 'http', label: 'HTTP 回调' },
]

/** 中文描述集,帮助用户理解冷门事件名。 */
const EVENT_HINTS: Partial<Record<HookEvent, string>> = {
  PreToolUse: '工具调用前',
  PostToolUse: '工具调用后',
  PostToolUseFailure: '工具调用失败后',
  UserPromptSubmit: '用户发送提示词时',
  SessionStart: '会话启动时',
  SessionEnd: '会话结束时',
  Stop: '智能体停止时',
  StopFailure: '智能体失败停止时',
  Subagent: '子智能体相关',
  SubagentStart: '子智能体启动',
  SubagentStop: '子智能体停止',
  PermissionRequest: '请求权限时',
  PermissionDenied: '权限被拒时',
  FileChanged: '文件被修改',
  CwdChanged: '工作目录变更',
  Notification: '产生通知',
  TaskCreated: '任务创建',
  TaskCompleted: '任务完成',
  PreCompact: '压缩上下文前',
  PostCompact: '压缩上下文后',
  PreSkillUse: '使用技能前',
  PostSkillUse: '使用技能后',
  StatusLine: '状态栏刷新',
  FileSuggestion: '文件建议生成',
  Elicitation: '请求用户输入',
  ElicitationResult: '用户输入返回',
}

export const HookListEditor: React.FC<HookListEditorProps> = ({
  hooks,
  onChange,
  addLabel = '添加钩子',
  emptyText = '当前没有钩子。点击下方按钮新增一条。',
  readOnly,
}) => {
  // 哪些条目展开了"高级选项"折叠区(按索引记录,但索引会随重排变化 ——
  // 这里选择用简单 Set<number>,重排/删除时让其自然失效;不需要稳定的
  // 跨重排展开态,重排后折叠即可,用户体验完全可接受)。
  const [advancedOpen, setAdvancedOpen] = useState<Set<number>>(new Set())
  const lastAddedIdxRef = useRef<number | null>(null)

  const emit = useCallback(
    (next: HookSpec[]) => {
      onChange(next)
    },
    [onChange],
  )

  const handleAdd = useCallback(() => {
    const next: HookSpec[] = [
      ...hooks,
      {
        event: 'PreToolUse',
        matcher: '',
        command: '',
      },
    ]
    lastAddedIdxRef.current = next.length - 1
    emit(next)
  }, [hooks, emit])

  const handleDelete = useCallback(
    (idx: number) => {
      const next = hooks.slice()
      next.splice(idx, 1)
      emit(next)
      setAdvancedOpen((prev) => {
        const n = new Set<number>()
        for (const i of prev) {
          if (i < idx) n.add(i)
          else if (i > idx) n.add(i - 1)
        }
        return n
      })
    },
    [hooks, emit],
  )

  const handleMove = useCallback(
    (idx: number, direction: -1 | 1) => {
      const target = idx + direction
      if (target < 0 || target >= hooks.length) return
      const next = hooks.slice()
      ;[next[idx], next[target]] = [next[target], next[idx]]
      emit(next)
      // 不维护展开态跨重排 —— 简单清空
      setAdvancedOpen(new Set())
    },
    [hooks, emit],
  )

  const handleFieldChange = useCallback(
    <K extends keyof HookSpec>(idx: number, field: K, value: HookSpec[K]) => {
      const next = hooks.slice()
      next[idx] = { ...next[idx], [field]: value }
      emit(next)
    },
    [hooks, emit],
  )

  const toggleAdvanced = useCallback((idx: number) => {
    setAdvancedOpen((prev) => {
      const n = new Set(prev)
      if (n.has(idx)) n.delete(idx)
      else n.add(idx)
      return n
    })
  }, [])

  const eventOptions = useMemo(
    () =>
      HOOK_EVENTS.map((ev) => ({
        value: ev,
        label: EVENT_HINTS[ev] ? `${ev} · ${EVENT_HINTS[ev]}` : ev,
      })),
    [],
  )

  return (
    <div className="hook-list-editor">
      {hooks.length === 0 ? (
        <div className="hook-list-empty">{emptyText}</div>
      ) : (
        // Transient "just-added" marker for the one-shot pulse
        // animation. See sibling comment in `PromptSectionsEditor` —
        // the ref is deliberately non-reactive here. The rule points
        // at the callback head, so the suppression lives on that line.
        // eslint-disable-next-line react-hooks/refs
        hooks.map((hook, idx) => {
          const isFirst = idx === 0
          const isLast = idx === hooks.length - 1
          const isNew = lastAddedIdxRef.current === idx
          const isAdvOpen = advancedOpen.has(idx)
          // 已知事件(在 HOOK_EVENTS 列表里)→ 用 select;否则退化为 input
          const knownEvent = (HOOK_EVENTS as readonly string[]).includes(hook.event)

          return (
            <div key={idx} className={`hook-card ${isNew ? 'is-new' : ''}`}>
              <div className="hook-card-header">
                <span className="hook-card-index">#{idx + 1}</span>

                {knownEvent ? (
                  <select
                    className="hook-event-select"
                    value={hook.event}
                    disabled={readOnly}
                    onChange={(e) => handleFieldChange(idx, 'event', e.currentTarget.value)}
                    title="选择触发事件"
                  >
                    {eventOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                    {/* 当 hook.event 不在列表中时(未来扩展事件),保留它 */}
                  </select>
                ) : (
                  <input
                    className="hook-event-select"
                    type="text"
                    value={hook.event}
                    disabled={readOnly}
                    onChange={(e) => handleFieldChange(idx, 'event', e.currentTarget.value)}
                    placeholder="自定义事件名"
                    title="自定义事件名"
                  />
                )}

                {readOnly ? null : (
                  <div className="hook-card-actions">
                    <button
                      type="button"
                      className="hook-icon-btn"
                      title="上移"
                      disabled={isFirst}
                      onClick={() => handleMove(idx, -1)}
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      type="button"
                      className="hook-icon-btn"
                      title="下移"
                      disabled={isLast}
                      onClick={() => handleMove(idx, 1)}
                    >
                      <ArrowDown size={12} />
                    </button>
                    <button
                      type="button"
                      className="hook-icon-btn hook-icon-btn-danger"
                      title="删除钩子"
                      onClick={() => handleDelete(idx)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )}
              </div>

              <div className="hook-field-row">
                <label className="hook-field-label">匹配规则</label>
                <input
                  className="hook-input"
                  type="text"
                  value={hook.matcher}
                  placeholder="例如:工具名 Read/Write 或正则(.*_test)"
                  disabled={readOnly}
                  onChange={(e) => handleFieldChange(idx, 'matcher', e.currentTarget.value)}
                />
              </div>

              <div className="hook-field-row">
                <label className="hook-field-label">命令</label>
                <textarea
                  className="hook-textarea"
                  value={hook.command}
                  rows={Math.max(2, Math.min(8, hook.command.split('\n').length + 1))}
                  placeholder="Shell 命令 / 提示词 / 智能体 type / HTTP URL(根据执行类型决定)"
                  disabled={readOnly}
                  onChange={(e) => handleFieldChange(idx, 'command', e.currentTarget.value)}
                />
              </div>

              {/* 高级折叠区: async + executionKind */}
              <button
                type="button"
                className="hook-advanced-toggle"
                onClick={() => toggleAdvanced(idx)}
              >
                <ChevronRight
                  size={11}
                  className={`hook-advanced-chevron ${isAdvOpen ? 'is-open' : ''}`}
                />
                <span>高级选项</span>
              </button>

              {isAdvOpen ? (
                <div className="hook-advanced-body">
                  <div className="hook-field-row">
                    <label className="hook-field-label">异步</label>
                    <label className="hook-checkbox-inline">
                      <input
                        type="checkbox"
                        checked={hook.async === true}
                        disabled={readOnly}
                        onChange={(e) =>
                          handleFieldChange(
                            idx,
                            'async',
                            e.currentTarget.checked ? true : undefined,
                          )
                        }
                      />
                      <span>
                        {hook.async === true
                          ? '异步执行(不阻塞主流程)'
                          : '同步执行(默认)'}
                      </span>
                    </label>
                  </div>
                  <div className="hook-field-row">
                    <label className="hook-field-label">执行类型</label>
                    <select
                      className="hook-input hook-exec-select"
                      value={hook.executionKind ?? ''}
                      disabled={readOnly}
                      onChange={(e) => {
                        const v = e.currentTarget.value
                        handleFieldChange(
                          idx,
                          'executionKind',
                          v === '' ? undefined : (v as HookSpec['executionKind']),
                        )
                      }}
                    >
                      {EXEC_KIND_OPTIONS.map((opt) => (
                        <option key={opt.value ?? ''} value={opt.value ?? ''}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : null}
            </div>
          )
        })
      )}

      {readOnly ? null : (
        <button type="button" className="hook-list-add" onClick={handleAdd}>
          <Plus size={13} />
          <span>{addLabel}</span>
        </button>
      )}
    </div>
  )
}
