/**
 * Mobile H5 viewport stabilizer.
 *
 * On phones the soft keyboard overlays the *layout* viewport, so a `100dvh`
 * chat shell leaves the input bar (and its send button) hidden behind the
 * keyboard — the user has to dismiss the keyboard to reach "send". We track
 * `window.visualViewport` (the actually-visible area) and publish its live
 * height as the `--h5-app-height` CSS variable. `h5-mobile.css` sizes the chat
 * shell to that variable, so the flex column shrinks when the keyboard opens and
 * the input row stays visible above it.
 *
 * Idempotent. No-op (CSS falls back to `100dvh`) when `visualViewport` is
 * unavailable or we are not in a DOM environment.
 */
let installed = false

export function installH5MobileViewport(): void {
  if (installed) return
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  installed = true

  const root = document.documentElement
  const vv = window.visualViewport ?? null

  const apply = (): void => {
    const height = vv?.height ?? window.innerHeight
    // iOS (incl. the WeChat WebView) shifts the visual viewport DOWN by
    // `offsetTop` when the keyboard opens and force-scrolls the layout viewport
    // to reveal the focused input. We anchor the fixed shell to the visible
    // area by exposing both the height and that top offset, and snap the layout
    // viewport scroll back to 0 so no blank gap appears above the chat.
    const offsetTop = vv?.offsetTop ?? 0
    root.style.setProperty('--h5-app-height', `${Math.round(height)}px`)
    root.style.setProperty('--h5-app-offset-top', `${Math.round(offsetTop)}px`)
    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0)
    }
  }

  apply()
  if (vv) {
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
  } else {
    window.addEventListener('resize', apply)
  }
  // The keyboard can finish animating after the focus event; re-apply shortly
  // after a focus to catch the settled viewport metrics.
  window.addEventListener('focusin', () => {
    apply()
    setTimeout(apply, 250)
  })
}
