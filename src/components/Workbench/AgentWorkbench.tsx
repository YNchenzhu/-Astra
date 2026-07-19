/**
 * AgentWorkbench — Phase 2 Sprint 1 (read-only).
 *
 * A full-surface modal with three columns:
 *
 *   ┌──────────┬───────────────────────┬──────────────┐
 *   │ Bundle   │ AgentEditor (tabs)    │ SystemPrompt │
 *   │ list /   │                       │ preview      │
 *   │ Agents / │                       │              │
 *   │ Teams    │                       │              │
 *   └──────────┴───────────────────────┴──────────────┘
 *
 * Sprint 1 scope (this iteration):
 *   - Shell + open/close (Esc, ×, overlay click).
 *   - Left column lists bundles and their agents/teams.
 *   - Middle column shows the selected agent's AgentDefinition fields
 *     across 7 read-only tabs.
 *   - Right column shows the composed systemPrompt (or a built-in
 *     fallback notice for agents whose prompt lives in main process).
 *
 * Sprint 2 will unlock editing + persistence. The component is
 * intentionally structured so that "make the fields `<input>`s instead
 * of `<span>`s" is the primary change for Sprint 2 — no state shape
 * rearrangement needed.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useBundleList, useBundleStore } from '../../stores/bundleStore'
import { useCapabilityCatalogStore } from '../../stores/capabilityCatalogStore'
import { BundleListPane } from './BundleListPane'
import { AgentEditor } from './AgentEditor'
import { SystemPromptPreview } from './SystemPromptPreview'
import { TryRunDrawer } from './TryRunDrawer'
import { useWorkbenchDraftStore, applyDraft } from '../../stores/workbenchDraftStore'
import type { PromptSection } from '../../../electron/agents/bundles/types'
import { useT } from '../../i18n'
import './AgentWorkbench.css'

/**
 * What's currently focused inside the workbench. `kind` tells us which
 * editor (middle column) to render. Stored as a component-local state
 * because it's purely UI/navigation — no main-process state to sync.
 */
export type WorkbenchSelection =
  | { kind: 'none' }
  | { kind: 'bundle-meta'; bundleId: string }
  | { kind: 'agent'; bundleId: string; agentType: string }
  | { kind: 'team'; bundleId: string; teamId: string }

