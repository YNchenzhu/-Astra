// Monaco decoration management for diff visualization.
// Manages green/red line backgrounds, gutter indicators, and character-level highlights.
// Shared by all three Diff modes.

import type * as monaco from 'monaco-editor'
import type { DiffHunk, CharRange } from './DiffModel'
import { computeCharDiff } from './DiffComputationService'

export interface RuntimeHunkState {
  currentStartLine: number
  currentEndLine: number
}

export interface DecorationContext {
  focusedHunkId: string | null
  acceptedHunks: Set<string>
  rejectedHunks: Set<string>
  runtimeState: Map<string, RuntimeHunkState>
}

/**
 * Build Monaco decoration descriptors for a set of diff hunks.
 * Pure function — does not touch the editor, just returns the decoration array.
 */
export function buildDiffDecorations(
  hunks: DiffHunk[],
  ctx: DecorationContext,
): monaco.editor.IModelDeltaDecoration[] {
  const decorations: monaco.editor.IModelDeltaDecoration[] = []

  for (const hunk of hunks) {
    if (ctx.acceptedHunks.has(hunk.id) || ctx.rejectedHunks.has(hunk.id)) continue
    if (hunk.type === 'delete') continue

    const state = ctx.runtimeState.get(hunk.id)
    if (!state) continue

    const startLine = state.currentStartLine + 1
    const endLine = state.currentEndLine
    const isFocused = ctx.focusedHunkId === hunk.id

    for (let line = startLine; line <= endLine; line++) {
      decorations.push({
        range: {
          startLineNumber: line,
          startColumn: 1,
          endLineNumber: line,
          endColumn: Number.MAX_SAFE_INTEGER,
        },
        options: {
          isWholeLine: true,
          className: isFocused
            ? 'inline-diff-added-line inline-diff-active-line'
            : 'inline-diff-added-line',
          glyphMarginClassName: 'inline-diff-glyph-added',
          linesDecorationsClassName: 'inline-diff-line-decoration-added',
          overviewRuler: {
            color: isFocused ? '#60a5fa' : '#22c55e',
            position: 2,
          },
        },
      })
    }

    if (hunk.type === 'modify') {
      const pairCount = Math.min(hunk.originalLines.length, hunk.modifiedLines.length)
      for (let p = 0; p < pairCount; p++) {
        const { newRanges } = computeCharDiff(hunk.originalLines[p], hunk.modifiedLines[p])
        const lineNum = startLine + p
        for (const range of newRanges) {
          decorations.push({
            range: {
              startLineNumber: lineNum,
              startColumn: range.startCol,
              endLineNumber: lineNum,
              endColumn: range.endCol,
            },
            options: {
              inlineClassName: 'inline-diff-char-added',
            },
          })
        }
      }
    }
  }

  return decorations
}

/**
 * Apply decorations to an editor, replacing previous decorations.
 */
export function applyDecorations(
  editor: monaco.editor.IStandaloneCodeEditor,
  oldDecorations: string[],
  hunks: DiffHunk[],
  ctx: DecorationContext,
): string[] {
  const newDecorations = buildDiffDecorations(hunks, ctx)
  return editor.deltaDecorations(oldDecorations, newDecorations)
}

/**
 * Clear all diff decorations from the editor.
 */
export function clearDecorations(
  editor: monaco.editor.IStandaloneCodeEditor,
  oldDecorations: string[],
): string[] {
  return editor.deltaDecorations(oldDecorations, [])
}

// ── Ghost DOM builders (for ViewZone deleted lines) ────────

