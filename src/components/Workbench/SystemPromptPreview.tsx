/**
 * 工作台右栏 —— 系统提示词实时预览。
 *
 * 合成逻辑镜像主进程 `composeSystemPrompt`（electron/agents/bundles/
 * bundleSerialize.ts），但在渲染进程直接执行，这样用户在中间面板修改
 * 提示词时预览能够零延迟更新。
 *
 * 解析顺序：
 *   1. `promptSections` → 按 order 排序拼接 "## <标题>\n\n<正文>"
 *   2. `systemPromptRaw` → 原样展示
 *   3. 内置智能体且未覆盖 → 展示说明占位
 *
 * 对 bundle-meta / team 选中项显示工作包整体信息而非 agent prompt。
 *
 * Sprint 2b.1：预览会叠加当前草稿（workbenchDraftStore）。即用户在
 * 中间面板敲字时预览立即刷新，方便"边写边看合成效果"。
 */
import React, { useMemo } from 'react'
import type {
  Bundle,
  AgentBundleEntry,
  PromptSection,
} from '../../../electron/agents/bundles/types'
import type { WorkbenchSelection } from './AgentWorkbench'
import { useWorkbenchDraftStore, applyDraft } from '../../stores/workbenchDraftStore'
import { useT } from '../../i18n'
import './SystemPromptPreview.css'

interface Props {
  bundles: Bundle[]
  selection: WorkbenchSelection
}

/** 把结构化段落合成为最终运行时 prompt（与主进程 composeSystemPrompt 一致）。 */
function composeFromSections(sections: PromptSection[]): string {
  return sections
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((s) => (s.title && s.title.trim().length > 0 ? `## ${s.title}\n\n${s.body}` : s.body))
    .join('\n\n')
    .trim()
}

export const SystemPromptPreview: React.FC<Props> = ({ bundles, selection }) => {
  const t = useT()
  const sp = t.workbench.systemPromptPreview
  const resolved = useMemo(() => {
    if (selection.kind === 'none') return null
    const bundle = bundles.find((b) => b.meta.id === selection.bundleId) ?? null
    if (!bundle) return null
    if (selection.kind === 'agent') {
      const agent = bundle.agents.find((a) => a.agentType === selection.agentType) ?? null
      return { bundle, agent }
    }
    return { bundle, agent: null as AgentBundleEntry | null }
  }, [bundles, selection])

  // 读取当前选中 agent 的草稿（若无 agent 选中或无草稿则 undefined）。
  const draft = useWorkbenchDraftStore((s) => {
    if (selection.kind !== 'agent') return undefined
    return s.drafts[`${selection.bundleId}::${selection.agentType}`]
  })

  // Extract `resolved?.agent` once so the dep array matches React Compiler's inferred
  // property accesses exactly (was: `[resolved?.agent, draft]` triggering
  // `preserve-manual-memoization` because the compiler inferred `resolved` as the source
  // dependency, which is wider than what the body actually reads).
  const resolvedAgent = resolved?.agent ?? null
  const effectiveAgent = useMemo<AgentBundleEntry | null>(
    () => (resolvedAgent ? applyDraft(resolvedAgent, draft) : null),
    [resolvedAgent, draft],
  )

  if (!resolved) {
    return (
      <div className="prompt-preview">
        <div className="prompt-preview-header">{sp.preview}</div>
        <div className="prompt-preview-empty">{sp.selectToView}</div>
      </div>
    )
  }

  const { bundle } = resolved

  // ── 工作包概览（bundle-meta / team 选中时）──
  // 注意:旧版本这里展示了 layout / capabilities.* 字段,但这些是**没有接入
  // 运行时**的死字段(主界面永远是 IDE 布局;capabilities.* 未被任何路径消费)。
  // 为避免误导用户"我在这配的东西有用",只保留真实生效的概览项:欢迎语。
  if (selection.kind === 'bundle-meta' || selection.kind === 'team') {
    return (
      <div className="prompt-preview">
        <div className="prompt-preview-header">{sp.bundleOverview}</div>
        <div className="prompt-preview-section">
          <div className="prompt-preview-label">{sp.basicInfo}</div>
          <div className="prompt-preview-value">
            <div className="prompt-preview-sublabel">
              {sp.idLabel}<span className="mono">{bundle.meta.id}</span>
            </div>
            {bundle.meta.domain ? (
              <div className="prompt-preview-sublabel">{sp.domainLabel}{bundle.meta.domain}</div>
            ) : null}
            <div className="prompt-preview-sublabel">
              {sp.members(bundle.agents.length, bundle.teams.length)}
            </div>
          </div>
        </div>

        {bundle.welcomeMessage ? (
          <div className="prompt-preview-section">
            <div className="prompt-preview-label">{sp.welcome}</div>
            <pre className="prompt-preview-pre">{bundle.welcomeMessage}</pre>
          </div>
        ) : null}
      </div>
    )
  }

  // ── Agent 系统提示词预览 ──
  if (!effectiveAgent) {
    return (
      <div className="prompt-preview">
        <div className="prompt-preview-header">{sp.preview}</div>
        <div className="prompt-preview-empty">{sp.agentNotFound}</div>
      </div>
    )
  }

  const hasSections =
    Array.isArray(effectiveAgent.promptSections) && effectiveAgent.promptSections.length > 0
  const hasRaw =
    typeof effectiveAgent.systemPromptRaw === 'string' &&
    effectiveAgent.systemPromptRaw.trim().length > 0

  if (hasSections) {
    const composed = composeFromSections(effectiveAgent.promptSections!)
    return (
      <div className="prompt-preview">
        <div className="prompt-preview-header">{sp.promptFromSections}</div>
        <pre className="prompt-preview-pre prompt-preview-prompt">{composed}</pre>
      </div>
    )
  }

  if (hasRaw) {
    return (
      <div className="prompt-preview">
        <div className="prompt-preview-header">{sp.promptRaw}</div>
        <pre className="prompt-preview-pre prompt-preview-prompt">
          {effectiveAgent.systemPromptRaw}
        </pre>
      </div>
    )
  }

  // 内置智能体且未被用户覆盖 —— 运行时 prompt 在主进程代码里。
  return (
    <div className="prompt-preview">
      <div className="prompt-preview-header">{sp.promptTitle}</div>
      <div className="prompt-preview-builtin">
        <p>
          <strong>{effectiveAgent.displayName ?? effectiveAgent.agentType}</strong>
          {sp.builtinNoteSuffix}
        </p>
        <p>
          {sp.builtinNote2Prefix}
          <strong>{sp.builtinNote2Strong}</strong>
          {sp.builtinNote2Mid}<code>## </code>
          {sp.builtinNote2Suffix}
        </p>
      </div>
    </div>
  )
}
