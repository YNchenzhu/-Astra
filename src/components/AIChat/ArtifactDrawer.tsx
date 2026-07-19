/**
 * Stage 4.5 — Artifact manifest drawer.
 *
 * Surfaces `orchestration_phase` events tagged `artifact_manifest` (emitted
 * at the kernel's Terminal phase, see `electron/orchestration/phases/terminal.ts`).
 * Each manifest carries a per-turn collection of rich outputs published by
 * tools / compact / subagents through `ArtifactPort.publish`.
 *
 * Default-collapsed side drawer in the chat panel. A small "artifacts" pill
 * shows the latest turn's count; clicking expands the drawer. Inside, each
 * manifest is grouped by turn, and each entry is rendered as a card with
 * kind / label / producer / inline JSON payload (truncated).
 */
import React, { useState, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Package, ChevronRight } from 'lucide-react'
import { useChatStore } from '../../stores/useChatStore'
import './ArtifactDrawer.css'

const MAX_PAYLOAD_PREVIEW = 400

function previewJson(payload: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(payload, null, 2)
    if (s.length <= MAX_PAYLOAD_PREVIEW) return s
    return s.slice(0, MAX_PAYLOAD_PREVIEW) + '\n…(truncated)'
  } catch {
    return '(payload not serialisable)'
  }
}

export const ArtifactDrawer: React.FC = () => {
  const manifests = useChatStore((s) => s.artifactManifests)
  const [open, setOpen] = useState(false)
  const [panelEl, setPanelEl] = useState<HTMLElement | null>(null)

  // The pill button lives inside `.chat-panel-header-actions`, which sets
  // `position: relative; z-index: 1` and therefore creates its own stacking
  // context. Rendering the `<aside>` as a sibling of the pill would make
  // its `position: absolute` resolve against that ~26px-tall action box
  // (collapsing height to 0 and trapping z-index below the rest of the
  // chat column). We portal the aside up to the closest `.chat-panel`
  // ancestor so it is anchored to the full chat panel and free to layer
  // above the message list / composer.
  //
  // We use a ref callback (rather than useRef + useLayoutEffect) because
  // the component does an `if (manifests.length === 0) return null` early
  // return below: on the very first renders the pill DOM doesn't exist,
  // and a `[]`-deps effect would not re-fire once manifests later arrive
  // and the button finally mounts. The ref callback fires exactly when
  // React attaches the button DOM, so it stays correct regardless of
  // when the pill first appears.
  const setPillRef = useCallback((el: HTMLButtonElement | null) => {
    if (!el) return
    setPanelEl((prev) => prev ?? (el.closest('.chat-panel') as HTMLElement | null))
  }, [])

  // Aggregate counts across all manifests for the pill badge. Only the most
  // recent manifest's count is "the new one"; older entries stack.
  const totalEntries = useMemo(
    () => manifests.reduce((acc, m) => acc + m.entries.length, 0),
    [manifests],
  )

  if (manifests.length === 0) return null

  const drawer = open ? (
    <aside
      className="artifact-drawer"
      role="complementary"
      aria-label="Orchestration artifacts"
    >
      <header className="artifact-drawer-header">
        <Package size={13} />
        <span>编排产出物</span>
        <button
          type="button"
          className="artifact-drawer-close"
          onClick={() => setOpen(false)}
          title="收起"
        >
          <ChevronRight size={13} />
        </button>
      </header>
      <div className="artifact-drawer-body">
        {manifests.slice().reverse().map((manifest, mi) => (
          <section key={mi} className="artifact-drawer-turn">
            <h4 className="artifact-drawer-turn-title">
              回合 #{manifest.turn} · {manifest.entries.length} 项
            </h4>
            <ul className="artifact-drawer-entries">
              {manifest.entries.map((entry) => (
                <li key={entry.id} className="artifact-drawer-entry">
                  <div className="artifact-drawer-entry-head">
                    <span className="artifact-drawer-entry-kind">
                      {entry.kind}
                    </span>
                    {entry.label && (
                      <span className="artifact-drawer-entry-label">
                        {entry.label}
                      </span>
                    )}
                    <span className="artifact-drawer-entry-producer">
                      {entry.producer}
                    </span>
                  </div>
                  <pre className="artifact-drawer-entry-payload">
                    {previewJson(entry.payload)}
                  </pre>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  ) : null

  return (
    <>
      <button
        ref={setPillRef}
        type="button"
        className={'artifact-drawer-pill' + (open ? ' artifact-drawer-pill--open' : '')}
        onClick={() => setOpen((v) => !v)}
        title={`本次会话已产出 ${totalEntries} 项 artifact`}
      >
        <Package size={11} />
        <span>{totalEntries}</span>
      </button>
      {drawer && panelEl ? createPortal(drawer, panelEl) : null}
    </>
  )
}
