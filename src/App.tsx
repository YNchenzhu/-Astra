import React, { Component, useEffect, useLayoutEffect, useState } from 'react'
import { TitleBar } from './components/TitleBar/TitleBar'
// 主界面永远是 CodeWorkspaceLayout (完整 IDE)。Bundle 只决定"团队 +
// 项目路径",不再决定布局 —— 5 种 layout 方案被移除。切换 Bundle 由
// TitleBar 中间的 BundleSwitcher 下拉驱动(代替之前的顶部 tab 条)。
import { CodeWorkspaceLayout } from './components/Layout/CodeWorkspaceLayout'
import { StatusBar } from './components/StatusBar/StatusBar'
import { CommandPalette } from './components/CommandPalette/CommandPalette'
import { useLayoutStore } from './stores/useLayoutStore'
import { useSettingsStore } from './stores/useSettingsStore'
import { initializeTools } from './services/tools/initializeTools'
// LSP diagnostics glue — subscribes to the main-process DiagnosticsHub and
// drives ProblemsPanel + Monaco squigglies + StatusBar LSP badge. Without
// this call the backend runs but the renderer mirror stays empty.
import { initDiagnosticsSync } from './services/diagnosticsSync'
import { jumpToDiagnostic, focusProblemsPanel } from './services/diagnosticsNavigation'
// ---- DiffTransaction (P1–P4) integration ----
// DT renderer mirror + authoritative-sync hook + DevTools kill-switch; undo toast
// + audit panel UIs. Feature-gated via `useSettingsStore.diffPrecisionMode`: in
// `legacy` mode the sync hook is a no-op and toasts are not enqueued, so mounting
// unconditionally is safe. See `electron/diff/*` and `src/stores/diffTx*`.
import { useDiffTransactionStore } from './stores/useDiffTransactionStore'
import {
  installDiffPrecisionModeDevtoolsHook,
  useDiffTxAuthoritativeSync,
} from './stores/diffTxAuthoritativeSync'
import { UndoToastContainer } from './components/DiffToast/UndoToastContainer'
import { DtAuditPanel } from './components/DiffAudit/DtAuditPanel'
// BuddyCompanion (虚拟宠物 overlay) lives at the app root so it can hover
// over any panel. Lazy-loaded so the buddy sprites/canvas aren't paid for
// until the user turns it on from Settings → Buddy.
const BuddyCompanion = React.lazy(() =>
  import('./components/Buddy/BuddyCompanion').then((m) => ({ default: m.BuddyCompanion })),
)
// Settings dialog + Composer panel.
//
// SettingsDialog reads `showSettings` from useSettingsStore itself — so we mount it
// unconditionally and let it self-gate. Mounting it conditionally would be fine too,
// but unconditional mount preserves any internal component state (search query,
// active category) across open/close cycles, which matches VS Code-like UX.
//
// ComposerPanel takes an `onClose` prop; its visibility is tied to
// `useLayoutStore.composerVisible` which `ActivityBar` toggles via `toggleComposer`.
// We render it conditionally so the panel's entire subtree (file-pickers,
// instruction textarea, diff session state) is torn down when closed, avoiding
// stale state on reopen.
import { SettingsDialog } from './components/AIChat/SettingsDialog'
import { ComposerPanel } from './components/Composer/ComposerPanel'
// Workbench (Phase 2) — self-gates on `workbenchVisible` in useLayoutStore,
// so we can mount unconditionally. Returns `null` when hidden and mounts
// its own modal overlay when visible.
import { AgentWorkbench } from './components/Workbench/AgentWorkbench'
// Running Agents panel (Phase 3) — same self-gating pattern as Workbench.
import { RunningAgentsPanel } from './components/RunningAgents/RunningAgentsPanel'
// Bundle Gallery (Phase 3 Sprint 3.2) — card-style browser/manager.
import { BundleGallery } from './components/BundleGallery/BundleGallery'
import { MCPConnectionProvider } from './context/MCPConnectionContext'
import { useWorkspaceStore } from './stores/useWorkspaceStore'
import { useWorkspaceIndexStore } from './stores/useWorkspaceIndexStore'
import { useBuddyStore } from './stores/useBuddyStore'
import { flushAllPersistedConversationsForQuit } from './stores/useChatStore'
// Cron fire → main chat bridge. Lives at the App root (not ChatPanel) so
// scheduled prompts are consumed and executed even while the chat surface
// is closed — without this subscription, `ai:cron-fire` events from the
// main-process cron scheduler were silently dropped in the renderer.
import { ensureCronFireController } from './stores/chat/cronFireController'
import { isBrowserMode } from './services/h5/h5Connection'
import './styles/global.css'

