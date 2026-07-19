import { create } from 'zustand'
import type { TabInfo } from '../types'
import { onWorkspaceFileChanged, readFile, writeFile } from '../services/fileSystem'
import { getOpenBehavior } from '../services/openBehavior'
import {
  isAbsolutePath,
  joinWorkspaceRelative,
  normalizePath,
  toRelativePath,
  toWorkspaceAbsoluteFilePath,
} from '../services/pathUtils'
import { useWorkspaceStore } from './useWorkspaceStore'
import { useSettingsStore } from './useSettingsStore'
import { refreshMarkersForModelPath } from '../services/monacoDiagnostics'
import { notifyLspDocumentClose, notifyLspDocumentSave } from '../services/lspDocumentSync'

let untitledCounter = 0

/**
 * Same path identity rules as {@link useFileStore.openFile}: relative vs absolute, workspace root, suffix match.
 * Use this anywhere the UI needs to know if a file is already open (AI events, search, Problems, etc.).
 */
export function findTabForWorkspacePath(
  tabs: TabInfo[],
  incomingPath: string,
  rootPath: string | null,
): TabInfo | undefined {
  const incomingKey = normalizePath(toWorkspaceAbsoluteFilePath(incomingPath, rootPath))
  if (!incomingKey) return undefined

  return tabs.find((t) => {
    const tabKey = normalizePath(toWorkspaceAbsoluteFilePath(t.path, rootPath))
    return tabKey === incomingKey
  })
}

/**
 * True when two path strings refer to the same workspace file
 * (same identity rules as {@link findTabForWorkspacePath}).
 */
export function workspacePathsReferToSameFile(
  pathA: string,
  pathB: string,
  rootPath: string | null,
): boolean {
  const probe: TabInfo = {
    id: '__path-probe__',
    path: pathA,
    name: '',
    language: 'plaintext',
    content: '',
    isModified: false,
  }
  return findTabForWorkspacePath([probe], pathB, rootPath) !== undefined
}

// ===== Pending Change (inline diff) =====

export interface PendingChange {
  id: string
  filePath: string
  normalizedPath?: string
  /** File content BEFORE the AI edit (used as diff "original") */
  originalContent: string
  /** File content AFTER the AI edit (used as diff "modified") */
  modifiedContent: string
  /** Which agentic tool call produced this change */
  toolUseId: string
  toolName: 'write_file' | 'edit_file'
  timestamp: number
  /** Link back to the permission request (for resolving accept/reject) */
  requestId?: string
  /** Destructive-change hints from the agent (e.g. clearing entire file). */
  riskWarnings?: string[]
}

interface FileState {
  tabs: TabInfo[]
  activeTabId: string | null
  cursorLine: number
  cursorColumn: number
  pendingJump: { line: number; column: number } | null

  // Pending changes for inline diff
  pendingChanges: Map<string, PendingChange>

  openFile: (tab: TabInfo) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  updateTabContent: (tabId: string, content: string) => void
  /** Replace buffer from disk/tool write; clears dirty flag (unlike updateTabContent). */
  syncTabContentFromDisk: (tabId: string, content: string, diagnosticsAbsolutePath?: string) => void
  markTabSaved: (tabId: string, savedContent?: string) => void
  setCursorPosition: (line: number, column: number) => void
  requestJump: (line: number, column: number) => void
  clearPendingJump: () => void
  newFile: () => void
  /** Give an untitled tab a real disk identity after a "Save As" write. */
  retargetTabAfterSaveAs: (tabId: string, params: { path: string; name: string; language: string }) => void

  // Inline diff actions
  addPendingChange: (change: PendingChange) => void
  setPendingChanges: (changes: Map<string, PendingChange>) => void
  acceptPendingChange: (filePath: string) => Promise<void>
  rejectPendingChange: (filePath: string) => Promise<void>
  clearAllPendingChanges: () => void
  getPendingChangeForFile: (filePath: string) => PendingChange | undefined

