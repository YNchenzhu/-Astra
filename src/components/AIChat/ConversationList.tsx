import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { MessageSquare, Trash2, Clock, Pencil, GripVertical, Package } from 'lucide-react'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useChatStore, getActiveStreamIdsKey } from '../../stores/useChatStore'
import type { ConversationMeta } from '../../types'
import { setConversationOrder } from '../../services/conversationAPI'
import { getActiveBundleId, useActiveBundle } from '../../stores/bundleStore'
import { reportUserActionError } from '../../utils/reportUserActionError'
import { useConfirmDialog } from '../common/ConfirmDialog'
import './ConversationList.css'

interface ConversationListProps {
  currentId: string | null
  onSelect: (convId: string) => void
  onRename?: (convId: string, newTitle: string) => void
  onDelete: (convId: string) => void | Promise<void>
  onBatchDelete?: (ids: string[]) => void | Promise<void>
  onClose: () => void
}

function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function timeGroupForTimestamp(ts: number): { key: string; label: string } {
  const now = new Date()
  const today0 = startOfLocalDay(now)
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  const yesterday0 = startOfLocalDay(y)
  const weekAgo = today0 - 7 * 86_400_000
  const monthAgo = today0 - 30 * 86_400_000

  if (ts >= today0) return { key: 'today', label: '今天' }
  if (ts >= yesterday0) return { key: 'yesterday', label: '昨天' }
  if (ts >= weekAgo) return { key: 'week', label: '近 7 天' }
  if (ts >= monthAgo) return { key: 'month', label: '近 30 天' }
  return { key: 'older', label: '更早' }
}

function bucketOrderedConversations(
  ordered: ConversationMeta[],
): Array<{ key: string; label: string; items: ConversationMeta[] }> {
  const map = new Map<string, { label: string; items: ConversationMeta[] }>()
  const keyOrder: string[] = []
  for (const c of ordered) {
    const { key, label } = timeGroupForTimestamp(c.updatedAt)
    if (!map.has(key)) {
      map.set(key, { label, items: [] })
      keyOrder.push(key)
    }
    map.get(key)!.items.push(c)
  }
  return keyOrder.map((key) => ({
    key,
    label: map.get(key)!.label,
    items: map.get(key)!.items,
  }))
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(timestamp).toLocaleDateString()
}

function reorderIds(ids: string[], draggedId: string, targetId: string, placeBefore: boolean): string[] {
  const next = [...ids]
  const fi = next.indexOf(draggedId)
  const ti = next.indexOf(targetId)
  if (fi < 0 || ti < 0 || fi === ti) return ids
  next.splice(fi, 1)
  const newTi = next.indexOf(targetId)
  if (newTi < 0) return ids
  const insertAt = placeBefore ? newTi : newTi + 1
  next.splice(insertAt, 0, draggedId)
  return next
}

