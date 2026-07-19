/**
 * BundleSwitcher —— TitleBar 中间的工作包切换器。
 *
 * 旧方案迭代:
 *   - 第 1 版是 TitleBar BundleSelector(只切换)
 *   - 第 2 版是 WorkspaceTabBar(横排 tabs,bundle 多时占空间)
 *   - **当前(第 3 版)**:回到 TitleBar 中间下拉,但下拉里功能齐全
 *     (切换 + 每项编辑/删除子菜单 + 底部新建入口)
 *
 * 主路径:
 *   - 点触发器 → 弹出 popover
 *   - popover 顶部:当前激活 bundle 的信息卡
 *   - popover 中部:所有 bundle 列表,点击切换 + 当前项√
 *   - popover 底部:`+ 新建工作包`
 *   - 每个 bundle 行右边有一个小的 `⋯` 按钮,点它展开二级菜单:
 *     编辑 / 删除
 *
 * 性能:tabs 用 useMemo 投影为精简 `BundleMeta[]`;按钮 React.memo;
 * 下拉关闭时不渲染。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronDown,
  Plus,
  Check,
  MoreHorizontal,
  Pencil,
  Trash2,
  Package,
  Download,
  Upload,
} from 'lucide-react'
import * as LucideIcons from 'lucide-react'
import { useBundleStore } from '../../stores/bundleStore'
import { useLayoutStore } from '../../stores/useLayoutStore'
import type { Bundle } from '../../../electron/agents/bundles/types'
import { CreateBundleDialog } from '../Workbench/CreateBundleDialog'
import { useConfirmDialog } from '../common/ConfirmDialog'
import './BundleSwitcher.css'

interface BundleMeta {
  id: string
  name: string
  icon: string | undefined
  domain: string | undefined
  description: string | undefined
  source: string
}

function resolveIcon(
  name: string | undefined,
): React.FC<{ size?: number; strokeWidth?: number }> {
  if (!name) return Package as unknown as React.FC<{ size?: number }>
  const Icon = (LucideIcons as unknown as Record<string, unknown>)[name] as
    | React.FC<{ size?: number; strokeWidth?: number }>
    | undefined
  return Icon ?? (Package as unknown as React.FC<{ size?: number }>)
}

export const BundleSwitcher: React.FC = () => {
  const bundles = useBundleStore((s) => s.bundles)
  const activeBundleId = useBundleStore((s) => s.activeBundleId)
  const activate = useBundleStore((s) => s.activate)
  const deleteBundle = useBundleStore((s) => s.deleteBundle)
  const exportBundle = useBundleStore((s) => s.exportBundle)
  const importBundle = useBundleStore((s) => s.importBundle)

  const setWorkbenchVisible = useLayoutStore((s) => s.setWorkbenchVisible)
  const setWorkbenchInitialSelection = useLayoutStore(
    (s) => s.setWorkbenchInitialSelection,
  )

  const metas: BundleMeta[] = useMemo(
    () =>
      bundles.map((b) => ({
        id: b.meta.id,
        name: b.meta.name,
        icon: b.meta.icon,
        domain: b.meta.domain,
        description: b.meta.description,
        source: b.meta.source,
      })),
    [bundles],
  )

  const activeMeta = useMemo(
    () => metas.find((m) => m.id === activeBundleId) ?? null,
    [metas, activeBundleId],
  )

  const [open, setOpen] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  // 二级菜单:bundle 行右边 ⋯ 按钮打开 "编辑 / 删除"
  const [subMenuId, setSubMenuId] = useState<string | null>(null)
  // popover 用 fixed 定位(规避父级 .app-container overflow:hidden 的
  // clip);这里保存锚定的 trigger 中心点和底边,每次展开时计算。
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)

  // Non-blocking replacements for the native `window.alert` / `window.confirm`
  // that used to live here. On Windows + Chinese IME those synchronous Chromium
  // modals detach the chat composer's IMM channel on dismiss, leaving the input
  // unable to accept keystrokes (no caret) for as long as the main thread stays
  // busy — e.g. the IPC burst from a bundle `activate`. The React-portal
  // confirm dialog + the inline toast below never block the renderer, so the
  // IMM channel is never severed. See `common/ConfirmDialog.tsx` for the full
  // root-cause writeup.
  const { dialog: confirmDialog, askConfirm } = useConfirmDialog()
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const noticeTimerRef = useRef<number | null>(null)
  const showNotice = useCallback((kind: 'info' | 'error', text: string) => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    setNotice({ kind, text })
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null)
      noticeTimerRef.current = null
    }, 3600)
  }, [])
  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    }
  }, [])

  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  // 打开时测量 trigger 位置并**自己算好最终 left**(不依赖 CSS
   // translateX 居中,避免 transform 和 animation keyframes 耦合时的副作用)。
  // resize/scroll 时重新测,但用 rAF 合批以避免每个 scroll 事件
  // 都触发一次同步 layout (`getBoundingClientRect`).
  useEffect(() => {
    if (!open) return
    const POPOVER_WIDTH = 340 // 估算,实际会略有浮动,钳位兜底
    const VIEW_MARGIN = 8
    const recompute = () => {
      const el = triggerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const viewportW = window.innerWidth
      const centerX = rect.left + rect.width / 2
      let left = centerX - POPOVER_WIDTH / 2
      left = Math.max(
        VIEW_MARGIN,
        Math.min(viewportW - POPOVER_WIDTH - VIEW_MARGIN, left),
      )
      setAnchor({ top: rect.bottom + 4, left })
    }
    let frameId = 0
    const scheduleRecompute = () => {
      if (frameId !== 0) return
      frameId = requestAnimationFrame(() => {
        frameId = 0
        recompute()
      })
    }
    recompute()
    window.addEventListener('resize', scheduleRecompute)
    window.addEventListener('scroll', scheduleRecompute, true)
    return () => {
      if (frameId !== 0) cancelAnimationFrame(frameId)
      window.removeEventListener('resize', scheduleRecompute)
      window.removeEventListener('scroll', scheduleRecompute, true)
    }
  }, [open])

  // 点击外部 / ESC 关闭 popover。popover 因为用 fixed + portal-like
  // 逻辑(直接在 React tree 里,但视觉脱离 wrapper 位置),需要判断
  // 点击目标是否在 wrapper **或** popover 内 —— 两者都放在同一 React
  // 子树,但通过 data attr 区分,简单一点用 closest。
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null
      if (!target) return
      if (
        wrapperRef.current?.contains(target) ||
        target.closest('.bundle-switcher-popover')
      ) {
        return
      }
      setOpen(false)
      setSubMenuId(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        setSubMenuId(null)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const handlePick = useCallback(
    (id: string) => {
      setOpen(false)
      setSubMenuId(null)
      if (id !== activeBundleId) void activate(id)
    },
    [activate, activeBundleId],
  )

  const handleOpenEdit = useCallback(
    (id: string) => {
      setWorkbenchInitialSelection({ kind: 'bundle-meta', bundleId: id })
      setWorkbenchVisible(true)
      setOpen(false)
      setSubMenuId(null)
    },
    [setWorkbenchInitialSelection, setWorkbenchVisible],
  )

  const handleDelete = useCallback(
    async (id: string) => {
      const b = bundles.find((x) => x.meta.id === id)
      if (!b) return
      const ok = await askConfirm({
        title: '删除工作包',
        message:
          `确定删除工作包「${b.meta.name}」?\n\n` +
          `这会删除它的磁盘文件${
            b.meta.source === 'preset'
              ? '(但 preset 源会在下次启动恢复)'
              : ''
          }。对话历史不会被删除。`,
        confirmText: '删除',
        cancelText: '取消',
        variant: 'danger',
      })
      if (!ok) return
      setOpen(false)
      setSubMenuId(null)
      try {
        await deleteBundle(id)
      } catch (err) {
        showNotice('error', `删除失败:${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [bundles, deleteBundle, askConfirm, showNotice],
  )

  const handleCreateOpen = useCallback(() => {
    setOpen(false)
    setSubMenuId(null)
    setShowCreate(true)
  }, [])

  const handleCreated = useCallback(
    (newBundle: Bundle) => {
      setShowCreate(false)
      void activate(newBundle.meta.id)
    },
    [activate],
  )

  const handleExport = useCallback(
    async (id: string) => {
      setOpen(false)
      setSubMenuId(null)
      try {
        const result = await exportBundle(id)
        if (result.ok) {
          showNotice('info', `工作包已导出到:\n${result.filePath}`)
        } else if (!('canceled' in result && result.canceled)) {
          showNotice('error', `导出失败:${'error' in result ? result.error : '未知错误'}`)
        }
      } catch (err) {
        showNotice('error', `导出失败:${err instanceof Error ? err.message : String(err)}`)
      } finally {
        // The native `dialog.showSaveDialog` (main process) detaches the chat
        // textarea's Chinese-IME channel on Windows; once it closes the input
        // looks focused but swallows keys until something re-focuses it. Nudge
        // ChatInput to re-attach so the user isn't locked out for ~20s.
        window.dispatchEvent(new CustomEvent('pole:refocus-chat-input'))
      }
    },
    [exportBundle, showNotice],
  )

  const handleImport = useCallback(async () => {
    setOpen(false)
    setSubMenuId(null)
    try {
      let result = await importBundle()
      // 冲突时给一次"用建议 ID"的机会,复杂重试(覆盖/三选一)在工作台
      // 里做;BundleSwitcher 的下拉保持简洁,两步内要么成要么让用户去工作台。
      if (
        !result.ok &&
        !('canceled' in result && result.canceled) &&
        (result.reason === 'id-conflict' || result.reason === 'preset-conflict') &&
        result.filePath &&
        result.suggestedId
      ) {
        const useSuggested = await askConfirm({
          title: '工作包 ID 冲突',
          message:
            `工作包 ID「${result.attemptedId ?? '?'}」已存在。\n是否改用建议 ID「${result.suggestedId}」导入?\n\n(如需覆盖或更细粒度处理,请打开工作台导入)`,
          confirmText: '用建议 ID 导入',
          cancelText: '取消',
        })
        if (useSuggested) {
          result = await importBundle({
            filePath: result.filePath,
            newId: result.suggestedId,
          })
        } else {
          return
        }
      }
      if (result.ok) {
        // 先 **await** 激活:它内部会触发 hydrateAfterWorkspaceChange
        // (取消流、清消息、加载新 bundle 下最近对话),再提示用户。
        // 提示走下方的非阻塞 toast(`showNotice`)而非 `window.alert` ——
        // 后者是同步原生模态,在 Windows + 中文 IME 下关闭时会掐断聊天
        // 输入框的 IMM 通道,导致激活那串 IPC 跑完前(~20s)输入框点不进、
        // 敲键盘无反应。toast 不阻塞渲染线程,IMM 通道不会被切断。
        const bundleName = result.bundle.meta.name
        const verb = result.replaced ? '已覆盖导入' : '已导入'
        try {
          await activate(result.bundle.meta.id)
        } catch (activateErr) {
          console.warn('[BundleSwitcher] activate after import failed:', activateErr)
        }
        showNotice('info', `${verb}工作包「${bundleName}」`)
      } else if (!('canceled' in result && result.canceled)) {
        showNotice('error', `导入失败:${'error' in result ? result.error : '未知错误'}`)
      }
    } catch (err) {
      showNotice('error', `导入失败:${err instanceof Error ? err.message : String(err)}`)
    } finally {
      // Same native-dialog IME-detach remedy as handleExport: the open dialog
      // steals the textarea's IMM channel; re-attach focus once we're done.
      window.dispatchEvent(new CustomEvent('pole:refocus-chat-input'))
    }
  }, [importBundle, activate, askConfirm, showNotice])

  if (!activeMeta) return null

  const TriggerIcon = resolveIcon(activeMeta.icon)

  return (
    <>
      <div className="bundle-switcher" ref={wrapperRef}>
        <button
          ref={triggerRef}
          type="button"
          className={`bundle-switcher-trigger ${open ? 'is-open' : ''}`}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="listbox"
          title={`当前工作包:${activeMeta.name}\n点击切换`}
        >
          {/* `TriggerIcon` is picked from a stable bundle-icon map, not
              created at render. */}
          {/* eslint-disable-next-line react-hooks/static-components */}
          <TriggerIcon size={13} strokeWidth={1.7} />
          <span className="bundle-switcher-label">{activeMeta.name}</span>
          <ChevronDown
            size={11}
            className={`bundle-switcher-chevron ${open ? 'is-open' : ''}`}
          />
        </button>

      </div>

      {/*
        Popover 走 Portal 直接渲染到 document.body —— 关键原因:
        `.titlebar-center` 祖先有 `transform: translateX(-50%)`,这在 CSS
        里让它成为 `position: fixed` 后代的 "containing block",导致
        fixed 元素的 left/top 不再相对视窗,而是相对这个 transformed
        的祖先(只有几十像素宽),视觉上 popover 就会跑偏。Portal 把
        popover 挂到 body 下,祖先链里无 transform,fixed 恢复正常行为。
      */}
      {open && anchor
        ? createPortal(
            <div
              className="bundle-switcher-popover"
              role="listbox"
              style={{ top: anchor.top, left: anchor.left }}
            >
              <div className="bundle-switcher-popover-header">
                <span className="bundle-switcher-popover-title">工作包</span>
                <span className="bundle-switcher-popover-count">
                  {metas.length} 个
                </span>
              </div>

              <div className="bundle-switcher-list">
                {metas.map((m) => (
                  <BundleRow
                    key={m.id}
                    meta={m}
                    active={m.id === activeBundleId}
                    subMenuOpen={subMenuId === m.id}
                    canDelete={metas.length > 1}
                    onSelect={handlePick}
                    onToggleSubMenu={(id) =>
                      setSubMenuId((cur) => (cur === id ? null : id))
                    }
                    onEdit={handleOpenEdit}
                    onDelete={(id) => void handleDelete(id)}
                    onExport={(id) => void handleExport(id)}
                  />
                ))}
              </div>

              <div className="bundle-switcher-footer">
                <button
                  type="button"
                  className="bundle-switcher-footer-btn bundle-switcher-footer-btn-primary"
                  onClick={handleCreateOpen}
                  title="新建一个空白 / 复制模板的工作包"
                >
                  <Plus size={12} /> 新建
                </button>
                <button
                  type="button"
                  className="bundle-switcher-footer-btn"
                  onClick={() => void handleImport()}
                  title="从 JSON 文件导入别人分享的工作包"
                >
                  <Upload size={12} /> 导入
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}

      {showCreate ? (
        <CreateBundleDialog
          bundles={bundles}
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      ) : null}

      {/* Promise-based confirm modal (replaces native window.confirm). */}
      {confirmDialog}

      {/* Non-blocking toast (replaces native window.alert). Portal to body so
          the TitleBar's transformed ancestors don't clip / mis-position it. */}
      {notice
        ? createPortal(
            <div
              className="bundle-switcher-notice"
              role="status"
              aria-live="polite"
              data-kind={notice.kind}
            >
              {notice.text}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

// ─── Bundle row(memoized) ───────────────────────────────────────

interface BundleRowProps {
  meta: BundleMeta
  active: boolean
  subMenuOpen: boolean
  canDelete: boolean
  onSelect: (id: string) => void
  onToggleSubMenu: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onExport: (id: string) => void
}

const BundleRow: React.FC<BundleRowProps> = React.memo(function BundleRow({
  meta,
  active,
  subMenuOpen,
  canDelete,
  onSelect,
  onToggleSubMenu,
  onEdit,
  onDelete,
  onExport,
}) {
  const Icon = resolveIcon(meta.icon)
  return (
    <div className={`bundle-switcher-row ${active ? 'is-active' : ''}`}>
      <button
        type="button"
        className="bundle-switcher-row-main"
        role="option"
        aria-selected={active}
        onClick={() => onSelect(meta.id)}
      >
        <span className="bundle-switcher-row-icon" aria-hidden>
          {/* Stable icon lookup (see comment on TriggerIcon above). */}
          {/* eslint-disable-next-line react-hooks/static-components */}
          <Icon size={13} strokeWidth={1.7} />
        </span>
        <span className="bundle-switcher-row-body">
          <span className="bundle-switcher-row-title">
            <span className="bundle-switcher-row-name">{meta.name}</span>
            {meta.domain ? (
              <span className="bundle-switcher-row-domain">{meta.domain}</span>
            ) : null}
          </span>
          {meta.description ? (
            <span className="bundle-switcher-row-desc">{meta.description}</span>
          ) : null}
        </span>
        {active ? (
          <Check
            size={12}
            className="bundle-switcher-row-check"
            aria-hidden
          />
        ) : null}
      </button>

      <button
        type="button"
        className="bundle-switcher-row-more"
        onClick={(e) => {
          e.stopPropagation()
          onToggleSubMenu(meta.id)
        }}
        title="更多操作"
        aria-label="更多操作"
      >
        <MoreHorizontal size={13} />
      </button>

      {subMenuOpen ? (
        <div className="bundle-switcher-submenu" role="menu">
          <button
            type="button"
            className="bundle-switcher-submenu-item"
            onClick={() => onEdit(meta.id)}
          >
            <Pencil size={11} /> 编辑
          </button>
          <button
            type="button"
            className="bundle-switcher-submenu-item"
            onClick={() => onExport(meta.id)}
            title="导出为 JSON,可分享给其他用户"
          >
            <Download size={11} /> 导出为 JSON
          </button>
          <button
            type="button"
            className="bundle-switcher-submenu-item bundle-switcher-submenu-item-danger"
            disabled={!canDelete}
            title={!canDelete ? '至少保留一个工作包' : undefined}
            onClick={() => onDelete(meta.id)}
          >
            <Trash2 size={11} /> 删除
          </button>
        </div>
      ) : null}
    </div>
  )
})
