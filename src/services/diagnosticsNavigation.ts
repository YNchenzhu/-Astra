/**
 * Keyboard-driven navigation through the diagnostics mirror.
 *
 *   F8       → next diagnostic (global, across all files)
 *   Shift+F8 → previous diagnostic
 *   Ctrl+Shift+M → focus the problems panel (terminal auto-open)
 *
 * Behaviour mirrors VS Code as closely as the current tab/jump capabilities
 * allow. Where the underlying {@link useFileStore} doesn't yet expose a
 * `pendingJump` channel (initial master snapshot doesn't), we degrade to
 * switching the active tab and updating the cursor position — Monaco will
 * read the new cursor coordinates from the editor mount glue on next focus.
 */

import type { TabInfo } from '../types'
import { useDiagnosticStore, type Diagnostic } from '../stores/useDiagnosticStore'
import { useFileStore } from '../stores/useFileStore'
import { useWorkspaceStore } from '../stores/useWorkspaceStore'
import { useLayoutStore } from '../stores/useLayoutStore'
import {
  isSamePath,
  joinWorkspaceRelative,
  toRelativePath,
} from './pathUtils'

type Direction = 'next' | 'prev'

function sortedAllDiagnostics(): Diagnostic[] {
  const all = useDiagnosticStore.getState().diagnostics.slice()
  all.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    if (a.line !== b.line) return a.line - b.line
    return a.column - b.column
  })
  return all
}

function currentCursorFile(): { file: string; line: number; column: number } | null {
  const fileStore = useFileStore.getState()
  const tab = fileStore.tabs.find((t) => t.id === fileStore.activeTabId)
  if (!tab) return null
  const rootPath = useWorkspaceStore.getState().rootPath
  const absolute = joinWorkspaceRelative(rootPath, tab.path)
  return { file: absolute, line: fileStore.cursorLine, column: fileStore.cursorColumn }
}

function comparePosition(
  a: { file: string; line: number; column: number },
  b: { file: string; line: number; column: number },
): number {
  if (!isSamePath(a.file, b.file)) return a.file < b.file ? -1 : 1
  if (a.line !== b.line) return a.line - b.line
  return a.column - b.column
}

function findTabForAbsolutePath(
  tabs: TabInfo[],
  absolutePath: string,
  rootPath: string | null,
): TabInfo | undefined {
  const targetAbs = absolutePath
  const targetRel = rootPath ? toRelativePath(absolutePath, rootPath) : absolutePath
  return tabs.find((t) => {
    if (isSamePath(t.path, targetRel)) return true
    if (isSamePath(t.path, targetAbs)) return true
    const tabAbs = rootPath ? joinWorkspaceRelative(rootPath, t.path) : t.path
    return isSamePath(tabAbs, targetAbs)
  })
}

/**
 * Try to nudge the active editor to the given (1-based) line/column.
 * Prefers the store's `requestJump`-style action when available (newer builds),
 * falls back to `setCursorPosition` as a best-effort signal.
 */
function requestEditorJump(line: number, column: number): void {
  const state = useFileStore.getState() as unknown as Record<string, unknown>
  const jumpFn = state.requestJump
  if (typeof jumpFn === 'function') {
    ;(jumpFn as (line: number, column: number) => void)(line, column)
    return
  }
  const setCursor = state.setCursorPosition
  if (typeof setCursor === 'function') {
    ;(setCursor as (line: number, column: number) => void)(line, column)
  }
}

export async function jumpToDiagnostic(direction: Direction): Promise<void> {
  const all = sortedAllDiagnostics()
  if (all.length === 0) return
  const cursor = currentCursorFile()

  let target: Diagnostic | undefined
  if (!cursor) {
    target = direction === 'next' ? all[0] : all[all.length - 1]
  } else if (direction === 'next') {
    target = all.find((d) => comparePosition(d, cursor) > 0) ?? all[0]
  } else {
    for (let i = all.length - 1; i >= 0; i--) {
      if (comparePosition(all[i], cursor) < 0) {
        target = all[i]
        break
      }
    }
    target = target ?? all[all.length - 1]
  }

  if (!target) return

  const layout = useLayoutStore.getState()
  if (!layout.terminalVisible) layout.toggleTerminal()
  layout.setActiveTerminalTab('problems')

  const fileStore = useFileStore.getState()
  const rootPath = useWorkspaceStore.getState().rootPath
  const existing = findTabForAbsolutePath(fileStore.tabs, target.file, rootPath)
  if (existing) {
    fileStore.setActiveTab(existing.id)
  } else {
    const fileName = target.fileName || target.file.split(/[\\/]/).pop() || target.file
    const ext = fileName.split('.').pop()?.toLowerCase() || ''
    const langMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      json: 'json',
      md: 'markdown',
      css: 'css',
      html: 'html',
      py: 'python',
      rs: 'rust',
      go: 'go',
      java: 'java',
      sh: 'shell',
      yml: 'yaml',
      yaml: 'yaml',
    }
    let content = ''
    try {
      const res = await window.electronAPI?.fs.readFile(target.file)
      if (res?.success && res.content) content = res.content
    } catch {
      /* ignore */
    }
    fileStore.openFile({
      id: `diag-nav-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: fileName,
      path: rootPath ? toRelativePath(target.file, rootPath) : target.file,
      language: langMap[ext] || 'plaintext',
      content,
      isModified: false,
    })
  }
  requestEditorJump(target.line, target.column)
}

export function focusProblemsPanel(): void {
  const layout = useLayoutStore.getState()
  if (!layout.terminalVisible) layout.toggleTerminal()
  layout.setActiveTerminalTab('problems')
}