export const ConversationList: React.FC<ConversationListProps> = ({
  currentId,
  onSelect,
  onRename,
  onDelete,
  onBatchDelete,
  onClose,
}) => {
  const [conversations, setConversations] = useState<ConversationMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renamingTitle, setRenamingTitle] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dropBefore, setDropBefore] = useState(true)
  const panelRef = useRef<HTMLDivElement>(null)
  const { rootPath } = useWorkspaceStore()
  const { dialog: confirmDialog, askConfirm } = useConfirmDialog()
  // Sprint 4.3: 告诉用户"对话列表按工作包分区"
  const activeBundle = useActiveBundle()
  const currentConversationTitle = useChatStore((s) => s.currentConversationTitle)
  const currentMessages = useChatStore((s) => s.messages)

  // Click-outside auto-dismiss. Without this the panel stays open while the
  // user clicks "新建对话 / 清空上下文 / 设置 / 输入框" etc., and the floating
  // panel (z-index: 400) keeps overlaying parts of the chat column. Mirrors
  // the dropdown-dismiss pattern already used by ChatInput.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (!target) return
      if (panelRef.current && panelRef.current.contains(target)) return
      // ConfirmDialog is rendered through a portal into document.body. Treat
      // clicks inside that portal as "inside" the conversation list flow;
      // otherwise the capture-phase outside-click handler closes/unmounts this
      // panel before the confirm button's onClick can resolve the promise.
      const confirmDialog = (target as Element)?.closest?.(
        '.confirm-dialog-overlay, .confirm-dialog-panel',
      )
      if (confirmDialog) return
      // The "会话历史" toggle button itself triggers open/close; let it
      // handle that path instead of double-toggling here.
      const toggle = (target as Element)?.closest?.('[data-conversation-list-toggle]')
      if (toggle) return
      onClose()
    }
    // mousedown (capture) so we close BEFORE the click resolves on the
    // underlying control — avoids a "first click is swallowed" feel.
    document.addEventListener('mousedown', handleClickOutside, true)
    return () => document.removeEventListener('mousedown', handleClickOutside, true)
  }, [onClose])
  const activeStreamKey = useChatStore((s) => getActiveStreamIdsKey(s))
  const activeStreams = useMemo(
    () => new Set(activeStreamKey ? activeStreamKey.split(',') : []),
    [activeStreamKey],
  )

  // 当前会话的 id 固化在 activeBundleId 里;这里独立订阅一个"切换工作包时
  // 刷新列表"的标识。Plan §4.5.4:会话历史按 bundle 分区持久化,不传 bundleId
  // 读回来的是 code-dev 分区,会跨 bundle 串扰(Bug #1 的根因)。
  const activeBundleId = activeBundle?.meta.id ?? null

  const displayConversations = useMemo<ConversationMeta[]>(() => {
    if (!currentId || currentMessages.length === 0) return conversations
    const firstTs = currentMessages[0]?.timestamp ?? Date.now()
    const lastTs = currentMessages[currentMessages.length - 1]?.timestamp ?? firstTs
    const currentMeta: ConversationMeta = {
      id: currentId,
      title: currentConversationTitle || '新对话',
      workspacePath: rootPath || '',
      createdAt: firstTs,
      updatedAt: lastTs,
      messageCount: currentMessages.length,
    }
    const idx = conversations.findIndex((c) => c.id === currentId)
    if (idx < 0) return [currentMeta, ...conversations]
    const next = conversations.slice()
    next[idx] = { ...next[idx], ...currentMeta }
    return next
  }, [conversations, currentId, currentMessages, currentConversationTitle, rootPath])

  const groups = useMemo(
    () => bucketOrderedConversations(displayConversations),
    [displayConversations],
  )

  const loadList = useCallback(async (): Promise<ConversationMeta[]> => {
    setLoading(true)
    try {
      const api = window.electronAPI
      if (!api) return []
      // 必须把 bundleId 传进去,否则主进程按 code-dev 默认分区读,会漏掉
      // / 串扰当前工作包的会话(Bug #1 / #2 / #3 的共同根因)。
      const list = await api.conversation.list(rootPath || '', getActiveBundleId())
      const rows = list || []
      setConversations(rows)
      return rows
    } catch {
      setConversations([])
      return []
    } finally {
      setLoading(false)
    }
  }, [rootPath])

  useEffect(() => {
    loadList()
    // 切换工作包时 activeBundleId 变化也要重拉列表,否则面板里还是上一个
    // 工作包的对话(Bug #1)。
     
  }, [loadList, activeBundleId])

  // 当前会话首次出现消息(首次发送 / 首次收到回复)时,主进程会在后续
  // message_stop 持久化这条会话;我们这里等 messageCount 从 0 → >0 时
  // 以及 id 变化时触发一次 loadList,让磁盘快照尽快替换掉内存里注入的
  // 临时 meta。这样即使没有 on-changed 广播,列表也不会长时间"只在内存"。
  useEffect(() => {
    if (!currentId) return
    if (currentMessages.length === 0) return
    const timer = window.setTimeout(() => {
      void loadList()
    }, 400)
    return () => window.clearTimeout(timer)
  }, [currentId, currentMessages.length, loadList])

  const metaById = useMemo(
    () => new Map(displayConversations.map((c) => [c.id, c])),
    [displayConversations],
  )

  const persistOrder = useCallback(
    async (orderedIds: string[]) => {
      const root = rootPath?.trim() ?? ''
      if (!root) return
      // Scope the sort order to the current bundle so switching bundles
      // doesn't cross-contaminate list ordering.
      const ok = await setConversationOrder(root, orderedIds, getActiveBundleId())
      if (!ok) console.warn('[ConversationList] setConversationOrder failed')
    },
    [rootPath],
  )

  const applyReorder = useCallback(
    (draggedId: string, targetId: string, placeBefore: boolean) => {
      if (draggedId === targetId) return
      const ids = conversations.map((c) => c.id)
      const nextIds = reorderIds(ids, draggedId, targetId, placeBefore)
      const nextList = nextIds.map((id) => metaById.get(id)).filter(Boolean) as ConversationMeta[]
      setConversations(nextList)
      void persistOrder(nextIds)
    },
    [conversations, metaById, persistOrder],
  )

  const toggleSelect = useCallback((convId: string) => {
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(convId)) n.delete(convId)
      else n.add(convId)
      return n
    })
  }, [])

  const selectAll = useCallback(() => {
    if (selected.size === displayConversations.length) {
      setSelected(new Set())
      return
    }
    setSelected(new Set(displayConversations.map((c) => c.id)))
  }, [displayConversations, selected.size])

  const handleBatchDelete = async () => {
    if (selected.size === 0) return
    const confirmed = await askConfirm({
      title: '删除会话',
      message: `确定删除选中的 ${selected.size} 个会话？此操作不可恢复。`,
      confirmText: '删除',
      variant: 'danger',
    })
    if (!confirmed) {
      return
    }
    const ids = [...selected]
    try {
      if (onBatchDelete) {
        await onBatchDelete(ids)
      } else {
        for (const id of ids) {
          await onDelete(id)
        }
      }
      setSelected(new Set())
      // 同单条删除路径:只信任 loadList() 的磁盘真相;不再本地先 filter 再
      // 覆盖回写,避免跨 bundle 分区串扰(Bug #3)。
      const rows = await loadList()
      if (rows.length > 0) {
        void persistOrder(rows.map((c) => c.id))
      } else {
        onClose()
      }
    } catch (error) {
      // Parent-supplied delete handlers ultimately call the conversation IPC;
      // that IPC can now throw when the preload bridge is missing. Before
      // this catch the rejection became an unhandled promise and the panel
      // just sat there — user assumed nothing deleted (or worse, everything).
      reportUserActionError('批量删除会话', error)
    }
  }

  const handleSelect = (convId: string) => {
    onSelect(convId)
    onClose()
  }

  const handleDelete = async (e: React.MouseEvent, convId: string) => {
    e.stopPropagation()
    const confirmed = await askConfirm({
      title: '删除会话',
      message: '确定删除该会话？此操作不可恢复。',
      confirmText: '删除',
      variant: 'danger',
    })
    if (!confirmed) {
      return
    }
    try {
      await onDelete(convId)
      setSelected((prev) => {
        const n = new Set(prev)
        n.delete(convId)
        return n
      })
      // 删除后以磁盘真相为准重拉列表。以前先本地 filter 再 loadList,等 list
      // 返回时如果 `bundleId` 没带(旧 Bug #3),会把"删除前的默认分区列表"
      // 覆盖回来,面板里看上去删除没生效。现在 loadList 带了 bundleId,
      // 直接用它的结果就足够,不再自己 filter。
      const rows = await loadList()
      if (rows.length > 0) {
        void persistOrder(rows.map((c) => c.id))
      } else {
        // 当前工作包里最后一条会话被删除,关闭面板避免悬浮层挡住输入区。
        onClose()
      }
    } catch (error) {
      reportUserActionError('删除会话', error)
    }
  }

  const startRename = (convId: string, currentTitle: string) => {
    setRenamingId(convId)
    setRenamingTitle(currentTitle)
  }

  const commitRename = () => {
    if (!renamingId || !renamingTitle.trim()) {
      setRenamingId(null)
      return
    }
    if (onRename) {
      onRename(renamingId, renamingTitle.trim())
      setConversations((prev) =>
        prev.map((c) =>
          c.id === renamingId ? { ...c, title: renamingTitle.trim() } : c,
        ),
      )
    }
    setRenamingId(null)
  }

  const cancelRename = () => {
    setRenamingId(null)
  }

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename()
    } else if (e.key === 'Escape') {
      cancelRename()
    }
  }

  const onDragStartRow = (e: React.DragEvent, convId: string) => {
    e.dataTransfer.setData('text/conversation-id', convId)
    e.dataTransfer.effectAllowed = 'move'
  }

  const onDragOverRow = (e: React.DragEvent, convId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const el = e.currentTarget as HTMLElement
    const rect = el.getBoundingClientRect()
    const before = e.clientY < rect.top + rect.height / 2
    setDragOverId(convId)
    setDropBefore(before)
  }

  const onDragLeaveRow = () => {
    setDragOverId(null)
  }

  const onDropRow = (e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    const draggedId = e.dataTransfer.getData('text/conversation-id')
    setDragOverId(null)
    if (!draggedId || draggedId === targetId) return
    applyReorder(draggedId, targetId, dropBefore)
  }

  const renderRow = (conv: ConversationMeta) => {
    const isActive = conv.id === currentId
    const isOver = dragOverId === conv.id
    const isStreaming = activeStreams.has(conv.id)
    return (
      <div
        key={conv.id}
        className={`conversation-list-item ${isActive ? 'active' : ''} ${isStreaming ? 'conversation-list-item--streaming' : ''} ${isOver ? 'conversation-list-item--drop-target' : ''} ${isOver && dropBefore ? 'conversation-list-item--drop-before' : ''} ${isOver && !dropBefore ? 'conversation-list-item--drop-after' : ''}`}
        onDragOver={(e) => onDragOverRow(e, conv.id)}
        onDragLeave={onDragLeaveRow}
        onDrop={(e) => onDropRow(e, conv.id)}
        onClick={() => handleSelect(conv.id)}
      >
        <label
          className="conversation-list-check"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selected.has(conv.id)}
            onChange={() => toggleSelect(conv.id)}
            aria-label="选择会话"
          />
        </label>
        <div
          className="conversation-list-drag-handle"
          draggable
          onDragStart={(e) => onDragStartRow(e, conv.id)}
          onClick={(e) => e.stopPropagation()}
          title="拖动排序"
          aria-hidden="true"
        >
          <GripVertical size={14} />
        </div>
        <div className="conversation-list-item-main">
          {renamingId === conv.id ? (
            <input
              className="conversation-list-item-rename-input"
              value={renamingTitle}
              onChange={(e) => setRenamingTitle(e.target.value)}
              onBlur={commitRename}
              onKeyDown={handleRenameKeyDown}
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <>
              <div className="conversation-list-item-title">
                {isStreaming && <span className="conversation-list-pulse" title="AI 运行中" />}
                {conv.title || '新对话'}
              </div>
              <div className="conversation-list-item-meta">
                {isStreaming ? (
                  <span className="conversation-list-running-badge">运行中</span>
                ) : (
                  <>
                    <Clock size={10} />
                    <span>{formatRelativeTime(conv.updatedAt)}</span>
                  </>
                )}
                <span className="conversation-list-item-dot">·</span>
                <span>{conv.messageCount} 条消息</span>
              </div>
            </>
          )}
        </div>
        <div className="conversation-list-item-actions">
          {onRename && renamingId !== conv.id && (
            <button
              type="button"
              className="conversation-list-item-action"
              onClick={(e) => {
                e.stopPropagation()
                startRename(conv.id, conv.title || '新对话')
              }}
              title="重命名"
            >
              <Pencil size={12} />
            </button>
          )}
          <button
            type="button"
            className="conversation-list-item-delete"
            onClick={(e) => void handleDelete(e, conv.id)}
            title="删除"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="conversation-list-panel" ref={panelRef}>
      {confirmDialog}
      <div className="conversation-list-header">
        <span className="conversation-list-title">
          <MessageSquare size={14} />
          历史会话
        </span>
        <div className="conversation-list-header-right">
          <span className="conversation-list-count">{displayConversations.length}</span>
          {displayConversations.length > 0 && (
            <>
              <button
                type="button"
                className="conversation-list-header-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  selectAll()
                }}
              >
                {selected.size === displayConversations.length ? '取消全选' : '全选'}
              </button>
              {selected.size > 0 && (
                <button
                  type="button"
                  className="conversation-list-header-btn conversation-list-header-btn--danger"
                  onClick={(e) => {
                    e.stopPropagation()
                    void handleBatchDelete()
                  }}
                >
                  删除选中 ({selected.size})
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Sprint 4.3: 工作包上下文提示 —— 明确告诉用户对话按 bundle 分区 */}
      {activeBundle ? (
        <div className="conversation-list-bundle-hint" title="对话历史按工作包分区存储">
          <Package size={10} />
          <span>
            <strong>{activeBundle.meta.name}</strong> 工作包的对话
          </span>
          <span className="conversation-list-bundle-hint-dim">切换工作包会看到不同的历史</span>
        </div>
      ) : null}

      <div
        className="conversation-list-body"
        onDragEnd={() => {
          setDragOverId(null)
        }}
      >
        {loading ? (
          <div className="conversation-list-empty">加载中...</div>
        ) : displayConversations.length === 0 ? (
          <div className="conversation-list-empty">暂无历史会话</div>
        ) : (
          groups.map((g) => (
            <div key={g.key} className="conversation-list-group">
              <div className="conversation-list-group-label">{g.label}</div>
              <div className="conversation-list-group-items">{g.items.map(renderRow)}</div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
