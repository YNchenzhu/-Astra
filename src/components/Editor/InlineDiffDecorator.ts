import type * as monaco from 'monaco-editor'
import {
  type DiffHunk,
  type RuntimeHunkState,
  computeDiff,
  buildDiffDecorations,
  buildGhostNode,
  createHunkButtons,
  navigateHunk,
  focusAfterResolve,
} from '../../services/diff'
import { INLINE_DIFF_REVEAL_FALLBACK_MS } from '../../constants/appTiming'
import { focusEditorIfIdle } from '../../services/editorFocusGuard'

// Re-export DiffHunk so existing consumers keep working
export type { DiffHunk } from '../../services/diff'

/**
 * Module-level counter tracking in-flight programmatic edits fired by this
 * decorator (initial `setValue(modifiedContent)`, accept/reject-hunk
 * `applyEdits`, full-file `rejectAll` `setValue`, etc.).
 *
 * Monaco's `model.setValue` / `model.applyEdits` trigger `onDidChangeContent`
 * synchronously, which `@monaco-editor/react` forwards to our `onChange`
 * prop. Without this suppression the decorator's programmatic content swap
 * was being mis-attributed to the user: `handleEditorChange` would call
 * `updateTabContent(activeTabId, value)`, flip the tab to `isModified: true`,
 * and the 1.5s autosave timer then wrote the decorator's (unapproved) diff
 * payload straight to disk under the tab's own path. That destroyed the
 * contents of whichever file happened to be the active tab at the time —
 * even when the user only clicked "Accept" on an unrelated, newly-created
 * file.
 *
 * Callers MUST pair every increment with a decrement; use the provided
 * `runWithSuppressedOnChange` helper to guarantee that via try/finally.
 */
let programmaticEditDepth = 0

export function isInlineDiffDecoratorEditInFlight(): boolean {
  return programmaticEditDepth > 0
}

/**
 * Run `fn` with `handleEditorChange` suppression active. Exported so other
 * diff-UI code (e.g. `InlineDiffController`'s accept/reject model sync and
 * its unmount revert) can piggy-back on the same suppression window without
 * re-inventing the counter. ALWAYS pair via try/finally — `runWithSuppressedOnChange`
 * already does this; direct callers should prefer this helper.
 */
export function runWithSuppressedOnChange<T>(fn: () => T): T {
  programmaticEditDepth++
  try {
    return fn()
  } finally {
    programmaticEditDepth--
  }
}

interface HunkZone {
  id: string
  domNode: HTMLElement
  viewZoneId: string | null
}

export class InlineDiffDecorator {
  private editor: monaco.editor.IStandaloneCodeEditor
  private decorations: string[] = []
  private hunkZones: HunkZone[] = []
  private hunks: DiffHunk[] = []
  private runtimeState: Map<string, RuntimeHunkState> = new Map()
  private originalContent: string
  private modifiedContent: string
  private acceptedHunks: Set<string> = new Set()
  private rejectedHunks: Set<string> = new Set()
  private focusedHunkId: string | null = null
  private disposed = false
  private wasReadOnly = false
  private revealFallbackTimer: ReturnType<typeof setTimeout> | null = null

  onAcceptHunk?: (hunkId: string) => void
  onRejectHunk?: (hunkId: string) => void
  onAllResolved?: () => void
  onFocusChange?: (meta: { hunkId: string | null; index: number; total: number }) => void

  constructor(
    editor: monaco.editor.IStandaloneCodeEditor,
    originalContent: string,
    modifiedContent: string,
  ) {
    this.editor = editor
    this.originalContent = originalContent
    this.modifiedContent = modifiedContent
  }

