import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ChatMessage } from '../../types'

export interface VirtualMessageListHandle {
  scrollToBottom: (behavior?: ScrollBehavior) => void
  scrollToMessage: (messageId: string, behavior?: ScrollBehavior) => void
}

interface VirtualMessageListProps {
  messages: ChatMessage[]
  containerRef: React.RefObject<HTMLDivElement | null>
  renderMessage: (message: ChatMessage, index: number) => React.ReactNode
  estimateHeight?: number
  overscanCount?: number
  /**
   * Live "user is following the bottom" flag (a ref so streaming deltas don't
   * re-render this list). While it is true, any layout change caused by
   * row measurement (estimate → real height) re-pins the viewport to the
   * bottom BEFORE paint. Without this, measured heights shift all offsets
   * below while scrollTop stays fixed, so the viewport visibly "jumps to
   * the middle" of the transcript — worst on the first mount mid-stream,
   * when every row is still at the estimated height.
   */
  pinToBottomRef?: React.RefObject<boolean>
}

export const VirtualMessageList = forwardRef<VirtualMessageListHandle, VirtualMessageListProps>(
  (
    {
      messages,
      containerRef,
      renderMessage,
      estimateHeight = 140,
      overscanCount = 4,
      pinToBottomRef,
    },
    ref
  ) => {
    const [scrollTop, setScrollTop] = useState(0)
    const [viewportHeight, setViewportHeight] = useState(0)
    const [itemHeights, setItemHeights] = useState<Map<string, number>>(() => new Map())

    /** Single shared ResizeObserver for all message rows — avoids N observers for N rows. */
    const sharedObserverRef = useRef<ResizeObserver | null>(null)
    /** Maps observed DOM nodes → messageId so the shared callback knows which row changed. */
    const nodeToMessageRef = useRef<Map<Element, string>>(new Map())
    /** Tracks which messageIds currently have an element attached. */
    const attachedIdsRef = useRef<Set<string>>(new Set())
    /**
     * Per-messageId ref-callback cache. Returning a fresh closure from the
     * render body (the previous `attachMeasureRef(id)` pattern) gave every
     * row a NEW ref identity each render, so React detached + re-attached
     * it on EVERY commit — i.e. during streaming it ran `unobserve` +
     * `getBoundingClientRect()` (a forced synchronous reflow) + `observe`
     * for every visible row ~60×/s. Caching one stable callback per id
     * means React only invokes it on real mount (node) / unmount (null).
     */

    // Initialize the shared observer once.
    useEffect(() => {
      const observer = new ResizeObserver((entries) => {
        const updates: [string, number][] = []
        for (const entry of entries) {
          const messageId = nodeToMessageRef.current.get(entry.target)
          if (!messageId) continue
          const nextHeight = Math.ceil(entry.contentRect.height)
          updates.push([messageId, nextHeight])
        }
        if (updates.length === 0) return
        setItemHeights((prev) => {
          let changed = false
          const next = new Map(prev)
          for (const [id, h] of updates) {
            if (prev.get(id) !== h) {
              next.set(id, h)
              changed = true
            }
          }
          return changed ? next : prev
        })
      })
      sharedObserverRef.current = observer
      // Rows whose ref callback ran during the FIRST commit were tracked in
      // `nodeToMessageRef` but never observed — this effect (which creates the
      // observer) runs AFTER ref callbacks, so `observer?.observe()` in the
      // callback was a no-op for them. Observe + re-measure them now; without
      // this their post-mount height growth (streaming text, async markdown,
      // colorize) is never tracked, leaving stale heights → absolutely
      // positioned rows overlap each other.
      const initialUpdates: [string, number][] = []
      for (const [node, messageId] of nodeToMessageRef.current) {
        observer.observe(node)
        initialUpdates.push([messageId, Math.ceil(node.getBoundingClientRect().height)])
      }
      let initialMeasureFrame = 0
      if (initialUpdates.length > 0) {
        initialMeasureFrame = requestAnimationFrame(() => {
          setItemHeights((prev) => {
            let changed = false
            const next = new Map(prev)
            for (const [id, h] of initialUpdates) {
              if (prev.get(id) !== h) {
                next.set(id, h)
                changed = true
              }
            }
            return changed ? next : prev
          })
        })
      }
      return () => {
        if (initialMeasureFrame) cancelAnimationFrame(initialMeasureFrame)
        observer.disconnect()
      }
    }, [])

    useEffect(() => {
      const container = containerRef.current
      if (!container) return

      // rAF-batch scroll updates — native scroll events fire at the
      // monitor's refresh rate (60-240Hz). Without batching, every event
      // triggered a full layout-memo recompute (O(n) over messages).
      // Coalescing to one update per animation frame caps work at ~60Hz.
      let scrollFrameId = 0
      const syncScroll = () => {
        if (scrollFrameId !== 0) return
        scrollFrameId = requestAnimationFrame(() => {
          scrollFrameId = 0
          setScrollTop(container.scrollTop)
        })
      }
      const syncSize = () => setViewportHeight(container.clientHeight)

      setScrollTop(container.scrollTop)
      syncSize()

      container.addEventListener('scroll', syncScroll, { passive: true })
      const resizeObserver = new ResizeObserver(syncSize)
      resizeObserver.observe(container)

      return () => {
        if (scrollFrameId !== 0) cancelAnimationFrame(scrollFrameId)
        container.removeEventListener('scroll', syncScroll)
        resizeObserver.disconnect()
      }
    }, [containerRef])

    // Clean up stale messageIds when the message list changes.
    useEffect(() => {
      const validMessageIds = new Set(messages.map((message) => message.id))
      const staleIds: string[] = []
      for (const id of attachedIdsRef.current) {
        if (!validMessageIds.has(id)) staleIds.push(id)
      }
      if (staleIds.length === 0) return

      const observer = sharedObserverRef.current
      for (const id of staleIds) {
        attachedIdsRef.current.delete(id)
        // Unobserve any DOM node still mapped to this id.
        for (const [node, msgId] of nodeToMessageRef.current) {
          if (msgId === id) {
            observer?.unobserve(node)
            nodeToMessageRef.current.delete(node)
          }
        }
      }

      queueMicrotask(() => {
        setItemHeights((prev) => {
          const next = new Map(prev)
          for (const id of staleIds) next.delete(id)
          return next
        })
      })
    }, [messages])

    const messageIndexMap = useMemo(() => {
      const indexMap = new Map<string, number>()
      // P1-38: `message.id` is supposed to be unique but the wider codebase
      // does not actually guarantee it (sub-agent bubbles, recovery
      // restarts, parallel timelines, third-party render entries can all
      // collide). When that happens this lookup table previously kept
      // only the LAST occurrence — `scrollToMessage` would then jump to
      // the wrong row. Keep the FIRST occurrence (matches DOM order) and
      // warn so we notice id collisions in dev builds.
      messages.forEach((message, index) => {
        if (!indexMap.has(message.id)) indexMap.set(message.id, index)
        else if (import.meta.env.DEV) {
          console.warn(
            `[VirtualMessageList] Duplicate message id encountered: "${message.id}" at indexes ` +
              `${indexMap.get(message.id)} and ${index}. Falling back to first occurrence for scroll.`,
          )
        }
      })
      return indexMap
    }, [messages])

    // Static layout — offsets / heights / totalHeight only change when the
    // message list or measured heights change. Splitting this out from the
    // visible-window memo means scroll events no longer rebuild O(n)
    // arrays just to find the visible slice.
    const staticLayout = useMemo(() => {
      const offsets: number[] = []
      const heights: number[] = []

      let currentOffset = 0
      for (let index = 0; index < messages.length; index += 1) {
        const messageId = messages[index].id
        const measuredHeight = itemHeights.get(messageId) ?? estimateHeight
        offsets[index] = currentOffset
        heights[index] = measuredHeight
        currentOffset += measuredHeight
      }

      return { offsets, heights, totalHeight: currentOffset }
    }, [messages, estimateHeight, itemHeights])

    // Bottom-pinning (scroll anchoring for the followed-bottom case).
    // Runs synchronously after every commit that changed totalHeight, before
    // the browser paints or dispatches the clamp-induced scroll event — so
    // the follow-bottom state in the parent never sees a transient
    // "far from bottom" frame and auto-follow doesn't break mid-stream.
    useLayoutEffect(() => {
      if (!pinToBottomRef?.current) return
      const container = containerRef.current
      if (!container) return
      // Pin to the container's REAL scrollHeight, not `staticLayout.totalHeight`.
      // The actively-streaming row's measured height lags the layout (the
      // ResizeObserver updates `itemHeights` a frame behind the DOM growth,
      // and off-screen rows fall back to the 140px estimate), so the
      // estimate-based total points mid-transcript and pinning to it strands
      // the reader in the middle while output is in flight. In a layout
      // effect `scrollHeight` already reflects the just-committed DOM, so it
      // is the authoritative bottom.
      const targetTop = Math.max(0, container.scrollHeight - container.clientHeight)
      if (Math.abs(container.scrollTop - targetTop) > 1) {
        container.scrollTop = targetTop
      }
    }, [staticLayout.totalHeight, containerRef, pinToBottomRef])

    // Binary-search the visible window. Depends on scroll + viewport so it
    // re-runs on scroll, but only walks O(log n) over the cached arrays.
    const layout = useMemo(() => {
      const { offsets, heights, totalHeight } = staticLayout
      const overscanHeight = overscanCount * estimateHeight
      const visibleTop = Math.max(0, scrollTop - overscanHeight)
      const visibleBottom = scrollTop + viewportHeight + overscanHeight

      // First index whose bottom edge is at or below visibleTop
      let startLo = 0
      let startHi = messages.length
      while (startLo < startHi) {
        const mid = (startLo + startHi) >> 1
        if (offsets[mid] + heights[mid] < visibleTop) {
          startLo = mid + 1
        } else {
          startHi = mid
        }
      }
      const startIndex = startLo

      // First index whose top edge is at or below visibleBottom
      let endLo = startIndex
      let endHi = messages.length
      while (endLo < endHi) {
        const mid = (endLo + endHi) >> 1
        if (offsets[mid] < visibleBottom) {
          endLo = mid + 1
        } else {
          endHi = mid
        }
      }
      const endIndex = endLo

      const safeEndIndex = Math.min(messages.length, Math.max(startIndex + 1, endIndex))

      return {
        offsets,
        totalHeight,
        startIndex,
        endIndex: safeEndIndex,
      }
    }, [staticLayout, messages.length, estimateHeight, overscanCount, scrollTop, viewportHeight])

    useImperativeHandle(
      ref,
      () => ({
        scrollToBottom: (behavior = 'auto') => {
          const container = containerRef.current
          if (!container) return
          // Target the live DOM bottom (scrollHeight), not the estimate-based
          // `layout.totalHeight` — while streaming, the latter lags the real
          // height and points mid-transcript. The browser clamps an
          // over-target to the true maximum scroll for us.
          container.scrollTo({ top: container.scrollHeight, behavior })
        },
        scrollToMessage: (messageId, behavior = 'smooth') => {
          const container = containerRef.current
          if (!container) return

          const index = messageIndexMap.get(messageId)
          if (index === undefined) return

          const targetTop = Math.max(0, (layout.offsets[index] ?? 0) - 24)
          container.scrollTo({ top: targetTop, behavior })
        },
      }),
      [containerRef, messageIndexMap, layout]
    )

    // Stable per-id ref callback (see `measureRefCacheRef`). Identity is
    // preserved across renders so React stops thrashing observe/measure.
    const getMeasureRef = useCallback(
      (messageId: string): ((node: HTMLDivElement | null) => void) => {
        const cb = (node: HTMLDivElement | null) => {
          const observer = sharedObserverRef.current

          // If the same messageId was previously attached to a different node, unobserve the old one.
          for (const [existingNode, existingMsgId] of nodeToMessageRef.current) {
            if (existingMsgId === messageId) {
              observer?.unobserve(existingNode)
              nodeToMessageRef.current.delete(existingNode)
            }
          }

          if (!node) return

          attachedIdsRef.current.add(messageId)
          // Measure immediately, then register with the shared observer.
          const initialHeight = Math.ceil(node.getBoundingClientRect().height)
          setItemHeights((prev) => {
            if (prev.get(messageId) === initialHeight) return prev
            const next = new Map(prev)
            next.set(messageId, initialHeight)
            return next
          })

          nodeToMessageRef.current.set(node, messageId)
          observer?.observe(node)
        }
        return cb
      },
      [],
    )

    const visibleRows = useMemo(
      () =>
        messages.slice(layout.startIndex, layout.endIndex).map((message, index) => ({
          message,
          messageIndex: layout.startIndex + index,
          measureRef: getMeasureRef(message.id),
        })),
      [messages, layout.startIndex, layout.endIndex, getMeasureRef],
    )

    if (messages.length === 0) return null

    return (
      <div className="virtual-message-list" style={{ height: layout.totalHeight }}>
        {visibleRows.map(({ message, messageIndex, measureRef }) => {
          return (
            <div
              key={message.id || `msg-fallback-${messageIndex}`}
              ref={measureRef}
              className="virtual-message-row"
              style={{ top: layout.offsets[messageIndex] ?? 0 }}
            >
              {renderMessage(message, messageIndex)}
            </div>
          )
        })}
      </div>
    )
  }
)

VirtualMessageList.displayName = 'VirtualMessageList'
