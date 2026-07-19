import React, { useState, useEffect, useMemo } from 'react'
import { Wrench, RefreshCw, X } from 'lucide-react'
import { useToolRegistry } from '../../stores/useToolRegistry'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useT, type Messages } from '../../i18n'
import {
  WebSearchKeyRow,
  type KeyRowTester,
  type KeyShapeWarning,
} from './WebSearchKeyRow'
import './ToolsPanel.css'

type ToolsMessages = Messages['settings']['tools']

interface ElectronToolInfo {
  name: string
  description: string
  isReadOnly: boolean
  isDestructive: boolean
}

/**
 * Shared mask helper — `head…tail · N 字符`. `headLen` lets Baidu show its
 * distinctive `bce-v3/ALTAK-` prefix (13 chars) while Brave shows the
 * compact 3-char head.
 */
function maskKeyForUI(
  key: string | undefined | null,
  headLen: number,
  charsLabel: (n: number) => string,
): string {
  const k = typeof key === 'string' ? key.trim() : ''
  if (!k) return ''
  if (k.length < headLen + 8) return `(${charsLabel(k.length)})`
  return `${k.slice(0, headLen)}…${k.slice(-4)} · ${charsLabel(k.length)}`
}

const braveShapeMessages = (t: ToolsMessages): Record<KeyShapeWarning, string> => ({
  'too-short': t.braveTooShort,
  'wrong-prefix': t.braveWrongPrefix,
  'invalid-charset': t.braveInvalidCharset,
})

const baiduShapeMessages = (t: ToolsMessages): Record<KeyShapeWarning, string> => ({
  'too-short': t.baiduTooShort,
  'wrong-prefix': t.baiduWrongPrefix,
  'invalid-charset': t.baiduInvalidCharset,
})

const SOURCE_COLORS: Record<string, { bg: string; fg: string }> = {
  frontend: { bg: 'rgba(34, 197, 94, 0.12)', fg: '#22c55e' },
  electron: { bg: 'rgba(245, 158, 11, 0.12)', fg: '#f59e0b' },
  mcp: { bg: 'rgba(139, 92, 246, 0.12)', fg: '#8b5cf6' },
}

/**
 * Adapter: the main-process returns a provider-shaped result; our row
 * component wants the generic `KeyTestResult`. Narrow the reason to string
 * and thread optional extras through.
 */
const makeBraveTester = (t: ToolsMessages): KeyRowTester => async (candidate) => {
  const r = await window.electronAPI.tools.braveTestKey(candidate)
  if (r.ok) {
    return {
      ok: true,
      status: 200,
      keyPreview: r.keyPreview,
      message: r.message,
      shapeWarnings: r.shapeWarnings,
    }
  }
  // Brave's secondary probe is the one provider-specific signal worth
  // lifting into the shared UI contract — condense it to a one-word hint.
  let secondaryHint: string | undefined
  if (r.reason === 'subscription_token_invalid') {
    if (r.secondaryProbe?.kind === 'ok')
      secondaryHint = t.braveSubNoWebSearch
    if (r.secondaryProbe?.kind === 'failed')
      secondaryHint = t.braveGlobalReject
  }
  return {
    ok: false,
    status: r.status,
    reason: r.reason,
    keyPreview: r.keyPreview,
    message: r.message,
    detail: r.detail,
    shapeWarnings: r.shapeWarnings,
    ...(secondaryHint ? { secondaryHint } : {}),
  }
}

const baiduTester: KeyRowTester = async (candidate) => {
  const r = await window.electronAPI.tools.baiduTestKey(candidate)
  if (r.ok) {
    return {
      ok: true,
      status: 200,
      keyPreview: r.keyPreview,
      message: r.message,
      shapeWarnings: r.shapeWarnings,
    }
  }
  return {
    ok: false,
    status: r.status,
    reason: r.reason,
    keyPreview: r.keyPreview,
    message: r.message,
    detail: r.detail,
    shapeWarnings: r.shapeWarnings,
  }
}

const buildBraveCurl = (key: string): string =>
  `curl.exe -H "X-Subscription-Token: ${key}" ` +
  `-H "Cache-Control: no-cache" ` +
  `"https://api.search.brave.com/res/v1/web/search?q=test&count=1"`

const buildBaiduCurl = (key: string): string =>
  `curl.exe -X POST "https://qianfan.baidubce.com/v2/ai_search/web_search" ` +
  `-H "Authorization: Bearer ${key}" ` +
  `-H "Content-Type: application/json" ` +
  `-d "{\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"test\\"}],\\"search_source\\":\\"baidu_search_v2\\",\\"resource_type_filter\\":[{\\"type\\":\\"web\\",\\"top_k\\":1}]}"`

