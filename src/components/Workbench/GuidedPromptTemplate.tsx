/**
 * GuidedPromptTemplate —— 面向"不懂 AI"用户的填空式提示词编辑器。
 *
 * 设计目标：把一段合格的智能体提示词拆成 5 个语义清晰的槽位，
 * 每个槽位有中文标签 + 说明 + 示例占位。改版后采用 **横向标签**
 * 布局:5 个段落变成 5 个 tab,当前 tab 的输入区铺满可视区域;
 * 没填的 tab 会显示"待填写"徽标,填了内容的 tab 亮一个绿点,
 * 用户一眼就能看到总体完成度。
 *
 * 数据层：
 *   - 每个槽位 id 对应 `BUILTIN_PROMPT_SECTION_IDS`，和主进程拆分
 *     / 合成逻辑天然兼容，不会因为中文标题导致 id 丢失。
 *   - 保存时仅把 body 非空的槽位写入 `promptSections[]`，保持磁盘
 *     JSON 清爽。
 *   - 读取时按 id 匹配已有段落 body；未知 id 的段落（老数据里用户
 *     自加的标题）会在底部提示切换到高级段落编辑。
 *
 * 故意不做：
 *   - 不搞实时预览 —— 右栏 SystemPromptPreview 已经能看到合成后的
 *     完整 prompt。
 *   - 不自动补默认 body —— 空槽位表示 "没要求"，直接跳过而不是塞
 *     一段无用的默认文案。
 */
import React, { useCallback, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Sparkles } from 'lucide-react'
import type { PromptSection } from '../../../electron/agents/bundles/types'
import { useT, type Messages } from '../../i18n'
import './GuidedPromptTemplate.css'

// ─── 模板槽位定义 ──────────────────────────────────────────────────

interface TemplateSlot {
  /** 持久化主键，匹配 BUILTIN_PROMPT_SECTION_IDS */
  id: 'role' | 'strengths' | 'guidelines' | 'constraints' | 'report_format'
  /** 渲染成 `## {title}` 的段落标题 —— 用英文以便 LLM 识别结构 */
  title: string
  /** 推荐最小行数 */
  minRows: number
  /** `role` 建议有内容；其它槽位可以完全空着 */
  recommended?: boolean
}

const TEMPLATE_SLOTS: readonly TemplateSlot[] = [
  { id: 'role', title: 'Role', minRows: 6, recommended: true },
  { id: 'strengths', title: 'Your strengths', minRows: 8 },
  { id: 'guidelines', title: 'Guidelines', minRows: 8 },
  { id: 'constraints', title: 'Constraints', minRows: 8 },
  { id: 'report_format', title: 'Report format', minRows: 8 },
] as const

type SlotId = TemplateSlot['id']

const SLOT_IDS = new Set<SlotId>(TEMPLATE_SLOTS.map((s) => s.id))

/** 从 i18n 取某槽位的本地化 label / hint / placeholder。 */
function slotText(id: SlotId, g: Messages['workbench']['guided']): {
  label: string
  hint: string
  placeholder: string
} {
  switch (id) {
    case 'strengths':
      return { label: g.strengthsLabel, hint: g.strengthsHint, placeholder: g.strengthsPlaceholder }
    case 'guidelines':
      return { label: g.guidelinesLabel, hint: g.guidelinesHint, placeholder: g.guidelinesPlaceholder }
    case 'constraints':
      return { label: g.constraintsLabel, hint: g.constraintsHint, placeholder: g.constraintsPlaceholder }
    case 'report_format':
      return { label: g.reportFormatLabel, hint: g.reportFormatHint, placeholder: g.reportFormatPlaceholder }
    default:
      return { label: g.roleLabel, hint: g.roleHint, placeholder: g.rolePlaceholder }
  }
}

// ─── Component ────────────────────────────────────────────────────

export interface GuidedPromptTemplateProps {
  /** 当前已保存 / draft 中的段落数组。可以为空。 */
  sections: PromptSection[] | undefined
  /** 每次字段改动时回调；传入重算后的完整 sections 数组。 */
  onChange: (next: PromptSection[] | undefined) => void
  /** 用户点 "切换为高级段落编辑" 时触发；由上层决定下一步显示哪种编辑器。 */
  onSwitchToAdvanced?: () => void
}

