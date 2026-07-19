/**
 * `WriteEditProgressView` — IDE-style live writing card body for
 * `write_file` / `edit_file` / `multi_edit_file`. Replaces the static
 * "Output" pre with a streaming code view that:
 *
 *   1. While the model is still streaming the `tool_use` JSON
 *      arguments (`streamingInput.partialJson` is set), pulls the
 *      in-progress `content` / `newString` / `oldString` values via
 *      tolerant partial-JSON extraction and renders them growing.
 *   2. Once `tool_start` lands and `streamingInput` is cleared, falls
 *      back to reading from `toolUse.input` — same content, now
 *      canonical.
 *   3. Highlights via `monaco.editor.colorize(...)`. Monaco is already
 *      a workspace dependency (loaded async via {@link monacoReadyPromise});
 *      using its tokenizer avoids adding shiki / hljs as a new dep.
 *
 * Coverage:
 *   - `write_file` — single growing code area, +N行 meta
 *   - `edit_file` — old / new diff blocks, +N/-M meta
 *   - `multi_edit_file` — preserves every streamed edit and reveals
 *     each mini-diff independently so a large batch never appears as
 *     one blocked burst at tool completion.
 */

import React, { useEffect, useRef, useState } from 'react'
import {
  parsePartialEditInput,
  parsePartialMultiEditInput,
  parsePartialWriteInput,
} from './partialToolInputExtract'
import {
  computeUnifiedDiff,
  indexOfLastAdded,
  type DiffLine,
} from './unifiedDiff'
import { getNextMultiEditVisibleCount } from './multiEditProgress'
import { getColorize } from '../monacoColorize'
import './WriteEditProgressView.css'

const CARET_HTML = '<span class="wep-caret-inline" aria-hidden="true"></span>'

interface Props {
  toolName: string
  input: Record<string, unknown>
  streamingInput?: { partialJson: string } | undefined
  status: 'running' | 'completed' | 'error' | 'failed' | 'stopped'
}

function pickString(input: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = input[k]
    if (typeof v === 'string') return v
  }
  return ''
}

/**
 * Read every `multi_edit_file.input.edits[]` entry as a normalised
 * `{ oldString, newString }` pair. Used AFTER streaming completes so
 * the card can stack one mini diff per edit. Tolerates `old_string` /
 * `new_string` snake-case aliases and skips entries that don't have
 * both strings (defensive — shouldn't happen on validated input).
 */
function pickAllMultiEdits(
  input: Record<string, unknown>,
): Array<{ oldString: string; newString: string }> {
  const edits = input.edits
  if (!Array.isArray(edits) || edits.length === 0) return []
  const out: Array<{ oldString: string; newString: string }> = []
  for (const entry of edits) {
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    const oldStr =
      (typeof obj.oldString === 'string' && obj.oldString) ||
      (typeof obj.old_string === 'string' && obj.old_string) ||
      ''
    const newStr =
      (typeof obj.newString === 'string' && obj.newString) ||
      (typeof obj.new_string === 'string' && obj.new_string) ||
      ''
    out.push({ oldString: oldStr, newString: newStr })
  }
  return out
}

/**
 * Best-effort filename → Monaco languageId. The fallback `plaintext` is
 * safe — Monaco's tokenizer ships as a no-op for unknown ids.
 */
function inferLanguageId(filePath: string): string {
  const m = filePath.toLowerCase().match(/\.([a-z0-9]+)$/)
  if (!m) return 'plaintext'
  const ext = m[1]
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'javascript'
    case 'py':
      return 'python'
    case 'rs':
      return 'rust'
    case 'go':
      return 'go'
    case 'java':
      return 'java'
    case 'rb':
      return 'ruby'
    case 'php':
      return 'php'
    case 'cs':
      return 'csharp'
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'hpp':
    case 'h':
      return 'cpp'
    case 'c':
      return 'c'
    case 'json':
      return 'json'
    case 'yml':
    case 'yaml':
      return 'yaml'
    case 'md':
    case 'markdown':
      return 'markdown'
    case 'sh':
    case 'bash':
      return 'shell'
    case 'ps1':
      return 'powershell'
    case 'html':
    case 'htm':
    case 'vue':
      return 'html'
    case 'css':
      return 'css'
    case 'scss':
      return 'scss'
    case 'less':
      return 'less'
    case 'sql':
      return 'sql'
    case 'xml':
      return 'xml'
    case 'toml':
    case 'ini':
      return 'ini'
    default:
      return 'plaintext'
  }
}

