/**
 * SimpleVirtualList —— 通用虚拟列表组件 (Sprint 7)。
 *
 * 设计动机:
 *   - 现有 `VirtualMessageList` 是聊天消息专用,强耦合 `ChatMessage[]`
 *   - 其它面板(Running Agents 历史、Bundle Gallery 等)在数据量大时
 *     也需要虚拟化,但各自实现成本高
 *   - 第三方库(react-window / @tanstack/react-virtual)会加 bundle 体积
 *
 * 实现思路(保持朴素):
 *   1. 维持 `itemHeights: Map<key, number>` 缓存每项渲染后的实测高度
 *   2. 没测过的项一律用 `estimateHeight` 估算
 *   3. 根据 scrollTop / viewportHeight / heights 计算 [start, end] 可见
 *      窗口;额外往两侧 overscan 几项避免滚动空白
 *   4. 外层放 `height = totalHeight` 的占位元素,内层用 translate3d
 *      把可见窗口精确定位到 scrollTop 对应的位置
 *   5. 单一共享 ResizeObserver,所有项变高度都走它,O(1) 新增 observer
 *
 * 启用阈值:默认 `enableThreshold = 50`。数据量 < 50 时直接全量渲染
 * (虚拟化本身有 ResizeObserver + 计算开销,少量数据反而更慢)。
 *
 * 不支持(刻意简化):
 *   - 横向虚拟化(只纵向)
 *   - 动画插入/删除(会破坏位移计算)
 *   - sticky 行(各面板需要时自己处理)
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

export interface SimpleVirtualListProps<T> {
  /** 完整数据列表(父组件保持稳定引用以避免不必要重算)。 */
  items: T[]
  /** 每项的稳定 key —— 用于高度缓存 + React key。 */
  getKey: (item: T, index: number) => string
  /** 渲染单项。内部会传 index 以便父组件做 memo。 */
  renderItem: (item: T, index: number) => React.ReactNode
  /**
   * 单项估算高度(px)。首次渲染用这个,之后按实测高度更新。
   * 越接近真实值滚动越稳。
   */
  estimateHeight?: number
  /** 可视窗口两侧额外渲染多少项作为缓冲,默认 6。 */
  overscan?: number
  /** 数据量 >= 此值才启用虚拟化;小列表全量渲染更稳更快。 */
  enableThreshold?: number
  /** 传到外层 div 的 class —— 方便面板自己控制滚动容器样式。 */
  className?: string
  /** 项与项之间的垂直间距(px),用 gap 模拟。 */
  itemGap?: number
}

