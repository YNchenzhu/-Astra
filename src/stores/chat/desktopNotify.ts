import { notifyDesktop } from '../../services/electronAPI'
import { useSettingsStore } from '../useSettingsStore'

/**
 * Desktop toast helper.
 *
 * Respects the per-category enable toggle passed by the caller **and** the
 * global `desktopNotificationMode` stored in `useSettingsStore`. When both
 * are set the notification is forwarded to the main process via
 * `notifyDesktop`; otherwise the call is a no-op.
 */
export function maybeDesktopNotify(opts: {
  enabled: boolean
  title: string
  body: string
  /** When true, prefix body if the event targets a different conversation than the one visible. */
  otherSession: boolean
}): void {
  if (!opts.enabled) return
  const settings = useSettingsStore.getState()
  if (settings.desktopNotificationMode === 'off') return
  const body = opts.otherSession ? `（其他会话）${opts.body}` : opts.body
  void notifyDesktop({
    title: opts.title,
    body,
    mode: settings.desktopNotificationMode,
  })
}

/**
 * Bounded preview for desktop-notify bodies so toasts stay legible across
 * Windows Action Center / macOS Notification Center / Linux libnotify —
 * different OSes truncate at wildly different lengths and some just drop
 * overflow silently. 120 chars is the safe lowest-common-denominator.
 */
export function clampPreview(raw: string, max = 120): string {
  const s = (raw || '').trim()
  return s.length > max ? `${s.slice(0, max - 3)}…` : s
}