export const AgentWorkbench: React.FC = () => {
  const t = useT()
  const visible = useLayoutStore((s) => s.workbenchVisible)
  const setVisible = useLayoutStore((s) => s.setWorkbenchVisible)
  // Sprint 3.2: outside callers (e.g. Bundle Gallery) can stage a
  // "jump here on next open" intent. We consume + clear it on the
  // visibility transition so the same intent doesn't linger and
  // hijack future opens.
  const initialSelectionIntent = useLayoutStore((s) => s.workbenchInitialSelection)
  const setInitialSelectionIntent = useLayoutStore(
    (s) => s.setWorkbenchInitialSelection,
  )
  const bundles = useBundleList()
  const activeBundleId = useBundleStore((s) => s.activeBundleId)

  // Selection starts on the active bundle's primary agent so users
  // see something meaningful the instant the workbench opens.
  const defaultSelection = useMemo<WorkbenchSelection>(() => {
    const bundleId = activeBundleId ?? bundles[0]?.meta.id
    if (!bundleId) return { kind: 'none' }
    const bundle = bundles.find((b) => b.meta.id === bundleId)
    if (!bundle) return { kind: 'none' }
    const primaryAgent = bundle.agents.find((a) => a.isPrimary) ?? bundle.agents[0]
    if (!primaryAgent) return { kind: 'bundle-meta', bundleId }
    return { kind: 'agent', bundleId, agentType: primaryAgent.agentType }
  }, [activeBundleId, bundles])

  const [selection, setSelection] = useState<WorkbenchSelection>(defaultSelection)

  // Re-sync selection when the workbench is *re-opened* (not on every
  // bundle list change, which would yank the user out of their current
  // selection during edits).
  //
  // Sprint 3.2: when an outside caller staged a `workbenchInitialSelection`
  // intent (e.g. Gallery "Edit in Workbench"), honor it once on open
  // and clear so it doesn't apply again on the next open.
  useEffect(() => {
    if (!visible) return
    if (initialSelectionIntent) {
      // Only use it if the target bundle is actually loaded.
      const exists = bundles.some(
        (b) => b.meta.id === initialSelectionIntent.bundleId,
      )
      if (exists) {
        setSelection(initialSelectionIntent)
      } else {
        setSelection(defaultSelection)
      }
      setInitialSelectionIntent(null)
    } else {
      setSelection(defaultSelection)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  // Pre-load the capability catalog when the workbench becomes
  // visible. Subsequent opens refresh once — users who register new
  // skills / MCP servers mid-session get fresh options next time
  // they open the workbench, without blocking the initial render.
  const refreshCatalog = useCapabilityCatalogStore((s) => s.refresh)
  const catalogLoaded = useCapabilityCatalogStore((s) => s.loaded)
  useEffect(() => {
    if (!visible) return
    if (catalogLoaded) {
      // Already loaded once — soft refresh for freshness.
      void refreshCatalog()
    } else {
      void refreshCatalog()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  // Esc closes; stop propagation from inner inputs happens in editor.
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setVisible(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [visible, setVisible])

  // Close the try-run drawer when the workbench closes — otherwise
  // reopening it next time feels haunted by the old drawer state.
  const setTryRunDrawerTarget = useLayoutStore((s) => s.setTryRunDrawerTarget)
  const handleClose = useCallback(() => {
    setTryRunDrawerTarget(null)
    setVisible(false)
  }, [setTryRunDrawerTarget, setVisible])

  if (!visible) return null

  return (
    <div className="workbench-overlay" role="dialog" aria-modal="true" aria-label="Agent Workbench">
      {/* Backdrop catches click-outside to close. The inner surface
          stops propagation so clicks on the actual UI don't dismiss. */}
      <div className="workbench-backdrop" onClick={handleClose} aria-hidden="true" />

      <div
        className="workbench-surface"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        <header className="workbench-header">
          <div className="workbench-header-title">
            <span className="workbench-title">{t.workbench.shellTitle}</span>
            <span className="workbench-subtitle">
              {t.workbench.shellSubtitle}
            </span>
          </div>
          <button
            type="button"
            className="workbench-close"
            onClick={handleClose}
            title={t.workbench.closeEsc}
            aria-label={t.workbench.close}
          >
            <X size={16} />
          </button>
        </header>

        <div className="workbench-body">
          <aside className="workbench-left">
            <BundleListPane
              bundles={bundles}
              selection={selection}
              onSelect={setSelection}
            />
          </aside>

          <main className="workbench-middle">
            <AgentEditor bundles={bundles} selection={selection} />
          </main>

          <aside className="workbench-right">
            <SystemPromptPreview bundles={bundles} selection={selection} />
            {/* Sprint 2d.a: when a try-run target is set AND it matches
                the currently-selected agent, render the drawer over
                the right column. Mismatched targets are ignored (and
                visually not shown) so drawer state and selection
                can't drift. */}
            <TryRunDrawerSlot bundles={bundles} selection={selection} />
          </aside>
        </div>
      </div>
    </div>
  )
}

/**
 * Thin connector between AgentWorkbench and TryRunDrawer —— looks up
 * the target from layout store, resolves baseline agent + draft,
 * computes the effective system prompt, and hands it all off to the
 * drawer. Separate component so the expensive prompt composition
 * doesn't run on every Workbench keystroke.
 */
const TryRunDrawerSlot: React.FC<{
  bundles: ReturnType<typeof useBundleList>
  selection: WorkbenchSelection
}> = ({ bundles, selection }) => {
  const target = useLayoutStore((s) => s.tryRunDrawerTarget)
  const setTarget = useLayoutStore((s) => s.setTryRunDrawerTarget)
  const draft = useWorkbenchDraftStore((s) => {
    if (selection.kind !== 'agent') return undefined
    if (!target) return undefined
    if (target.bundleId !== selection.bundleId || target.agentType !== selection.agentType) {
      return undefined
    }
    return s.drafts[`${target.bundleId}::${target.agentType}`]
  })

  if (!target) return null
  if (selection.kind !== 'agent') return null
  if (
    selection.bundleId !== target.bundleId ||
    selection.agentType !== target.agentType
  ) {
    // Drawer exists but you clicked to another agent — hide until you
    // come back OR open the drawer from the new target's header.
    return null
  }

  const bundle = bundles.find((b) => b.meta.id === target.bundleId)
  if (!bundle) return null
  const baselineAgent = bundle.agents.find((a) => a.agentType === target.agentType)
  if (!baselineAgent) return null
  const effectiveAgent = applyDraft(baselineAgent, draft)

  // Compose effective system prompt on the renderer side so we can
  // feed live drafts (unsaved) to the try-run IPC. Mirrors the
  // `composeSystemPrompt` logic in bundleSerialize.ts. For built-in
  // agents with no override, we pass empty — main process will fall
  // back to the built-in closure via getBuiltInAgent.
  const sections: PromptSection[] | undefined = effectiveAgent.promptSections
  const raw = effectiveAgent.systemPromptRaw
  let effectivePrompt: string
  if (Array.isArray(sections) && sections.length > 0) {
    effectivePrompt = sections
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((s) =>
        s.title && s.title.trim().length > 0 ? `## ${s.title}\n\n${s.body}` : s.body,
      )
      .join('\n\n')
      .trim()
  } else if (typeof raw === 'string' && raw.trim().length > 0) {
    effectivePrompt = raw
  } else {
    // Empty → backend will compose built-in fallback via getBuiltInAgent.
    // Don't pass systemPromptOverride at all so the server-side default
    // kicks in. We signal this by returning empty; the drawer passes
    // systemPromptOverride unconditionally though, so handle it there.
    effectivePrompt = ''
  }

  return (
    <TryRunDrawer
      bundle={bundle}
      agent={effectiveAgent}
      effectiveSystemPrompt={effectivePrompt}
      onClose={() => setTarget(null)}
    />
  )
}