export function SimpleVirtualList<T>({
  items,
  getKey,
  renderItem,
  estimateHeight = 120,
  overscan = 6,
  enableThreshold = 50,
  className,
  itemGap = 0,
}: SimpleVirtualListProps<T>): React.ReactElement {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  // 实测高度缓存。注意:用 ref 而非 state 可以避免每次测量都触发
  // re-render;我们只在关键时点(滚动或布局变化)读它。
  const heightsRef = useRef<Map<string, number>>(new Map())
  // Revision 计数:每当有测量结果落地时 +1,触发重新布局。
  const [heightsRev, setHeightsRev] = useState(0)

  const virtualEnabled = items.length >= enableThreshold

  // ── 计算每项的 top offset 和总高度 ────────────────────────
  const layout = useMemo(() => {
    const offsets: number[] = new Array(items.length)
    let acc = 0
    for (let i = 0; i < items.length; i++) {
      offsets[i] = acc
      const key = getKey(items[i], i)
      const h = heightsRef.current.get(key) ?? estimateHeight
      acc += h + (i < items.length - 1 ? itemGap : 0)
    }
    return { offsets, totalHeight: acc }
    // heightsRev 纳入依赖:每次测量后重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, getKey, estimateHeight, itemGap, heightsRev])

  // ── 计算可见窗口 [startIdx, endIdx] ──────────────────────
  const windowRange = useMemo(() => {
    if (!virtualEnabled || items.length === 0) {
      return { start: 0, end: items.length }
    }
    const top = scrollTop
    const bottom = scrollTop + viewportHeight
    // 二分找 start:最后一个 offset[i] + h[i] > top 的 i - 1 是前一个可见
    // 简化:线性扫描一次 —— items.length 通常 <= 10000,scroll 发生时
    // 一次遍历 < 1ms。可加二分优化,但过早。
    let start = 0
    for (let i = 0; i < layout.offsets.length; i++) {
      const key = getKey(items[i], i)
      const h = heightsRef.current.get(key) ?? estimateHeight
      if (layout.offsets[i] + h >= top) {
        start = i
        break
      }
    }
    let end = items.length
    for (let i = start; i < layout.offsets.length; i++) {
      if (layout.offsets[i] > bottom) {
        end = i
        break
      }
    }
    return {
      start: Math.max(0, start - overscan),
      end: Math.min(items.length, end + overscan),
    }
  }, [
    virtualEnabled,
    items,
    layout,
    scrollTop,
    viewportHeight,
    overscan,
    getKey,
    estimateHeight,
  ])

  // ── ResizeObserver: 单共享,所有行共用 ──────────────────
  const observerRef = useRef<ResizeObserver | null>(null)
  const rowKeyByEl = useRef<WeakMap<Element, string>>(new WeakMap())
  const pendingResizeRef = useRef(false)

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const obs = new ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        const key = rowKeyByEl.current.get(entry.target)
        if (!key) continue
        const h = entry.contentRect.height
        if (!Number.isFinite(h) || h <= 0) continue
        const prev = heightsRef.current.get(key)
        // 容忍微小差异,避免高度在 145.3 / 145.4 之间来回抖
        if (prev === undefined || Math.abs(prev - h) > 0.5) {
          heightsRef.current.set(key, h)
          changed = true
        }
      }
      if (changed && !pendingResizeRef.current) {
        pendingResizeRef.current = true
        // 合批:下一次 animation frame 再触发 layout 重算,防止每行
        // 依次 resize 时触发 N 次 re-render。
        requestAnimationFrame(() => {
          pendingResizeRef.current = false
          setHeightsRev((r) => r + 1)
        })
      }
    })
    observerRef.current = obs
    return () => {
      obs.disconnect()
      observerRef.current = null
    }
  }, [])

  // ── Scroll + resize 观察 ────────────────────────────────
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const measureViewport = () => setViewportHeight(el.clientHeight)
    // rAF-batch scroll updates so wheel/touch events at 60-240Hz only
    // trigger one windowRange recompute per animation frame instead of
    // one per native scroll event.
    let scrollFrameId = 0
    const handleScroll = () => {
      if (scrollFrameId !== 0) return
      scrollFrameId = requestAnimationFrame(() => {
        scrollFrameId = 0
        setScrollTop(el.scrollTop)
      })
    }
    measureViewport()
    el.addEventListener('scroll', handleScroll, { passive: true })
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(measureViewport)
        : null
    ro?.observe(el)
    return () => {
      if (scrollFrameId !== 0) cancelAnimationFrame(scrollFrameId)
      el.removeEventListener('scroll', handleScroll)
      ro?.disconnect()
    }
  }, [])

  // ── Row ref callback ────────────────────────────────────
  const makeRowRef = useCallback(
    (key: string) => (node: HTMLDivElement | null) => {
      const obs = observerRef.current
      if (!obs) return
      if (node) {
        rowKeyByEl.current.set(node, key)
        obs.observe(node)
      }
    },
    [],
  )

  // ── 非虚拟化 fast path ─────────────────────────────────
  if (!virtualEnabled) {
    return (
      <div ref={scrollerRef} className={className}>
        {items.map((item, i) => {
          const key = getKey(item, i)
          return (
            <div
              key={key}
              ref={makeRowRef(key)}
              style={itemGap > 0 ? { marginBottom: i < items.length - 1 ? itemGap : 0 } : undefined}
            >
              {renderItem(item, i)}
            </div>
          )
        })}
      </div>
    )
  }

  // ── 虚拟化渲染 ─────────────────────────────────────────
  const visibleItems: React.ReactNode[] = []
  for (let i = windowRange.start; i < windowRange.end; i++) {
    const item = items[i]
    const key = getKey(item, i)
    visibleItems.push(
      <div
        key={key}
        ref={makeRowRef(key)}
        style={{
          position: 'absolute',
          top: layout.offsets[i],
          left: 0,
          right: 0,
        }}
      >
        {renderItem(item, i)}
      </div>,
    )
  }

  return (
    <div
      ref={scrollerRef}
      className={className}
      style={{ position: 'relative', overflowY: 'auto' }}
    >
      {/* 撑高的占位元素,驱动原生滚动条 */}
      <div
        style={{
          height: layout.totalHeight,
          position: 'relative',
        }}
      >
        {visibleItems}
      </div>
    </div>
  )
}
