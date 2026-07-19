/**
 * ThinkingBlock — the model's chain-of-thought, rendered as a single feed
 * row that shows "Thinking 9.2s" while streaming and "Thought for 9.2s"
 * when done. Click to expand and read the full reasoning.
 *
 * Duration-accounting invariants (hard-won):
 *
 *   - The store does NOT persist `thinkingTimeMs` — the prop is always
 *     `undefined` in practice. All duration state therefore has to live
 *     inside this component. Losing it (e.g. via remount) = losing the
 *     value; there's no upstream to re-seed from.
 *
 *   - An unmount → remount is triggered by lots of innocuous re-renders
 *     (virtualised list recycling, sibling sub-agent collapse shifting
 *     `idx`, parent re-keying). Without persistence, remount snaps the
 *     timer back to 0.0s — which the user reads as "the sibling event
 *     reset the main-agent timer".
 *
 *   - Re-firing the streaming-start effect (if `isStreaming` flips, or
 *     a parent re-renders in a way that re-runs effects) must NOT
 *     overwrite `displayMs` with 0. The tick must resume from the
 *     current value.
 *
 * Fix strategy:
 *
 *   1. A module-scoped `durationCache: Map<string, number>` lets us
 *      survive unmount/remount. The caller passes a stable `stableKey`
 *      (message id + block index); every displayMs update writes back,
 *      and mount reads from it first.
 *
 *   2. The streaming-start effect reads `displayMs` via a stale closure
 *      and reverse-engineers a start timestamp, so tick continues
 *      rather than restarts. No `setDisplayMs(0)` anywhere on stream
 *      start.
 *
 *   3. The authoritative-snap effect (post-streaming) only overwrites
 *      when `thinkingTimeMs > 0` — treating `0` / `undefined` as "no
 *      data; keep whatever the tick accumulated".
 *
 * Other preserved behaviour:
 *   - Auto-expand while streaming.
 *   - Auto-collapse ~3.5s after streaming ends (skipped if the user
 *     has toggled during the session).
 *   - Streaming viewport clips markdown to 240px and auto-scrolls to
 *     the bottom so the chat transcript isn't pushed down by a growing
 *     reasoning block.
 *   - `showSummaryCard=false && !streaming && empty content` → renders
 *     nothing (preserves the old silence contract).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ActivityRow } from './activity/ActivityRow'
import './ThinkingBlock.css'

// ─── Structured-sections parsing (H: long-reasoning navigation) ──────────────
//
// Models that emit chain-of-thought longer than ~1.5 KB almost always
// structure it with markdown subheadings — `## Plan`, `### Step 2`,
// `## Verification`, etc. Rendering 10 KB of reasoning as one flat
// markdown wall makes "find the part where it decided X" a manual scroll
// hunt. When we detect ≥2 H2/H3 headings and the body is long enough, we
// switch from flat to per-section collapsible accordions (native
// `<details>` elements — zero React state per section).
//
// Activation is gated on streaming ending. During streaming the user is
// actively reading the live feed and stick-to-bottom matters more than
// navigation; the moment the block finalises we re-parse and offer the
// structured view if criteria are met.

const MIN_CONTENT_LENGTH_FOR_SECTIONS = 1500
const MIN_HEADINGS_FOR_SECTIONS = 2

// Module-stable plugin array so `ReactMarkdown` doesn't see a new
// `remarkPlugins` identity on every render and rebuild its processor.
const REMARK_PLUGINS = [remarkGfm]

// Captured once: when `IntersectionObserver` is unavailable (jsdom tests,
// SSR) we must NOT gate the streaming tick on `inView` — it would never
// flip true and the timer would never run. Real browsers fire the observer
// within a frame of mount, so off-screen gating is safe there.
const IO_SUPPORTED = typeof IntersectionObserver !== 'undefined'

interface ReasoningSection {
  level: 2 | 3
  heading: string
  body: string
  /** Line count of the body, used as a quick "size" hint in the summary. */
  lineCount: number
}