  apply(): void {
    if (this.disposed) return

    this.wasReadOnly = this.editor.getOption(/* readOnly */ 90) as unknown as boolean
    this.editor.updateOptions({ readOnly: true })

    const model = this.editor.getModel()
    if (model && model.getValue() !== this.modifiedContent) {
      runWithSuppressedOnChange(() => model.setValue(this.modifiedContent))
    }

    const diffResult = computeDiff(this.originalContent, this.modifiedContent)
    this.hunks = diffResult.hunks
    this.runtimeState = new Map(
      this.hunks.map((h) => [
        h.id,
        { currentStartLine: h.modStartLine, currentEndLine: h.modEndLine },
      ]),
    )

    const unresolved = this.getUnresolvedHunks()
    this.focusedHunkId = unresolved[0]?.id ?? null

    this.applyDecorations()
    this.addViewZones()
    this.emitFocusChange()

    // Delay before reveal to allow Monaco internal layout to settle after setValue
    if (this.focusedHunkId) {
      setTimeout(() => {
        if (!this.disposed) {
          this.scheduleRevealFocusedHunk()
        }
      }, 150)
    }

    // Ensure the editor has focus so keyboard shortcuts (Ctrl+Enter etc.)
    // work against the just-attached diff — but DON'T steal focus when the
    // user is actively typing into a different surface (Settings → Rules,
    // chat composer, command palette, …). `apply()` is called right after
    // the AI produces a pending change, which can easily race with the user
    // editing an unrelated input; yanking their keystrokes into the edited
    // file is exactly the bug we're guarding against.
    focusEditorIfIdle(this.editor)
  }

  updateContents(originalContent: string, modifiedContent: string): void {
    if (this.disposed) return
    if (this.originalContent === originalContent && this.modifiedContent === modifiedContent) return

    this.originalContent = originalContent
    this.modifiedContent = modifiedContent
    this.acceptedHunks.clear()
    this.rejectedHunks.clear()

    const model = this.editor.getModel()
    this.editor.updateOptions({ readOnly: true })
    if (model && model.getValue() !== this.modifiedContent) {
      runWithSuppressedOnChange(() => model.setValue(this.modifiedContent))
    }

    const diffResult = computeDiff(this.originalContent, this.modifiedContent)
    this.hunks = diffResult.hunks
    this.runtimeState = new Map(
      this.hunks.map((h) => [
        h.id,
        { currentStartLine: h.modStartLine, currentEndLine: h.modEndLine },
      ]),
    )

    const unresolved = this.getUnresolvedHunks()
    this.focusedHunkId = unresolved[0]?.id ?? null
    this.refresh()

    if (this.focusedHunkId) {
      this.scheduleRevealFocusedHunk()
    }
  }

  // ── Unresolved helpers ──────────────────────────────────

  private getUnresolvedHunks(): DiffHunk[] {
    return this.hunks.filter(
      (h) => !this.acceptedHunks.has(h.id) && !this.rejectedHunks.has(h.id),
    )
  }

  private emitFocusChange(): void {
    const unresolved = this.getUnresolvedHunks()
    if (unresolved.length === 0) {
      this.onFocusChange?.({ hunkId: null, index: 0, total: 0 })
      return
    }
    const idx = this.focusedHunkId
      ? unresolved.findIndex((h) => h.id === this.focusedHunkId)
      : -1
    if (idx === -1) {
      this.focusedHunkId = unresolved[0].id
      this.onFocusChange?.({ hunkId: this.focusedHunkId, index: 1, total: unresolved.length })
      return
    }
    this.onFocusChange?.({ hunkId: this.focusedHunkId, index: idx + 1, total: unresolved.length })
  }

  // ── Decorations — delegated to shared DiffDecorationManager ──

  private applyDecorations(): void {
    const ctx = {
      focusedHunkId: this.focusedHunkId,
      acceptedHunks: this.acceptedHunks,
      rejectedHunks: this.rejectedHunks,
      runtimeState: this.runtimeState,
    }
    const newDecorations = buildDiffDecorations(this.hunks, ctx)
    this.decorations = this.editor.deltaDecorations(this.decorations, newDecorations)
  }

  // ── ViewZones (ghost zones for deleted lines) ───────────

