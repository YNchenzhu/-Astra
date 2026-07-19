import React, { useState, useEffect } from 'react'
import { ArrowLeft } from 'lucide-react'
import {
  getContextState,
  getContextThresholds,
  setContextThresholds,
  resetContext,
  analyzeContextLive,
  getRegistryContextWindows,
  getUserContextWindowOverrides,
  setUserContextWindowOverride,
  clearUserContextWindowOverride,
  type ContextState,
  type ContextThresholds,
} from '../../../services/electronAPI'
import type { ContextAnalysisResult } from '../../../types'

const LEVEL_LABELS: Record<string, string> = {
  ok: '正常',
  warning: '警告',
  error: '接近上限',
  micro_compact: '微压缩',
  auto_compact: '自动压缩',
  blocking: '已阻塞',
}

const LEVEL_COLORS: Record<string, string> = {
  ok: '#22c55e',
  warning: '#f59e0b',
  error: '#ef4444',
  micro_compact: '#a855f7',
  auto_compact: '#a855f7',
  blocking: '#ef4444',
}

const THRESHOLD_FIELDS: Array<{ key: keyof ContextThresholds; label: string; hint: string }> = [
  { key: 'warningTokens', label: '警告阈值', hint: '超过此值时，指示器变为警告色' },
  { key: 'errorTokens', label: '错误阈值', hint: '超过此值时，指示器变红' },
  { key: 'historySnipTokens', label: '历史裁剪阈值', hint: '超过此值时丢弃最早的对话轮次（零 LLM 成本，OC §9.1 第 1 层），介于错误与微压缩之间' },
  { key: 'microCompactTokens', label: '微压缩阈值', hint: '超过此估算令牌数时自动裁剪旧工具输出（内部为字符启发式 ≈len/4，长对话可调低）' },
  { key: 'autoCompactTokens', label: '自动压缩阈值', hint: '超过此值时调用模型生成对话摘要并压缩（会消耗一次额外 API）' },
  { key: 'blockingTokens', label: '阻塞阈值', hint: '超过此值时，强制压缩（可能丢失上下文）' },
  { key: 'anchorBudgetChars', label: '锚点预算', hint: '压缩时保留的高信号锚点消息最大字符数（诊断、待办、工具摘要等）' },
]

const ANALYSIS_CATEGORY_LABELS: Record<string, string> = {
  system_prompt: '系统提示',
  system_tools: '工具定义',
  mcp_tools: 'MCP 工具',
  memory_files: '记忆文件',
  skills: '技能',
  tool_results: '工具结果',
  read_results: '文件读取',
  messages: '对话消息',
  autocompact_buffer: '自动压缩缓冲',
  compact_buffer: '手动压缩缓冲',
  free_space: '空闲空间',
}