/**
 * Parse a thinking block's markdown into sections delimited by H2/H3
 * headings. Returns `null` when the content is too short or doesn't carry
 * enough structure to justify the section UI — callers should fall back to
 * flat markdown in that case.
 *
 * Code-fence handling: `## comment` inside a fenced code block is NOT a
 * heading. The parser tracks fence state and skips any matches while
 * inside one.
 *
 * Content before the first heading becomes a synthetic "Lead-in" section
 * so it isn't dropped or rendered out of order.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function parseReasoningSections(content: string): ReasoningSection[] | null {
  if (content.length < MIN_CONTENT_LENGTH_FOR_SECTIONS) return null

  const lines = content.split('\n')
  const sections: ReasoningSection[] = []
  let inFence = false
  let current: { level: 2 | 3; heading: string; bodyLines: string[] } | null = null
  const preambleLines: string[] = []

  const finishSection = () => {
    if (!current) return
    const body = current.bodyLines.join('\n').trim()
    sections.push({
      level: current.level,
      heading: current.heading,
      body,
      lineCount: body ? body.split('\n').length : 0,
    })
  }

  for (const line of lines) {
    // Toggle fence state on a line that starts a markdown fence. Indented
    // fences (rare) are NOT recognised — same restriction CommonMark
    // requires for fence opening. Worst case: indented fence's contents
    // get treated as ordinary text and any heading-shaped lines inside
    // would be parsed as headings, which is an acceptable false-positive
    // for an opportunistic parser.
    if (/^```/.test(line)) {
      inFence = !inFence
      if (current) current.bodyLines.push(line)
      else preambleLines.push(line)
      continue
    }
    if (inFence) {
      if (current) current.bodyLines.push(line)
      else preambleLines.push(line)
      continue
    }
    const m = /^(##|###)\s+(.+?)\s*$/.exec(line)
    if (m) {
      finishSection()
      current = {
        level: m[1].length === 2 ? 2 : 3,
        heading: m[2].trim(),
        bodyLines: [],
      }
      continue
    }
    if (current) current.bodyLines.push(line)
    else preambleLines.push(line)
  }
  finishSection()

  if (sections.length < MIN_HEADINGS_FOR_SECTIONS) return null

  const preamble = preambleLines.join('\n').trim()
  if (preamble) {
    sections.unshift({
      level: 2,
      heading: '前言',
      body: preamble,
      lineCount: preamble.split('\n').length,
    })
  }
  return sections
}

const ReasoningSections: React.FC<{ sections: ReasoningSection[] }> = ({ sections }) => {
  return (
    <div className="thinking-sections">
      {sections.map((s, i) => (
        // Native `<details>` keeps per-section open/closed state in the DOM
        // — zero React state to keep in sync, no remount-collapse bugs.
        // First section defaults open so the block doesn't look empty on
        // first reveal; subsequent sections start collapsed so the
        // structured view is the "outline" the user came for.
        <details
          key={i}
          className={`thinking-section thinking-section-h${s.level}`}
          open={i === 0}
        >
          <summary className="thinking-section-summary">
            <span className="thinking-section-marker" aria-hidden="true">▸</span>
            <span className="thinking-section-heading">{s.heading}</span>
            {s.lineCount > 0 ? (
              <span className="thinking-section-meta">{s.lineCount} 行</span>
            ) : null}
          </summary>
          <div className="thinking-section-body">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{s.body}</ReactMarkdown>
          </div>
        </details>
      ))}
    </div>
  )
}

interface ThinkingMarkdownBodyProps {
  content: string
  sections: ReasoningSection[] | null
  streaming: boolean
  scrollRef: React.RefObject<HTMLDivElement | null>
}

/**
 * The reasoning markdown viewport, split out and memoised so the streaming
 * wall-clock tick — which re-renders the parent `ThinkingBlock` every
 * 100ms via `displayMs` — does NOT re-run the (expensive) `ReactMarkdown`
 * pipeline. The body only re-renders when the actual text (`content`) or
 * its parsed structure (`sections`) changes; the per-tick re-render of the
 * parent now stops at this memo boundary.
 */