export function buildGhostNode(
  hunk: DiffHunk,
  isFocused: boolean,
  onAccept?: () => void,
  onReject?: () => void,
): HTMLElement {
  const ghostNode = document.createElement('div')
  ghostNode.className = isFocused
    ? 'inline-diff-deleted-ghost active'
    : 'inline-diff-deleted-ghost'

  for (let i = 0; i < hunk.originalLines.length; i++) {
    const wrapper = document.createElement('div')
    wrapper.className = 'inline-diff-deleted-line-wrapper'

    const lineNumEl = document.createElement('span')
    lineNumEl.className = 'inline-diff-deleted-line-number'
    lineNumEl.textContent = String(hunk.origStartLine + i + 1)

    const prefixEl = document.createElement('span')
    prefixEl.className = 'inline-diff-deleted-prefix'
    prefixEl.textContent = '−'

    const lineEl = document.createElement('span')
    lineEl.className = 'inline-diff-deleted-line-content'

    if (hunk.type === 'modify' && i < hunk.modifiedLines.length) {
      const { oldRanges } = computeCharDiff(hunk.originalLines[i], hunk.modifiedLines[i])
      lineEl.appendChild(buildHighlightedDeletedLine(hunk.originalLines[i], oldRanges))
    } else {
      lineEl.textContent = hunk.originalLines[i] || '\u00A0'
    }

    wrapper.appendChild(lineNumEl)
    wrapper.appendChild(prefixEl)
    wrapper.appendChild(lineEl)
    ghostNode.appendChild(wrapper)
  }

  if (hunk.type === 'delete' && onAccept && onReject) {
    const btnRow = document.createElement('div')
    btnRow.className = 'inline-diff-ghost-btn-row'
    btnRow.appendChild(createHunkButtons(isFocused, onAccept, onReject))
    ghostNode.appendChild(btnRow)
  }

  return ghostNode
}

function buildHighlightedDeletedLine(text: string, ranges: CharRange[]): DocumentFragment {
  const frag = document.createDocumentFragment()
  if (ranges.length === 0 || !text) {
    frag.appendChild(document.createTextNode(text || '\u00A0'))
    return frag
  }

  let cursor = 0
  for (const r of ranges) {
    const start = r.startCol - 1
    const end = r.endCol - 1

    if (cursor < start) {
      frag.appendChild(document.createTextNode(text.slice(cursor, start)))
    }

    const highlight = document.createElement('span')
    highlight.className = 'inline-diff-char-deleted'
    highlight.textContent = text.slice(start, end)
    frag.appendChild(highlight)

    cursor = end
  }

  if (cursor < text.length) {
    frag.appendChild(document.createTextNode(text.slice(cursor)))
  }

  return frag
}

export function createHunkButtons(
  isFocused: boolean,
  onAccept: () => void,
  onReject: () => void,
): HTMLElement {
  // NOTE on accessibility: these buttons live inside a Monaco view-zone whose
  // parent `<div.view-zones>` is marked `aria-hidden="true"` by Monaco itself.
  // Previously we mirrored that attribute onto our container + buttons, but
  // when the user clicked a button Chromium would still focus it, producing
  // the console warning:
  //   "Blocked aria-hidden on an element because its descendant retained focus."
  // The robust fix is to prevent the button from receiving focus on click
  // (via `mousedown.preventDefault()`) while keeping `tabIndex = -1` so they
  // are not reachable via Tab either. With neither `aria-hidden` nor focus
  // on our element, the only violation left would be Monaco's outer zone,
  // which also disappears because the focused descendant is gone. We also
  // replace the tooltip-only labels with `aria-label` so any AT that *does*
  // reach them (e.g. users who turn off Monaco's zone-hiding) still gets a
  // meaningful announcement.
  const btnContainer = document.createElement('div')
  btnContainer.className = isFocused
    ? 'inline-diff-hunk-buttons active'
    : 'inline-diff-hunk-buttons'

  const acceptBtn = document.createElement('button')
  acceptBtn.className = 'inline-diff-btn-small accept'
  acceptBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>'
  acceptBtn.title = '接受此更改 (Ctrl/Cmd+Y)'
  acceptBtn.setAttribute('aria-label', '接受此更改')
  acceptBtn.tabIndex = -1
  acceptBtn.addEventListener('mousedown', (e) => {
    // Stop the browser from transferring focus to this button on click — we
    // only want the `click` side-effect, not focus.
    e.preventDefault()
  })
  acceptBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    onAccept()
  })

  const rejectBtn = document.createElement('button')
  rejectBtn.className = 'inline-diff-btn-small reject'
  rejectBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
  rejectBtn.title = '拒绝此更改 (Ctrl/Cmd+N)'
  rejectBtn.setAttribute('aria-label', '拒绝此更改')
  rejectBtn.tabIndex = -1
  rejectBtn.addEventListener('mousedown', (e) => {
    e.preventDefault()
  })
  rejectBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    onReject()
  })

  btnContainer.appendChild(acceptBtn)
  btnContainer.appendChild(rejectBtn)
  return btnContainer
}