export const GuidedPromptTemplate: React.FC<GuidedPromptTemplateProps> = ({
  sections,
  onChange,
  onSwitchToAdvanced,
}) => {
  const t = useT()
  const g = t.workbench.guided
  /** 按槽位 id 索引当前 body。命中的槽位用已有 body，否则为 ''。 */
  const slotBodyById = useMemo(() => {
    const map: Record<string, string> = {}
    for (const s of sections ?? []) {
      map[s.id] = typeof s.body === 'string' ? s.body : ''
    }
    return map
  }, [sections])

  /** 已有但不属于模板槽位的段落 —— 提示用户这些只能在高级模式里编辑。 */
  const extraSections = useMemo(() => {
    if (!sections || sections.length === 0) return []
    return sections.filter((s) => !SLOT_IDS.has(s.id as SlotId))
  }, [sections])

  // 当前激活的 tab。初始聚焦到第一个没填的槽位(或第 0 个)便于
  // 新手一打开就从头开始填;如果所有槽位都已填,默认停在第 0 个。
  const initialActiveId = useMemo<SlotId>(() => {
    for (const s of TEMPLATE_SLOTS) {
      if (!(slotBodyById[s.id] ?? '').trim()) return s.id
    }
    return TEMPLATE_SLOTS[0].id
    // 故意只在 mount 时算一次,用户切 tab 后不再跟随 body 变化跳走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [activeId, setActiveId] = useState<SlotId>(initialActiveId)
  const activeSlot = useMemo(
    () => TEMPLATE_SLOTS.find((s) => s.id === activeId) ?? TEMPLATE_SLOTS[0],
    [activeId],
  )

  // 完成度(非空槽位占比)——一条细进度条展示,给用户成就感。
  const filledCount = useMemo(
    () =>
      TEMPLATE_SLOTS.reduce(
        (n, s) => n + ((slotBodyById[s.id] ?? '').trim().length > 0 ? 1 : 0),
        0,
      ),
    [slotBodyById],
  )
  const totalCount = TEMPLATE_SLOTS.length
  const progressPct = Math.round((filledCount / totalCount) * 100)

  /** 写回某个槽位 —— 空 body 视为"清掉该段落"。 */
  const handleSlotChange = useCallback(
    (slot: TemplateSlot, nextBody: string) => {
      const prev = sections ?? []
      // 先把所有模板槽位条目剥离(避免重复),其它自定义段落原样保留。
      const others = prev.filter((s) => !SLOT_IDS.has(s.id as SlotId))
      const nextSlotBody: Record<SlotId, string> = {
        role: slot.id === 'role' ? nextBody : slotBodyById['role'] ?? '',
        strengths: slot.id === 'strengths' ? nextBody : slotBodyById['strengths'] ?? '',
        guidelines: slot.id === 'guidelines' ? nextBody : slotBodyById['guidelines'] ?? '',
        constraints: slot.id === 'constraints' ? nextBody : slotBodyById['constraints'] ?? '',
        report_format:
          slot.id === 'report_format' ? nextBody : slotBodyById['report_format'] ?? '',
      }

      const orderedSlotSections: PromptSection[] = []
      let order = 0
      for (const s of TEMPLATE_SLOTS) {
        const b = nextSlotBody[s.id].trim()
        if (b.length === 0) continue
        orderedSlotSections.push({
          id: s.id,
          title: s.title,
          body: nextSlotBody[s.id],
          order: order++,
        })
      }
      const reorderedOthers = others.map((s) => ({ ...s, order: order++ }))
      const combined = [...orderedSlotSections, ...reorderedOthers]

      if (combined.length === 0) {
        onChange(undefined)
      } else {
        onChange(combined)
      }
    },
    [onChange, sections, slotBodyById],
  )

  const activeBody = slotBodyById[activeSlot.id] ?? ''
  const activeFilled = activeBody.trim().length > 0

  return (
    <div className="guided-prompt">
      <div className="guided-prompt-intro">
        <Sparkles size={14} className="guided-prompt-intro-icon" />
        <div className="guided-prompt-intro-text">
          <div className="guided-prompt-intro-title">{g.introTitle}</div>
          <div className="guided-prompt-intro-body">
            {g.introBody}
          </div>
        </div>
        <div className="guided-prompt-progress" aria-label={g.progressAria(filledCount, totalCount)}>
          <div className="guided-prompt-progress-label">
            <span className="guided-prompt-progress-num">
              {filledCount} / {totalCount}
            </span>
            <span className="guided-prompt-progress-hint">{g.filled}</span>
          </div>
          <div className="guided-prompt-progress-bar">
            <div
              className="guided-prompt-progress-fill"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* ─── 横向标签 ─── */}
      <div className="guided-prompt-tabs" role="tablist" aria-label={g.tabsAria}>
        {TEMPLATE_SLOTS.map((slot, idx) => {
          const filled = (slotBodyById[slot.id] ?? '').trim().length > 0
          const isActive = slot.id === activeId
          const st = slotText(slot.id, g)
          return (
            <button
              key={slot.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`guided-prompt-tab ${isActive ? 'is-active' : ''} ${
                filled ? 'is-filled' : 'is-empty'
              }`}
              onClick={() => setActiveId(slot.id)}
              title={st.hint}
            >
              <span className="guided-prompt-tab-index">{idx + 1}</span>
              <span className="guided-prompt-tab-label">{st.label}</span>
              {filled ? (
                <CheckCircle2
                  size={12}
                  className="guided-prompt-tab-check"
                  aria-hidden
                />
              ) : (
                <span className="guided-prompt-tab-dot" aria-hidden />
              )}
            </button>
          )
        })}
      </div>

      {/* ─── 当前 tab 内容 ─── */}
      <div className="guided-prompt-pane" role="tabpanel">
        <div className="guided-prompt-pane-head">
          <div className="guided-prompt-pane-titles">
            <span className="guided-prompt-pane-label">{slotText(activeSlot.id, g).label}</span>
            <span className="guided-prompt-pane-title-en">{activeSlot.title}</span>
          </div>
          {activeSlot.recommended ? (
            <span className="guided-prompt-pane-badge is-recommended">{g.recommended}</span>
          ) : (
            <span className="guided-prompt-pane-badge">{g.optional}</span>
          )}
          {activeFilled ? (
            <span className="guided-prompt-pane-status is-filled">
              <CheckCircle2 size={12} /> {g.statusFilled}
            </span>
          ) : (
            <span className="guided-prompt-pane-status">{g.statusPending}</span>
          )}
        </div>
        <div className="guided-prompt-pane-hint">{slotText(activeSlot.id, g).hint}</div>
        <textarea
          className="guided-prompt-pane-input"
          value={activeBody}
          placeholder={slotText(activeSlot.id, g).placeholder}
          rows={Math.max(activeSlot.minRows, Math.min(22, activeBody.split('\n').length + 2))}
          onChange={(e) => handleSlotChange(activeSlot, e.currentTarget.value)}
        />
      </div>

      {/* ─── 自定义(非模板)段落提示 ─── */}
      {extraSections.length > 0 ? (
        <div className="guided-prompt-extras">
          <div className="guided-prompt-extras-head">
            <AlertTriangle size={13} className="guided-prompt-extras-icon" />
            <div>
              <div className="guided-prompt-extras-title">
                {g.extrasTitle(extraSections.length)}
              </div>
              <div className="guided-prompt-extras-body">
                {g.extrasBody}
              </div>
            </div>
          </div>
          <ul className="guided-prompt-extras-list">
            {extraSections.map((s) => (
              <li key={s.id} className="guided-prompt-extras-item">
                <span className="guided-prompt-extras-item-title">{s.title || s.id}</span>
                <span className="guided-prompt-extras-item-hint">
                  {s.body.length > 60 ? `${s.body.slice(0, 60)}…` : s.body || g.empty}
                </span>
              </li>
            ))}
          </ul>
          {onSwitchToAdvanced ? (
            <button
              type="button"
              className="guided-prompt-extras-action"
              onClick={onSwitchToAdvanced}
            >
              {g.switchToSections}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * 判断给定 sections 数组是否可以 "用引导模板展示" ——
 *   - 空数组：可以（空模板）
 *   - 只有模板槽位 id：可以
 *   - 含有自定义 id 段落：仍然可以（额外段落会在提示区列出，不影响编辑）
 */
// Template-compatibility predicate, co-located with the editor that
// consumes it. Extraction would fragment a small, tightly coupled API.
// eslint-disable-next-line react-refresh/only-export-components
export function sectionsAreTemplateCompatible(
  sections: PromptSection[] | undefined,
): boolean {
  if (!sections || sections.length === 0) return true
  return sections.every((s) => SLOT_IDS.has(s.id as SlotId))
}