const ThinkingMarkdownBody = React.memo<ThinkingMarkdownBodyProps>(
  ({ content, sections, streaming, scrollRef }) => (
    <div
      ref={scrollRef}
      className={`thinking-markdown${streaming ? ' thinking-markdown-streaming' : ''}`}
    >
      {sections ? (
        // Long, structured reasoning → collapsible per-section view for
        // navigation. Flat fallback covers the streaming path and short /
        // unstructured blocks.
        <ReasoningSections sections={sections} />
      ) : (
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{content}</ReactMarkdown>
      )}
    </div>
  ),
)
ThinkingMarkdownBody.displayName = 'ThinkingMarkdownBody'

interface ThinkingBlockProps {
  content?: string
  isStreaming?: boolean
  showSummaryCard?: boolean
  thinkingTimeMs?: number
  /**
   * Approximate output tokens spent on the thinking block, sourced from
   * a length-based heuristic at the provider boundary (see
   * `electron/ai/anthropicCompatHttp.ts#estimateThinkingTokens`). When
   * present, surfaced inline next to the timer with a `~` prefix so the
   * user reads it as approximate. Omitted on legacy / streaming-in-
   * progress blocks where the count would either be unknown or a moving
   * target.
   */
  thinkingTokens?: number
  /**
   * When set, this block's text was truncated by the persistence-layer
   * compaction pass (see `compactThinkingOnSave` setting). The renderer
   * surfaces a small "(truncated)" pill in the meta strip so users
   * understand they're looking at a preview, not the full chain of
   * thought.
   */
  compactedAt?: number
  /**
   * Stable identity across unmount / remount, typically
   * `${message.id}:thinking:${blockIdx}`. Used to persist the tick
   * counter in a module-scoped cache so a virtualised list recycling
   * the row — or a sibling sub-agent collapse shifting React keys —
   * doesn't snap the displayed duration back to 0.
   *
   * Optional: when omitted, the component still works but loses its
   * memory across remounts (same as the pre-fix behaviour).
   */
  stableKey?: string
  /**
   * 长会话兜底（plan Phase 3.B）：父组件检测到当前会话 thinking 块总数超过
   * `useSettingsStore.thinkingAutoCollapseThreshold` 时，对非 streaming 的
   * 历史块传 `true`，让 ThinkingBlock 跳过：
   *   1. mount 时根据 `isStreaming` 自动展开
   *   2. streaming 期间的"展开 + 重置 userToggled"
   *   3. streaming 结束后 3.5s 的"自动折叠"
   * 用户手动点开/收起的能力不受影响（`userToggledRef` 路径仍然生效）。
   *
   * 设计选择：用 prop drill 而不是组件内部订阅 store，保持组件纯。
   */
  forceCollapsed?: boolean
}

function formatSeconds(ms: number): string {
  const safe = typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, ms) : 0
  return `${(safe / 1000).toFixed(1)}s`
}

/**
 * Format an approximate token count for the meta strip: `123` for small
 * counts, `1.3k` for thousands, `12k` once we're past 10k. Always emits
 * a value caller can prepend `~` to. Negative / zero / non-finite input
 * returns `''` so the caller can skip rendering entirely.
 *
 * Exported for test coverage; the function is small but the rounding
 * boundaries (1000 / 10000) are easy to regress on.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function formatThinkingTokens(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return ''
  if (n < 1000) return String(n)
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

/**
 * Persistent duration storage, keyed by whatever the caller passes
 * as `stableKey`. Lives for the lifetime of the renderer process and
 * survives unmount → remount (virtualised list recycling, sibling
 * sub-agent collapse, etc.) so the duration display doesn't snap back
 * to 0.0s when React happens to rebuild the row.
 *
 * Bounded with simple LRU semantics: long sessions can produce hundreds
 * of thinking blocks (parent + multi sub-agents × multi turns), and an
 * unbounded `Map` would grow monotonically until the renderer process
 * ends. We rely on `Map` insertion-order iteration to evict the oldest
 * entry once we exceed {@link DURATION_CACHE_MAX_ENTRIES}.
 *
 * Deliberately NOT a React state atom — it's a pure survive-remount
 * side-channel. React's re-render cycle is driven by `displayMs` local
 * state; the cache is a source of truth only when local state is
 * uninitialised (i.e. fresh mount).
 */
