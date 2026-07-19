import { create } from 'zustand'
import type { SidebarView } from '../types'
import {
  LAYOUT_AI_CHAT_HEIGHT_FALLBACK_MAX_PX,
  LAYOUT_AI_CHAT_HEIGHT_VIEWPORT_RESERVE_PX,
  LAYOUT_AI_CHAT_MAX_WIDTH_PX,
  LAYOUT_AI_CHAT_MIN_HEIGHT_PX,
  LAYOUT_AI_CHAT_MIN_WIDTH_PX,
  LAYOUT_DEFAULT_AI_CHAT_WIDTH_PX,
  LAYOUT_DEFAULT_SIDEBAR_WIDTH_PX,
  LAYOUT_DEFAULT_TERMINAL_HEIGHT_PX,
  LAYOUT_SIDEBAR_MAX_WIDTH_PX,
  LAYOUT_SIDEBAR_MIN_WIDTH_PX,
  LAYOUT_TERMINAL_HEIGHT_FALLBACK_MAX_PX,
  LAYOUT_TERMINAL_HEIGHT_VIEWPORT_RESERVE_PX,
  LAYOUT_TERMINAL_MIN_HEIGHT_PX,
} from '../constants/layoutConstraints'

/** Apply persisted zoom to the document (store remains source of truth). */
export function applyZoomLevelToBody(zoomLevel: number): void {
  if (typeof document === 'undefined') return
  document.body.style.zoom = zoomLevel === 100 ? '1' : `${zoomLevel / 100}`
  // Notify Monaco editors to re-measure font after CSS zoom change.
  window.dispatchEvent(new CustomEvent('app:zoom-changed', { detail: { zoomLevel } }))
}

export interface TerminalInstance {
  id: number
  label: string
  cwd: string
}

interface LayoutState {
  sidebarVisible: boolean
  sidebarView: SidebarView
  sidebarWidth: number
  aiChatVisible: boolean
  aiChatWidth: number
  aiChatHeight: number | null
  terminalVisible: boolean
  terminalHeight: number
  commandPaletteVisible: boolean
  activeTerminalTab: 'terminal' | 'problems' | 'output' | 'debug'
  composerVisible: boolean
  /**
   * Workbench (Agent / Team / Bundle editor) — Phase 2 of the personal-
   * workspace plan. Rendered as a modal overlay; mutually exclusive
   * with nothing (it can coexist with any main-UI state but traps
   * focus while open). See `src/components/Workbench/AgentWorkbench.tsx`.
   */
  workbenchVisible: boolean
  /**
   * Running Agents panel — Phase 3 Sprint 3.1a. Same modal-overlay
   * pattern as Workbench. Toggled by the Activity icon in ActivityBar.
   */
  runningAgentsPanelVisible: boolean
  /**
   * Bundle Gallery — Phase 3 Sprint 3.2. Browse / activate / manage
   * bundles card-style. Toggled by the PackageOpen icon in ActivityBar.
   */
  bundleGalleryVisible: boolean
  /**
   * Optional "open workbench at this selection" intent. Consumed by
   * AgentWorkbench on its first render after becoming visible, then
   * cleared. Used by the Gallery's "在工作台编辑" action to jump the
   * user straight to a specific bundle / agent / team without them
   * needing to re-navigate.
   *
   * Setting `kind: 'bundle-meta'` lands on the bundle overview;
   * narrower kinds ('agent' / 'team') could be added later.
   */
  workbenchInitialSelection:
    | { kind: 'bundle-meta'; bundleId: string }
    | { kind: 'agent'; bundleId: string; agentType: string }
    | { kind: 'team'; bundleId: string; teamId: string }
    | null
  /**
   * Workbench's try-run drawer — Phase 3 Sprint 2d.a. When set, a
   * slide-in panel over the right column lets the user talk to the
   * currently-edited agent in a sandbox. Cleared by closing the
   * drawer or switching to a different agent selection.
   */
  tryRunDrawerTarget:
    | { bundleId: string; agentType: string }
    | null
  zoomLevel: number
  terminalInstances: TerminalInstance[]
  activeTerminalId: number | null

