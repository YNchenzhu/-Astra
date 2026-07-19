/**
 * Workbench left column — nested tree of bundles → agents + teams.
 *
 * Sprint 1 scope (read-only): lists bundles, each row expandable to
 * show agents + teams; clicking any row navigates the middle column.
 *
 * Sprint 2c.2a additions:
 *   - 顶部「+ 新建工作包」按钮,打开 CreateBundleDialog
 *   - 每个 bundle 行右侧 hover 显示「⋯」菜单(目前仅"删除")
 *   - Preset-tier bundles 的删除按钮 disabled,tooltip 解释为什么
 *   - 删除前走 JS `confirm` 二次确认(destructive action 最低成本的
 *     防误触,后续可升级为自定义对话框)
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  Package,
  Bot,
  Users,
  Star,
  Plus,
  MoreHorizontal,
  Trash2,
  Copy,
  X,
  Download,
  Upload,
} from 'lucide-react'
import type { Bundle } from '../../../electron/agents/bundles/types'
import type { WorkbenchSelection } from './AgentWorkbench'
import { useBundleStore } from '../../stores/bundleStore'
import { CreateBundleDialog } from './CreateBundleDialog'
import { InlineAddRow } from './InlineAddRow'
import { useConfirmDialog } from '../common/ConfirmDialog'
import { useT } from '../../i18n'
import './BundleListPane.css'

export interface BundleListPaneProps {
  bundles: Bundle[]
  selection: WorkbenchSelection
  onSelect: (next: WorkbenchSelection) => void
}

export const BundleListPane: React.FC<BundleListPaneProps> = ({
  bundles,
  selection,
  onSelect,
}) => {
  const t = useT()
  const bl = t.workbench.bundleList
  const initiallyOpen = useMemo<Set<string>>(() => {
    const set = new Set<string>()
    if (selection.kind !== 'none') set.add(selection.bundleId)
    return set
  }, [selection])
  const [openBundleIds, setOpenBundleIds] = useState<Set<string>>(initiallyOpen)

  // 悬停菜单:同时最多一个 bundle 的菜单展开(点击"⋯"切换)。
  const [menuOpenForId, setMenuOpenForId] = useState<string | null>(null)
  const [createDialog, setCreateDialog] = useState<
    { open: true; copyFromId?: string } | null
  >(null)
  // Non-blocking toast (replaces native `window.alert`, which on Windows +
  // Chinese IME detaches the chat textarea's IMM channel and leaves it
  // key-swallowing for ~20s). Auto-dismisses; error variant styled via data-kind.
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

  // Promise-based confirm modal (replaces native `window.confirm`, same IME
  // detach hazard as window.alert). Rendered React-side, so no native modal.
  const { dialog: confirmDialog, askConfirm } = useConfirmDialog()

  // The native OS file dialog behind export/import (main-process
  // showSaveDialog / showOpenDialog) also steals the chat textarea's IME
  // focus. Nudge ChatInput to re-attach once we're back (mirrors BundleSwitcher).
  const refocusChatInput = useCallback(() => {
    window.dispatchEvent(new CustomEvent('pole:refocus-chat-input'))
  }, [])

  const deleteBundleAction = useBundleStore((s) => s.deleteBundle)
  const addAgentAction = useBundleStore((s) => s.addAgent)
  const removeAgentAction = useBundleStore((s) => s.removeAgent)
  const addTeamAction = useBundleStore((s) => s.addTeam)
  const removeTeamAction = useBundleStore((s) => s.removeTeam)
  const exportBundleAction = useBundleStore((s) => s.exportBundle)
  const importBundleAction = useBundleStore((s) => s.importBundle)

  // 内联添加行的激活状态: { bundleId, kind } 或 null
  // 同一时刻只能有一个 InlineAddRow 展开,简化 UX 和状态管理。
  const [addingTo, setAddingTo] = useState<
    { bundleId: string; kind: 'agent' | 'team' } | null
  >(null)

  const toggleOpen = useCallback((id: string) => {
    setOpenBundleIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleDelete = useCallback(
    async (bundle: Bundle) => {
      const ok = await askConfirm({
        title: bl.deleteBundleTitle,
        message: bl.deleteBundleMsg(bundle.meta.name),
        confirmText: bl.delete,
        cancelText: bl.cancel,
        variant: 'danger',
      })
      if (!ok) return
      try {
        await deleteBundleAction(bundle.meta.id)
        setMenuOpenForId(null)
        // 删除后若选中的是被删项,清除选中(父组件 AgentWorkbench 的
        // selection 会在下次 bundles 变化时重算,此处是防御性清理)。
        if (selection.kind !== 'none' && selection.bundleId === bundle.meta.id) {
          onSelect({ kind: 'none' })
        }
      } catch (err) {
        showNotice('error', bl.deleteFailed(err instanceof Error ? err.message : String(err)))
      }
    },
    [deleteBundleAction, selection, onSelect, askConfirm, showNotice, bl],
  )

  const handleRemoveAgent = useCallback(
    async (bundleId: string, agentType: string, displayName: string) => {
      const ok = await askConfirm({
        title: bl.removeAgentTitle,
        message: bl.removeAgentMsg(displayName),
        confirmText: bl.remove,
        cancelText: bl.cancel,
        variant: 'danger',
      })
      if (!ok) return
      try {
        await removeAgentAction(bundleId, agentType)
        // 如果删除的是当前选中项,重置 selection
        if (
          selection.kind === 'agent' &&
          selection.bundleId === bundleId &&
          selection.agentType === agentType
        ) {
          onSelect({ kind: 'bundle-meta', bundleId })
        }
      } catch (err) {
        showNotice('error', bl.removeFailed(err instanceof Error ? err.message : String(err)))
      }
    },
    [removeAgentAction, selection, onSelect, askConfirm, showNotice, bl],
  )

  const handleRemoveTeam = useCallback(
    async (bundleId: string, teamId: string, teamName: string) => {
      const ok = await askConfirm({
        title: bl.removeTeamTitle,
        message: bl.removeTeamMsg(teamName),
        confirmText: bl.remove,
        cancelText: bl.cancel,
        variant: 'danger',
      })
      if (!ok) return
      try {
        await removeTeamAction(bundleId, teamId)
        if (
          selection.kind === 'team' &&
          selection.bundleId === bundleId &&
          selection.teamId === teamId
        ) {
          onSelect({ kind: 'bundle-meta', bundleId })
        }
      } catch (err) {
        showNotice('error', bl.removeFailed(err instanceof Error ? err.message : String(err)))
      }
    },
    [removeTeamAction, selection, onSelect, askConfirm, showNotice, bl],
  )

  const handleAddAgent = useCallback(
    async (bundleId: string, payload: { id: string; name: string }) => {
      const bundle = await addAgentAction(bundleId, {
        agentType: payload.id,
        displayName: payload.name || undefined,
      })
      setAddingTo(null)
      // 跳转到新增的 agent 上,方便用户立即编辑 prompt 等字段。
      onSelect({ kind: 'agent', bundleId: bundle.meta.id, agentType: payload.id })
    },
    [addAgentAction, onSelect],
  )

  const handleAddTeam = useCallback(
    async (bundleId: string, payload: { id: string; name: string }) => {
      const bundle = await addTeamAction(bundleId, {
        id: payload.id,
        name: payload.name || undefined,
      })
      setAddingTo(null)
      onSelect({ kind: 'team', bundleId: bundle.meta.id, teamId: payload.id })
    },
    [addTeamAction, onSelect],
  )

  const handleExport = useCallback(
    async (bundle: Bundle) => {
      setMenuOpenForId(null)
      try {
        const result = await exportBundleAction(bundle.meta.id)
        if (result.ok) {
          showNotice('info', bl.exportedTo(result.filePath))
        } else if (!('canceled' in result && result.canceled)) {
          showNotice('error', bl.exportFailed('error' in result ? result.error : bl.unknownError))
        }
        // canceled 分支:用户主动取消,不打扰
      } catch (err) {
        showNotice('error', bl.exportFailed(err instanceof Error ? err.message : String(err)))
      } finally {
        // The native save dialog detached the chat textarea's IME; re-attach.
        refocusChatInput()
      }
    },
    [exportBundleAction, showNotice, refocusChatInput, bl],
  )

  const handleImport = useCallback(async () => {
    try {
      // 首次不带 filePath,让 main 弹选择文件对话框。
      let result = await importBundleAction()

      // 冲突场景:让用户决定"换 id" / "覆盖" / "取消",再重试调用
      // (复用 main 返回的 filePath,避免让用户再选一次文件)。
      while (
        !result.ok &&
        !('canceled' in result && result.canceled) &&
        (result.reason === 'id-conflict' || result.reason === 'preset-conflict') &&
        result.filePath
      ) {
        const isPreset = result.reason === 'preset-conflict'
        const suggested = result.suggestedId
        const attemptedId = result.attemptedId ?? '?'

        // 三选一:OK=用建议 id;Cancel=终止。"覆盖"通过再一个 confirm 获取。
        // 浏览器内置对话框能力有限,这里复合两层 confirm:
        //   第一层:要不要用建议 id?
        //     OK → 用 suggested
        //     Cancel → 继续问第二层(仅非-preset 场景)
        //   第二层:要不要覆盖现有的?
        //     OK → replaceExisting=true
        //     Cancel → 作废整个流程
        const useSuggested = await askConfirm({
          title: bl.idConflictTitle,
          message: bl.idConflictMsg(attemptedId, isPreset, suggested ?? bl.noneSuggested),
          confirmText: bl.useSuggestedId,
          cancelText: bl.cancel,
        })

        if (useSuggested && suggested) {
          result = await importBundleAction({
            filePath: result.filePath,
            newId: suggested,
          })
          continue
        }

        if (isPreset) {
          // preset 冲突不允许覆盖,直接终止
          return
        }

        const replace = await askConfirm({
          title: bl.overwriteTitle,
          message: bl.overwriteMsg(attemptedId),
          confirmText: bl.overwrite,
          cancelText: bl.cancel,
          variant: 'danger',
        })
        if (!replace) return
        result = await importBundleAction({
          filePath: result.filePath,
          replaceExisting: true,
        })
      }

      if (result.ok) {
        // 跳转选中导入结果,让用户立即看到
        setOpenBundleIds((prev) => {
          const next = new Set(prev)
          next.add(result.usedId)
          return next
        })
        onSelect({ kind: 'bundle-meta', bundleId: result.usedId })
        showNotice('info', bl.importedBundle(result.replaced, result.bundle.meta.name))
      } else if (!('canceled' in result && result.canceled)) {
        showNotice('error', bl.importFailed('error' in result ? result.error : bl.unknownError))
      }
    } catch (err) {
      showNotice('error', bl.importFailed(err instanceof Error ? err.message : String(err)))
    } finally {
      // The native open dialog detached the chat textarea's IME; re-attach.
      refocusChatInput()
    }
  }, [importBundleAction, onSelect, askConfirm, showNotice, refocusChatInput, bl])

  const handleCreated = useCallback(
    (bundle: Bundle) => {
      // 新建成功后自动展开并选中该 bundle 的 meta 视图,方便用户立即
      // 修改 name/description 等字段。
      setOpenBundleIds((prev) => {
        const next = new Set(prev)
        next.add(bundle.meta.id)
        return next
      })
      onSelect({ kind: 'bundle-meta', bundleId: bundle.meta.id })
    },
    [onSelect],
  )

  // 顶部"导出当前"按钮锚定的 bundle:
  //   - 选中某个 bundle/agent/team → 用它所属的 bundle
  //   - 什么都没选 → 用列表里第一个 bundle(或禁用按钮)
  // 这个"当前"的语义跟 BundleSwitcher 的激活态不一致是有意的:工作台
  // 里用户可能正编辑 A、但仍激活在 B,导出当前按钮以**工作台选中**为准。
  const currentBundleForExport: Bundle | null = useMemo(() => {
    if (selection.kind !== 'none') {
      return bundles.find((b) => b.meta.id === selection.bundleId) ?? null
    }
    return bundles[0] ?? null
  }, [selection, bundles])

  return (
    <div className="bundle-list-pane">
      {/* 顶部工具栏:新建 / 导入 / 导出当前 */}
      <div className="bundle-list-toolbar">
        <button
          type="button"
          className="bundle-list-create-btn"
          onClick={() => setCreateDialog({ open: true })}
          title={bl.newBundleTitle}
        >
          <Plus size={13} />
          <span>{bl.new}</span>
        </button>
        <button
          type="button"
          className="bundle-list-import-btn"
          onClick={() => void handleImport()}
          title={bl.importTitle}
        >
          <Upload size={13} />
          <span>{bl.import}</span>
        </button>
        <button
          type="button"
          className="bundle-list-export-btn"
          onClick={() => {
            if (currentBundleForExport) void handleExport(currentBundleForExport)
          }}
          disabled={!currentBundleForExport}
          title={
            currentBundleForExport
              ? bl.exportTitle(currentBundleForExport.meta.name)
              : bl.exportNoSelect
          }
        >
          <Download size={13} />
          <span>{bl.export}</span>
        </button>
      </div>
      {notice ? (
        <div
          className="bundle-list-import-notice"
          role="status"
          aria-live="polite"
          data-kind={notice.kind}
        >
          {notice.text}
        </div>
      ) : null}
      {confirmDialog}

      {bundles.length === 0 ? (
        <div className="workbench-empty-state">
          {bl.emptyPrefix}
          <code> electron/agents/bundles/presets/ </code>
          {bl.emptySuffix}
        </div>
      ) : (
        bundles.map((bundle) => {
          const isOpen = openBundleIds.has(bundle.meta.id)
          const isBundleSelected =
            selection.kind === 'bundle-meta' && selection.bundleId === bundle.meta.id
          const menuOpen = menuOpenForId === bundle.meta.id
          const isPreset = bundle.meta.source === 'preset'

          return (
            <div key={bundle.meta.id} className="bundle-list-group">
              <div
                className={`bundle-list-bundle-row ${isBundleSelected ? 'is-selected' : ''}`}
              >
                <button
                  type="button"
                  className="bundle-list-bundle"
                  onClick={() => {
                    toggleOpen(bundle.meta.id)
                    onSelect({ kind: 'bundle-meta', bundleId: bundle.meta.id })
                  }}
                  aria-expanded={isOpen}
                >
                  <ChevronRight
                    size={12}
                    className={`bundle-list-caret ${isOpen ? 'is-open' : ''}`}
                    aria-hidden="true"
                  />
                  <Package size={13} className="bundle-list-icon" aria-hidden="true" />
                  <span className="bundle-list-name">{bundle.meta.name}</span>
                  {bundle.meta.domain ? (
                    <span className="bundle-list-domain">{bundle.meta.domain}</span>
                  ) : null}
                </button>

                {/* 悬停时出现的 "⋯" 菜单触发器 */}
                <button
                  type="button"
                  className={`bundle-list-row-menu-trigger ${menuOpen ? 'is-open' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenuOpenForId(menuOpen ? null : bundle.meta.id)
                  }}
                  title={bl.moreActions}
                  aria-label={bl.moreActions}
                >
                  <MoreHorizontal size={12} />
                </button>

                {menuOpen ? (
                  <div
                    className="bundle-list-row-menu"
                    role="menu"
                    onMouseLeave={() => setMenuOpenForId(null)}
                  >
                    <button
                      type="button"
                      className="bundle-list-row-menu-item"
                      onClick={(e) => {
                        e.stopPropagation()
                        setMenuOpenForId(null)
                        setCreateDialog({ open: true, copyFromId: bundle.meta.id })
                      }}
                    >
                      <Copy size={11} />
                      <span>{bl.createFromTemplate}</span>
                    </button>
                    <button
                      type="button"
                      className="bundle-list-row-menu-item"
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleExport(bundle)
                      }}
                    >
                      <Download size={11} />
                      <span>{bl.exportAsJson}</span>
                    </button>
                    <button
                      type="button"
                      className="bundle-list-row-menu-item bundle-list-row-menu-item-danger"
                      disabled={isPreset}
                      title={isPreset ? bl.presetCantDelete : bl.deleteThisBundle}
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleDelete(bundle)
                      }}
                    >
                      <Trash2 size={11} />
                      <span>{bl.deleteBundleLabel}{isPreset ? bl.presetSuffix : ''}</span>
                    </button>
                  </div>
                ) : null}
              </div>

              {isOpen ? (
                <div className="bundle-list-children">
                  {/* ── 智能体子列表 ─────────────────────── */}
                  <div className="bundle-list-subsection">
                    <div className="bundle-list-subsection-header">
                      <span className="bundle-list-subsection-label">
                        {bl.agentsCount(bundle.agents.length)}
                      </span>
                      <button
                        type="button"
                        className="bundle-list-subsection-add"
                        onClick={(e) => {
                          e.stopPropagation()
                          setAddingTo({ bundleId: bundle.meta.id, kind: 'agent' })
                        }}
                        title={bl.addAgent}
                        aria-label={bl.addAgent}
                      >
                        <Plus size={11} />
                      </button>
                    </div>

                    {addingTo &&
                    addingTo.bundleId === bundle.meta.id &&
                    addingTo.kind === 'agent' ? (
                      <InlineAddRow
                        kind="agent"
                        existingIds={bundle.agents.map((a) => a.agentType)}
                        onSubmit={(payload) => handleAddAgent(bundle.meta.id, payload)}
                        onCancel={() => setAddingTo(null)}
                      />
                    ) : null}

                    {bundle.agents.map((agent) => {
                      const isSelected =
                        selection.kind === 'agent' &&
                        selection.bundleId === bundle.meta.id &&
                        selection.agentType === agent.agentType
                      const canRemove = bundle.agents.length > 1
                      return (
                        <div
                          key={agent.agentType}
                          className={`bundle-list-entry-row ${isSelected ? 'is-selected' : ''}`}
                        >
                          <button
                            type="button"
                            className={`bundle-list-entry ${isSelected ? 'is-selected' : ''}`}
                            onClick={() =>
                              onSelect({
                                kind: 'agent',
                                bundleId: bundle.meta.id,
                                agentType: agent.agentType,
                              })
                            }
                            title={agent.whenToUse || agent.agentType}
                          >
                            <Bot
                              size={11}
                              className="bundle-list-entry-icon"
                              aria-hidden="true"
                            />
                            <span className="bundle-list-entry-name">
                              {agent.displayName ?? agent.agentType}
                            </span>
                            {agent.isPrimary ? (
                              <Star
                                size={10}
                                className="bundle-list-entry-primary"
                                aria-label={t.workbench.chrome.primaryBadge}
                              />
                            ) : null}
                          </button>
                          <button
                            type="button"
                            className="bundle-list-entry-remove"
                            disabled={!canRemove}
                            title={
                              canRemove
                                ? bl.removeAgentBtn
                                : bl.cantRemoveLastAgent
                            }
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleRemoveAgent(
                                bundle.meta.id,
                                agent.agentType,
                                agent.displayName ?? agent.agentType,
                              )
                            }}
                          >
                            <X size={10} />
                          </button>
                        </div>
                      )
                    })}
                  </div>

                  {/* ── 团队子列表 ───────────────────────── */}
                  <div className="bundle-list-subsection">
                    <div className="bundle-list-subsection-header">
                      <span className="bundle-list-subsection-label">
                        {bl.teamsCount(bundle.teams.length)}
                      </span>
                      <button
                        type="button"
                        className="bundle-list-subsection-add"
                        onClick={(e) => {
                          e.stopPropagation()
                          setAddingTo({ bundleId: bundle.meta.id, kind: 'team' })
                        }}
                        title={bl.addTeam}
                        aria-label={bl.addTeam}
                      >
                        <Plus size={11} />
                      </button>
                    </div>

                    {addingTo &&
                    addingTo.bundleId === bundle.meta.id &&
                    addingTo.kind === 'team' ? (
                      <InlineAddRow
                        kind="team"
                        existingIds={bundle.teams.map((t) => t.id)}
                        onSubmit={(payload) => handleAddTeam(bundle.meta.id, payload)}
                        onCancel={() => setAddingTo(null)}
                      />
                    ) : null}

                    {bundle.teams.length === 0 &&
                    !(
                      addingTo &&
                      addingTo.bundleId === bundle.meta.id &&
                      addingTo.kind === 'team'
                    ) ? (
                      <div className="bundle-list-subsection-empty">
                        {bl.addFirstTeam}
                      </div>
                    ) : null}

                    {bundle.teams.map((team) => {
                      const isSelected =
                        selection.kind === 'team' &&
                        selection.bundleId === bundle.meta.id &&
                        selection.teamId === team.id
                      return (
                        <div
                          key={team.id}
                          className={`bundle-list-entry-row ${isSelected ? 'is-selected' : ''}`}
                        >
                          <button
                            type="button"
                            className={`bundle-list-entry ${isSelected ? 'is-selected' : ''}`}
                            onClick={() =>
                              onSelect({
                                kind: 'team',
                                bundleId: bundle.meta.id,
                                teamId: team.id,
                              })
                            }
                            title={team.description || team.name}
                          >
                            <Users
                              size={11}
                              className="bundle-list-entry-icon"
                              aria-hidden="true"
                            />
                            <span className="bundle-list-entry-name">{team.name}</span>
                            <span className="bundle-list-entry-badge">
                              {team.members.length}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="bundle-list-entry-remove"
                            title={bl.removeTeamBtn}
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleRemoveTeam(
                                bundle.meta.id,
                                team.id,
                                team.name,
                              )
                            }}
                          >
                            <X size={10} />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          )
        })
      )}

      {createDialog ? (
        <CreateBundleDialog
          bundles={bundles}
          defaultCopyFromId={createDialog.copyFromId}
          onClose={() => setCreateDialog(null)}
          onCreated={handleCreated}
        />
      ) : null}
    </div>
  )
}
