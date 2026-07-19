/**
 * BundleGallery —— 工作包卡片浏览面板（Phase 3 Sprint 3.2）
 *
 * 与 Workbench 的左栏树形列表互补:左栏侧重"编辑上下文"(紧凑列表
 * 配合中栏详情);Gallery 是"浏览/选择上下文"(卡片网格 + 富信息
 * 展示),相当于工作包市集的"本地视图"。
 *
 * 数据源纯粹来自 `bundleStore`;所有 IPC 能力(激活/导入/导出/新建)
 * 已在 Sprint 2 齐备,这里只是把它们组装成新入口。
 *
 * MVP 范围:
 *   ✓ 本地已加载的所有 bundles 按来源分组展示
 *   ✓ 顶部搜索(名称/描述/domain 模糊匹配) + 来源过滤
 *   ✓ 每卡:激活 / 在工作台编辑 / 导出 JSON
 *   ✓ 顶部操作: + 新建 / + 从文件导入
 *   ✗ 远程/社区源(需要后端索引服务,留给后续 Sprint)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  X,
  PackageOpen,
  Search,
  Plus,
  Upload,
  Download,
  Sparkles,
  CheckCircle2,
  ArrowUpRight,
  Package,
  Bot,
  Users,
} from 'lucide-react'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useBundleList, useBundleStore } from '../../stores/bundleStore'
import type { Bundle, BundleSource } from '../../../electron/agents/bundles/types'
import { CreateBundleDialog } from '../Workbench/CreateBundleDialog'
import { useConfirmDialog } from '../common/ConfirmDialog'
import './BundleGallery.css'

type SourceFilter = 'all' | BundleSource

const SOURCE_LABEL: Record<BundleSource, string> = {
  preset: '内置',
  user: '用户',
  project: '项目',
  imported: '导入',
}

const SOURCE_HINT: Record<BundleSource, string> = {
  preset: '随程序出厂,升级会随之更新;编辑会自动复制到用户目录',
  user: '你自己的工作包,跨项目共享',
  project: '绑定到当前工作区,会与代码一起进版本库',
  imported: '从外部 JSON 文件导入',
}

export const BundleGallery: React.FC = () => {
  const visible = useLayoutStore((s) => s.bundleGalleryVisible)
  const setVisible = useLayoutStore((s) => s.setBundleGalleryVisible)
  const setWorkbenchVisible = useLayoutStore((s) => s.setWorkbenchVisible)
  const setWorkbenchInitialSelection = useLayoutStore(
    (s) => s.setWorkbenchInitialSelection,
  )

  const bundles = useBundleList()
  const activeBundleId = useBundleStore((s) => s.activeBundleId)
  const activate = useBundleStore((s) => s.activate)
  const exportBundle = useBundleStore((s) => s.exportBundle)
  const importBundle = useBundleStore((s) => s.importBundle)

  const [query, setQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [createDialog, setCreateDialog] = useState<{ copyFromId?: string } | null>(null)

  // Non-blocking toast + React confirm modal, replacing the native
  // `window.alert` / `window.confirm` modals that detach the chat textarea's
  // Chinese IME on Windows and lock the input for ~20s. Mirrors BundleSwitcher.
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const noticeTimerRef = useRef<number | null>(null)
  const showNotice = useCallback((kind: 'info' | 'error', text: string) => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    setNotice({ kind, text })
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null)
      noticeTimerRef.current = null
    }, kind === 'error' ? 5000 : 2600)
  }, [])
  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    }
  }, [])
  const { dialog: confirmDialog, askConfirm } = useConfirmDialog()
  const refocusChatInput = useCallback(() => {
    window.dispatchEvent(new CustomEvent('pole:refocus-chat-input'))
  }, [])

  // Esc 关闭
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (!createDialog) setVisible(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [visible, setVisible, createDialog])

  // 面板关闭时顺手清搜索,下次重新打开回到初始态
  useEffect(() => {
    if (!visible) {
      setQuery('')
      setSourceFilter('all')
      setBusyId(null)
    }
  }, [visible])

  // 按来源分组 + 搜索过滤。按来源组展示有助于用户理解"我自己的" vs
  // "内置的"的边界,尤其当 bundles 数量增长到 10+ 时。
  const filteredBundles = useMemo(() => {
    const q = query.trim().toLowerCase()
    return bundles.filter((b) => {
      if (sourceFilter !== 'all' && b.meta.source !== sourceFilter) return false
      if (!q) return true
      const hay = [
        b.meta.id,
        b.meta.name,
        b.meta.description,
        b.meta.domain,
        b.meta.author,
      ]
        .filter((s): s is string => typeof s === 'string')
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [bundles, query, sourceFilter])

  const grouped = useMemo(() => {
    const order: BundleSource[] = ['user', 'project', 'preset', 'imported']
    const map = new Map<BundleSource, Bundle[]>()
    for (const b of filteredBundles) {
      const arr = map.get(b.meta.source) ?? []
      arr.push(b)
      map.set(b.meta.source, arr)
    }
    return order
      .map((src) => ({ source: src, bundles: map.get(src) ?? [] }))
      .filter((g) => g.bundles.length > 0)
  }, [filteredBundles])

  const sourceCounts = useMemo(() => {
    const c = { all: bundles.length, preset: 0, user: 0, project: 0, imported: 0 }
    for (const b of bundles) c[b.meta.source] = (c[b.meta.source] ?? 0) + 1
    return c
  }, [bundles])

  const handleActivate = useCallback(
    async (bundleId: string) => {
      if (bundleId === activeBundleId) return
      setBusyId(bundleId)
      try {
        await activate(bundleId)
      } catch (err) {
        showNotice('error', `激活失败:${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setBusyId(null)
      }
    },
    [activate, activeBundleId, showNotice],
  )

  const handleOpenInWorkbench = useCallback(
    (bundleId: string) => {
      setWorkbenchInitialSelection({ kind: 'bundle-meta', bundleId })
      setVisible(false)
      requestAnimationFrame(() => setWorkbenchVisible(true))
    },
    [setWorkbenchInitialSelection, setVisible, setWorkbenchVisible],
  )

  const handleExport = useCallback(
    async (bundle: Bundle) => {
      try {
        const res = await exportBundle(bundle.meta.id)
        if (res.ok) {
          showNotice('info', `工作包已导出到:\n${res.filePath}`)
        } else if (!('canceled' in res && res.canceled)) {
          showNotice('error', `导出失败:${'error' in res ? res.error : '未知错误'}`)
        }
      } catch (err) {
        showNotice('error', `导出失败:${err instanceof Error ? err.message : String(err)}`)
      } finally {
        // The native save dialog detached the chat textarea's IME; re-attach.
        refocusChatInput()
      }
    },
    [exportBundle, showNotice, refocusChatInput],
  )

  const handleImport = useCallback(async () => {
    try {
      let result = await importBundle()

      while (
        !result.ok &&
        !('canceled' in result && result.canceled) &&
        (result.reason === 'id-conflict' || result.reason === 'preset-conflict') &&
        result.filePath
      ) {
        const isPreset = result.reason === 'preset-conflict'
        const useSuggested = await askConfirm({
          title: '工作包 ID 冲突',
          message:
            `工作包 ID "${result.attemptedId ?? '?'}" ${isPreset ? '与内置工作包冲突' : '已存在'}。\n\n` +
            `是否改用建议的 ID「${result.suggestedId ?? '(无)'}」导入？\n` +
            `(点"取消"可${isPreset ? '终止' : '选择覆盖现有工作包'})`,
          confirmText: '用建议 ID 导入',
          cancelText: '取消',
        })
        if (useSuggested && result.suggestedId) {
          result = await importBundle({
            filePath: result.filePath,
            newId: result.suggestedId,
          })
          continue
        }
        if (isPreset) return
        const replace = await askConfirm({
          title: '覆盖现有工作包？',
          message: `确定要覆盖现有的工作包「${result.attemptedId ?? '?'}」吗？`,
          confirmText: '覆盖',
          cancelText: '取消',
          variant: 'danger',
        })
        if (!replace) return
        result = await importBundle({
          filePath: result.filePath,
          replaceExisting: true,
        })
      }

      if (result.ok) {
        // 导入成功后:先 await 激活新 bundle(触发 hydrate 重置聊天状态),
        // 再关闭 Gallery 覆盖层让焦点回到主界面 —— 覆盖层是 aria-modal 焦点
        // 陷阱,不关则 ChatInput 拿不到焦点。关闭后派发 refocus 让中文输入法
        // 重新 attach 到 textarea。成功反馈由"覆盖层关闭 + 新工作包激活"体现,
        // 不再用会掐断 IME 的 window.alert。
        const bundleId = result.bundle.meta.id
        try {
          await activate(bundleId)
        } catch (activateErr) {
          console.warn('[BundleGallery] activate after import failed:', activateErr)
        }
        setVisible(false)
      } else if (!('canceled' in result && result.canceled)) {
        showNotice('error', `导入失败:${'error' in result ? result.error : '未知错误'}`)
      }
    } catch (err) {
      showNotice('error', `导入失败:${err instanceof Error ? err.message : String(err)}`)
    } finally {
      // The native open dialog detached the chat textarea's IME; re-attach
      // (fires after the overlay closes on success, so focus lands on the
      // main window's chat composer).
      refocusChatInput()
    }
  }, [importBundle, activate, setVisible, askConfirm, showNotice, refocusChatInput])

  if (!visible) return null

  return (
    <div
      className="bundle-gallery-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="工作包库"
    >
      <div
        className="bundle-gallery-backdrop"
        onClick={() => setVisible(false)}
        aria-hidden="true"
      />
      <div className="bundle-gallery-surface" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <header className="bundle-gallery-header">
          <div className="bundle-gallery-header-title">
            <PackageOpen size={16} className="bundle-gallery-header-icon" />
            <span className="bundle-gallery-title">工作包库</span>
            <span className="bundle-gallery-subtitle">
              本地已加载 {bundles.length} 个,当前激活
              <span className="bundle-gallery-active-name">
                {bundles.find((b) => b.meta.id === activeBundleId)?.meta.name ?? '—'}
              </span>
            </span>
          </div>
          <div className="bundle-gallery-header-actions">
            <button
              type="button"
              className="bundle-gallery-header-btn bundle-gallery-header-btn-primary"
              onClick={() => setCreateDialog({})}
              title="新建工作包"
            >
              <Plus size={12} />
              <span>新建</span>
            </button>
            <button
              type="button"
              className="bundle-gallery-header-btn"
              onClick={() => void handleImport()}
              title="从 JSON 文件导入"
            >
              <Upload size={12} />
              <span>导入</span>
            </button>
            <button
              type="button"
              className="bundle-gallery-icon-btn"
              onClick={() => setVisible(false)}
              title="关闭 (Esc)"
              aria-label="关闭"
            >
              <X size={15} />
            </button>
          </div>
        </header>

        {notice ? (
          <div
            className="bundle-gallery-notice"
            role="status"
            aria-live="polite"
            data-kind={notice.kind}
          >
            {notice.text}
          </div>
        ) : null}

        {/* Toolbar: 搜索 + 来源切换 */}
        <div className="bundle-gallery-toolbar">
          <div className="bundle-gallery-search">
            <Search size={12} className="bundle-gallery-search-icon" />
            <input
              type="text"
              placeholder="按名称 / 描述 / 领域 / 作者 搜索…"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
            {query ? (
              <button
                type="button"
                className="bundle-gallery-search-clear"
                onClick={() => setQuery('')}
                title="清除"
              >
                <X size={10} />
              </button>
            ) : null}
          </div>
          <div className="bundle-gallery-source-tabs" role="tablist">
            {(['all', 'preset', 'user', 'project', 'imported'] as const).map((src) => {
              const count = src === 'all' ? sourceCounts.all : sourceCounts[src]
              if (src !== 'all' && count === 0) return null
              return (
                <button
                  key={src}
                  type="button"
                  role="tab"
                  aria-selected={sourceFilter === src}
                  className={`bundle-gallery-source-tab ${sourceFilter === src ? 'is-active' : ''}`}
                  onClick={() => setSourceFilter(src)}
                  title={src === 'all' ? '全部来源' : SOURCE_HINT[src]}
                >
                  <span>{src === 'all' ? '全部' : SOURCE_LABEL[src]}</span>
                  <span className="bundle-gallery-source-count">{count}</span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Body */}
        <div className="bundle-gallery-body">
          {filteredBundles.length === 0 ? (
            <div className="bundle-gallery-empty">
              <PackageOpen size={32} strokeWidth={1.3} />
              {bundles.length === 0 ? (
                <>
                  <p>目前没有加载任何工作包。</p>
                  <p className="bundle-gallery-empty-hint">
                    点顶部「新建」从空白或现有工作包开始,或点「导入」载入一个 JSON 文件。
                  </p>
                </>
              ) : (
                <>
                  <p>未找到匹配的工作包。</p>
                  <p className="bundle-gallery-empty-hint">
                    试试清空搜索或切换来源过滤。
                  </p>
                </>
              )}
            </div>
          ) : (
            grouped.map(({ source, bundles: groupBundles }) => (
              <section key={source} className="bundle-gallery-group">
                <div className="bundle-gallery-group-header">
                  <span className="bundle-gallery-group-title">
                    {SOURCE_LABEL[source]}工作包
                  </span>
                  <span className="bundle-gallery-group-hint">
                    {SOURCE_HINT[source]}
                  </span>
                </div>
                <div className="bundle-gallery-grid">
                  {groupBundles.map((bundle) => (
                    <BundleCard
                      key={bundle.meta.id}
                      bundle={bundle}
                      isActive={bundle.meta.id === activeBundleId}
                      busy={busyId === bundle.meta.id}
                      onActivate={() => void handleActivate(bundle.meta.id)}
                      onEdit={() => handleOpenInWorkbench(bundle.meta.id)}
                      onExport={() => void handleExport(bundle)}
                      onFork={() => setCreateDialog({ copyFromId: bundle.meta.id })}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>

      {createDialog ? (
        <CreateBundleDialog
          bundles={bundles}
          defaultCopyFromId={createDialog.copyFromId}
          onClose={() => setCreateDialog(null)}
          onCreated={(newBundle) => {
            // Gallery 里新建完自动激活一下,让用户能立刻在主界面看到效果
            void handleActivate(newBundle.meta.id)
          }}
        />
      ) : null}

      {confirmDialog}
    </div>
  )
}

// ─── 单张 Bundle 卡片 ────────────────────────────────────────────

// Sprint 7: memo —— 大量 bundle 时避免无关状态变化触发全列表重渲染。
const BundleCard: React.FC<{
  bundle: Bundle
  isActive: boolean
  busy: boolean
  onActivate: () => void
  onEdit: () => void
  onExport: () => void
  onFork: () => void
}> = React.memo(function BundleCard({
  bundle,
  isActive,
  busy,
  onActivate,
  onEdit,
  onExport,
  onFork,
}) {
  const primary = bundle.agents.find((a) => a.isPrimary) ?? bundle.agents[0]

  return (
    <article
      className={`bundle-card ${isActive ? 'is-active' : ''}`}
      aria-current={isActive ? 'true' : undefined}
    >
      {/* 角标 / 状态条 */}
      {isActive ? (
        <div className="bundle-card-active-bar">
          <CheckCircle2 size={11} />
          <span>当前激活</span>
        </div>
      ) : null}

      <div className="bundle-card-head">
        <div className="bundle-card-icon" aria-hidden="true">
          <Package size={20} strokeWidth={1.5} />
        </div>
        <div className="bundle-card-identity">
          <div className="bundle-card-name" title={bundle.meta.name}>
            {bundle.meta.name}
          </div>
          <div className="bundle-card-id mono" title={bundle.meta.id}>
            {bundle.meta.id}
          </div>
        </div>
        {bundle.meta.domain ? (
          <span className="bundle-card-domain" title="领域">
            {bundle.meta.domain}
          </span>
        ) : null}
      </div>

      <div className="bundle-card-description" title={bundle.meta.description}>
        {bundle.meta.description || (
          <span className="bundle-card-description-dim">（无描述）</span>
        )}
      </div>

      <div className="bundle-card-stats">
        <span title="智能体数量">
          <Bot size={11} /> {bundle.agents.length}
        </span>
        <span title="团队数量">
          <Users size={11} /> {bundle.teams.length}
        </span>
        {primary ? (
          <span className="bundle-card-primary-hint" title="默认智能体">
            主:{primary.displayName ?? primary.agentType}
          </span>
        ) : null}
        {bundle.meta.author ? (
          <span className="bundle-card-author" title="作者">
            作者:{bundle.meta.author}
          </span>
        ) : null}
      </div>

      <div className="bundle-card-actions">
        <button
          type="button"
          className="bundle-card-btn bundle-card-btn-primary"
          onClick={onActivate}
          disabled={isActive || busy}
          title={isActive ? '该工作包已激活' : '切换到此工作包'}
        >
          {isActive ? (
            <>
              <CheckCircle2 size={11} />
              <span>已激活</span>
            </>
          ) : (
            <>
              <Sparkles size={11} />
              <span>{busy ? '激活中…' : '激活'}</span>
            </>
          )}
        </button>
        <button
          type="button"
          className="bundle-card-btn"
          onClick={onEdit}
          title="在工作台中打开进行编辑"
        >
          <ArrowUpRight size={11} />
          <span>在工作台编辑</span>
        </button>
        <div className="bundle-card-secondary-actions">
          <button
            type="button"
            className="bundle-card-icon-btn"
            onClick={onFork}
            title="以此为模板新建"
          >
            <Plus size={11} />
          </button>
          <button
            type="button"
            className="bundle-card-icon-btn"
            onClick={onExport}
            title="导出为 JSON"
          >
            <Download size={11} />
          </button>
        </div>
      </div>
    </article>
  )
})