  toggleSidebar: () => void
  setSidebarView: (view: SidebarView) => void
  /** Force the sidebar open at the given view. Unlike `setSidebarView`,
   *  re-selecting the current view does NOT toggle the sidebar closed —
   *  intended for menu / shortcut triggers that always mean "open this". */
  openSidebarView: (view: SidebarView) => void
  /** Monotonic counter; bump it to ask the SearchPanel to focus its
   *  input. Using a nonce instead of a boolean covers the case where
   *  the panel is already mounted (view='search') — a fresh boolean
   *  set to `true` while the previous value was already `true` would
   *  not re-fire the effect. The panel reads this via a `useEffect`
   *  dependency, so mount also triggers one focus. */
  focusSearchNonce: number
  requestFocusSearch: () => void
  setSidebarWidth: (width: number) => void
  toggleAIChat: () => void
  toggleComposer: () => void
  toggleWorkbench: () => void
  setWorkbenchVisible: (visible: boolean) => void
  toggleRunningAgentsPanel: () => void
  setRunningAgentsPanelVisible: (visible: boolean) => void
  toggleBundleGallery: () => void
  setBundleGalleryVisible: (visible: boolean) => void
  /** Set (overrides) the "jump into workbench at this" intent.
   *  AgentWorkbench consumes + clears it on mount. */
  setWorkbenchInitialSelection: (
    sel: LayoutState['workbenchInitialSelection'],
  ) => void
  /** Open / close the try-run drawer. `null` closes. */
  setTryRunDrawerTarget: (target: LayoutState['tryRunDrawerTarget']) => void
  setAIChatWidth: (width: number) => void
  setAIChatHeight: (height: number | null) => void
  toggleTerminal: () => void
  setTerminalHeight: (height: number) => void
  setCommandPaletteVisible: (visible: boolean) => void
  setActiveTerminalTab: (tab: 'terminal' | 'problems' | 'output' | 'debug') => void
  addTerminalInstance: (instance: TerminalInstance) => void
  removeTerminalInstance: (id: number) => void
  /** Drop all terminal tabs (e.g. panel teardown); does not kill PTYs — renderer must close sessions first. */
  clearTerminalInstances: () => void
  setActiveTerminalId: (id: number) => void
  renameTerminalInstance: (id: number, label: string) => void
  zoomIn: () => void
  zoomOut: () => void
  zoomReset: () => void
}

