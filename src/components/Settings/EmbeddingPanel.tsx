import React, { useCallback, useEffect, useState } from 'react'
import {
  Trash2, CheckCircle2, AlertTriangle, Download, X,
  Cpu, Cloud, Zap, RefreshCw, Loader2,
} from 'lucide-react'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useWorkspaceIndexStore } from '../../stores/useWorkspaceIndexStore'
import { useT } from '../../i18n'
import {
  formatBytes,
  buildSections,
  type DownloadProgress,
  type DownloadableEntry,
  type LocalModelEntry,
  type SectionId,
} from './embeddingPanelTypes'
import './EmbeddingPanel.css'

// `WorkspaceIndexStatus` / `WorkspaceIndexProgress` used to be declared here;
// they now live in `src/stores/useWorkspaceIndexStore.ts` as the single
// source of truth and are consumed via Zustand selectors (see above).

/**
 * Settings → 向量模型 面板.
 *
 * 左侧竖向 tab 条，右侧是对应的 section 内容。每个 tab 只显示相关配置，
 * 用户不用从头滑到尾。Tab 身上带状态 badge（已启用 / 未配置 / 错误）。
 */
export const EmbeddingPanel: React.FC = () => {
  const t = useT().settings.embedding
  const SECTIONS = React.useMemo(() => buildSections(t), [t])
  const {
    embeddingProviderId,
    embeddingModel,
    embeddingApiKey,
    embeddingBaseUrl,
    embeddingDimensions,
    embeddingMode,
    embeddingLocalModelId,
    rerankProviderId,
    rerankModel,
    rerankApiKey,
    rerankBaseUrl,
    setEmbeddingConfig,
    setRerankConfig,
  } = useSettingsStore()

  const [activeSection, setActiveSection] = useState<SectionId>('mode')

  // --- Test / local-model / cache state -----------------------------------
  const [testStatus, setTestStatus] = useState<
    { state: 'idle' } | { state: 'loading' } | { state: 'ok'; dim: number } | { state: 'error'; msg: string }
  >({ state: 'idle' })
  const [rerankStatus, setRerankStatus] = useState<
    { state: 'idle' } | { state: 'loading' } | { state: 'ok' } | { state: 'error'; msg: string }
  >({ state: 'idle' })
  const [localTestStatus, setLocalTestStatus] = useState<
    { state: 'idle' } | { state: 'loading' } | { state: 'ok'; model: string; dim: number } | { state: 'error'; msg: string }
  >({ state: 'idle' })
  const [installed, setInstalled] = useState<LocalModelEntry[]>([])
  const [downloadable, setDownloadable] = useState<DownloadableEntry[]>([])
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({})
  const [vectorStats, setVectorStats] = useState<{ files: number; bytes: number } | null>(null)
  const [cacheStats, setCacheStats] = useState<{ files: number; bytes: number } | null>(null)

  // --- Stale-fp inventory (post-namespace-unification) -------------------
  //
  // Each (kind × source × model-fingerprint) gets its own namespace; when a
  // user switches embedding model, the old namespaces become "stale" — still
  // queryable if the user switches back, but otherwise just disk usage.
  // We surface them as a one-button GC.
  const [staleSummary, setStaleSummary] = useState<{
    activeFp: string
    activeModel: string
    staleEntries: number
    staleBytes: number
  } | null>(null)
  const [staleLoading, setStaleLoading] = useState(false)

  // --- Workspace index state ----------------------------------------------
  //
  // Lives in the global `useWorkspaceIndexStore` so the build keeps
  // progressing visibly even when the user navigates away from this panel.
  // See stores/useWorkspaceIndexStore.ts for the rationale. This panel is
  // now a *view* over that store rather than its owner.
  const workspaceRoot = useWorkspaceStore((s) => s.rootPath)
  const wsStatus = useWorkspaceIndexStore((s) => s.status)
  const wsBuilding = useWorkspaceIndexStore((s) => s.building)
  const wsProgress = useWorkspaceIndexStore((s) => s.progress)
  const wsError = useWorkspaceIndexStore((s) => s.error)
  const startWsBuild = useWorkspaceIndexStore((s) => s.startBuild)
  const refreshWsStatus = useWorkspaceIndexStore((s) => s.refreshStatus)
  const clearWsIndex = useWorkspaceIndexStore((s) => s.clearIndex)

  // Local catalog (scans resources/embeddings + userData/downloaded-models).
  const refreshCatalog = useCallback(async () => {
    const api = window.electronAPI?.embedding
    if (!api?.listLocal) return
    const r = await api.listLocal()
    if (r) {
      setInstalled((r.installed || []) as LocalModelEntry[])
      setDownloadable((r.downloadable || []) as DownloadableEntry[])
    }
  }, [])

  const refreshStats = useCallback(async () => {
    const v = await window.electronAPI?.vector?.stats?.()
    if (v) setVectorStats(v)
    const c = await window.electronAPI?.attachments?.cacheStats?.()
    if (c) setCacheStats(c)
  }, [])

  /**
   * Compute the stale-fp summary by combining the active fp probe with the
   * inventory. We do this lazily (on cache panel mount or after a clear) so
   * the user doesn't pay a 1-vector embed cost on every panel switch.
   */
  const refreshStaleSummary = useCallback(async () => {
    const eapi = window.electronAPI?.embedding
    if (!eapi?.activeFp || !eapi?.inventory) {
      setStaleSummary(null)
      return
    }
    setStaleLoading(true)
    try {
      const [fp, inv] = await Promise.all([eapi.activeFp(), eapi.inventory()])
      if (!fp.ok || !inv.ok || !fp.fp) {
        setStaleSummary(null)
        return
      }
      const stale = inv.entries.filter((e) => e.fp !== fp.fp)
      setStaleSummary({
        activeFp: fp.fp,
        activeModel: fp.model || '(unknown)',
        staleEntries: stale.length,
        staleBytes: stale.reduce((s, e) => s + e.sizeBytes, 0),
      })
    } catch {
      setStaleSummary(null)
    } finally {
      setStaleLoading(false)
    }
  }, [])

  useEffect(() => { void refreshCatalog(); void refreshStats() }, [refreshCatalog, refreshStats])

  // First time the user opens the cache panel, kick off the stale-fp probe.
  // Subsequent visits reuse the previous result until a clear/GC bumps it.
  useEffect(() => {
    if (activeSection === 'cache' && staleSummary === null && !staleLoading) {
      void refreshStaleSummary()
    }
  }, [activeSection, staleSummary, staleLoading, refreshStaleSummary])

  // One-shot toast when the main process has migrated v1 → v2 vector store.
  useEffect(() => {
    const api = window.electronAPI?.embedding
    if (!api?.onMigrationReport) return
    return api.onMigrationReport((report) => {
      if (!report.migrated || !report.archiveDir) return
      const total = report.details.reduce((s, d) => s + d.files, 0)
      // Use a simple alert here; the panel is already opt-in and the message
      // is one-time. A nicer toast could land in a follow-up.
      window.alert(t.migrationAlert(total, report.archiveDir))
    })
  }, [t])

  useEffect(() => {
    const api = window.electronAPI?.embedding
    if (!api?.onDownloadProgress) return
    return api.onDownloadProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.modelId]: p }))
      if (p.state === 'done' || p.state === 'error') void refreshCatalog()
    })
  }, [refreshCatalog])

  // --- Actions -----------------------------------------------------------

  const testCloud = useCallback(async () => {
    if (!embeddingProviderId.trim() || !embeddingModel.trim()) {
      setTestStatus({ state: 'error', msg: t.testErrNoProviderModel })
      return
    }
    setTestStatus({ state: 'loading' })
    try {
      const r = await window.electronAPI?.embedding?.embed?.({
        config: {
          providerId: embeddingProviderId,
          model: embeddingModel,
          apiKey: embeddingApiKey || undefined,
          baseUrl: embeddingBaseUrl || undefined,
          dimensions: embeddingDimensions ?? undefined,
        },
        texts: ['hello world'],
      })
      if (!r) return setTestStatus({ state: 'error', msg: t.apiUnavailable })
      if (r.ok) return setTestStatus({ state: 'ok', dim: r.dim })
      setTestStatus({ state: 'error', msg: r.error })
    } catch (err) {
      setTestStatus({ state: 'error', msg: err instanceof Error ? err.message : String(err) })
    }
  }, [embeddingProviderId, embeddingModel, embeddingApiKey, embeddingBaseUrl, embeddingDimensions, t])

  const testRerank = useCallback(async () => {
    if (!rerankProviderId.trim() || !rerankModel.trim()) {
      setRerankStatus({ state: 'error', msg: t.testErrNoRerank })
      return
    }
    setRerankStatus({ state: 'loading' })
    try {
      const r = await window.electronAPI?.embedding?.rerank?.({
        config: {
          providerId: rerankProviderId,
          model: rerankModel,
          apiKey: rerankApiKey || undefined,
          baseUrl: rerankBaseUrl || undefined,
        },
        query: 'TypeScript best practices',
        documents: [
          { id: '1', text: 'TypeScript is a typed superset of JavaScript.' },
          { id: '2', text: 'Cats are popular household pets.' },
        ],
      })
      if (!r) return setRerankStatus({ state: 'error', msg: t.apiUnavailable })
      if (r.ok) return setRerankStatus({ state: 'ok' })
      setRerankStatus({ state: 'error', msg: r.error })
    } catch (err) {
      setRerankStatus({ state: 'error', msg: err instanceof Error ? err.message : String(err) })
    }
  }, [rerankProviderId, rerankModel, rerankApiKey, rerankBaseUrl, t])

  const clearRerank = useCallback(() => {
    if (!window.confirm(t.confirmClearRerank)) return
    setRerankConfig({ rerankProviderId: '', rerankModel: '', rerankApiKey: '', rerankBaseUrl: '' })
    setRerankStatus({ state: 'idle' })
  }, [setRerankConfig, t])

  const testLocal = useCallback(async (modelId: string) => {
    const api = window.electronAPI?.embedding
    if (!api?.embedLocal) return
    setLocalTestStatus({ state: 'loading' })
    try {
      const r = await api.embedLocal({ modelId, texts: ['你好，世界 · Hello, world'] })
      if (r.ok) setLocalTestStatus({ state: 'ok', model: r.model, dim: r.dim })
      else setLocalTestStatus({ state: 'error', msg: r.error })
    } catch (err) {
      setLocalTestStatus({ state: 'error', msg: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  const handleDownload = useCallback(async (modelId: string) => {
    const api = window.electronAPI?.embedding
    if (!api?.downloadLocal) return
    setProgress((p) => ({
      ...p,
      [modelId]: { modelId, fileIndex: 0, totalFiles: 0, currentFile: '', currentBytes: 0, currentTotal: 0, overallBytes: 0, overallTotal: 0, state: 'downloading' },
    }))
    await api.downloadLocal({ modelId })
    await refreshCatalog()
  }, [refreshCatalog])

  const handleCancelDownload = useCallback((modelId: string) => {
    void window.electronAPI?.embedding?.cancelDownload?.({ modelId })
  }, [])

  const handleDeleteLocal = useCallback(async (modelId: string) => {
    if (!window.confirm(t.confirmDeleteLocal(modelId))) return
    await window.electronAPI?.embedding?.deleteLocal?.({ modelId })
    await refreshCatalog()
  }, [refreshCatalog, t])

  const clearVectorStore = useCallback(async () => {
    if (!window.confirm(t.confirmClearVector)) return
    await window.electronAPI?.vector?.clearAll?.()
    void refreshStats()
    void refreshStaleSummary()
  }, [refreshStats, refreshStaleSummary, t])

  const gcStaleFp = useCallback(async () => {
    const eapi = window.electronAPI?.embedding
    if (!eapi?.gcStale || !staleSummary) return
    if (!window.confirm(
      t.confirmGcStale(staleSummary.staleEntries, formatBytes(staleSummary.staleBytes)),
    )) return
    const r = await eapi.gcStale({ activeFp: staleSummary.activeFp })
    if (r.ok) {
      window.alert(t.gcDone(r.removed, formatBytes(r.bytes)))
    } else {
      window.alert(t.gcFailed(r.error ?? ''))
    }
    void refreshStats()
    void refreshStaleSummary()
  }, [staleSummary, refreshStats, refreshStaleSummary, t])

  const clearAttachmentCache = useCallback(async () => {
    if (!window.confirm(t.confirmClearAttach)) return
    await window.electronAPI?.attachments?.cacheClear?.()
    void refreshStats()
  }, [refreshStats, t])

  // --- Workspace index actions -------------------------------------------
  //
  // All build/status/clear logic now lives in useWorkspaceIndexStore. The
  // panel just wires actions to workspaceRoot and refreshes the vector /
  // cache stats after each operation for UI badges.

  useEffect(() => {
    if (workspaceRoot) void refreshWsStatus(workspaceRoot)
  }, [workspaceRoot, refreshWsStatus])

  // When the build completes, also refresh the panel-local vector/cache
  // stats so the "缓存管理" badge numbers update.
  useEffect(() => {
    if (!wsBuilding) void refreshStats()
  }, [wsBuilding, refreshStats])

  const buildWorkspaceIndex = useCallback(async (force = false) => {
    if (!workspaceRoot) return
    await startWsBuild(workspaceRoot, force)
    void refreshStats()
  }, [workspaceRoot, startWsBuild, refreshStats])

  const clearWorkspaceIndex = useCallback(async () => {
    if (!workspaceRoot) return
    if (!window.confirm(t.confirmClearWsIndex)) return
    await clearWsIndex(workspaceRoot)
    void refreshStats()
  }, [workspaceRoot, clearWsIndex, refreshStats, t])

  // --- Derived state ------------------------------------------------------

  const installedCount = installed.filter((m) => m.installed).length
  const activeLocalModel = installed.find((m) => m.id === embeddingLocalModelId && m.installed)
    || installed.find((m) => m.installed)

  const cloudConfigured = Boolean(embeddingModel.trim() && embeddingProviderId.trim())
  const rerankConfigured = Boolean(rerankModel.trim() && rerankProviderId.trim())

  const sectionBadge = (id: SectionId): { label: string; tone: 'ok' | 'warn' | 'info' } | null => {
    switch (id) {
      case 'mode':
        return { label: embeddingMode, tone: embeddingMode === 'auto' ? 'ok' : 'info' }
      case 'local':
        if (installedCount === 0) return { label: t.badgeNoModel, tone: 'warn' }
        return { label: t.badgeCount(installedCount), tone: 'ok' }
      case 'cloud':
        return cloudConfigured
          ? { label: t.badgeConfigured, tone: 'ok' }
          : { label: t.badgeUnconfigured, tone: 'warn' }
      case 'rerank':
        return rerankConfigured
          ? { label: t.badgeEnabled, tone: 'ok' }
          : { label: t.badgeDisabled, tone: 'info' }
      case 'workspace':
        if (!workspaceRoot) return { label: t.badgeNotOpen, tone: 'info' }
        if (wsStatus?.indexed && wsStatus.chunkCount > 0) {
          return { label: t.badgeChunks(wsStatus.chunkCount), tone: 'ok' }
        }
        return { label: t.badgeNotBuilt, tone: 'warn' }
      case 'cache':
        return null
    }
  }

  // -----------------------------------------------------------------------

  return (
    <div className="epanel-root">
      {/* Left rail: section tabs */}
      <aside className="epanel-rail">
        {SECTIONS.map((s) => {
          const Icon = s.icon
          const badge = sectionBadge(s.id)
          const active = activeSection === s.id
          return (
            <button
              key={s.id}
              className={`epanel-rail-item ${active ? 'active' : ''}`}
              onClick={() => setActiveSection(s.id)}
              title={s.hint}
            >
              <Icon size={15} />
              <div className="epanel-rail-text">
                <span className="epanel-rail-label">{s.label}</span>
                <span className="epanel-rail-hint">{s.hint}</span>
              </div>
              {badge && (
                <span className={`epanel-badge epanel-badge-${badge.tone}`}>{badge.label}</span>
              )}
            </button>
          )
        })}
      </aside>

      {/* Right: active section content */}
      <div className="epanel-body">
        {activeSection === 'mode' && (
          <section className="epanel-section">
            <header className="epanel-section-header">
              <h3>{t.modeTitle}</h3>
              <p>{t.modeDesc}</p>
            </header>
            <div className="epanel-mode-grid">
              {([
                { id: 'auto',  icon: Zap,   title: t.modeAuto,  hint: t.modeAutoHint },
                { id: 'local', icon: Cpu,   title: t.modeLocal, hint: t.modeLocalHint },
                { id: 'cloud', icon: Cloud, title: t.modeCloud, hint: t.modeCloudHint },
              ] as const).map((opt) => {
                const Icon = opt.icon
                const active = embeddingMode === opt.id
                return (
                  <button
                    key={opt.id}
                    className={`epanel-mode-card ${active ? 'active' : ''}`}
                    onClick={() => setEmbeddingConfig({ embeddingMode: opt.id })}
                  >
                    <Icon size={18} />
                    <strong>{opt.title}</strong>
                    <span>{opt.hint}</span>
                  </button>
                )
              })}
            </div>
            <div className="epanel-tip">
              💡 {t.tipCurrentMode}<code>{embeddingMode}</code>
              {embeddingMode === 'auto' && activeLocalModel && (
                <>{t.tipPreferLocal}<code>{activeLocalModel.id}</code></>
              )}
              {embeddingMode === 'auto' && !activeLocalModel && cloudConfigured && (
                <>{t.tipUseCloud}<code>{embeddingModel}</code></>
              )}
              {embeddingMode === 'auto' && !activeLocalModel && !cloudConfigured && (
                <> · <span style={{ color: '#f38ba8' }}>{t.tipNoConfig}</span></>
              )}
            </div>
          </section>
        )}

        {activeSection === 'local' && (
          <section className="epanel-section">
            <header className="epanel-section-header">
              <h3>{t.localTitle}</h3>
              <p>{t.localDesc1}<code>resources/embeddings/</code>{t.localDesc2}<code>userData/downloaded-models/</code>{t.localDesc3}</p>
            </header>

            <div className="epanel-subsection-title">{t.installed}</div>
            {installed.length === 0 && (
              <div className="epanel-empty">{t.noLocalModels}</div>
            )}
            {installed.map((m) => {
              const active = embeddingLocalModelId === m.id
              return (
                <div key={m.id} className={`epanel-row ${active ? 'active' : ''}`}>
                  <div className="epanel-row-main">
                    <div className="epanel-row-title">
                      <strong>{m.name}</strong>
                      {m.source === 'bundled' && <span className="epanel-badge epanel-badge-info">{t.badgeBundled}</span>}
                      {m.source === 'downloaded' && <span className="epanel-badge epanel-badge-info">{t.badgeDownloaded}</span>}
                      {!m.installed && <span className="epanel-badge epanel-badge-warn">{m.reason || t.badgeIncomplete}</span>}
                      {active && <span className="epanel-badge epanel-badge-ok">{t.badgeSelected}</span>}
                    </div>
                    <div className="epanel-row-hint">
                      {m.description}
                      {m.dimensions ? t.dimSuffix(m.dimensions) : ''}
                      {m.sizeBytes ? ` · ${formatBytes(m.sizeBytes)}` : ''}
                    </div>
                  </div>
                  <div className="epanel-row-actions">
                    {m.installed && (
                      <button
                        className="epanel-btn"
                        onClick={() => setEmbeddingConfig({ embeddingLocalModelId: active ? '' : m.id })}
                        title={active ? t.deselectTitle : t.selectTitle}
                      >
                        {active ? t.deselect : t.select}
                      </button>
                    )}
                    {m.installed && (
                      <button
                        className="epanel-btn"
                        onClick={() => testLocal(m.id)}
                        title={t.testInferTitle}
                      >
                        <Zap size={12} /> {t.test}
                      </button>
                    )}
                    {m.source === 'downloaded' && (
                      <button className="epanel-btn epanel-btn-danger" onClick={() => handleDeleteLocal(m.id)}>
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
            {localTestStatus.state === 'loading' && <div className="epanel-inline-note">{t.testing}</div>}
            {localTestStatus.state === 'ok' && (
              <div className="epanel-inline-note epanel-inline-ok">
                <CheckCircle2 size={12} /> {t.testOkLocal(localTestStatus.dim)}<code>{localTestStatus.model}</code>
              </div>
            )}
            {localTestStatus.state === 'error' && (
              <div className="epanel-inline-note epanel-inline-err">
                <AlertTriangle size={12} /> {localTestStatus.msg}
              </div>
            )}

            <div className="epanel-subsection-title">{t.downloadableTitle}</div>
            {downloadable.map((m) => {
              const isInstalled = installed.some((i) => i.id === m.id && i.installed)
              const prog = progress[m.id]
              const downloading = prog && prog.state === 'downloading' && prog.totalFiles > 0
              const percent = prog && prog.overallTotal > 0
                ? Math.floor((prog.overallBytes / prog.overallTotal) * 100)
                : 0
              return (
                <div key={m.id} className="epanel-row">
                  <div className="epanel-row-main">
                    <div className="epanel-row-title">
                      <strong>{m.name}</strong>
                      {isInstalled && <span className="epanel-badge epanel-badge-ok">{t.badgeInstalled}</span>}
                    </div>
                    <div className="epanel-row-hint">
                      {m.description}{t.dimSuffix(m.dimensions)} · ~{formatBytes(m.approxSizeBytes)}
                    </div>
                    {downloading && (
                      <div className="epanel-progress">
                        <div className="epanel-progress-bar" style={{ width: `${percent}%` }} />
                        <span className="epanel-progress-label">
                          {t.progressLabel(percent, prog.fileIndex + 1, prog.totalFiles, prog.currentFile)}
                        </span>
                      </div>
                    )}
                    {prog && prog.state === 'error' && (
                      <div className="epanel-inline-err" style={{ marginTop: 4 }}>
                        <AlertTriangle size={12} /> {prog.error}
                      </div>
                    )}
                  </div>
                  <div className="epanel-row-actions">
                    {downloading ? (
                      <button className="epanel-btn" onClick={() => handleCancelDownload(m.id)}>
                        <X size={12} /> {t.cancel}
                      </button>
                    ) : isInstalled ? (
                      <span className="epanel-badge epanel-badge-ok">✓</span>
                    ) : (
                      <button className="epanel-btn epanel-btn-primary" onClick={() => handleDownload(m.id)}>
                        <Download size={12} /> {t.download}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </section>
        )}

        {activeSection === 'cloud' && (
          <section className="epanel-section">
            <header className="epanel-section-header">
              <h3>{t.cloudTitle}</h3>
              <p>{t.cloudDesc1}<code>/v1/embeddings</code>{t.cloudDesc2}</p>
            </header>

            <div className="epanel-field">
              <label>{t.providerId}</label>
              <input
                className="epanel-input"
                value={embeddingProviderId}
                placeholder="openai / jina / siliconflow / ollama"
                onChange={(e) => setEmbeddingConfig({ embeddingProviderId: e.target.value })}
              />
            </div>
            <div className="epanel-field">
              <label>{t.model}</label>
              <input
                className="epanel-input"
                value={embeddingModel}
                placeholder="text-embedding-3-small / jina-embeddings-v3 / bge-m3"
                onChange={(e) => setEmbeddingConfig({ embeddingModel: e.target.value })}
              />
            </div>
            <div className="epanel-field-row">
              <div className="epanel-field">
                <label>{t.apiKey}</label>
                <input
                  className="epanel-input"
                  type="password"
                  value={embeddingApiKey}
                  placeholder={t.apiKeyPlaceholder}
                  onChange={(e) => setEmbeddingConfig({ embeddingApiKey: e.target.value })}
                />
              </div>
              <div className="epanel-field">
                <label>{t.baseUrl}</label>
                <input
                  className="epanel-input"
                  value={embeddingBaseUrl}
                  placeholder="https://api.openai.com/v1"
                  onChange={(e) => setEmbeddingConfig({ embeddingBaseUrl: e.target.value })}
                />
              </div>
            </div>
            <div className="epanel-field" style={{ maxWidth: 180 }}>
              <label>{t.dimensions}</label>
              <input
                className="epanel-input"
                type="number"
                value={embeddingDimensions ?? ''}
                placeholder={t.dimensionsPlaceholder}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  setEmbeddingConfig({ embeddingDimensions: v ? Number(v) : null })
                }}
              />
            </div>

            <div className="epanel-actions">
              <button className="epanel-btn epanel-btn-primary" onClick={testCloud}>{t.testConnectivity}</button>
              {testStatus.state === 'loading' && <span className="epanel-inline-note">{t.requesting}</span>}
              {testStatus.state === 'ok' && (
                <span className="epanel-inline-ok"><CheckCircle2 size={12} /> {t.testOkCloud(testStatus.dim)}</span>
              )}
              {testStatus.state === 'error' && (
                <span className="epanel-inline-err"><AlertTriangle size={12} /> {testStatus.msg}</span>
              )}
            </div>
          </section>
        )}

        {activeSection === 'rerank' && (
          <section className="epanel-section">
            <header className="epanel-section-header">
              <h3>{t.rerankTitle}</h3>
              <p>{t.rerankDesc1}<strong>{t.rerankDescStrong}</strong>{t.rerankDesc2}</p>
            </header>

            <div className="epanel-field">
              <label>{t.providerId}</label>
              <input
                className="epanel-input"
                value={rerankProviderId}
                placeholder="jina / cohere / siliconflow"
                onChange={(e) => setRerankConfig({ rerankProviderId: e.target.value })}
              />
            </div>
            <div className="epanel-field">
              <label>{t.model}</label>
              <input
                className="epanel-input"
                value={rerankModel}
                placeholder="jina-reranker-v2-base-multilingual / rerank-english-v3.0"
                onChange={(e) => setRerankConfig({ rerankModel: e.target.value })}
              />
            </div>
            <div className="epanel-field-row">
              <div className="epanel-field">
                <label>{t.apiKey}</label>
                <input
                  className="epanel-input"
                  type="password"
                  value={rerankApiKey}
                  onChange={(e) => setRerankConfig({ rerankApiKey: e.target.value })}
                />
              </div>
              <div className="epanel-field">
                <label>{t.baseUrl}</label>
                <input
                  className="epanel-input"
                  value={rerankBaseUrl}
                  placeholder="https://api.jina.ai/v1"
                  onChange={(e) => setRerankConfig({ rerankBaseUrl: e.target.value })}
                />
              </div>
            </div>

            <div className="epanel-actions">
              <button className="epanel-btn epanel-btn-primary" onClick={testRerank}>{t.testConnectivity}</button>
              {rerankConfigured && (
                <button className="epanel-btn" onClick={clearRerank}>
                  <Trash2 size={12} /> {t.disableRerank}
                </button>
              )}
              {rerankStatus.state === 'loading' && <span className="epanel-inline-note">{t.requesting}</span>}
              {rerankStatus.state === 'ok' && (
                <span className="epanel-inline-ok"><CheckCircle2 size={12} /> OK</span>
              )}
              {rerankStatus.state === 'error' && (
                <span className="epanel-inline-err"><AlertTriangle size={12} /> {rerankStatus.msg}</span>
              )}
            </div>

            <div className="epanel-tip">
              {t.rerankTip}
            </div>
          </section>
        )}

        {activeSection === 'workspace' && (
          <section className="epanel-section">
            <header className="epanel-section-header">
              <h3>{t.wsTitle}</h3>
              <p>
                {t.wsDesc}
              </p>
            </header>

            {!workspaceRoot ? (
              <div className="epanel-tip">
                <AlertTriangle size={13} /> {t.wsNoWorkspace}
              </div>
            ) : (
              <>
                <div className="epanel-row">
                  <div className="epanel-row-main">
                    <div className="epanel-row-title"><strong>{t.wsCurrent}</strong></div>
                    <div className="epanel-row-hint">
                      <code>{workspaceRoot}</code>
                    </div>
                    <div className="epanel-row-hint" style={{ marginTop: 4 }}>
                      {wsStatus?.indexed && wsStatus.chunkCount > 0 ? (
                        <>
                          {t.wsIndexedPre}<strong>{wsStatus.filesIndexed}</strong>{t.wsIndexedFiles}
                          <strong>{wsStatus.chunkCount}</strong>{t.wsIndexedChunks}{wsStatus.dim}{t.wsIndexedModel}<code>{wsStatus.model}</code>
                          {wsStatus.builtAt > 0 && (
                            <>{t.wsBuiltAt(new Date(wsStatus.builtAt).toLocaleString())}</>
                          )}
                        </>
                      ) : (
                        <>{t.wsNotIndexed}</>
                      )}
                    </div>
                    {wsStatus && wsStatus.errors.length > 0 && (
                      <div className="epanel-row-hint" style={{ marginTop: 4, color: 'var(--accent-yellow, #f9e2af)' }}>
                        <AlertTriangle size={11} /> {t.wsSkipped(wsStatus.errors.length)}
                      </div>
                    )}
                  </div>
                  <div className="epanel-row-actions">
                    {!wsStatus?.indexed || wsStatus.chunkCount === 0 ? (
                      <button
                        className="epanel-btn epanel-btn-primary"
                        onClick={() => void buildWorkspaceIndex(false)}
                        disabled={wsBuilding}
                      >
                        {wsBuilding ? (
                          <><Loader2 size={12} className="spinning" /> {t.wsBuilding}</>
                        ) : (
                          <><Download size={12} /> {t.wsBuild}</>
                        )}
                      </button>
                    ) : (
                      <>
                        <button
                          className="epanel-btn"
                          onClick={() => void buildWorkspaceIndex(true)}
                          disabled={wsBuilding}
                          title={t.wsRebuildTitle}
                        >
                          {wsBuilding ? (
                            <><Loader2 size={12} className="spinning" /> {t.wsRebuilding}</>
                          ) : (
                            <><RefreshCw size={12} /> {t.wsRebuild}</>
                          )}
                        </button>
                        <button
                          className="epanel-btn epanel-btn-danger"
                          onClick={() => void clearWorkspaceIndex()}
                          disabled={wsBuilding}
                        >
                          <Trash2 size={12} /> {t.wsClear}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {wsBuilding && wsProgress && (
                  <div className="epanel-row">
                    <div className="epanel-row-main">
                      <div className="epanel-row-title"><strong>{t.wsProgressTitle}</strong></div>
                      <div className="epanel-row-hint">
                        {wsProgress.phase === 'walk' && t.phaseWalk}
                        {wsProgress.phase === 'chunk' && t.phaseChunk(wsProgress.filesScanned)}
                        {wsProgress.phase === 'embed' && t.phaseEmbed(wsProgress.chunksEmbedded, wsProgress.chunksTotal)}
                        {wsProgress.phase === 'upsert' && t.phaseUpsert}
                        {wsProgress.phase === 'done' && t.phaseDone}
                      </div>
                      {wsProgress.chunksTotal > 0 && (
                        <div style={{
                          marginTop: 6,
                          height: 4,
                          background: 'rgba(255,255,255,0.08)',
                          borderRadius: 2,
                          overflow: 'hidden',
                        }}>
                          <div style={{
                            width: `${Math.min(100, (wsProgress.chunksEmbedded / wsProgress.chunksTotal) * 100)}%`,
                            height: '100%',
                            background: 'var(--accent-blue, #89b4fa)',
                            transition: 'width 0.2s',
                          }} />
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {wsError && (
                  <div className="epanel-tip" style={{ background: 'rgba(243,139,168,0.1)', borderColor: 'rgba(243,139,168,0.3)' }}>
                    <AlertTriangle size={13} /> {wsError}
                  </div>
                )}

                <div className="epanel-tip">
                  {t.wsTip}
                </div>
              </>
            )}
          </section>
        )}

        {activeSection === 'cache' && (
          <section className="epanel-section">
            <header className="epanel-section-header">
              <h3>{t.cacheTitle}</h3>
              <p>{t.cacheDesc}</p>
            </header>

            <div className="epanel-row">
              <div className="epanel-row-main">
                <div className="epanel-row-title"><strong>{t.cacheAttachTitle}</strong></div>
                <div className="epanel-row-hint">
                  {cacheStats ? t.cacheEntries(cacheStats.files, formatBytes(cacheStats.bytes)) : t.loadingShort}
                </div>
                <div className="epanel-row-hint" style={{ marginTop: 4 }}>
                  {t.cacheLocPrefix}<code>userData/attachment-cache/</code>{t.cacheAttachLocSuffix}
                </div>
              </div>
              <div className="epanel-row-actions">
                <button className="epanel-btn epanel-btn-danger" onClick={clearAttachmentCache}>
                  <Trash2 size={12} /> {t.clear}
                </button>
              </div>
            </div>

            <div className="epanel-row">
              <div className="epanel-row-main">
                <div className="epanel-row-title"><strong>{t.cacheVectorTitle}</strong></div>
                <div className="epanel-row-hint">
                  {vectorStats ? t.cacheNamespaces(vectorStats.files, formatBytes(vectorStats.bytes)) : t.loadingShort}
                </div>
                <div className="epanel-row-hint" style={{ marginTop: 4 }}>
                  {t.cacheLocPrefix}<code>userData/vector-store/</code>{t.cacheVectorLocSuffix}
                  <code>{'<kind>-<srcHash>-<modelFp>'}</code>
                </div>
              </div>
              <div className="epanel-row-actions">
                <button className="epanel-btn epanel-btn-danger" onClick={clearVectorStore}>
                  <Trash2 size={12} /> {t.clear}
                </button>
              </div>
            </div>

            <div className="epanel-row">
              <div className="epanel-row-main">
                <div className="epanel-row-title"><strong>{t.cacheStaleTitle}</strong></div>
                <div className="epanel-row-hint">
                  {staleLoading && t.staleProbing}
                  {!staleLoading && !staleSummary && t.staleNoModel}
                  {!staleLoading && staleSummary && (
                    staleSummary.staleEntries === 0
                      ? t.staleNone
                      : t.staleSome(staleSummary.staleEntries, formatBytes(staleSummary.staleBytes))
                  )}
                  {!staleLoading && staleSummary && (
                    <code>{staleSummary.activeModel}</code>
                  )}
                </div>
                <div className="epanel-row-hint" style={{ marginTop: 4 }}>
                  {t.staleHint}
                </div>
              </div>
              <div className="epanel-row-actions">
                <button
                  className="epanel-btn"
                  onClick={() => void refreshStaleSummary()}
                  disabled={staleLoading}
                  title={t.staleRefreshTitle}
                >
                  <RefreshCw size={12} /> {t.refresh}
                </button>
                <button
                  className="epanel-btn epanel-btn-danger"
                  onClick={gcStaleFp}
                  disabled={!staleSummary || staleSummary.staleEntries === 0 || staleLoading}
                >
                  <Trash2 size={12} /> {t.clearStale}
                </button>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

export type {
  LocalModelEntry,
  DownloadableEntry,
  DownloadProgress,
  SectionId,
  SectionMeta,
} from './embeddingPanelTypes'
// Back-compat re-exports: the constants/utilities live in
// `./embeddingPanelTypes`; consumers historically imported them from this
// module. Fast-refresh-affecting non-component exports are intentional here.
/* eslint-disable react-refresh/only-export-components */
export {
  buildSections,
  formatBytes,
} from './embeddingPanelTypes'
/* eslint-enable react-refresh/only-export-components */