/**
 * Remove the boot-time `#initial-splash` overlay once React has committed
 * its first frame. Safe to call any number of times — no-ops after first.
 * Shared by the normal success path (useLayoutEffect) and the ErrorBoundary,
 * so that a render-time crash still reveals the error UI instead of leaving
 * the user staring at "正在启动 星构Astra…" forever.
 */
function dismissInitialSplash(): void {
  const el = document.getElementById('initial-splash')
  if (!el) return
  el.classList.add('splash-hiding')
  // Fallback: drop the node immediately (CSS transition handles the fade).
  if (el.parentNode) el.parentNode.removeChild(el)
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class ErrorBoundary extends Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error) {
    // Clear the splash immediately so the fallback UI is visible. Touching
    // a DOM node outside React's managed tree (#initial-splash lives in
    // document.body, not #root) is safe during the render phase and has
    // no React-specific side effects.
    dismissInitialSplash()
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[App] Unhandled rendering error:', error, info.componentStack)
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          background: '#1e1e2e',
          color: '#cdd6f4',
          fontFamily: 'system-ui, sans-serif',
          gap: 16,
          padding: 40,
        }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>渲染出错</h2>
          <pre style={{
            maxWidth: 600,
            maxHeight: 200,
            overflow: 'auto',
            background: '#11111b',
            padding: 16,
            borderRadius: 8,
            fontSize: 12,
            color: '#f38ba8',
            whiteSpace: 'pre-wrap',
          }}>
            {this.state.error?.message || '未知错误'}
          </pre>
          <button
            onClick={this.handleReload}
            style={{
              padding: '8px 24px',
              borderRadius: 6,
              border: 'none',
              background: '#89b4fa',
              color: '#1e1e2e',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

const AppInner: React.FC = () => {
  // Per-field selectors: whole-store destructuring would re-render AppInner
  // whenever any layout flag changes (e.g. sidebar toggles in a child),
  // even though AppInner only needs composerVisible and a few actions.
  const composerVisible = useLayoutStore((s) => s.composerVisible)
  const setCommandPaletteVisible = useLayoutStore((s) => s.setCommandPaletteVisible)
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar)
  const toggleTerminal = useLayoutStore((s) => s.toggleTerminal)
  const toggleAIChat = useLayoutStore((s) => s.toggleAIChat)
  const toggleComposer = useLayoutStore((s) => s.toggleComposer)
  const openSidebarView = useLayoutStore((s) => s.openSidebarView)
  const requestFocusSearch = useLayoutStore((s) => s.requestFocusSearch)
  const theme = useSettingsStore((state) => state.theme)
  const loadSettings = useSettingsStore((state) => state.loadSettings)
  const bootstrapDiffTx = useDiffTransactionStore((state) => state.bootstrap)
  // Mount the Buddy overlay whenever the user has already opted in (enabled)
  // OR has previously hatched a companion (species set) so the persisted
  // Buddy persists across app restarts. Without checking `species`, the
  // overlay never re-appears on boot because `initialize()` used to live
  // inside `BuddyCompanion`'s mount effect — creating a chicken-and-egg
  // where `enabled` was never rehydrated from disk.
  const buddyEnabled = useBuddyStore((s) => s.enabled)
  const buddyHasSpecies = useBuddyStore((s) => s.species !== null)
  const buddyShowTeaser = useBuddyStore((s) => s.showTeaser)
  const initializeBuddy = useBuddyStore((s) => s.initialize)

  // P4e: DT audit panel. Opened via Ctrl+Shift+D, closed via Escape / backdrop.
  // Component state kept local — the panel is read-only so no global store needed.
  const [auditOpen, setAuditOpen] = useState(false)

  // P2: DT authoritative sync loop. Inert in `legacy` mode (no-op per-DT visitor).
  // Mounted unconditionally so the hook call order is stable across mode flips.
  useDiffTxAuthoritativeSync()

  useEffect(() => {
    void loadSettings()
    // Register renderer-side in-process teammate tools (A set, 4 class-based
    // ITool impls) at boot, and mirror them into the `useToolRegistry` zustand
    // store so Settings → Tools panel can list + toggle them immediately —
    // previously this was lazy on first teammate spawn, leaving the UI empty.
    initializeTools()
    // Subscribe to the main-process DiagnosticsHub. Without this call,
    // ProblemsPanel / Monaco marker painter / StatusBar LSP badge all stay
    // at zero even though the backend publishes diagnostics continuously.
    // Idempotent — safe to call multiple times.
    void initDiagnosticsSync()
    // Bootstrap the DT renderer mirror (pulls `diff-tx:request-snapshot`, then
    // subscribes to incremental broadcasts). Idempotent — the bootstrap fn
    // itself re-registers the listener safely on HMR reload. Also install a
    // DevTools-accessible kill-switch so `window.__setDiffPrecisionMode('legacy')`
    // can be used as an in-session panic button if `dt` mode misbehaves.
    void bootstrapDiffTx()
    installDiffPrecisionModeDevtoolsHook()

    // Rehydrate Buddy state from the main-process store. Previously this
    // lived inside `BuddyCompanion`'s `useEffect`, but the component is
    // gated on `buddyEnabled` so a disabled-on-disk → `initialize()` never
    // runs → persisted `enabled`/`species` never load → overlay stays
    // invisible forever. Driving it from the app root breaks the cycle.
    void initializeBuddy()

    // Subscribe to cron scheduler fires (`ai:cron-fire`). This is the missing
    // execution link of the cron system: on fire, the task prompt is submitted
    // through the main-chat send pipeline so the scheduled agent turn actually
    // runs. Idempotent — installs a single process-wide listener.
    ensureCronFireController()

    // Workspace-index progress listener. Mounted here (App root) rather than
    // inside EmbeddingPanel so that index builds keep streaming progress into
    // the global store even while the user navigates away from the Settings
    // panel. Without this move, unmounting the panel tore down the IPC
    // subscription and the UI looked like the build had stopped — even
    // though the main process was happily churning through chunks.
    const unsubWsIndex = useWorkspaceIndexStore.getState().subscribeProgress()

    // Register the "before-quit flush" handler so that main.ts can drive a
    // final persistence pass via `lifecycle:before-quit-flush` before the
    // process exits. Without this, unsaved chat conversation state could be
    // dropped on app close.
    const lifecycle = typeof window !== 'undefined'
      ? window.electronAPI?.lifecycle
      : undefined
    const unsubFlush = lifecycle?.setBeforeQuitFlushHandler(async () => {
      try {
        await flushAllPersistedConversationsForQuit()
      } catch (err) {
        console.error('[App] before-quit flush failed:', err)
      }
    })

    return () => {
      unsubWsIndex()
      unsubFlush?.()
    }
  }, [loadSettings, bootstrapDiffTx, initializeBuddy])

  // Refresh persisted workspace-index status whenever the workspace root
  // changes, so the StatusBar indicator reflects the right number of
  // indexed chunks after opening/closing folders.
  const workspaceRoot = useWorkspaceStore((s) => s.rootPath)
  const refreshIndexStatus = useWorkspaceIndexStore((s) => s.refreshStatus)
  useEffect(() => {
    if (!workspaceRoot) return
    void refreshIndexStatus(workspaceRoot)
  }, [workspaceRoot, refreshIndexStatus])

  /**
   * Boot-time splash handoff.
   *
   * `index.html` renders `#initial-splash` at `position:fixed; z-index:9999`
   * so the window shows "正在启动 星构Astra…" before any JS runs. That
   * splash lives **outside** `#root`, so `createRoot().render(...)` does
   * not clear it — we must remove it explicitly, otherwise it covers the
   * real UI forever (spinner keeps turning, main interface never appears).
   *
   * `useLayoutEffect` fires after React commits the first paint of the
   * real UI but *before* the browser paints the next frame, so the
   * sequence is: [splash visible] → [React committed] → [fade splash]
   * → [UI revealed]. No flicker.
   */
  useLayoutEffect(() => {
    const el = document.getElementById('initial-splash')
    if (!el) return
    el.classList.add('splash-hiding')
    let removed = false
    const drop = () => {
      if (removed || !el.parentNode) return
      removed = true
      el.removeEventListener('transitionend', drop)
      el.parentNode.removeChild(el)
    }
    el.addEventListener('transitionend', drop, { once: true })
    // Fallback: some browsers skip `transitionend` (reduced-motion,
    // backgrounded tab, CSS disabled) — drop the node after the nominal
    // 160ms transition + a buffer.
    const fallbackId = window.setTimeout(drop, 400)
    return () => {
      window.clearTimeout(fallbackId)
      el.removeEventListener('transitionend', drop)
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey

      if (mod && e.key === 'k') {
        e.preventDefault()
        setCommandPaletteVisible(true)
      } else if (mod && e.key === 'b') {
        e.preventDefault()
        toggleSidebar()
      } else if (mod && e.key === 'j') {
        e.preventDefault()
        toggleTerminal()
      } else if (mod && e.key === 'l') {
        e.preventDefault()
        toggleAIChat()
      } else if (mod && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
        // VS Code parity: Ctrl+Shift+M → focus Problems panel.
        e.preventDefault()
        focusProblemsPanel()
      } else if (mod && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        // VS Code parity: Ctrl+Shift+F → open the Search panel in the sidebar.
        // We use openSidebarView (force-open) rather than setSidebarView so
        // the shortcut is idempotent: pressing it twice doesn't toggle the
        // sidebar shut. requestFocusSearch bumps a nonce that the panel
        // watches via useEffect, so the second press of the shortcut also
        // grabs focus even when SearchPanel was already mounted.
        // Letting Monaco's Ctrl+F still win when the editor is focused is
        // intentional — that's the per-file find widget.
        e.preventDefault()
        openSidebarView('search')
        requestFocusSearch()
      } else if (e.key === 'F8') {
        // VS Code parity: F8 = next diagnostic, Shift+F8 = previous.
        // Ignore the mod state (mirrors VS Code's behaviour of accepting
        // F8 with any modifier combo as long as the key is F8).
        e.preventDefault()
        void jumpToDiagnostic(e.shiftKey ? 'prev' : 'next')
      } else if (mod && e.shiftKey && (e.key === 'd' || e.key === 'D')) {
        // P4e: Ctrl/Cmd+Shift+D toggles the DiffTransaction audit panel.
        // Uppercase `D` branch handles keyboards where Shift flips the key code.
        e.preventDefault()
        setAuditOpen((prev) => !prev)
      } else if (e.key === 'Escape') {
        setCommandPaletteVisible(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setCommandPaletteVisible, toggleSidebar, toggleTerminal, toggleAIChat, openSidebarView, requestFocusSearch])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const applyTheme = () => {
      const resolvedTheme = theme === 'system'
        ? (mediaQuery.matches ? 'dark' : 'light')
        : theme
      document.documentElement.setAttribute('data-theme', resolvedTheme)
    }

    applyTheme()

    if (theme !== 'system') {
      return
    }

    const handleChange = () => applyTheme()

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange)
      return () => mediaQuery.removeEventListener('change', handleChange)
    }

    mediaQuery.addListener(handleChange)
    return () => mediaQuery.removeListener(handleChange)
  }, [theme])

  // Browser / H5 (phone) mode: render a minimal chat-first shell — the full
  // desktop chrome (title bar, status bar, command palette, workbench, buddy,
  // diff/audit overlays) targets the Electron desktop and has no working
  // backend in a browser. CodeWorkspaceLayout itself collapses to just the
  // ChatPanel in browser mode.
  if (isBrowserMode()) {
    return (
      <div className="app-container">
        <CodeWorkspaceLayout />
        {/* SettingsDialog self-gates on `showSettings`; harmless to mount. */}
        <SettingsDialog />
      </div>
    )
  }

  return (
    <div className="app-container">
      <TitleBar />
      <CodeWorkspaceLayout />
      <StatusBar />
      <CommandPalette />
      {/* Settings dialog — self-gated on `showSettings` from useSettingsStore.
          ActivityBar's ⚙️ button flips that flag via `setShowSettings(true)`. */}
      <SettingsDialog />
      {/* Composer (inline-edit) panel — conditional on `composerVisible`.
          ActivityBar's Layers button flips that flag via `toggleComposer`.
          `onClose` invokes the same toggler so internal close affordances work. */}
      {composerVisible && <ComposerPanel onClose={toggleComposer} />}
      {/* Phase 2 Workbench — modal overlay for agent / team / bundle
          editing. Self-gated on `workbenchVisible`. ActivityBar's
          SlidersHorizontal button flips that flag via `toggleWorkbench`. */}
      <AgentWorkbench />
      {/* Phase 3 Running Agents panel — modal overlay showing the
          live ActiveAgent registry. Self-gated on
          `runningAgentsPanelVisible`. ActivityBar's Activity button
          flips that flag via `toggleRunningAgentsPanel`. */}
      <RunningAgentsPanel />
      {/* Phase 3 Sprint 3.2 Bundle Gallery — card-style bundle
          browser. Self-gated on `bundleGalleryVisible`. ActivityBar's
          PackageOpen button flips that flag. */}
      <BundleGallery />
      {/* P4c: Undo-after-Applied toast overlay. Self-hiding when no toasts active. */}
      <UndoToastContainer />
      {/* P4e: DiffTransaction audit panel. Toggled via Ctrl/Cmd+Shift+D. */}
      <DtAuditPanel open={auditOpen} onClose={() => setAuditOpen(false)} />
      {/* Virtual pet overlay. Mount when the user has enabled Buddy, has a
          hatched companion, or the onboarding teaser is active; in any of
          these cases a visible UI element (overlay, launch button, or
          teaser) is expected. Still gated so brand-new users who dismissed
          the teaser don't pay for BuddyCompanion. Wrapped in Suspense
          because it is React.lazy'd. */}
      {(buddyEnabled || buddyHasSpecies || buddyShowTeaser) ? (
        <React.Suspense fallback={null}>
          <BuddyCompanion />
        </React.Suspense>
      ) : null}
    </div>
  )
}

const App: React.FC = () => (
  <ErrorBoundary>
    <MCPConnectionProvider>
      <AppInner />
    </MCPConnectionProvider>
  </ErrorBoundary>
)

export default App
