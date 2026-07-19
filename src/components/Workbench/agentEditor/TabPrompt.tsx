import React, { useCallback, useState } from 'react'
import { Loader2, AlertTriangle, Sparkles, RotateCcw } from 'lucide-react'
import type {
  AgentBundleEntry,
  PromptSection,
} from '../../../../electron/agents/bundles/types'
import type { OnFieldChange } from './constants'
import { PromptSectionsEditor } from '../PromptSectionsEditor'
import { GuidedPromptTemplate } from '../GuidedPromptTemplate'
import { useT } from '../../../i18n'

// ─── 提示词 Tab（可编辑，Sprint 2b.1）─────────────────────────────

/**
 * 提示词 Tab 支持三种状态：
 *   1. **已结构化**（effectiveAgent.promptSections 有值）
 *      → PromptSectionsEditor
 *   2. **自由文本**（effectiveAgent.systemPromptRaw 有值）
 *      → 单个 textarea + "切换为结构化"动作
 *   3. **内置（未覆盖）**
 *      → 说明 + "载入并转为可编辑"按钮（调 IPC 取内置 prompt 并 split）
 *
 * 所有写入都会：
 *   - 调 onChange('promptSections' | 'systemPromptRaw', ...) 写到 draftStore
 *   - 保存时由主进程 normalizeAgent 裁剪为合法形状
 *
 * 注意互斥：promptSections 存在时覆盖 systemPromptRaw；切换模式时我们
 * 主动把另一方清空（设为 undefined），保持 JSON 简洁、预览不歧义。
 */
type PromptEditorMode = 'guided' | 'sections' | 'raw'

