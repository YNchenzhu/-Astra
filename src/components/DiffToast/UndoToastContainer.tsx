/**
 * Undo toast overlay (P4c).
 *
 * Renders one small card per active undo entry in the bottom-right corner. Clicking
 * "Undo" dispatches the main-process `intentUndo` IPC and reflects the result locally:
 *
 *   active  ─ click ─► undoing  ─ ok ───► undone (lingers ~2.5s) ─► removed
 *                      │
 *                      └──────── fail ──► failed (lingers ~5s with message) ─► removed
 *
 * The component is intentionally self-contained:
 *   • Zero props (reads from Zustand stores).
 *   • Inline styles so it works without any additional CSS loading.
 *   • Gracefully renders nothing when toast list is empty — safe to mount at the root
 *     unconditionally. Feature-gated via the dt mode inside the sync hook (toasts only
 *     get enqueued when mode === 'dt').
 */

import React, { useCallback } from 'react'
import { Check, RotateCcw, X, AlertTriangle } from 'lucide-react'
import { useUndoToastStore, type UndoToast } from '../../stores/useUndoToastStore'

function toastBase(status: UndoToast['status']): React.CSSProperties {
  const palette: Record<UndoToast['status'], { bg: string; border: string; fg: string }> = {
    active: {
      bg: 'var(--color-surface, #202020)',
      border: 'var(--color-border, #3a3a3a)',
      fg: 'var(--color-fg, #d4d4d4)',
    },
    undoing: {
      bg: 'var(--color-surface, #202020)',
      border: 'var(--color-border, #3a3a3a)',
      fg: 'var(--color-fg, #a0a0a0)',
    },
    undone: {
      bg: 'rgba(63, 140, 63, 0.16)',
      border: 'rgba(63, 140, 63, 0.6)',
      fg: 'var(--color-success-fg, #5cbf5c)',
    },
    failed: {
      bg: 'var(--color-error-bg, rgba(248, 81, 73, 0.12))',
      border: 'var(--color-error-border, rgba(248, 81, 73, 0.5))',
      fg: 'var(--color-error-fg, #f85149)',
    },
    expired: { bg: 'transparent', border: 'transparent', fg: 'transparent' },
  }
  const p = palette[status]
  return {
    minWidth: 280,
    maxWidth: 420,
    padding: '8px 10px',
    borderRadius: 6,
    background: p.bg,
    border: `1px solid ${p.border}`,
    color: p.fg,
    fontSize: 12,
    lineHeight: 1.4,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.3)',
    pointerEvents: 'auto',
  }
}

const UndoToastRow: React.FC<{ toast: UndoToast }> = ({ toast }) => {
  const markUndoing = useUndoToastStore((s) => s.markUndoing)
  const markUndone = useUndoToastStore((s) => s.markUndone)
  const markFailed = useUndoToastStore((s) => s.markFailed)
  const dismiss = useUndoToastStore((s) => s.dismiss)

  const handleUndo = useCallback(async () => {
    const api = window.electronAPI?.diffTx
    if (!api?.intentUndo) {
      markFailed(toast.dtId, 'Undo not available in this build.')
      return
    }
    markUndoing(toast.dtId)
    try {
      const r = await api.intentUndo(toast.dtId)
      if (r.ok) markUndone(toast.dtId)
      else markFailed(toast.dtId, r.reason || 'Undo refused by main process.')
    } catch (err) {
      markFailed(toast.dtId, err instanceof Error ? err.message : String(err))
    }
  }, [toast.dtId, markUndoing, markUndone, markFailed])

  const handleDismiss = useCallback(() => dismiss(toast.dtId), [dismiss, toast.dtId])

  const fileName = toast.filePath.split(/[\\/]/).pop() || toast.filePath

  // Four distinct renderings — one per non-terminal status. `expired` is swept away
  // by the store before it ever reaches render.
  switch (toast.status) {
    case 'active':
      return (
        <div style={toastBase('active')} role="status">
          <Check size={14} style={{ flexShrink: 0, color: 'var(--color-success-fg, #5cbf5c)' }} />
          <span style={{ flex: 1 }}>
            Applied to <strong>{fileName}</strong>
          </span>
          <button type="button" onClick={handleUndo} style={btnStyle('primary')}>
            <RotateCcw size={12} />
            <span>Undo</span>
          </button>
          <button type="button" onClick={handleDismiss} style={btnStyle('ghost')} aria-label="Dismiss">
            <X size={12} />
          </button>
        </div>
      )
    case 'undoing':
      return (
        <div style={toastBase('undoing')} role="status">
          <RotateCcw size={14} style={{ flexShrink: 0, animation: 'spin 1s linear infinite' }} />
          <span style={{ flex: 1 }}>
            Undoing <strong>{fileName}</strong>…
          </span>
        </div>
      )
    case 'undone':
      return (
        <div style={toastBase('undone')} role="status">
          <Check size={14} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1 }}>
            Reverted <strong>{fileName}</strong>
          </span>
          <button type="button" onClick={handleDismiss} style={btnStyle('ghost')} aria-label="Dismiss">
            <X size={12} />
          </button>
        </div>
      )
    case 'failed':
      return (
        <div style={toastBase('failed')} role="alert">
          <AlertTriangle size={14} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1 }}>
            Undo failed for <strong>{fileName}</strong>
            {toast.errorMessage ? `: ${toast.errorMessage}` : ''}
          </span>
          <button type="button" onClick={handleDismiss} style={btnStyle('ghost')} aria-label="Dismiss">
            <X size={12} />
          </button>
        </div>
      )
    default:
      return null
  }
}

function btnStyle(variant: 'primary' | 'ghost'): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: variant === 'primary' ? '4px 10px' : '4px',
    borderRadius: 4,
    border: '1px solid transparent',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: 12,
    flexShrink: 0,
  }
  if (variant === 'primary') {
    base.background = 'var(--color-button-primary-bg, #2563eb)'
    base.color = '#fff'
    base.borderColor = 'var(--color-button-primary-border, #1e4fb8)'
  } else {
    base.opacity = 0.7
  }
  return base
}

/**
 * Bottom-right stack of undo toasts. Mount once at the app root (inside AppInner).
 */
export const UndoToastContainer: React.FC = () => {
  const toasts = useUndoToastStore((s) => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 9999,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => (
        <UndoToastRow key={t.dtId} toast={t} />
      ))}
    </div>
  )
}
