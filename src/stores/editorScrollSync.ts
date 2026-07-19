/**
 * editorScrollSync —— Monaco 视口行号的轻量跨组件广播 (Sprint 9.2+ 增强)。
 *
 * 目的:让 OutlineSidebar 高亮当前可视章节,让 MarkdownPreview 与
 * 编辑器滚动联动 —— 而这些订阅者之间互不直接耦合 Monaco。
 *
 * 设计取舍:
 *   - **不用 zustand**:跨组件只需一个数值,zustand 会带来每次变化
 *     全局订阅者重渲染的成本。这里用 `useSyncExternalStore` + 原始
 *     Set 订阅,读写都 O(1),回调精确调用。
 *   - **rAF throttle**:Monaco `onDidScrollChange` 在用户惯性滚时
 *     能触发 60+ fps。所有 emit 统一进 requestAnimationFrame,同一
 *     帧内最后一次值 win,避免在低端机卡顿。
 *   - **tab 粒度**:`activeTabId` 作为值的第二维 —— 切 tab 时自动
 *     复位为 1,避免上一个文件的滚动位置被带到新文件误触发大纲跳转。
 */

import { useSyncExternalStore } from 'react'

interface ScrollSnapshot {
  tabId: string | null
  /** 1-indexed,Monaco 坐标;未初始化时为 1 */
  visibleStartLine: number
}

let snapshot: ScrollSnapshot = { tabId: null, visibleStartLine: 1 }
const listeners = new Set<() => void>()

let rafPending: number | null = null
let pendingNext: ScrollSnapshot | null = null

function emitNow(): void {
  rafPending = null
  if (pendingNext && pendingNext !== snapshot) {
    snapshot = pendingNext
    pendingNext = null
    for (const l of listeners) l()
  } else {
    pendingNext = null
  }
}

/**
 * 设置当前可视起始行。会 rAF-throttle,同一帧内最后一次调用 win。
 * tabId 若与当前 snapshot 不同,会立即生效(切 tab 不等帧)。
 */
export function setVisibleStartLine(tabId: string | null, line: number): void {
  // 切 tab 立即清状态 —— 保证大纲不会残留上个文件的高亮
  if (tabId !== snapshot.tabId) {
    snapshot = { tabId, visibleStartLine: Math.max(1, line | 0) }
    pendingNext = null
    if (rafPending !== null) {
      cancelAnimationFrame(rafPending)
      rafPending = null
    }
    for (const l of listeners) l()
    return
  }

  pendingNext = { tabId, visibleStartLine: Math.max(1, line | 0) }
  if (rafPending !== null) return
  if (typeof requestAnimationFrame === 'function') {
    rafPending = requestAnimationFrame(emitNow)
  } else {
    // SSR / jest:同步
    rafPending = 0
    emitNow()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): ScrollSnapshot {
  return snapshot
}

/** Hook:订阅当前可视行。tabId 不匹配时返回 1(无效状态)。 */
export function useVisibleStartLine(expectedTabId: string | null): number {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (!expectedTabId) return 1
  if (snap.tabId !== expectedTabId) return 1
  return snap.visibleStartLine
}