/**
 * Cap the highlighted text to the **tail** N chars while streaming. A
 * very long content blob would otherwise re-tokenize on every delta,
 * tanking frame rate. 16K is plenty to show the live-typing window;
 * past that we elide the head and signal it with a `…` prefix.
 */
const HIGHLIGHT_TAIL_CAP = 16_000

/**
 * P2-1: when truncating to the tail, snap to the nearest line boundary
 * so the tokenizer doesn't start mid-token. Without this, slicing into
 * the middle of a string literal / regex / template would mis-detect
 * every subsequent token type for the remainder of the buffer
 * (JS/TS regex grammars are notoriously context-sensitive). Returns
 * the slice we should pass to colorize, prefixed with `…\n` so the
 * user knows content was elided.
 */
function clampToTailWithLineBoundary(text: string): string {
  if (text.length <= HIGHLIGHT_TAIL_CAP) return text
  const tail = text.slice(text.length - HIGHLIGHT_TAIL_CAP)
  const firstNewline = tail.indexOf('\n')
  // No newline anywhere in the tail → very long single line; tokenizer
  // will likely re-sync after the first whitespace anyway, just accept
  // the imprecision rather than dropping the whole tail.
  if (firstNewline < 0) return '…\n' + tail
  return '…\n' + tail.slice(firstNewline + 1)
}

interface HighlightedCodeProps {
  text: string
  languageId: string
  streaming: boolean
  /** Optional class used by the diff variant to colorise the gutter. */
  variant?: 'plain' | 'added' | 'removed'
}

