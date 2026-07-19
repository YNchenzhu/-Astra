/**
 * Unified user-action error reporter for renderer code.
 *
 * Motivation
 * ----------
 * The renderer has a large class of buttons whose `onClick` ultimately calls
 * `window.electronAPI.*` via a service wrapper. Before this helper, failures
 * typically took one of three silent paths:
 *
 *   1. `if (!api) return null/false/[]` — preload bridge missing ⇒ caller
 *      sees "no result" indistinguishable from legitimate empty state.
 *   2. `void someAsync()` at the click site — IPC rejection becomes an
 *      unhandled promise rejection, user sees nothing.
 *   3. `catch { /* ignore *\/ }` / `catch(() => {})` in the store — the
 *      action pretends to succeed and the user moves on with stale state.
 *
 * All three produce the same symptom: the button appears dead. This helper is
 * the single place every catch branch should route to when the user did a
 * thing and something blew up behind it.
 *
 * Contract
 * --------
 * - Always writes a structured `console.error` (searchable prefix `[UI]`)
 *   with the origin tag and the underlying error object intact, so stack
 *   traces and cause chains survive Chrome DevTools inspection.
 * - For HIGH-severity user-initiated actions (`silent !== true`) also shows a
 *   native `window.alert`. The project has no toast infrastructure; `alert`
 *   is deliberately chosen because it's guaranteed to be visible and is what
 *   `useWorkspaceStore.openWorkspace` already uses, keeping the UX
 *   consistent across the "dead button" class of bugs.
 * - Background / fire-and-forget / optional side-effects should pass
 *   `silent: true` so we don't bombard the user with popups for
 *   non-user-initiated failures (autosave ticks, Buddy animations, etc.)
 *
 * Never-throw guarantee
 * ---------------------
 * This function must itself be bullet-proof — a faulty reporter masking the
 * real error would be worse than the original silent failure. The reporter
 * catches any internal problem (e.g. `alert` unavailable under headless
 * jsdom) and falls back to a plain `console.error`.
 */
export interface ReportUserActionErrorOptions {
  /**
   * When true, only logs — no `alert`. Use for background tasks, optional
   * side-effects, or anything the user didn't consciously trigger.
   */
  silent?: boolean
}

export function reportUserActionError(
  origin: string,
  error: unknown,
  options?: ReportUserActionErrorOptions,
): void {
  try {
    const message = extractErrorMessage(error)

    // Structured log — include the raw error object so DevTools shows the
    // stack trace & cause chain, not just a stringified summary.
     
    console.error(`[UI:${origin}] ${message}`, error)

    if (options?.silent === true) return
    if (typeof window === 'undefined') return
    if (typeof window.alert !== 'function') return

    // User-visible popup. Intentionally plain and consistent with
    // openWorkspace's existing alert so users see the same shape each time.
    window.alert(`${origin} 失败：${message}`)
  } catch (reporterError) {
    // Reporter must never rethrow. Falling back to the most primitive path
    // possible so at least something lands in the console.
    try {
       
      console.error(
        `[UI:${origin}] reporter crashed:`,
        reporterError,
        'original error:',
        error,
      )
    } catch {
      /* truly nothing we can do here */
    }
  }
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || 'Unknown error'
  }
  if (typeof error === 'string') return error
  if (error == null) return 'Unknown error'
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