  private addViewZones(): void {
    this.removeViewZones()

    this.editor.changeViewZones((accessor) => {
      for (const hunk of this.hunks) {
        if (this.acceptedHunks.has(hunk.id) || this.rejectedHunks.has(hunk.id)) continue

        const state = this.runtimeState.get(hunk.id)
        if (!state) continue

        const isFocused = this.focusedHunkId === hunk.id

        if (hunk.type === 'delete' || hunk.type === 'modify') {
          const ghostNode = buildGhostNode(
            hunk,
            isFocused,
            () => { this.focusHunkById(hunk.id); this.acceptHunk(hunk.id) },
            () => { this.focusHunkById(hunk.id); this.rejectHunk(hunk.id) },
          )

          const afterLineNumber =
            state.currentStartLine === 0 ? 0 : state.currentStartLine
          const lineCount = hunk.originalLines.length

          const ghostZoneId = accessor.addZone({
            afterLineNumber,
            afterColumn: 1,
            heightInLines: lineCount + (hunk.type === 'delete' ? 0.6 : 0),
            domNode: ghostNode,
            suppressMouseDown: false,
          })

          this.hunkZones.push({
            id: `${hunk.id}-ghost`,
            domNode: ghostNode,
            viewZoneId: ghostZoneId,
          })
        }

        if (hunk.type !== 'delete') {
          const btnNode = document.createElement('div')
          btnNode.className = 'inline-diff-hunk-actions-inline'
          btnNode.appendChild(
            createHunkButtons(
              isFocused,
              () => { this.focusHunkById(hunk.id); this.acceptHunk(hunk.id) },
              () => { this.focusHunkById(hunk.id); this.rejectHunk(hunk.id) },
            ),
          )

          const btnZoneId = accessor.addZone({
            afterLineNumber: state.currentEndLine,
            afterColumn: 1,
            heightInLines: 0.01,
            domNode: btnNode,
            suppressMouseDown: false,
          })
          this.hunkZones.push({ id: `${hunk.id}-btn`, domNode: btnNode, viewZoneId: btnZoneId })
        }
      }
    })
  }

  private removeViewZones(): void {
    if (this.hunkZones.length === 0) return
    this.editor.changeViewZones((accessor) => {
      for (const zone of this.hunkZones) {
        if (zone.viewZoneId) accessor.removeZone(zone.viewZoneId)
      }
    })
    this.hunkZones = []
  }

  // ── Focus management ────────────────────────────────────

  private updateFocusAfterResolve(resolvedHunkId: string): void {
    this.focusedHunkId = focusAfterResolve(
      resolvedHunkId,
      this.focusedHunkId,
      this.getUnresolvedHunks(),
    )
    this.emitFocusChange()
    if (this.focusedHunkId) {
      this.editor.layout()
      this.revealFocusedHunk()
    }
  }