export const useLayoutStore = create<LayoutState>((set) => ({
  sidebarVisible: true,
  sidebarView: 'explorer',
  sidebarWidth: LAYOUT_DEFAULT_SIDEBAR_WIDTH_PX,
  aiChatVisible: false,
  aiChatWidth: LAYOUT_DEFAULT_AI_CHAT_WIDTH_PX,
  aiChatHeight: null,
  terminalVisible: true,
  terminalHeight: LAYOUT_DEFAULT_TERMINAL_HEIGHT_PX,
  commandPaletteVisible: false,
  composerVisible: false,
  workbenchVisible: false,
  runningAgentsPanelVisible: false,
  bundleGalleryVisible: false,
  workbenchInitialSelection: null,
  tryRunDrawerTarget: null,
  activeTerminalTab: 'terminal',
  terminalInstances: [],
  activeTerminalId: null,
  zoomLevel: 100,
  focusSearchNonce: 0,

  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  setSidebarView: (view) => set((s) => {
    if (s.sidebarView === view) return { sidebarVisible: !s.sidebarVisible }
    return { sidebarView: view, sidebarVisible: true }
  }),
  openSidebarView: (view) => set({ sidebarView: view, sidebarVisible: true }),
  requestFocusSearch: () => set((s) => ({ focusSearchNonce: s.focusSearchNonce + 1 })),
  setSidebarWidth: (width) =>
    set({ sidebarWidth: Math.max(LAYOUT_SIDEBAR_MIN_WIDTH_PX, Math.min(LAYOUT_SIDEBAR_MAX_WIDTH_PX, width)) }),
  toggleAIChat: () => set((s) => ({ aiChatVisible: !s.aiChatVisible })),
  toggleComposer: () => set((s) => ({ composerVisible: !s.composerVisible })),
  toggleWorkbench: () => set((s) => ({ workbenchVisible: !s.workbenchVisible })),
  setWorkbenchVisible: (visible) => set({ workbenchVisible: visible }),
  toggleRunningAgentsPanel: () =>
    set((s) => ({ runningAgentsPanelVisible: !s.runningAgentsPanelVisible })),
  setRunningAgentsPanelVisible: (visible) => set({ runningAgentsPanelVisible: visible }),
  toggleBundleGallery: () =>
    set((s) => ({ bundleGalleryVisible: !s.bundleGalleryVisible })),
  setBundleGalleryVisible: (visible) => set({ bundleGalleryVisible: visible }),
  setWorkbenchInitialSelection: (sel) => set({ workbenchInitialSelection: sel }),
  setTryRunDrawerTarget: (target) => set({ tryRunDrawerTarget: target }),
  setAIChatWidth: (width) =>
    set({ aiChatWidth: Math.max(LAYOUT_AI_CHAT_MIN_WIDTH_PX, Math.min(LAYOUT_AI_CHAT_MAX_WIDTH_PX, width)) }),
  setAIChatHeight: (height) => set((_state) => {
    if (height === null) return { aiChatHeight: null }
    const upperBound =
      typeof window !== 'undefined'
        ? Math.max(LAYOUT_AI_CHAT_MIN_HEIGHT_PX, window.innerHeight - LAYOUT_AI_CHAT_HEIGHT_VIEWPORT_RESERVE_PX)
        : LAYOUT_AI_CHAT_HEIGHT_FALLBACK_MAX_PX
    return { aiChatHeight: Math.max(LAYOUT_AI_CHAT_MIN_HEIGHT_PX, Math.min(upperBound, height)) }
  }),
  toggleTerminal: () => set((s) => ({ terminalVisible: !s.terminalVisible })),
  setTerminalHeight: (height) => {
    const maxH =
      typeof window !== 'undefined'
        ? window.innerHeight - LAYOUT_TERMINAL_HEIGHT_VIEWPORT_RESERVE_PX
        : LAYOUT_TERMINAL_HEIGHT_FALLBACK_MAX_PX
    return set({
      terminalHeight: Math.max(LAYOUT_TERMINAL_MIN_HEIGHT_PX, Math.min(maxH, height)),
    })
  },
  setCommandPaletteVisible: (visible) => set({ commandPaletteVisible: visible }),
  setActiveTerminalTab: (tab) => set({ activeTerminalTab: tab }),
  addTerminalInstance: (instance) => set((s) => ({
    terminalInstances: [...s.terminalInstances, instance],
    activeTerminalId: instance.id,
  })),
  removeTerminalInstance: (id) => set((s) => {
    const next = s.terminalInstances.filter((t) => t.id !== id)
    const activeId = s.activeTerminalId === id
      ? (next.length > 0 ? next[next.length - 1].id : null)
      : s.activeTerminalId
    return { terminalInstances: next, activeTerminalId: activeId }
  }),
  clearTerminalInstances: () => set({ terminalInstances: [], activeTerminalId: null }),
  setActiveTerminalId: (id) => set({ activeTerminalId: id }),
  renameTerminalInstance: (id, label) => set((s) => ({
    terminalInstances: s.terminalInstances.map((t) => t.id === id ? { ...t, label } : t),
  })),
  zoomIn: () => set((s) => {
    const zoomLevel = Math.min(200, s.zoomLevel + 10)
    applyZoomLevelToBody(zoomLevel)
    return { zoomLevel }
  }),
  zoomOut: () => set((s) => {
    const zoomLevel = Math.max(50, s.zoomLevel - 10)
    applyZoomLevelToBody(zoomLevel)
    return { zoomLevel }
  }),
  zoomReset: () => {
    applyZoomLevelToBody(100)
    return set({ zoomLevel: 100 })
  },
}))
