/**
 * Reusable confirmation dialog — the React-native replacement for
 * `window.confirm()`.
 *
 * Why this exists:
 *   Electron's `window.confirm()` is a synchronous, hard-blocking Chromium
 *   modal. On Windows with a Chinese IME (Pinyin) the dismiss flow
 *   detaches the IMM channel from the underlying textarea, so even though
 *   the element looks focused after the dialog closes, keystrokes are
 *   silently swallowed until the main thread idles enough for a fresh
 *   `.focus()` to land (observed: up to ~60 s on boot when IPC is busy).
 *
 * Design:
 *   - React portal into `document.body` so z-index / layout always escape
 *     the invoking component's tree.
 *   - `aria-modal` + backdrop click + `Escape` → cancel.
 *   - `variant: 'danger'` auto-focuses the cancel button and colours the
 *     primary button red — the right default for destructive ops.
 *   - Promise-based API below (`useConfirmDialog`) lets callers `await` a
 *     decision without needing a state machine at the call site.
 *
 * NOT for side-effect-heavy flows where the confirmation outcome feeds
 * something with its own loading state — use a purpose-built component
 * for those. This is strictly for "OK / Cancel" forks.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './ConfirmDialog.css'

export interface ConfirmDialogProps {
  open: boolean
  /** Title shown at the top; omit for a title-less message-only dialog. */
  title?: string
  /** Body text. String or preformatted ReactNode; both are rendered as-is. */
  message: string | React.ReactNode
  /** Confirm button label. Default: "确认". */
  confirmText?: string
  /** Cancel button label. Default: "取消". */
  cancelText?: string
  /**
   * Visual style.
   *   - `'default'` — primary button styled normally.
   *   - `'danger'`  — primary button red; auto-focus moves to cancel so an
   *                   accidental Enter does NOT trigger the destructive op.
   */
  variant?: 'default' | 'danger'
  /** Fired when the user accepts. Dialog does not auto-close — the caller
   *  is responsible for flipping `open` back to false, normally right
   *  inside this handler. */
  onConfirm: () => void
  /** Fired when the user cancels (button, ESC, or backdrop click). Same
   *  auto-close contract as {@link onConfirm}. */
  onCancel: () => void
}