  // Global accept/reject all changes across ALL pending files
  acceptAllChanges: (respondToPermissionRequest?: (params: { requestId: string; behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown> }) => Promise<boolean>) => Promise<void>
  rejectAllChanges: (respondToPermissionRequest?: (params: { requestId: string; behavior: 'allow' | 'deny' }) => Promise<boolean>) => Promise<void>

  syncTabsAfterTreeDelete: (relativePath: string, isDirectory: boolean) => void
  syncTabsAfterTreeRename: (
    oldRelative: string,
    newRelative: string,
    newBaseName: string,
    isDirectory: boolean,
  ) => void

  /** Close all tabs and pending diffs when switching to another workspace folder. */
  resetForWorkspaceChange: () => void
}

function triggerDiagnosticsRefreshForPath(filePath: string): void {
  refreshMarkersForModelPath(filePath)
}

function absolutePathForLspTab(tab: TabInfo, rootPath: string | null): string | null {
  if (!rootPath || tab.path.startsWith('untitled')) return null
  return isAbsolutePath(tab.path) ? tab.path.replace(/\\/g, '/') : joinWorkspaceRelative(rootPath, tab.path)
}

export const useFileStore = create<FileState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  cursorLine: 1,
  cursorColumn: 1,
  pendingJump: null,
  pendingChanges: new Map(),

  openFile: (tab) =>
    set((s) => {
      const rootPath = useWorkspaceStore.getState().rootPath
      const exists = findTabForWorkspacePath(s.tabs, tab.path, rootPath)
      if (exists) return { activeTabId: exists.id }
      // Seed the disk baseline so the autosave conflict guard can tell apart a
      // user-only edit from an external (AI) write. A freshly opened, unmodified
      // tab has buffer === disk, so `content` is the correct baseline.
      const seeded: TabInfo =
        tab.diskContent === undefined && !tab.isModified
          ? { ...tab, diskContent: tab.content }
          : tab
      return { tabs: [...s.tabs, seeded], activeTabId: seeded.id }
    }),

  closeTab: (tabId) => {
    const s = get()
    const closing = s.tabs.find((t) => t.id === tabId)
    const rootPath = useWorkspaceStore.getState().rootPath
    let closeLspPath: string | null = null
    if (closing && rootPath && !closing.path.startsWith('untitled')) {
      closeLspPath = isAbsolutePath(closing.path)
        ? closing.path
        : joinWorkspaceRelative(rootPath, closing.path)
    }
    set(() => {
      const newTabs = s.tabs.filter((t) => t.id !== tabId)
      let newActiveId = s.activeTabId
      if (s.activeTabId === tabId) {
        const idx = s.tabs.findIndex((t) => t.id === tabId)
        newActiveId = newTabs[Math.min(idx, newTabs.length - 1)]?.id || null
      }
      return { tabs: newTabs, activeTabId: newActiveId }
    })
    if (closeLspPath) notifyLspDocumentClose(closeLspPath)
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  updateTabContent: (tabId, content) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, content, isModified: true } : t
      ),
    })),

  syncTabContentFromDisk: (tabId, content, diagnosticsAbsolutePath) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        // Buffer is now equal to disk → both `content` and the baseline track it.
        t.id === tabId ? { ...t, content, isModified: false, diskContent: content } : t
      ),
    }))
    if (diagnosticsAbsolutePath) {
      triggerDiagnosticsRefreshForPath(diagnosticsAbsolutePath)
    }
  },

  markTabSaved: (tabId, savedContent) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        // The buffer was just persisted to disk, so the on-disk baseline now
        // equals the bytes we wrote. Callers write `tab.content`, so default
        // the baseline to the current buffer when an explicit value is omitted.
        t.id === tabId
          ? { ...t, isModified: false, diskContent: savedContent ?? t.content }
          : t
      ),
    })),

  setCursorPosition: (line, column) => set({ cursorLine: line, cursorColumn: column }),
  requestJump: (line, column) => set({ pendingJump: { line, column } }),
  clearPendingJump: () => set({ pendingJump: null }),

  newFile: () =>
    set((s) => {
      untitledCounter++
      const tab: TabInfo = {
        id: `untitled-${untitledCounter}-${Date.now()}`,
        name: `Untitled-${untitledCounter}`,
        path: `untitled-${untitledCounter}`,
        language: 'plaintext',
        content: '',
        isModified: false,
      }
      return { tabs: [...s.tabs, tab], activeTabId: tab.id }
    }),

  retargetTabAfterSaveAs: (tabId, { path, name, language }) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? // The buffer was just written to `path`, so disk === buffer.
            { ...t, path, name, language, isModified: false, diskContent: t.content }
          : t,
      ),
    })),

  // ===== Inline diff actions =====

  addPendingChange: (change) =>
    set((s) => {
      const next = new Map(s.pendingChanges)
      const normalizedPath = normalizePath(change.filePath)
      next.set(normalizedPath, {
        ...change,
        normalizedPath,
      })
      return { pendingChanges: next }
    }),

  setPendingChanges: (changes) => set({ pendingChanges: changes }),

  acceptPendingChange: async (filePath) => {
    const { pendingChanges, tabs } = get()
    const normalizedFilePath = normalizePath(filePath)
    const change = pendingChanges.get(normalizedFilePath)
    if (!change) return

    const next = new Map(pendingChanges)
    next.delete(normalizedFilePath)

    const rootPath = useWorkspaceStore.getState().rootPath
    const tab = findTabForWorkspacePath(tabs, filePath, rootPath)

    const updatedTabs = tab
      ? tabs.map((t) =>
          t.id === tab.id
            ? {
                ...t,
                content: change.modifiedContent,
                isModified: false,
                diskContent: change.modifiedContent,
              }
            : t,
        )
      : tabs

    set({ pendingChanges: next, tabs: updatedTabs })
    triggerDiagnosticsRefreshForPath(filePath)
    const lspPath = tab ? absolutePathForLspTab(tab, rootPath) : toWorkspaceAbsoluteFilePath(filePath, rootPath)
    if (lspPath) notifyLspDocumentSave(lspPath)
  },

  rejectPendingChange: async (filePath) => {
    const { pendingChanges, tabs } = get()
    const normalizedFilePath = normalizePath(filePath)
    const change = pendingChanges.get(normalizedFilePath)
    if (!change) return

    const rootPath = useWorkspaceStore.getState().rootPath
    const pathForWrite = rootPath ? toRelativePath(change.filePath, rootPath) : change.filePath

    const next = new Map(pendingChanges)
    next.delete(normalizedFilePath)

    const tab = findTabForWorkspacePath(tabs, filePath, rootPath)
    const updatedTabs = tab
      ? tabs.map((t) =>
          t.id === tab.id
            ? {
                ...t,
                content: change.originalContent,
                isModified: false,
                diskContent: change.originalContent,
              }
            : t,
        )
      : tabs

    set({ pendingChanges: next, tabs: updatedTabs })

    try {
      await writeFile(pathForWrite, change.originalContent)
    } catch (err) {
      console.error('[useFileStore] Failed to revert file:', err)
    }
  },

  clearAllPendingChanges: () => set({ pendingChanges: new Map() }),

  getPendingChangeForFile: (filePath) => get().pendingChanges.get(normalizePath(filePath)),

  acceptAllChanges: async (respondToPermissionRequest) => {
    const { pendingChanges, tabs } = get()
    if (pendingChanges.size === 0) {
      return
    }
    const rootPath = useWorkspaceStore.getState().rootPath

    // Resolve all permission requests first
    for (const change of pendingChanges.values()) {
      if (change.requestId && respondToPermissionRequest) {
        try {
          await respondToPermissionRequest({
            requestId: change.requestId,
            behavior: 'allow',
            updatedInput: {
              filePath: change.filePath,
              file_path: change.filePath,
              content: change.modifiedContent,
            },
          })
        } catch (err) {
          console.error('[useFileStore] Failed to accept change:', change.filePath, err)
        }
      }
    }

    // Update all affected tabs
    const updatedTabs = tabs.map((t) => {
      for (const change of pendingChanges.values()) {
        if (findTabForWorkspacePath([t], change.filePath, rootPath)) {
          return {
            ...t,
            content: change.modifiedContent,
            isModified: false,
            diskContent: change.modifiedContent,
          }
        }
      }
      return t
    })

    set({ pendingChanges: new Map(), tabs: updatedTabs })
    for (const change of pendingChanges.values()) {
      triggerDiagnosticsRefreshForPath(change.filePath)
      const tab = findTabForWorkspacePath(updatedTabs, change.filePath, rootPath)
      const lspPath = tab ? absolutePathForLspTab(tab, rootPath) : toWorkspaceAbsoluteFilePath(change.filePath, rootPath)
      if (lspPath) notifyLspDocumentSave(lspPath)
    }
  },

  rejectAllChanges: async (respondToPermissionRequest) => {
    const { pendingChanges, tabs } = get()
    if (pendingChanges.size === 0) {
      return
    }
    const rootPath = useWorkspaceStore.getState().rootPath

    // Revert all files to original content
    for (const change of pendingChanges.values()) {
      try {
        const pathForWrite = rootPath ? toRelativePath(change.filePath, rootPath) : change.filePath
        await writeFile(pathForWrite, change.originalContent)
      } catch (err) {
        console.error('[useFileStore] Failed to revert file:', change.filePath, err)
      }

      if (change.requestId && respondToPermissionRequest) {
        try {
          await respondToPermissionRequest({
            requestId: change.requestId,
            behavior: 'deny',
          })
        } catch (err) {
          console.error('[useFileStore] Failed to reject change:', change.filePath, err)
        }
      }
    }

    // Update all affected tabs
    const updatedTabs = tabs.map((t) => {
      for (const change of pendingChanges.values()) {
        if (findTabForWorkspacePath([t], change.filePath, rootPath)) {
          return {
            ...t,
            content: change.originalContent,
            isModified: false,
            diskContent: change.originalContent,
          }
        }
      }
      return t
    })

    set({ pendingChanges: new Map(), tabs: updatedTabs })
    for (const change of pendingChanges.values()) {
      const tab = findTabForWorkspacePath(updatedTabs, change.filePath, rootPath)
      const lspPath = tab ? absolutePathForLspTab(tab, rootPath) : toWorkspaceAbsoluteFilePath(change.filePath, rootPath)
      if (lspPath) notifyLspDocumentSave(lspPath)
    }
  },

  syncTabsAfterTreeDelete: (relativePath, isDirectory) => {
    const rootPath = useWorkspaceStore.getState().rootPath
    const norm = normalizePath(relativePath.replace(/\\/g, '/'))

    set((s) => {
      const toClose = s.tabs.filter((t) => {
        const tp = normalizePath(t.path.replace(/\\/g, '/'))
        if (isDirectory) {
          return tp === norm || tp.startsWith(`${norm}/`)
        }
        return tp === norm
      }).map((t) => t.id)

      const newTabs = s.tabs.filter((t) => !toClose.includes(t.id))
      let newActiveId = s.activeTabId
      if (s.activeTabId && toClose.includes(s.activeTabId)) {
        const idx = s.tabs.findIndex((t) => t.id === s.activeTabId)
        newActiveId = newTabs[Math.min(idx, newTabs.length - 1)]?.id || null
      }

      const nextPending = new Map(s.pendingChanges)
      for (const [k, change] of nextPending.entries()) {
        const rel = rootPath ? toRelativePath(change.filePath, rootPath) : change.filePath
        const tr = normalizePath(rel.replace(/\\/g, '/'))
        const drop =
          isDirectory ? tr === norm || tr.startsWith(`${norm}/`) : tr === norm
        if (drop) nextPending.delete(k)
      }

      return { tabs: newTabs, activeTabId: newActiveId, pendingChanges: nextPending }
    })
  },

  syncTabsAfterTreeRename: (oldRelative, newRelative, newBaseName, isDirectory) => {
    const rootPath = useWorkspaceStore.getState().rootPath
    const o = normalizePath(oldRelative.replace(/\\/g, '/'))

    set((s) => {
      const matchesOld = (tabPath: string) => {
        const tp = normalizePath(tabPath.replace(/\\/g, '/'))
        if (tp === o) return true
        // Fallback: compare absolute forms when one side is absolute and the other relative.
        if (rootPath) {
          const absTab = normalizePath(toWorkspaceAbsoluteFilePath(tabPath, rootPath))
          const absOld = normalizePath(toWorkspaceAbsoluteFilePath(oldRelative, rootPath))
          return absTab === absOld
        }
        return false
      }
      const newTabs = s.tabs.map((t) => {
        const tp = normalizePath(t.path.replace(/\\/g, '/'))
        if (!isDirectory) {
          if (matchesOld(t.path)) {
            return { ...t, path: newRelative, name: newBaseName }
          }
          return t
        }
        if (matchesOld(t.path)) {
          return { ...t, path: newRelative, name: newBaseName }
        }
        if (tp.startsWith(`${o}/`)) {
          const rest = t.path.slice(oldRelative.length).replace(/^[/\\]/, '')
          const newPath = rest ? `${newRelative}/${rest}` : newRelative
          const segments = newPath.split(/[/\\]/).filter(Boolean)
          const leafName = segments[segments.length - 1] || t.name
          return { ...t, path: newPath, name: leafName }
        }
        return t
      })

      const nextPending = new Map<string, PendingChange>()
      for (const [mapKey, change] of s.pendingChanges.entries()) {
        const rel = rootPath ? toRelativePath(change.filePath, rootPath) : change.filePath
        const tr = normalizePath(rel.replace(/\\/g, '/'))
        let newAbs = change.filePath
        if (!isDirectory && tr === o) {
          newAbs = joinWorkspaceRelative(rootPath, newRelative)
        } else if (isDirectory && (tr === o || tr.startsWith(`${o}/`))) {
          const suffix = tr === o ? '' : rel.replace(/\\/g, '/').slice(oldRelative.length).replace(/^\//, '')
          newAbs = joinWorkspaceRelative(rootPath, suffix ? `${newRelative}/${suffix}` : newRelative)
        } else {
          nextPending.set(mapKey, change)
          continue
        }
        const nk = normalizePath(newAbs)
        nextPending.set(nk, {
          ...change,
          filePath: newAbs,
          normalizedPath: nk,
        })
      }

      return { tabs: newTabs, pendingChanges: nextPending }
    })
  },

  resetForWorkspaceChange: () =>
    set({
      tabs: [],
      activeTabId: null,
      pendingChanges: new Map(),
      pendingJump: null,
      cursorLine: 1,
      cursorColumn: 1,
    }),
}))