const HighlightedCode: React.FC<HighlightedCodeProps> = ({
  text,
  languageId,
  streaming,
  variant = 'plain',
}) => {
  const [html, setHtml] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const lastTokenRef = useRef(0)

  useEffect(() => {
    // Degrade while streaming: skip `monaco.editor.colorize` entirely and let
    // the plaintext `<pre>` branch render (with the live caret). Colorizing on
    // every delta is the heaviest per-frame cost of the Write/Edit progress
    // card; the highlighted view is only worth computing once the args settle.
    // `streaming` is in the deps so the colorize fires exactly once when the
    // stream ends (streaming flips true -> false).
    if (streaming) {
      return
    }
    let cancelled = false
    const token = ++lastTokenRef.current
    const shown = clampToTailWithLineBoundary(text)
    void getColorize().then((colorize) => {
      if (cancelled || token !== lastTokenRef.current) return
      colorize(shown, languageId, { tabSize: 2 })
        .then((colorized: string) => {
          if (cancelled || token !== lastTokenRef.current) return
          setHtml(colorized)
        })
        .catch(() => {
          if (cancelled || token !== lastTokenRef.current) return
          setHtml(null)
        })
    })
    return () => {
      cancelled = true
    }
  }, [text, languageId, streaming])

  useEffect(() => {
    if (!streaming) return
    const el = containerRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [text, streaming])

  const className = `wep-code wep-variant-${variant}${streaming ? ' is-streaming' : ''}`

  return (
    <div ref={containerRef} className={className}>
      {!streaming && html !== null ? (
        <pre
          className="wep-code-pre"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="wep-code-pre">
          {(streaming ? clampToTailWithLineBoundary(text) : text) || '\u00A0'}
          {streaming ? <span className="wep-caret-inline" aria-hidden="true" /> : null}
        </pre>
      )}
    </div>
  )
}

/**
 * #3: Soft cap on the line count we feed to `monaco.editor.colorize`.
 * Beyond this we drop syntax highlighting (treat the buffer as
 * plaintext) so a 50K-line edit doesn't block the JS thread for
 * seconds on every streaming chunk. Picked so all typical source
 * files (~500 LOC) get full highlighting; only outliers (generated
 * code, lockfiles, minified JS) hit the cap.
 */
const COLORIZE_LINE_CAP = 800

/**
 * #4: Process-lifetime LRU for `monaco.editor.colorize` outputs.
 *
 * Streaming flow:
 *   - oldString completes early in the model's output, then stays
 *     identical across every subsequent delta of newString. WITHOUT
 *     a cache, we re-colorize the same oldString text 50-100 times
 *     per second during the rest of the stream. Same story for any
 *     edit whose oldString shows up in `multi_edit_file.edits[]`
 *     repeatedly (the model often reuses similar context lines).
 *
 * Cache key strategy: full `text + languageId` would mean a cache
 * entry per stream snapshot of newString, which never hits. Instead
 * we use a length + boundary-fingerprint that's fast to compute and
 * uniquely identifies the realistic re-renders we care about (stable
 * oldString across deltas, identical edits stacked in multi-edit).
 * Collisions are theoretically possible but harmless — a stale cache
 * hit is shown for one frame at worst before the dep change forces
 * a re-render with the correct key.
 *
 * `MAX_CACHE_ENTRIES = 64`: each entry is at most a handful of KB of
 * HTML; 64 covers several open chats × several tools each without
 * needing a smarter eviction policy.
 */
const colorizeCache = new Map<string, string[]>()
const MAX_CACHE_ENTRIES = 64

function makeColorizeCacheKey(text: string, languageId: string): string {
  // Fingerprint: length + sampled boundary bytes. Avoids hashing the
  // full content (which would dominate the per-frame work and defeat
  // the optimization at large sizes — by the time we've hashed 50KB
  // of text, we may as well have colorized it).
  const head = text.length > 64 ? text.slice(0, 64) : text
  const tail = text.length > 128 ? text.slice(-64) : ''
  return `${languageId}:${text.length}:${head}:${tail}`
}

/**
 * Tokenize `text` with Monaco, then split the colorize output by `<br/>`
 * to get per-line HTML so the diff renderer can match each `DiffLine`
 * to its corresponding tokenized line. Returns the array of per-line
 * HTML strings, or `null` if colorize hasn't completed / failed
 * (caller falls back to plain text).
 *
 * Why this is a separate hook instead of inlined: it has to handle the
 * "buffer changed mid-tokenize" race for BOTH the old and new sides
 * independently in the diff view, and the per-side token refs need to
 * stay scoped. Hooks the shared `colorizeCache` for the streaming /
 * multi-edit reuse cases described above.
 */
function useColorizedLines(
  text: string,
  languageId: string,
): string[] | null {
  const [lines, setLines] = useState<string[] | null>(null)
  const lastTokenRef = useRef(0)

  // Synchronous cache lookup: if we've colorized this exact buffer
  // before, render the result on the FIRST paint of the effect
  // dependency change. Without this, every dep change would briefly
  // show the plain-text fallback even when we have HTML on hand.
  const cachedKey = text
    ? makeColorizeCacheKey(text, languageId)
    : ''
  const cached = cachedKey ? colorizeCache.get(cachedKey) : null

  useEffect(() => {
    let cancelled = false
    const token = ++lastTokenRef.current
    if (!text) {
      // Reset the line cache when the buffer empties. Has to happen here
      // (not via derived-render) so it is correctly ordered against the
      // in-flight async colorize below — `cancelled` only stops the
      // pending colorize from writing back; we still need to drop any
      // result the previous text produced.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLines([])
      return
    }
    const key = makeColorizeCacheKey(text, languageId)
    const hit = colorizeCache.get(key)
    if (hit) {
      // Refresh LRU position on hit by re-inserting.
      colorizeCache.delete(key)
      colorizeCache.set(key, hit)
      setLines(hit)
      return
    }
    // #3 size guard: bail to plaintext for outsized inputs. The
    // tokenizer for `plaintext` is a no-op; colorize completes in
    // microseconds and the highlight degrades gracefully to "no
    // colors, still readable diff".
    const lineCount = countLines(text)
    const safeLanguageId = lineCount > COLORIZE_LINE_CAP ? 'plaintext' : languageId
    void getColorize().then((colorize) => {
      if (cancelled || token !== lastTokenRef.current) return
      colorize(text, safeLanguageId, { tabSize: 2 })
        .then((html: string) => {
          if (cancelled || token !== lastTokenRef.current) return
          const ls = html.split(/<br\s*\/?>/)
          colorizeCache.set(key, ls)
          if (colorizeCache.size > MAX_CACHE_ENTRIES) {
            // LRU eviction: drop the oldest entry (Map preserves
            // insertion order, refreshed on every hit above).
            const first = colorizeCache.keys().next().value
            if (first !== undefined) colorizeCache.delete(first)
          }
          setLines(ls)
        })
        .catch(() => {
          if (cancelled || token !== lastTokenRef.current) return
          setLines(null)
        })
    })
    return () => {
      cancelled = true
    }
  }, [text, languageId])

  // Prefer the synchronous cache hit on this render — `setLines` from
  // the effect is one tick behind.
  return cached ?? lines
}

/**
 * Count line-break-separated lines without splitting the string into
 * an array. Avoids the allocation for the line-cap check on each
 * `useColorizedLines` invocation.
 */
function countLines(text: string): number {
  if (text.length === 0) return 0
  let n = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a /* \n */) n++
  }
  return n
}