export const TabPrompt: React.FC<{
  bundleId: string
  agentType: string
  agent: AgentBundleEntry
  onChange: OnFieldChange
}> = ({ bundleId, agentType, agent, onChange }) => {
  const t = useT()
  const tpt = t.workbench.promptTab
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const hasSections = Array.isArray(agent.promptSections) && agent.promptSections.length > 0
  const hasRaw =
    typeof agent.systemPromptRaw === 'string' && agent.systemPromptRaw.length > 0
  const hasAnyOverride = hasSections || hasRaw

  // 默认模式：
  //  - 自由文本优先(旧数据直接保留用户当初选的形态)
  //  - 其它情况(包括"无覆盖"和"只有结构化段落")都走引导模式,
  //    因为引导模式对段落兼容,且对"零基础填空"友好度最高。
  const [mode, setMode] = useState<PromptEditorMode>(hasRaw ? 'raw' : 'guided')

  /** 调主进程拿到内置 prompt 并拆分,塞进 draft 的 promptSections;
   *  作为 "从内置开始改" 的一次性种子操作,不是默认路径。 */
  const handleLoadBuiltin = useCallback(async () => {
    const bridge =
      typeof window !== 'undefined'
        ? (window as unknown as { electronAPI?: Window['electronAPI'] }).electronAPI?.bundle
        : undefined
    if (!bridge?.getBuiltinPrompt) {
      setLoadError(tpt.loadBuiltinUnavailable)
      return
    }
    setLoading(true)
    setLoadError(null)
    try {
      const res = await bridge.getBuiltinPrompt({ bundleId, agentType })
      if (!res.ok) {
        setLoadError(res.error)
        return
      }
      if (!res.sections || res.sections.length === 0) {
        setLoadError(tpt.builtinEmpty)
        return
      }
      onChange('promptSections', res.sections as PromptSection[])
      onChange('systemPromptRaw', undefined)
      setMode('guided')
    } catch (err) {
      setLoadError(tpt.loadFailed(err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }, [bundleId, agentType, onChange, tpt])

  /** 清空所有覆盖,恢复为内置 prompt。 */
  const handleRevertToBuiltin = useCallback(() => {
    onChange('promptSections', undefined)
    onChange('systemPromptRaw', undefined)
    setMode('guided')
  }, [onChange])

  /** 模式切换时的数据迁移。核心策略:保持用户已经输入的文本不丢。 */
  const switchMode = useCallback(
    (next: PromptEditorMode) => {
      if (next === mode) return
      if (next === 'raw') {
        // 引导 / 段落 → 自由文本：按 order 合成 markdown,写入 systemPromptRaw,
        // 清空 promptSections。
        const merged = (agent.promptSections ?? [])
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((s) =>
            s.title && s.title.trim().length > 0 ? `## ${s.title}\n\n${s.body}` : s.body,
          )
          .join('\n\n')
          .trim()
        if (merged.length > 0) {
          onChange('systemPromptRaw', merged)
          onChange('promptSections', undefined)
        }
        setMode('raw')
        return
      }
      // → guided 或 → sections
      if (hasRaw && !hasSections) {
        // 自由文本 → 结构化:按 ## 标题拆分。无 ## 则整段变成 role 段。
        const raw = (agent.systemPromptRaw ?? '').trim()
        if (raw.length > 0) {
          const lines = raw.split(/\r?\n/)
          const result: PromptSection[] = []
          let currentTitle: string | null = null
          let currentBody: string[] = []
          const flush = () => {
            const body = currentBody.join('\n').trim()
            if (currentTitle === null && body.length === 0) return
            const order = result.length
            const id =
              (currentTitle ?? 'role')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '') || `section_${order}`
            result.push({
              id,
              title: currentTitle ?? 'Role',
              body,
              order,
            })
          }
          for (const line of lines) {
            const m = /^##\s+(.+?)\s*$/.exec(line)
            if (m) {
              flush()
              currentTitle = m[1]
              currentBody = []
            } else {
              currentBody.push(line)
            }
          }
          flush()
          if (result.length > 0) {
            onChange('promptSections', result)
            onChange('systemPromptRaw', undefined)
          }
        }
      }
      setMode(next)
    },
    [mode, hasRaw, hasSections, agent.promptSections, agent.systemPromptRaw, onChange],
  )

  const renderModeSwitcher = () => (
    <div className="agent-editor-prompt-mode-switch" role="tablist" aria-label={tpt.modeSwitcherAria}>
      {(
        [
          { id: 'guided', label: tpt.modeGuided, hint: tpt.modeGuidedHint },
          { id: 'sections', label: tpt.modeSections, hint: tpt.modeSectionsHint },
          { id: 'raw', label: tpt.modeRaw, hint: tpt.modeRawHint },
        ] as const
      ).map((m) => (
        <button
          key={m.id}
          type="button"
          role="tab"
          aria-selected={mode === m.id}
          className={`agent-editor-prompt-mode-btn ${mode === m.id ? 'is-active' : ''}`}
          onClick={() => switchMode(m.id)}
          title={m.hint}
        >
          {m.label}
        </button>
      ))}
    </div>
  )

  return (
    <div className="agent-editor-panel">
      <div className="agent-editor-prompt-toolbar">
        {renderModeSwitcher()}
        <div className="agent-editor-prompt-toolbar-actions">
          <button
            type="button"
            className="agent-editor-btn agent-editor-btn-ghost"
            onClick={handleLoadBuiltin}
            disabled={loading}
            title={tpt.loadBuiltinTitle}
          >
            {loading ? (
              <Loader2 size={12} className="is-spinning" />
            ) : (
              <Sparkles size={12} />
            )}
            <span>{loading ? tpt.loading : tpt.loadBuiltin}</span>
          </button>
          {hasAnyOverride ? (
            <button
              type="button"
              className="agent-editor-btn agent-editor-btn-ghost"
              onClick={handleRevertToBuiltin}
              title={tpt.revertTitle}
            >
              <RotateCcw size={12} />
              <span>{tpt.revert}</span>
            </button>
          ) : null}
        </div>
      </div>

      {loadError ? (
        <div className="agent-editor-error-banner" role="alert">
          <AlertTriangle size={12} />
          <span>{loadError}</span>
        </div>
      ) : null}

      {mode === 'guided' ? (
        <GuidedPromptTemplate
          sections={agent.promptSections}
          onChange={(next) => {
            if (!next || next.length === 0) {
              onChange('promptSections', undefined)
            } else {
              onChange('promptSections', next)
            }
            // 引导模式写入时自然属于结构化段落态;若原来有 raw 则清空
            if (hasRaw) onChange('systemPromptRaw', undefined)
          }}
          onSwitchToAdvanced={() => setMode('sections')}
        />
      ) : mode === 'sections' ? (
        <PromptSectionsEditor
          sections={agent.promptSections ?? []}
          onChange={(next) => {
            if (next.length === 0) {
              onChange('promptSections', undefined)
            } else {
              onChange('promptSections', next)
            }
            if (hasRaw) onChange('systemPromptRaw', undefined)
          }}
        />
      ) : (
        <textarea
          className="agent-editor-prompt-raw"
          value={agent.systemPromptRaw ?? ''}
          placeholder={tpt.rawPlaceholder}
          rows={16}
          onChange={(e) => {
            const v = e.currentTarget.value
            onChange('systemPromptRaw', v.length > 0 ? v : undefined)
          }}
        />
      )}
    </div>
  )
}