const DURATION_CACHE_MAX_ENTRIES = 500
const durationCache = new Map<string, number>()

function writeDurationCache(key: string, ms: number): void {
  // Re-insert pattern: deleting before set moves the entry to the tail
  // of the iteration order, making it "most recently used" so the LRU
  // sweep below evicts only genuinely stale entries.
  if (durationCache.has(key)) durationCache.delete(key)
  durationCache.set(key, ms)
  while (durationCache.size > DURATION_CACHE_MAX_ENTRIES) {
    const oldest = durationCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    durationCache.delete(oldest)
  }
}

function readDurationCache(key: string): number | undefined {
  const v = durationCache.get(key)
  if (typeof v === 'number' && v > 0) {
    // Touch on read so frequently-rendered blocks (the currently-visible
    // ones in a virtualised list) keep their LRU position fresh.
    durationCache.delete(key)
    durationCache.set(key, v)
    return v
  }
  return undefined
}

/** @internal test-only helper to inspect / reset the cache. */
// eslint-disable-next-line react-refresh/only-export-components
export function __resetDurationCacheForTests(): void {
  durationCache.clear()
}

/** Resolve the best initial `displayMs` at mount time. */
function resolveInitialDisplayMs(
  stableKey: string | undefined,
  thinkingTimeMs: number | undefined,
): number {
  // 1) Module cache wins — survives remount.
  if (stableKey) {
    const cached = readDurationCache(stableKey)
    if (typeof cached === 'number') return cached
  }
  // 2) Prop from the store (almost never present, but honour it).
  if (
    typeof thinkingTimeMs === 'number' &&
    Number.isFinite(thinkingTimeMs) &&
    thinkingTimeMs > 0
  ) {
    return thinkingTimeMs
  }
  // 3) Zero — genuine "no data yet" sentinel.
  return 0
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({
  content = '',
  isStreaming,
  showSummaryCard = true,
  thinkingTimeMs,
  thinkingTokens,
  compactedAt,
  stableKey,
  forceCollapsed = false,
}) => {
  // Mount-time seed: cache > prop > 0. `useState(() => …)` runs the
  // initializer exactly once per component instance, not on every
  // render, so this is cheap.
  const [displayMs, setDisplayMs] = useState<number>(() =>
    resolveInitialDisplayMs(stableKey, thinkingTimeMs),
  )
  // 长会话兜底：forceCollapsed 时初始 collapsed（即使在 streaming 中也不展开）
  const [expanded, setExpanded] = useState<boolean>(!!isStreaming && !forceCollapsed)

  // User-initiated toggles override the auto-collapse timer.
  const userToggledRef = useRef(false)

  // Scroll target for the streaming markdown viewport.
  const markdownScrollRef = useRef<HTMLDivElement | null>(null)

  // Wall-clock anchor for the streaming tick. Persisted in a ref (not
  // local state) so pausing the tick while off-screen and resuming on
  // scroll-back — or a fresh mount seeded from the duration cache —
  // continues from the real elapsed time instead of snapping to 0.0s.
  // Reset to `null` whenever streaming stops so the next stream re-anchors.
  const startAnchorRef = useRef<number | null>(null)

  // Wrapper observed by the IntersectionObserver below. We wrap the
  // ActivityRow rather than threading a ref through it because the row
  // component doesn't forwardRef, and adding a passthrough there would
  // touch many call sites that don't care about visibility.
  const rowWrapperRef = useRef<HTMLDivElement | null>(null)

  // Visibility-gated auto-collapse: defer the 3.5s timer while the row is
  // actually on-screen so a user mid-read isn't snap-collapsed.
  //
  // Initial `false` means "treat as off-screen until proven otherwise".
  // For environments without `IntersectionObserver` (older test runners,
  // SSR) this preserves the original unconditional collapse behaviour —
  // the observer effect simply never wires up and `inView` stays false.
  // For real browsers the IO callback fires within a frame of mount, well
  // before streaming ends, so there's no observable "false flash"
  // race-collapsing a freshly-mounted block.
  const [inView, setInView] = useState(false)

  // Every non-zero displayMs is written back to the cache so the next
  // mount (e.g. after a virtualised list recycle) can resume. We only
  // update on meaningful values so `durationCache` never regresses
  // from a real duration back to 0. `writeDurationCache` enforces LRU
  // bounds (see `DURATION_CACHE_MAX_ENTRIES`).
  useEffect(() => {
    if (!stableKey) return
    if (displayMs <= 0) return
    writeDurationCache(stableKey, displayMs)
  }, [stableKey, displayMs])

  // (1a) Auto-expand when streaming begins. Kept separate from the tick
  //      (1b) so that visibility (`inView`) changes during streaming do
  //      NOT re-run "expand + reset userToggled" — otherwise scrolling a
  //      collapsed-by-user block back on-screen would force it open again.
  useEffect(() => {
    if (!isStreaming) return
    // 长会话兜底：forceCollapsed 时不再自动展开、也不重置 userToggled
    if (forceCollapsed) return
    setExpanded(true)
    userToggledRef.current = false
  }, [isStreaming, forceCollapsed])

  // (1b) Wall-clock tick while streaming, gated on visibility.
  //
  //     CRITICAL: the start instant is derived from *current* displayMs
  //     (stale closure capture) the first time we anchor, so any resume —
  //     fresh mount with cache, re-entry from isStreaming flipping,
  //     scroll-back into view — continues from where we left off. We
  //     deliberately never call setDisplayMs(0) here; that was the bug
  //     behind "sibling sub-agent collapse resets the timer to 0.0s".
  //
  //     Visibility gating: an off-screen block spends no setState per
  //     100ms (and, combined with the `ThinkingMarkdownBody` memo, never
  //     re-parses its markdown on a tick). When IntersectionObserver is
  //     unavailable we keep ticking unconditionally (see IO_SUPPORTED).
  useEffect(() => {
    if (!isStreaming) {
      startAnchorRef.current = null
      return
    }
    if (startAnchorRef.current === null) {
      startAnchorRef.current = Date.now() - displayMs
    }
    const anchor = startAnchorRef.current
    // Snap once on (re)entry so a row scrolled back into view shows the
    // correct elapsed time immediately rather than the value frozen on exit.
    setDisplayMs(Date.now() - anchor)
    if (IO_SUPPORTED && !inView) return
    const timer = window.setInterval(() => {
      setDisplayMs(Date.now() - anchor)
    }, 100)
    return () => window.clearInterval(timer)
    // `displayMs` is intentionally NOT in deps — it only seeds the anchor
    // via stale closure on entry; including it would re-arm the timer on
    // every tick (an infinite re-arm loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, inView])

  // (2) Authoritative snap when streaming ends AND the caller knows
  //     the true elapsed time. Treat `0` as "no data yet" —
  //     indistinguishable in practice from `undefined`.
  useEffect(() => {
    if (isStreaming) return
    if (
      typeof thinkingTimeMs === 'number' &&
      Number.isFinite(thinkingTimeMs) &&
      thinkingTimeMs > 0
    ) {
      setDisplayMs(thinkingTimeMs)
    }
  }, [isStreaming, thinkingTimeMs])

  // Wire the IntersectionObserver once per mount. The handler updates
  // `inView` purely as render state — no side effects beyond that — so
  // re-attaching on `expanded` toggles or content updates is wasteful
  // and would defeat the LRU-friendly long-mount assumption.
  useEffect(() => {
    const el = rowWrapperRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setInView(entry.isIntersecting)
      },
      // `threshold: 0` fires as soon as any pixel of the row crosses the
      // viewport boundary. We deliberately don't require "fully visible"
      // — even a sliver of the row showing means the user could still be
      // tracking it, and the 3.5s collapse is already lenient enough.
      { threshold: 0 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // (3) Auto-collapse shortly after streaming ends — unless the user
  //     has already toggled the row during the session, OR the row is
  //     currently on-screen (in which case the user is likely reading
  //     and an unsolicited collapse is jarring). Falling out of viewport
  //     re-arms the timer on the next render.
  useEffect(() => {
    if (isStreaming) return
    if (!content.trim()) return
    if (userToggledRef.current) return
    if (!expanded) return
    if (inView) return
    // 长会话兜底：forceCollapsed 模式下 mount 时已经是 collapsed，不需要再
    // 触发"3.5s 后收起"的过渡（避免空跑一次 setTimeout）。
    if (forceCollapsed) return
    const timer = window.setTimeout(() => setExpanded(false), 3500)
    return () => window.clearTimeout(timer)
  }, [isStreaming, content, expanded, inView, forceCollapsed])

  // (4) Stick-to-bottom while streaming so the latest thought stays
  //     visible inside the fixed-height viewport.
  useEffect(() => {
    if (!isStreaming) return
    const el = markdownScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [content, isStreaming, expanded])

  // Structured-sections opt-in: only when streaming has finalised AND
  // the content is long enough with markdown structure. Wrapping in
  // `useMemo` keeps parsing off the main render path for short blocks
  // (the parser early-returns under the length threshold anyway, but
  // memoising avoids the re-parse on every tick while expanded).
  const sections = useMemo<ReasoningSection[] | null>(() => {
    if (isStreaming) return null
    return parseReasoningSections(content)
  }, [content, isStreaming])

  if (!showSummaryCard && !isStreaming && !content.trim()) return null

  const actionWord = isStreaming ? 'Thinking' : 'Thought'
  // Always surface the timer — even `0.0s` communicates "no data"
  // honestly, whereas hiding it reads as "the time display was
  // removed". When the provider stamped an output-token estimate on the
  // block, append it after the time as `· ~1.3k tok` so users can size
  // up the cost of a turn at a glance. We deliberately suppress the
  // count while streaming: it would tick alongside the timer and add
  // visual noise without adding decision value (the block isn't billed
  // yet).
  const tokensStr =
    !isStreaming ? formatThinkingTokens(thinkingTokens) : ''
  const baseMeta = isStreaming
    ? formatSeconds(displayMs)
    : `for ${formatSeconds(displayMs)}`
  const withTokens = tokensStr ? `${baseMeta} · ~${tokensStr} tok` : baseMeta
  // The "(truncated)" hint only appears when the block was compacted by
  // the persistence pass — the rendered `content` is then a prefix +
  // elided-count tail, so callers shouldn't read it as the model's full
  // reasoning. Keep the badge inline in the meta strip rather than
  // adding a separate row so it travels with the timer/token labels.
  const isCompacted = typeof compactedAt === 'number' && compactedAt > 0
  const meta = isCompacted ? `${withTokens} · (truncated)` : withTokens

  const trimmed = content.trim()

  return (
    <div ref={rowWrapperRef}>
      <ActivityRow
        actionWord={actionWord}
        meta={meta}
        status={isStreaming ? 'running' : 'idle'}
        expanded={expanded}
        onExpandedChange={(next) => {
          userToggledRef.current = true
          setExpanded(next)
        }}
      >
        {trimmed ? (
          <ThinkingMarkdownBody
            content={content}
            sections={sections}
            streaming={!!isStreaming}
            scrollRef={markdownScrollRef}
          />
        ) : null}
      </ActivityRow>
    </div>
  )
}