interface UnifiedDiffViewProps {
  oldText: string
  newText: string
  languageId: string
  /** Whether the model is still streaming the new content. */
  streamingNew: boolean
}

/**
 * Single-card inline unified diff. Lines are rendered top-to-bottom
 * with a per-line `+` / `-` / ` ` marker and a tint matching the
 * action — the IDE's defining visual for edits. Token highlighting
 * comes from per-side Monaco `colorize` calls split by `<br/>`; we
 * use whichever side a line came from to look up the correct
 * tokenized HTML.
 *
 * Streaming caret: appended to the last `added` line's HTML when
 * `streamingNew` is true. Browser flow places it right at the cursor
 * position the model is currently typing into.
 */
const UnifiedDiffView: React.FC<UnifiedDiffViewProps> = ({
  oldText,
  newText,
  languageId,
  streamingNew,
}) => {
  const oldHtmlLines = useColorizedLines(oldText, languageId)
  const newHtmlLines = useColorizedLines(newText, languageId)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const diff: DiffLine[] = React.useMemo(
    () => computeUnifiedDiff(oldText, newText, 2),
    [oldText, newText],
  )
  const lastAddedIdx = streamingNew ? indexOfLastAdded(diff) : -1

  // Cap rendered rows so a 10K-line rewrite doesn't tank React render
  // time. Past this we elide with a "+N more" footer. Picked to fit
  // ~6 screens of card at default density.
  const RENDER_CAP = 300
  const visible = diff.length <= RENDER_CAP ? diff : diff.slice(0, RENDER_CAP)
  const elided = diff.length - visible.length

  // Pin scroll to bottom while streaming a new line — same UX as
  // `HighlightedCode`. Only when the user hasn't scrolled up.
  useEffect(() => {
    if (!streamingNew) return
    const el = containerRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [newText, streamingNew])

  return (
    <div
      ref={containerRef}
      className={`wep-diff${streamingNew ? ' is-streaming' : ''}`}
    >
      {visible.map((line, i) => {
        const isLastAdded = i === lastAddedIdx
        let html: string | null = null
        if (line.kind === 'added') {
          html = newHtmlLines?.[line.newIdx] ?? null
        } else {
          // 'removed' or 'context' — both sourced from oldText. For
          // 'context' newIdx exists but is by definition identical
          // content; oldHtmlLines is fine.
          html = oldHtmlLines?.[line.oldIdx] ?? null
        }
        const marker = line.kind === 'removed' ? '-' : line.kind === 'added' ? '+' : ' '
        return (
          <div key={i} className={`wep-diff-line wep-diff-${line.kind}`}>
            <span className="wep-diff-marker" aria-hidden="true">
              {marker}
            </span>
            {html !== null ? (
              <span
                className="wep-diff-code"
                dangerouslySetInnerHTML={{
                  __html: isLastAdded ? html + CARET_HTML : html || '&nbsp;',
                }}
              />
            ) : (
              <span className="wep-diff-code">
                {line.text || '\u00A0'}
                {isLastAdded ? (
                  <span className="wep-caret-inline" aria-hidden="true" />
                ) : null}
              </span>
            )}
          </div>
        )
      })}
      {elided > 0 ? (
        <div className="wep-diff-elided">…{elided} 行未显示…</div>
      ) : null}
    </div>
  )
}

type ResolvedView =
  | {
      kind: 'write'
      filePath: string
      content: string
      streaming: boolean
    }
  | {
      kind: 'edit'
      filePath: string
      oldString: string
      newString: string
      streamingNew: boolean
      streamingOld: boolean
    }
  | {
      kind: 'multi-edit'
      filePath: string
      /** One entry per edit operation received so far. */
      edits: Array<{ oldString: string; newString: string }>
      /** Total edits received so far. */
      editsCount: number
      /**
       * Index into `edits[]` whose newString is currently streaming.
       * `-1` once streaming has ended.
       */
      streamingEditIndex: number
    }

/**
 * Resolve the view-model for the current render. P2-7: NOT wrapped in
 * `useMemo` — React Compiler memoizes by reference equality on the
 * dependencies it infers from this function body (`partialJson`,
 * `input.content`, etc.), and the result is cheap to recompute when
 * memoization isn't kicked in. The previous manual memoization listed
 * `input` as a dep even when only `input.<field>` was read, which the
 * Compiler refused to honour and disabled optimization for the whole
 * component.
 */
function resolveView(
  toolName: string,
  input: Record<string, unknown>,
  partialJson: string | undefined,
): ResolvedView {
  const isEdit = toolName === 'edit_file'
  const isWrite = toolName === 'write_file'
  const isMultiEdit = toolName === 'multi_edit_file'

  if (partialJson) {
    if (isWrite) {
      const p = parsePartialWriteInput(partialJson)
      return {
        kind: 'write',
        filePath: p.filePath || pickString(input, ['filePath', 'file_path']),
        content: p.content || '',
        streaming: !p.contentComplete,
      }
    }
    if (isEdit) {
      const p = parsePartialEditInput(partialJson)
      return {
        kind: 'edit',
        filePath: p.filePath || pickString(input, ['filePath', 'file_path']),
        oldString: p.oldString || '',
        newString: p.newString || '',
        streamingNew: !p.newComplete,
        streamingOld: !p.oldComplete && p.newString == null,
      }
    }
    if (isMultiEdit) {
      const p = parsePartialMultiEditInput(partialJson)
      const edits = p.edits.map((edit) => ({
        oldString: edit.oldString || '',
        newString: edit.newString || '',
      }))
      return {
        kind: 'multi-edit',
        filePath: p.filePath || pickString(input, ['filePath', 'file_path']),
        edits,
        editsCount: edits.length,
        streamingEditIndex: p.streamingEditIndex,
      }
    }
  }

  if (isWrite) {
    return {
      kind: 'write',
      filePath: pickString(input, ['filePath', 'file_path']),
      content: pickString(input, ['content', 'fileContents']),
      streaming: false,
    }
  }
  if (isMultiEdit) {
    // After streaming, expand every edit in `input.edits[]` into its
    // own diff section. Mirrors the way real diff viewers stack
    // hunks — keeps each change visible instead of collapsing N
    // edits into the trailing one.
    const all = pickAllMultiEdits(input)
    return {
      kind: 'multi-edit',
      filePath: pickString(input, ['filePath', 'file_path']),
      edits: all,
      editsCount: all.length,
      streamingEditIndex: -1,
    }
  }
  return {
    kind: 'edit',
    filePath: pickString(input, ['filePath', 'file_path']),
    oldString: pickString(input, ['oldString', 'old_string']),
    newString: pickString(input, ['newString', 'new_string']),
    streamingNew: false,
    streamingOld: false,
  }
}

const MULTI_EDIT_REVEAL_DELAY_MS = 34

function readPrefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * Time-slice multi-edit mounting so diff calculation and Monaco
 * colorization for a large batch are distributed across paints. The
 * progressive choice is sticky for this component instance: once a
 * live tool starts revealing cards, the final canonical input cannot
 * force the still-hidden remainder to jump in all at once.
 */
function useProgressiveRevealCount(
  targetCount: number,
  shouldAnimate: boolean,
): number {
  const [progressivelyReveal] = useState(
    () => shouldAnimate && !readPrefersReducedMotion(),
  )
  const [visibleCount, setVisibleCount] = useState(() =>
    progressivelyReveal ? Math.min(targetCount, 1) : targetCount,
  )

  useEffect(() => {
    if (visibleCount === targetCount) return
    const delay =
      progressivelyReveal && targetCount > visibleCount
        ? MULTI_EDIT_REVEAL_DELAY_MS
        : 0
    const timer = setTimeout(() => {
      setVisibleCount((current) =>
        getNextMultiEditVisibleCount(
          current,
          targetCount,
          progressivelyReveal,
        ),
      )
    }, delay)
    return () => clearTimeout(timer)
  }, [progressivelyReveal, targetCount, visibleCount])

  return Math.min(visibleCount, targetCount)
}

interface MultiEditSectionProps {
  editIndex: number
  oldString: string
  newString: string
  languageId: string
  streamingNew: boolean
}

/**
 * Completed sections are memoized so deltas for the active edit don't
 * rerun diff calculation or token lookup for every preceding card.
 */
const MultiEditSection = React.memo(function MultiEditSection({
  editIndex,
  oldString,
  newString,
  languageId,
  streamingNew,
}: MultiEditSectionProps) {
  return (
    <div
      className="wep-multi-edit-section"
      data-edit-index={editIndex}
      aria-label={`第 ${editIndex + 1} 处变更`}
    >
      <div className="wep-multi-edit-section-inner">
        <div className="wep-multi-edit-section-header">
          @@ 第 {editIndex + 1} 处变更 @@
        </div>
        <UnifiedDiffView
          oldText={oldString}
          newText={newString}
          languageId={languageId}
          streamingNew={streamingNew}
        />
      </div>
    </div>
  )
})

export const WriteEditProgressView: React.FC<Props> = ({
  toolName,
  input,
  streamingInput,
  status,
}) => {
  // Pull the buffer out of the optional-chain so React Compiler can
  // reason about its dependency identity for the surrounding renders.
  const partialJson = streamingInput?.partialJson
  const view = resolveView(toolName, input, partialJson)
  const languageId = inferLanguageId(view.filePath || '')
  const isRunning = status === 'running'
  const multiEditTargetCount = view.kind === 'multi-edit' ? view.edits.length : 0
  const visibleMultiEditCount = useProgressiveRevealCount(
    multiEditTargetCount,
    view.kind === 'multi-edit' && (isRunning || partialJson !== undefined),
  )

  // P2-6: while the model is still streaming, line counts shift on
  // every chunk and the meta string visibly flickers (e.g. "+3 / -1"
  // → "+4 / -1" → "+5 / -1" 20Hz). Show a stable "…" placeholder
  // while streaming and only render numbers once the args are final.
  const isStreamingAny =
    (view.kind === 'write' && view.streaming) ||
    (view.kind === 'edit' && (view.streamingNew || view.streamingOld)) ||
    (view.kind === 'multi-edit' && view.streamingEditIndex >= 0)

  if (view.kind === 'write') {
    return (
      <div className="wep-root">
        <div className="wep-header">
          <span className="wep-action">写入</span>
          <span className="wep-filepath" title={view.filePath}>
            {view.filePath || '(无路径)'}
          </span>
          <span className="wep-meta">
            {isStreamingAny || !view.content
              ? '…'
              : `${view.content.split('\n').length} 行`}
          </span>
        </div>
        <HighlightedCode
          text={view.content}
          languageId={languageId}
          streaming={view.streaming && isRunning}
          variant="added"
        />
      </div>
    )
  }

  if (view.kind === 'multi-edit') {
    const total = view.editsCount
    const headerCount = total > 0 ? `（${total} 处变更）` : ''
    return (
      <div className="wep-root">
        <div className="wep-header">
          <span className="wep-action">批量编辑</span>
          <span className="wep-filepath" title={view.filePath}>
            {view.filePath || '(无路径)'}
            {headerCount}
          </span>
          <span className="wep-meta">
            {renderMultiEditMeta(view.edits, isStreamingAny)}
          </span>
        </div>
        {view.edits.slice(0, visibleMultiEditCount).map((edit, i) => (
          <MultiEditSection
            key={`edit-${i}`}
            editIndex={i}
            oldString={edit.oldString}
            newString={edit.newString}
            languageId={languageId}
            streamingNew={view.streamingEditIndex === i && isRunning}
          />
        ))}
      </div>
    )
  }

  // edit_file — single-card inline unified diff (P3 / "the IDE"-style).
  return (
    <div className="wep-root">
      <div className="wep-header">
        <span className="wep-action">编辑</span>
        <span className="wep-filepath" title={view.filePath}>
          {view.filePath || '(无路径)'}
        </span>
        <span className="wep-meta">
          {renderEditMeta(view.oldString, view.newString, isStreamingAny)}
        </span>
      </div>
      <UnifiedDiffView
        oldText={view.oldString}
        newText={view.newString}
        languageId={languageId}
        streamingNew={view.streamingNew && isRunning}
      />
    </div>
  )
}

/**
 * Meta string for edit-style cards. Suppresses the +/- numbers while
 * the model is still streaming (they'd flicker on every chunk) and
 * also when either side is empty (e.g. first delta brought oldString
 * but newString hasn't started yet).
 */
function renderEditMeta(
  oldString: string,
  newString: string,
  isStreaming: boolean,
): string {
  if (isStreaming || (!oldString && !newString)) return '…'
  const oldLines = oldString.length === 0 ? 0 : oldString.split('\n').length
  const newLines = newString.length === 0 ? 0 : newString.split('\n').length
  return `+${newLines} / -${oldLines}`
}

/**
 * Aggregate `+N / -M` across every edit in the multi_edit_file array.
 * Suppresses the digits during streaming to avoid flicker, matching
 * the single-edit behaviour. When the user has only one edit
 * collapsed in this card (streaming partial case), delegates to
 * `renderEditMeta` so the displayed format is consistent.
 */
function renderMultiEditMeta(
  edits: Array<{ oldString: string; newString: string }>,
  isStreaming: boolean,
): string {
  if (isStreaming || edits.length === 0) return '…'
  let added = 0
  let removed = 0
  for (const e of edits) {
    added += e.newString.length === 0 ? 0 : e.newString.split('\n').length
    removed += e.oldString.length === 0 ? 0 : e.oldString.split('\n').length
  }
  return `+${added} / -${removed}`
}