  /**
   * Scroll after flex/toolbars + Monaco automaticLayout settle — a single rAF often runs too early.
   */
  private scheduleRevealFocusedHunk(): void {
    if (this.revealFallbackTimer !== null) {
      clearTimeout(this.revealFallbackTimer)
      this.revealFallbackTimer = null
    }

    const run = () => {
      if (this.disposed) return
      this.editor.layout()
      this.revealFocusedHunk()
    }

    // Triple rAF + microtask to ensure Monaco has fully processed setValue + layout
    queueMicrotask(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(run)
        })
      })
    })

    this.revealFallbackTimer = setTimeout(run, INLINE_DIFF_REVEAL_FALLBACK_MS)
  }

  private revealFocusedHunk(): void {
    if (!this.focusedHunkId) return

    const hunk = this.hunks.find((h) => h.id === this.focusedHunkId)
    const state = hunk ? this.runtimeState.get(hunk.id) : undefined
    if (!hunk || !state) return

    const model = this.editor.getModel()

    if (hunk.type === 'delete') {
      let lineNumber = Math.max(1, state.currentStartLine)
      if (model) {
        const lc = model.getLineCount()
        if (lc < 1) return
        lineNumber = Math.min(lineNumber, lc)
      }
      this.editor.revealLineInCenter(lineNumber)
      return
    }

    const startLine = Math.max(1, state.currentStartLine + 1)
    const endLine = Math.max(startLine, state.currentEndLine)
    if (model) {
      const lineCount = model.getLineCount()
      if (lineCount < 1) return
      // Runtime hunk lines can lag behind the buffer after edits/refresh; Monaco throws on OOB lineNumber.
      const safeStart = Math.min(Math.max(1, startLine), lineCount)
      const safeEnd = Math.min(Math.max(safeStart, endLine), lineCount)
      this.editor.revealRangeInCenter({
        startLineNumber: safeStart,
        startColumn: 1,
        endLineNumber: safeEnd,
        endColumn: model.getLineMaxColumn(safeEnd),
      })
    } else {
      this.editor.revealLineInCenter(startLine)
    }
  }

  focusNextUnresolved(direction: 1 | -1): boolean {
    const unresolvedHunks = this.getUnresolvedHunks()
    const nextId = navigateHunk({ focusedHunkId: this.focusedHunkId, unresolvedHunks }, direction)
    if (!nextId) return false

    this.focusedHunkId = nextId
    this.refresh()
    this.editor.layout()
    this.revealFocusedHunk()
    return true
  }

  focusHunkById(hunkId: string): boolean {
    const unresolved = this.getUnresolvedHunks()
    if (!unresolved.some((h) => h.id === hunkId)) return false

    this.focusedHunkId = hunkId
    this.refresh()
    this.editor.layout()
    this.revealFocusedHunk()
    return true
  }

  acceptFocusedHunk(): boolean {
    if (!this.focusedHunkId) return false
    this.acceptHunk(this.focusedHunkId)
    return true
  }

  rejectFocusedHunk(): boolean {
    if (!this.focusedHunkId) return false
    this.rejectHunk(this.focusedHunkId)
    return true
  }

  // ── Accept / Reject logic ──────────────────────────────

  acceptHunk(hunkId: string): void {
    if (this.acceptedHunks.has(hunkId) || this.rejectedHunks.has(hunkId)) return

    this.acceptedHunks.add(hunkId)
    this.onAcceptHunk?.(hunkId)
    this.updateFocusAfterResolve(hunkId)
    this.refresh()
    this.checkAllResolved()
  }

  /**
   * Re-insert deleted original lines into the modified buffer for a delete-type hunk.
   * `state.currentStartLine` matches DiffHunk.modStartLine (0-based line index before the gap).
   * When it is 0, the gap is before the first modified line — insert at document start (1,1).
   * Otherwise insert after the end of Monaco line `currentStartLine` (still 1-based indexing for the API).
   */
  private applyRejectForDeleteHunk(
    model: monaco.editor.ITextModel,
    state: RuntimeHunkState,
    hunk: DiffHunk,
  ): void {
    const linesText = hunk.originalLines.join('\n')
    const gapAfterZeroBased = state.currentStartLine

    if (gapAfterZeroBased === 0) {
      runWithSuppressedOnChange(() =>
        model.applyEdits([
          {
            range: {
              startLineNumber: 1,
              startColumn: 1,
              endLineNumber: 1,
              endColumn: 1,
            },
            text: `${linesText}\n`,
          },
        ]),
      )
      return
    }

    const anchorMonacoLine = Math.max(1, gapAfterZeroBased)
    const colAfterAnchor = model.getLineMaxColumn(anchorMonacoLine)
    runWithSuppressedOnChange(() =>
      model.applyEdits([
        {
          range: {
            startLineNumber: anchorMonacoLine,
            startColumn: colAfterAnchor,
            endLineNumber: anchorMonacoLine,
            endColumn: colAfterAnchor,
          },
          text: `\n${linesText}`,
        },
      ]),
    )
  }

  rejectHunk(hunkId: string): void {
    const hunk = this.hunks.find((h) => h.id === hunkId)
    const state = this.runtimeState.get(hunkId)
    if (!hunk || !state) return

    const model = this.editor.getModel()
    if (!model) return

    this.editor.updateOptions({ readOnly: false })

    const startLine = state.currentStartLine + 1
    const endLine = state.currentEndLine
    const replacementText = hunk.originalLines.join('\n')

    if (hunk.type === 'delete') {
      this.applyRejectForDeleteHunk(model, state, hunk)
    } else if (hunk.type === 'add') {
      const rangeStart = startLine
      const rangeEnd = endLine
      const endCol = model.getLineMaxColumn(rangeEnd)
      const removeRange =
        rangeStart === 1
          ? {
              startLineNumber: 1,
              startColumn: 1,
              endLineNumber: rangeEnd + 1 <= model.getLineCount() ? rangeEnd + 1 : rangeEnd,
              endColumn: rangeEnd + 1 <= model.getLineCount() ? 1 : endCol,
            }
          : {
              startLineNumber: rangeStart - 1,
              startColumn: model.getLineMaxColumn(rangeStart - 1),
              endLineNumber: rangeEnd,
              endColumn: endCol,
            }

      runWithSuppressedOnChange(() =>
        model.applyEdits([{ range: removeRange, text: '' }]),
      )
    } else {
      runWithSuppressedOnChange(() =>
        model.applyEdits([
          {
            range: {
              startLineNumber: startLine,
              startColumn: 1,
              endLineNumber: endLine,
              endColumn: model.getLineMaxColumn(endLine),
            },
            text: replacementText,
          },
        ]),
      )
    }

    this.editor.updateOptions({ readOnly: true })

    const oldSpan = state.currentEndLine - state.currentStartLine
    const newSpan = hunk.type === 'add' ? 0 : hunk.originalLines.length
    const delta = newSpan - oldSpan

    this.runtimeState.set(hunkId, {
      currentStartLine: state.currentStartLine,
      currentEndLine: state.currentStartLine + newSpan,
    })

    if (delta !== 0) {
      for (const other of this.hunks) {
        if (other.id === hunkId) continue
        if (this.acceptedHunks.has(other.id) || this.rejectedHunks.has(other.id)) continue

        const otherState = this.runtimeState.get(other.id)
        if (!otherState) continue

        if (otherState.currentStartLine >= state.currentEndLine) {
          this.runtimeState.set(other.id, {
            currentStartLine: otherState.currentStartLine + delta,
            currentEndLine: otherState.currentEndLine + delta,
          })
        }
      }
    }

    this.rejectedHunks.add(hunkId)
    this.onRejectHunk?.(hunkId)
    this.updateFocusAfterResolve(hunkId)
    this.refresh()
    this.checkAllResolved()
  }

  // ── Bulk operations ─────────────────────────────────────

  acceptAll(): void {
    for (const hunk of this.hunks) {
      if (!this.acceptedHunks.has(hunk.id) && !this.rejectedHunks.has(hunk.id)) {
        this.acceptedHunks.add(hunk.id)
      }
    }
    this.focusedHunkId = null
    this.refresh()
    this.onAllResolved?.()
  }

  rejectAll(): void {
    const model = this.editor.getModel()
    if (model) {
      this.editor.updateOptions({ readOnly: false })
      runWithSuppressedOnChange(() => model.setValue(this.originalContent))
      this.editor.updateOptions({ readOnly: true })
    }

    for (const hunk of this.hunks) {
      if (!this.rejectedHunks.has(hunk.id)) {
        this.rejectedHunks.add(hunk.id)
        this.onRejectHunk?.(hunk.id)
      }
    }

    this.focusedHunkId = null
    this.refresh()
    this.checkAllResolved()
  }

  // ── Refresh ─────────────────────────────────────────────

  private refresh(): void {
    this.applyDecorations()
    this.removeViewZones()
    this.addViewZones()
    this.emitFocusChange()
  }

  private checkAllResolved(): void {
    const allResolved = this.hunks.every(
      (h) => this.acceptedHunks.has(h.id) || this.rejectedHunks.has(h.id),
    )
    if (allResolved && this.hunks.length > 0) {
      this.editor.updateOptions({ readOnly: this.wasReadOnly })
      this.onAllResolved?.()
    }
  }

  // ── Query helpers ───────────────────────────────────────

  getStats(): { added: number; removed: number; hunks: number } {
    let added = 0
    let removed = 0
    for (const hunk of this.hunks) {
      added += hunk.modifiedLines.length
      removed += hunk.originalLines.length
    }
    return { added, removed, hunks: this.hunks.length }
  }

  getCurrentContent(): string {
    return this.editor.getModel()?.getValue() || ''
  }

  getUnresolvedCount(): number {
    return this.getUnresolvedHunks().length
  }

  getFocusMeta(): { hunkId: string | null; index: number; total: number } {
    const unresolved = this.getUnresolvedHunks()
    if (unresolved.length === 0) return { hunkId: null, index: 0, total: 0 }
    if (!this.focusedHunkId) return { hunkId: unresolved[0].id, index: 1, total: unresolved.length }

    const idx = unresolved.findIndex((h) => h.id === this.focusedHunkId)
    if (idx === -1) return { hunkId: unresolved[0].id, index: 1, total: unresolved.length }
    return { hunkId: this.focusedHunkId, index: idx + 1, total: unresolved.length }
  }

  // ── Dispose ─────────────────────────────────────────────

  dispose(): void {
    this.disposed = true
    if (this.revealFallbackTimer !== null) {
      clearTimeout(this.revealFallbackTimer)
      this.revealFallbackTimer = null
    }
    this.decorations = this.editor.deltaDecorations(this.decorations, [])
    this.removeViewZones()
    const model = this.editor.getModel()
    const hadUnresolved = this.hunks.some(
      (h) => !this.acceptedHunks.has(h.id) && !this.rejectedHunks.has(h.id),
    )
    if (model && hadUnresolved) {
      this.editor.updateOptions({ readOnly: false })
      runWithSuppressedOnChange(() => model.setValue(this.originalContent))
    }
    this.editor.updateOptions({ readOnly: this.wasReadOnly })
  }
}