export const ToolsPanel: React.FC = () => {
  const t = useT().settings.tools
  const braveTester = useMemo(() => makeBraveTester(t), [t])
  const braveShapeMsg = useMemo(() => braveShapeMessages(t), [t])
  const baiduShapeMsg = useMemo(() => baiduShapeMessages(t), [t])
  const { tools, enabledTools, toggleTool } = useToolRegistry()
  const webSearchBraveApiKey = useSettingsStore((s) => s.webSearchBraveApiKey)
  const webSearchBaiduApiKey = useSettingsStore((s) => s.webSearchBaiduApiKey)
  const embeddedSearchTools = useSettingsStore((s) => s.embeddedSearchTools)
  const setWebSearchBraveApiKey = useSettingsStore((s) => s.setWebSearchBraveApiKey)
  const setWebSearchBaiduApiKey = useSettingsStore((s) => s.setWebSearchBaiduApiKey)
  const setEmbeddedSearchTools = useSettingsStore((s) => s.setEmbeddedSearchTools)
  const toggleDisabledTool = useSettingsStore((s) => s.toggleDisabledTool)

  const [electronTools, setElectronTools] = useState<ElectronToolInfo[]>([])
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Declare the loader ahead of the effect that references it — otherwise
  // the effect captures a binding that the linter considers not yet
  // initialised at closure-creation time (`react-hooks/immutability`).
  const loadElectronTools = async () => {
    try {
      const result = await window.electronAPI.tools.list()
      const definitions = result.definitions || []
      const mapped: ElectronToolInfo[] = definitions.map((raw) => {
        // `tools.list` entries follow `ToolDefinitionCompact` declared on
        // the preload, but the runtime payload sometimes carries legacy
        // fields (`tool_name`, `readOnly`, `destructive`). Route through
        // `unknown → Record<string, unknown>` instead of `any` so we keep
        // the defensive fallback without losing every other type check.
        const def = raw as unknown as Record<string, unknown>
        const name =
          (typeof def.name === 'string' && def.name) ||
          (typeof def.tool_name === 'string' && def.tool_name) ||
          'unknown'
        return {
          name,
          description: typeof def.description === 'string' ? def.description : '',
          isReadOnly: Boolean(def.readOnly),
          isDestructive: Boolean(def.destructive),
        }
      })
      setElectronTools(mapped)
    } catch {
      setElectronTools([])
    }
  }

  useEffect(() => {
    // Standard "fetch on mount" — the async setState happens after the
    // await, but the rule can't see through the closure. Same shape as
    // `AgentsPanel.tsx#refreshDiskAgents`.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadElectronTools()
  }, [])

  const handleToggle = (name: string) => {
    // Keep the in-memory registry (drives this UI) and the persisted
    // `disabledTools` list in sync — the latter is the source of truth
    // that `initializeTools()` reconciles from on next launch.
    toggleTool(name)
    toggleDisabledTool(name)
  }

  const handleReload = async () => {
    setLoading(true)
    await loadElectronTools()
    setLoading(false)
  }

  // All per-provider key UI state (draft, save, test, curl-copy) now lives
  // inside <WebSearchKeyRow /> — keeps this component focused on the overall
  // layout while each provider row is self-contained.

  // Merge all tools
  const allTools = useMemo(() => {
    const frontendTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      isReadOnly: false,
      isDestructive: false,
      source: 'frontend' as const,
      toggleable: true,
    }))

    const electronToolList = electronTools.map((t) => ({
      name: t.name,
      description: t.description,
      isReadOnly: t.isReadOnly,
      isDestructive: t.isDestructive,
      source: 'electron' as const,
      toggleable: false,
    }))

    return [...frontendTools, ...electronToolList]
  }, [tools, electronTools])

  const filtered = useMemo(() => {
    if (!search.trim()) return allTools
    const q = search.toLowerCase()
    return allTools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
    )
  }, [allTools, search])

  const grouped = useMemo(() => {
    const frontend = filtered.filter((t) => t.source === 'frontend')
    const electron = filtered.filter((t) => t.source === 'electron')
    return [
      { label: t.groupFrontend, items: frontend, source: 'frontend' },
      { label: t.groupSystem, items: electron, source: 'electron' },
    ].filter((g) => g.items.length > 0)
  }, [filtered, t])

  return (
    <div className="tools-panel">
      {/* Header */}
      <div className="tools-header">
        <h3 className="tools-title">
          <Wrench size={16} />
          {t.title}
          <span className="tools-count">{allTools.length}</span>
        </h3>
        <button
          className="tools-reload-btn"
          onClick={handleReload}
          disabled={loading}
          title={t.reloadTitle}
        >
          <RefreshCw size={13} className={loading ? 'spinning' : ''} />
          {t.refresh}
        </button>
      </div>

      <div className="tools-options">
        <WebSearchKeyRow
          label={t.braveLabel}
          docUrl="https://brave.com/search/api/"
          savedKey={webSearchBraveApiKey}
          onSave={setWebSearchBraveApiKey}
          tester={braveTester}
          buildCurl={buildBraveCurl}
          maskKey={(k) => maskKeyForUI(k, 3, t.maskChars)}
          placeholder={t.bravePlaceholder}
          inputTitleHint={t.braveInputHint}
          shapeWarningMessages={braveShapeMsg}
        />
        <WebSearchKeyRow
          label={t.baiduLabel}
          docUrl="https://console.bce.baidu.com/ai-search/qianfan/ais/console/apiKey"
          savedKey={webSearchBaiduApiKey}
          onSave={setWebSearchBaiduApiKey}
          tester={baiduTester}
          buildCurl={buildBaiduCurl}
          maskKey={(k) => maskKeyForUI(k, 13, t.maskChars)}
          placeholder={t.baiduPlaceholder}
          inputTitleHint={t.baiduInputHint}
          shapeWarningMessages={baiduShapeMsg}
        />

        <label className="tools-options-row">
          <input
            type="checkbox"
            checked={embeddedSearchTools}
            onChange={(e) => setEmbeddedSearchTools(e.target.checked)}
          />
          <span>
            {t.embeddedSearch}
          </span>
        </label>
        <p className="tools-options-hint tools-options-hint-tight">
          {t.embeddedHintPre}<code>ASTRA_EMBEDDED_SEARCH</code>{t.embeddedHintMid}<code>EMBEDDED_SEARCH_TOOLS</code>{t.embeddedHintSuf}
        </p>
      </div>

      {/* Search */}
      <div className="tools-search">
        <input
          type="text"
          placeholder={t.searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button className="tools-search-clear" onClick={() => setSearch('')}>
            <X size={12} />
          </button>
        )}
      </div>

      {/* List */}
      {allTools.length === 0 ? (
        <div className="tools-empty">
          <Wrench size={32} />
          <p>{t.emptyNoTools}</p>
        </div>
      ) : grouped.length === 0 ? (
        <div className="tools-empty">
          <p>{t.noMatch}</p>
          <p className="tools-empty-hint">{t.tryOtherKeywords}</p>
        </div>
      ) : (
        <div className="tools-list">
          {grouped.map((group) => {
            const colors = SOURCE_COLORS[group.source] || {
              bg: 'rgba(108, 112, 134, 0.12)',
              fg: '#6c7086',
            }
            return (
              <div key={group.source} className="tools-group">
                <div className="tools-group-header">
                  <span
                    className="tools-group-badge"
                    style={{ background: colors.bg, color: colors.fg }}
                  >
                    {group.label}
                  </span>
                  <span className="tools-group-count">{group.items.length}</span>
                </div>

                {group.items.map((tool) => {
                  const isExpanded = expanded === tool.name
                  const isEnabled = enabledTools.has(tool.name)

                  return (
                    <div
                      key={tool.name}
                      className={`tool-card${isExpanded ? ' expanded' : ''}${!isEnabled ? ' disabled' : ''}`}
                    >
                      <div
                        className="tool-card-header"
                        onClick={() =>
                          setExpanded(isExpanded ? null : tool.name)
                        }
                      >
                        <div className="tool-card-left">
                          <div
                            className="tool-card-icon"
                            style={{
                              background: colors.bg,
                              color: colors.fg,
                            }}
                          >
                            <Wrench size={15} />
                          </div>
                          <div className="tool-card-info">
                            <div className="tool-card-name-row">
                              <span className="tool-card-name">
                                {tool.name}
                              </span>
                              {!isEnabled && tool.toggleable && (
                                <span className="tool-badge disabled">{t.badgeDisabled}</span>
                              )}
                              {tool.isReadOnly && (
                                <span className="tool-badge readonly">{t.badgeReadonly}</span>
                              )}
                              {tool.isDestructive && (
                                <span className="tool-badge destructive">
                                  {t.badgeDestructive}
                                </span>
                              )}
                            </div>
                            <p className="tool-card-brief">
                              {tool.description.slice(0, 70)}
                              {tool.description.length > 70 ? '…' : ''}
                            </p>
                          </div>
                        </div>

                        <div className="tool-card-right">
                          {tool.toggleable && (
                            <label
                              className="tool-toggle-label"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="checkbox"
                                checked={isEnabled}
                                onChange={() => handleToggle(tool.name)}
                              />
                              <span className="tool-toggle-track" />
                            </label>
                          )}
                        </div>
                      </div>

                      {isExpanded && tool.description && (
                        <div className="tool-card-body">
                          <p className="tool-card-desc">
                            {tool.description}
                          </p>
                          <div className="tool-card-meta">
                            <span>
                              {t.sourceLabel}
                              <code>
                                {tool.source === 'frontend' ? t.sourceFrontend : t.sourceSystem}
                              </code>
                            </span>
                            {!tool.toggleable && (
                              <span className="tool-card-meta-note">
                                {t.systemNoDisable}
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