export function ConfirmDialog(props: ConfirmDialogProps): React.ReactElement | null {
  const {
    open,
    title,
    message,
    confirmText = '确认',
    cancelText = '取消',
    variant = 'default',
    onConfirm,
    onCancel,
  } = props

  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)

  // Keep a stable reference to the latest cancel handler so the global ESC
  // listener below doesn't need to re-attach on every parent re-render.
  // Writing the ref inside `useEffect` (not during render) keeps
  // `react-hooks/refs` happy — React 19 forbids ref writes during render.
  const onCancelRef = useRef(onCancel)
  useEffect(() => {
    onCancelRef.current = onCancel
  }, [onCancel])

  // Focus management — open: stash previous focus, move to safe button.
  // Close: restore previous focus. Cancelling is the safe default for
  // danger variants (so a reflexive Enter press in a slow rendering tree
  // can't commit the destructive action).
  useEffect(() => {
    if (!open) return
    previouslyFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null
    const target = variant === 'danger' ? cancelRef.current : confirmRef.current
    // Defer by a frame so the portal subtree has mounted in the DOM.
    const h = window.requestAnimationFrame(() => {
      try {
        target?.focus()
      } catch {
        /* unmounted before rAF fired */
      }
    })
    return () => {
      window.cancelAnimationFrame(h)
      // Restore outside focus on close. Guarded because the element may
      // have been unmounted while the dialog was open.
      const prev = previouslyFocusedRef.current
      if (prev && typeof prev.focus === 'function') {
        try {
          prev.focus()
        } catch {
          /* caller moved on */
        }
      }
    }
    // Intentional dep set: only re-run when the dialog toggles or the
    // variant changes (which can shift the "safe" auto-focus target).
  }, [open, variant])

  // Global ESC → cancel, while the dialog is open.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancelRef.current()
      }
    }
    document.addEventListener('keydown', handler, { capture: true })
    return () => {
      document.removeEventListener('keydown', handler, { capture: true })
    }
  }, [open])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // The portal escapes the DOM tree but NOT the React tree: synthetic
      // events still bubble to the invoking component's ancestors (e.g. the
      // settings modal's click-outside-to-close overlay). Always stop
      // propagation here so interacting with the confirm dialog can never
      // dismiss whatever UI launched it.
      e.stopPropagation()
      // Only fire cancel when the click is actually on the backdrop itself —
      // clicks that bubbled from inside the panel should not dismiss.
      if (e.target === e.currentTarget) {
        onCancel()
      }
    },
    [onCancel],
  )

  if (!open) return null
  if (typeof document === 'undefined') return null // SSR / vitest without DOM

  const primaryClass = `confirm-dialog-btn confirm-dialog-btn-primary ${
    variant === 'danger' ? 'confirm-dialog-btn-danger' : ''
  }`

  return createPortal(
    <div
      className="confirm-dialog-overlay"
      role="presentation"
      onClick={handleBackdropClick}
    >
      <div
        className="confirm-dialog-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={title ? 'confirm-dialog-title' : undefined}
        aria-describedby="confirm-dialog-message"
      >
        {title ? (
          <div className="confirm-dialog-header" id="confirm-dialog-title">
            {title}
          </div>
        ) : null}
        <div className="confirm-dialog-body" id="confirm-dialog-message">
          {message}
        </div>
        <div className="confirm-dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            className="confirm-dialog-btn confirm-dialog-btn-secondary"
            onClick={onCancel}
          >
            {cancelText}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={primaryClass}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * Hook providing a Promise-based `askConfirm` + the rendered dialog element
 * the caller drops into its tree. Typical usage:
 *
 * ```tsx
 * const { dialog, askConfirm } = useConfirmDialog()
 * const onClickDangerous = async () => {
 *   const ok = await askConfirm({
 *     title: '切换到自动写入？',
 *     message: '所有文件变更将直接落盘。',
 *     variant: 'danger',
 *   })
 *   if (!ok) return
 *   await doTheThing()
 * }
 * return (
 *   <>
 *     <button onClick={onClickDangerous}>自动写入</button>
 *     {dialog}
 *   </>
 * )
 * ```
 */
export type AskConfirmParams = Omit<ConfirmDialogProps, 'open' | 'onConfirm' | 'onCancel'>

// `useConfirmDialog` is a hook co-located with its `ConfirmDialog` component.
// The "one component per file for HMR" lint treats any non-component export
// as a Fast Refresh hazard; for this idiomatic hook-plus-its-sibling-component
// pattern the benefit of splitting is zero while the cost (two imports at
// every call site) is real. Scope the suppression narrowly.
// eslint-disable-next-line react-refresh/only-export-components
export function useConfirmDialog(): {
  dialog: React.ReactElement | null
  askConfirm: (params: AskConfirmParams) => Promise<boolean>
} {
  const [open, setOpen] = useState(false)
  const [params, setParams] = useState<AskConfirmParams | null>(null)
  const resolveRef = useRef<((value: boolean) => void) | null>(null)

  const askConfirm = useCallback(
    (p: AskConfirmParams): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        resolveRef.current = resolve
        setParams(p)
        setOpen(true)
      }),
    [],
  )

  const closeWith = useCallback((value: boolean) => {
    setOpen(false)
    const r = resolveRef.current
    resolveRef.current = null
    // Clear params AFTER the current microtask so the unmount transition
    // doesn't lose the message text mid-fade.
    Promise.resolve().then(() => setParams(null))
    if (r) r(value)
  }, [])

  const dialog: React.ReactElement | null = params ? (
    <ConfirmDialog
      {...params}
      open={open}
      onConfirm={() => closeWith(true)}
      onCancel={() => closeWith(false)}
    />
  ) : null

  return { dialog, askConfirm }
}