let unsubscribeWorkspaceFileChanged: (() => void) | null = null

function ensureWorkspaceFileChangedSubscription(): void {
  if (typeof window === 'undefined' || unsubscribeWorkspaceFileChanged) return

  unsubscribeWorkspaceFileChanged = onWorkspaceFileChanged((payload) => {
    void (async () => {
      const rootPath = useWorkspaceStore.getState().rootPath
      if (!rootPath || normalizePath(payload.workspacePath) !== normalizePath(rootPath)) return
      if (payload.changeType !== 'change') return

      const state = useFileStore.getState()
      const tab = findTabForWorkspacePath(state.tabs, payload.filePath, rootPath)
      if (!tab || tab.path.startsWith('untitled')) return
      // 图片/文档预览类标签页内容恒为空(查看器自读二进制并自带
      // 文件变更重载),UTF-8 刷新只会把乱码灌进 store —— 跳过。
      if (getOpenBehavior(tab.name) !== 'text') return
      const diskRefreshMode = useSettingsStore.getState().externalDiskChangeRefreshMode
      if (tab.isModified && diskRefreshMode !== 'always_reload') return
      if (state.getPendingChangeForFile(payload.filePath)) return

      try {
        const text = await readFile(payload.filePath)
        const abs = normalizePath(payload.filePath)
        state.syncTabContentFromDisk(tab.id, text, abs)
      } catch (err) {
        console.warn('[useFileStore] External file refresh skipped:', payload.relativePath, err)
      }
    })()
  })
}

ensureWorkspaceFileChangedSubscription()

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeWorkspaceFileChanged?.()
    unsubscribeWorkspaceFileChanged = null
  })
}