const ContextAnalysisSection: React.FC<{ analysis: ContextAnalysisResult }> = ({ analysis }) => {
  const usedCategories = analysis.categories.filter((c) => c.tokens > 0)
  return (
    <div style={{ padding: '8px 0' }}>
      {/* Usage bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', minWidth: 60 }}>
          {analysis.usagePercent.toFixed(1)}%
        </span>
        <div style={{
          flex: 1, height: 12, borderRadius: 6, overflow: 'hidden',
          background: 'var(--bg-tertiary)', display: 'flex',
        }}>
          {usedCategories.filter(c => c.name !== 'free_space').map((cat) => (
            <div
              key={cat.name}
              title={`${ANALYSIS_CATEGORY_LABELS[cat.name] || cat.name}: ${(cat.tokens / 1000).toFixed(1)}k (${cat.percent.toFixed(1)}%)`}
              style={{
                width: `${Math.max(0.5, cat.percent)}%`,
                height: '100%',
                background: cat.color,
                transition: 'width 0.3s ease',
              }}
            />
          ))}
        </div>
      </div>

      {/* Window info */}
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10 }}>
        <span>窗口: {(analysis.contextWindowTokens / 1000).toFixed(0)}k</span>
        <span>有效窗口: {(analysis.effectiveWindowTokens / 1000).toFixed(0)}k</span>
        <span>已使用: {(analysis.totalUsedTokens / 1000).toFixed(1)}k</span>
      </div>

      {/* Category breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px' }}>
        {usedCategories.filter(c => c.name !== 'free_space' && c.tokens > 0).map((cat) => (
          <div key={cat.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            <span style={{
              width: 8, height: 8, borderRadius: 2,
              background: cat.color, flexShrink: 0,
            }} />
            <span style={{ color: 'var(--text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {ANALYSIS_CATEGORY_LABELS[cat.name] || cat.name}
            </span>
            <span style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
              {(cat.tokens / 1000).toFixed(1)}k
            </span>
          </div>
        ))}
      </div>

      {/* Grid visualization */}
      {analysis.grid.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 500 }}>上下文网格</span>
          <div style={{
            marginTop: 4, padding: 6, borderRadius: 6,
            background: 'var(--bg-tertiary)', fontFamily: 'monospace',
            fontSize: 10, lineHeight: 1.4, overflowX: 'auto',
          }}>
            {analysis.grid.map((row, i) => (
              <div key={i} style={{ display: 'flex', gap: 2 }}>
                {row.map((cell, j) => {
                  const cat = usedCategories.find(c => c.name.charAt(0).toUpperCase() === cell)
                  const bg = cat?.color ?? 'transparent'
                  const isFree = cell === '░'
                  return (
                    <span
                      key={j}
                      title={cat ? (ANALYSIS_CATEGORY_LABELS[cat.name] || cat.name) : '空闲'}
                      style={{
                        width: 14, height: 14,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        borderRadius: 2,
                        background: isFree ? 'var(--bg-secondary)' : `${bg}30`,
                        color: isFree ? 'var(--text-tertiary)' : bg,
                        fontWeight: isFree ? 400 : 600,
                        cursor: 'default',
                      }}
                    >
                      {cell}
                    </span>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Suggestions */}
      {analysis.suggestions.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {analysis.suggestions.map((s, i) => (
            <div
              key={i}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 6,
                padding: '4px 8px', marginBottom: 4, borderRadius: 4,
                fontSize: 11, lineHeight: 1.5,
                background: s.type === 'error' ? '#ef444415' : s.type === 'warning' ? '#f59e0b15' : '#3b82f615',
                color: s.type === 'error' ? '#ef4444' : s.type === 'warning' ? '#f59e0b' : '#3b82f6',
              }}
            >
              <span style={{ flexShrink: 0, marginTop: 1 }}>
                {s.type === 'error' ? '✖' : s.type === 'warning' ? '⚠' : 'ℹ'}
              </span>
              <span>{s.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

type ContextSubView = 'main' | 'analysis'

export const ContextPanel: React.FC = () => {
  const [subView, setSubView] = useState<ContextSubView>('main')
  const [state, setState] = useState<ContextState | null>(null)
  const [thresholds, setThresholds] = useState<ContextThresholds | null>(null)
  const [localThresholds, setLocalThresholds] = useState<ContextThresholds | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [analysis, setAnalysis] = useState<ContextAnalysisResult | null>(null)
  const [analyzingBusy, setAnalyzingBusy] = useState(false)
  const [resetting, setResetting] = useState(false)

  useEffect(() => {
    void getContextState().then(setState)
    void getContextThresholds().then((t) => { setThresholds(t); setLocalThresholds(t) })
  }, [])

  const handleAnalyze = async () => {
    setAnalyzingBusy(true)
    try {
      const result = await analyzeContextLive()
      if (result) {
        setAnalysis(result)
        setSubView('analysis')
      }
    } catch (e) {
      console.error('Context analysis failed:', e)
    } finally {
      setAnalyzingBusy(false)
    }
  }

  const handleThresholdChange = (key: keyof ContextThresholds, value: number) => {
    if (!localThresholds) return
    setLocalThresholds({ ...localThresholds, [key]: value })
    setDirty(true)
  }

  const handleSave = async () => {
    if (!localThresholds) return
    setSaving(true)
    await setContextThresholds(localThresholds)
    setThresholds(localThresholds)
    setDirty(false)
    setSaving(false)
    void getContextState().then(setState)
  }

  const handleReset = async () => {
    setResetting(true)
    await resetContext()
    const fresh = await getContextState()
    setState(fresh)
    setAnalysis(null)
    setResetting(false)
  }

  // ── Sub-view: analysis detail ──
  if (subView === 'analysis' && analysis) {
    return (
      <div className="settings-form-body">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <button
            className="settings-btn settings-btn-secondary"
            onClick={() => setSubView('main')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px' }}
          >
            <ArrowLeft size={14} />
            返回
          </button>
          <label className="settings-label" style={{ margin: 0 }}>上下文分析详情</label>
        </div>

        <ContextAnalysisSection analysis={analysis} />

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            className="settings-btn settings-btn-primary"
            onClick={handleAnalyze}
            disabled={analyzingBusy}
          >
            {analyzingBusy ? '刷新中...' : '刷新分析'}
          </button>
          <button
            className="settings-btn settings-btn-secondary"
            onClick={() => setSubView('main')}
          >
            返回主面板
          </button>
        </div>
      </div>
    )
  }

  // ── Main view ──
  return (
    <div className="settings-form-body">
      {/* Section 1: Current context state */}
      <div className="settings-group">
        <label className="settings-label">当前上下文状态</label>
        {state ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '4px 10px', borderRadius: 6,
              background: `${LEVEL_COLORS[state.level] || '#888'}20`,
              color: LEVEL_COLORS[state.level] || '#888',
              fontWeight: 600, fontSize: 12,
            }}>
              {LEVEL_LABELS[state.level] || state.level}
            </span>
            <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>
              {state.estimatedTokens.toLocaleString()} 令牌
            </span>
            {state.usagePercentOfWindow != null && (
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                {state.usagePercentOfWindow.toFixed(0)}% 窗口
              </span>
            )}
            {state.compactCount > 0 && (
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                已压缩 {state.compactCount} 次
              </span>
            )}
          </div>
        ) : (
          <p className="settings-hint">加载中...</p>
        )}
        {state && state.lastCompactSummary && (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '4px 0', lineHeight: 1.5, maxHeight: 80, overflow: 'auto' }}>
            上次压缩摘要：{state.lastCompactSummary}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            className="settings-btn settings-btn-primary"
            onClick={handleAnalyze}
            disabled={analyzingBusy}
          >
            {analyzingBusy ? '分析中...' : '分析当前上下文'}
          </button>
          <button
            className="settings-btn settings-btn-secondary"
            onClick={handleReset}
            disabled={resetting}
          >
            {resetting ? '重置中...' : '重置上下文状态'}
          </button>
        </div>
      </div>

      {/* Section 2: Threshold configuration */}
      <div className="settings-group">
        <label className="settings-label">压缩阈值配置</label>
        <p className="settings-hint">
          调整各级阈值（单位：令牌）。较小的值会更早触发压缩，节省上下文空间但可能丢失细节。
          点击「保存阈值」后会写入本地配置文件，下次启动仍生效。
        </p>
        {localThresholds && THRESHOLD_FIELDS.map(({ key, label, hint }) => {
          const isAnchorBudget = key === 'anchorBudgetChars'
          const min = isAnchorBudget ? 500 : 50000
          const max = isAnchorBudget ? 20000 : 1100000
          const step = isAnchorBudget ? 500 : 10000
          // historySnipTokens is optional (added in P2-1) so saved settings
          // written before that field existed read back as undefined; main
          // process repairs the invariant on next setContextThresholds.
          const rawValue = localThresholds[key] ?? 0
          const displayValue = isAnchorBudget
            ? `${(rawValue / 1000).toFixed(1)}k 字符`
            : `${(rawValue / 1000).toFixed(0)}k`
          return (
            <div key={key} style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>{label}</span>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{displayValue}</span>
              </div>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={rawValue}
                onChange={(e) => handleThresholdChange(key, Number(e.target.value))}
                style={{ width: '100%', marginTop: 2 }}
              />
              <p className="settings-hint" style={{ marginTop: 0 }}>{hint}</p>
            </div>
          )
        })}
        {dirty && (
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              className="settings-btn settings-btn-primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? '保存中...' : '保存阈值'}
            </button>
            <button
              className="settings-btn settings-btn-secondary"
              onClick={() => { setLocalThresholds(thresholds); setDirty(false) }}
            >
              取消
            </button>
          </div>
        )}
      </div>

      {/* Section 2.5: per-model context window overrides */}
      <ModelWindowOverrideSection />

      {/* Section 3: Explanation */}
      <div className="settings-group">
        <p className="settings-hint" style={{ lineHeight: 1.6 }}>
          上下文管理系统会在 AI 工具调用过程中自动评估对话令牌用量，并在超过阈值时执行压缩（微压缩裁剪旧工具结果，自动压缩使用 AI 总结对话）。
          你可以在聊天面板顶部看到实时的上下文状态指示器。
        </p>
      </div>
    </div>
  )
}

// ─── Per-model context-window override panel ────────────────────────────
//
// Lets users correct the chat-header `% 模型窗口` gauge for any model
// without code changes. Lookup priority (main process):
//   ENV → user override (this panel) → providerRegistry.contextWindow
//        → regex tier → 200K default
// See `electron/context/modelWindowOverrides.ts`.

const ModelWindowOverrideSection: React.FC = () => {
  const [registry, setRegistry] = useState<Record<string, number>>({})
  const [overrides, setOverrides] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingValue, setEditingValue] = useState<string>('')
  const [customId, setCustomId] = useState('')
  const [customValue, setCustomValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = async () => {
    setLoading(true)
    try {
      const [r, o] = await Promise.all([
        getRegistryContextWindows(),
        getUserContextWindowOverrides(),
      ])
      setRegistry(r)
      setOverrides(o)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [])

  const startEdit = (id: string, current: number) => {
    setEditingId(id)
    setEditingValue(String(current))
    setError(null)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditingValue('')
    setError(null)
  }

  const parseTokens = (raw: string): number | null => {
    const trimmed = raw.trim().toLowerCase()
    if (!trimmed) return null
    let n: number
    if (trimmed.endsWith('k')) {
      n = Number(trimmed.slice(0, -1)) * 1_000
    } else if (trimmed.endsWith('m')) {
      n = Number(trimmed.slice(0, -1)) * 1_000_000
    } else {
      n = Number(trimmed)
    }
    if (!Number.isFinite(n) || n <= 0) return null
    return Math.round(n)
  }

  const commitEdit = async () => {
    if (!editingId) return
    const tokens = parseTokens(editingValue)
    if (tokens == null) { setError('请输入有效的 token 数（支持 256000、256k、1m）'); return }
    setBusy(true)
    const res = await setUserContextWindowOverride(editingId, tokens)
    setBusy(false)
    if (!res.success) { setError(res.error || '保存失败'); return }
    setEditingId(null)
    setEditingValue('')
    setError(null)
    await reload()
  }

  const removeOverride = async (id: string) => {
    setBusy(true)
    const res = await clearUserContextWindowOverride(id)
    setBusy(false)
    if (!res.success) { setError(res.error || '删除失败'); return }
    await reload()
  }

  const addCustom = async () => {
    const id = customId.trim()
    if (!id) { setError('请填写模型 ID'); return }
    const tokens = parseTokens(customValue)
    if (tokens == null) { setError('请输入有效的 token 数（支持 256000、256k、1m）'); return }
    setBusy(true)
    const res = await setUserContextWindowOverride(id, tokens)
    setBusy(false)
    if (!res.success) { setError(res.error || '保存失败'); return }
    setCustomId('')
    setCustomValue('')
    setError(null)
    await reload()
  }

  // Build a unified row list: every registry id + every override id
  // (override-only ones marked as "自定义"). Sort by id.
  const allIds = Array.from(
    new Set([...Object.keys(registry), ...Object.keys(overrides)]),
  ).sort()

  const formatTokens = (t: number) =>
    t >= 1_000_000 ? `${(t / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
      : t >= 1_000 ? `${(t / 1_000).toFixed(0)}k`
      : String(t)

  return (
    <div className="settings-group">
      <label className="settings-label">模型窗口覆盖</label>
      <p className="settings-hint">
        聊天头部的 <code>% 模型窗口</code> 提示器使用这里的值。优先级：用户覆盖 &gt;
        Provider 注册表 (<code>src/data/providerRegistry.ts</code>) &gt; regex 兜底 &gt; 200K 默认。
        新模型不准时直接在这里改一行就行，不用动代码。
      </p>
      {loading && <p className="settings-hint">加载中...</p>}
      {!loading && allIds.length === 0 && (
        <p className="settings-hint">尚未推送 Registry 数据。重启应用即可。</p>
      )}
      {!loading && allIds.length > 0 && (
        <div style={{
          maxHeight: 320, overflow: 'auto', border: '1px solid var(--border)',
          borderRadius: 6, marginTop: 8,
        }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, background: 'var(--bg-secondary)', textAlign: 'left' }}>
                <th style={{ padding: '6px 10px' }}>模型 ID</th>
                <th style={{ padding: '6px 10px' }}>注册表值</th>
                <th style={{ padding: '6px 10px' }}>用户覆盖</th>
                <th style={{ padding: '6px 10px', width: 1 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {allIds.map((id) => {
                const reg = registry[id]
                const usr = overrides[id]
                const isEditing = editingId === id
                return (
                  <tr key={id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 10px', fontFamily: 'monospace' }}>
                      {id}
                      {reg == null && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-secondary)' }}>
                          自定义
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>
                      {reg != null ? formatTokens(reg) : '—'}
                    </td>
                    <td style={{ padding: '6px 10px' }}>
                      {isEditing ? (
                        <input
                          type="text"
                          value={editingValue}
                          onChange={(e) => setEditingValue(e.target.value)}
                          placeholder="例如 256000 / 256k / 1m"
                          style={{ width: 160, padding: '2px 6px' }}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void commitEdit()
                            if (e.key === 'Escape') cancelEdit()
                          }}
                        />
                      ) : usr != null ? (
                        <span style={{ color: 'var(--accent)' }}>{formatTokens(usr)}</span>
                      ) : (
                        <span style={{ color: 'var(--text-secondary)' }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                      {isEditing ? (
                        <>
                          <button
                            className="settings-btn settings-btn-primary"
                            disabled={busy}
                            onClick={() => void commitEdit()}
                            style={{ padding: '2px 8px', fontSize: 11 }}
                          >保存</button>
                          <button
                            className="settings-btn settings-btn-secondary"
                            disabled={busy}
                            onClick={cancelEdit}
                            style={{ padding: '2px 8px', fontSize: 11, marginLeft: 4 }}
                          >取消</button>
                        </>
                      ) : (
                        <>
                          <button
                            className="settings-btn settings-btn-secondary"
                            disabled={busy}
                            onClick={() => startEdit(id, usr ?? reg ?? 200_000)}
                            style={{ padding: '2px 8px', fontSize: 11 }}
                          >{usr != null ? '修改' : '覆盖'}</button>
                          {usr != null && (
                            <button
                              className="settings-btn settings-btn-secondary"
                              disabled={busy}
                              onClick={() => void removeOverride(id)}
                              style={{ padding: '2px 8px', fontSize: 11, marginLeft: 4 }}
                            >还原</button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Add custom row (for `compatible` provider with arbitrary id) */}
      <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={customId}
          onChange={(e) => setCustomId(e.target.value)}
          placeholder="自定义 model id（如 my-local-llama）"
          style={{ flex: '1 1 200px', padding: '4px 8px', fontSize: 12 }}
        />
        <input
          type="text"
          value={customValue}
          onChange={(e) => setCustomValue(e.target.value)}
          placeholder="窗口（256k / 1m / 数字）"
          style={{ width: 180, padding: '4px 8px', fontSize: 12 }}
          onKeyDown={(e) => { if (e.key === 'Enter') void addCustom() }}
        />
        <button
          className="settings-btn settings-btn-primary"
          disabled={busy}
          onClick={() => void addCustom()}
        >添加</button>
      </div>
      {error && (
        <p className="settings-hint" style={{ color: 'var(--error)', marginTop: 6 }}>{error}</p>
      )}
    </div>
  )
}
