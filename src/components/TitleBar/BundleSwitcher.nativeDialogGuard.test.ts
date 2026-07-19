/**
 * Regression guard for the native-dialog → non-blocking-UI migration in
 * `BundleSwitcher.tsx`.
 *
 * ## Why a source-level test (not a render test)
 *
 * This workspace deliberately ships renderer tests as pure-function / source
 * assertions: there is no `jsdom` / `@testing-library/react` in the dependency
 * tree (see the note atop `RedactedThinkingBlock.test.tsx`), and vitest runs
 * under the `node` environment. `BundleSwitcher` uses `createPortal`,
 * `useEffect`, refs and click-driven async flows, none of which can be
 * exercised via `renderToStaticMarkup`. Pulling in jsdom + testing-library for
 * one component would be a new dependency the project intentionally avoids.
 *
 * ## What this guards
 *
 * The bug: on Windows + Chinese IME, the synchronous Chromium modals
 * `window.alert` / `window.confirm` detach the chat composer's IMM channel on
 * dismiss, so after importing / switching a bundle the input swallows
 * keystrokes (no caret) until the main thread idles (~20s while the activate
 * IPC burst runs). The fix replaced every native dialog in this component with
 * the React-portal `useConfirmDialog` modal + an inline non-blocking toast.
 *
 * These assertions fail the build if anyone reintroduces a native blocking
 * dialog here, or removes the non-blocking wiring the fix depends on.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('./BundleSwitcher.tsx', import.meta.url), 'utf8')

/** Match real call sites (`window.alert(` / `window.confirm(`), not prose
 *  mentions inside comments (`native \`window.alert\``). */
const NATIVE_DIALOG_CALL_RE = /window\s*\.\s*(alert|confirm)\s*\(/g

describe('BundleSwitcher native-dialog migration', () => {
  it('has zero native window.alert / window.confirm CALL sites', () => {
    const calls = SOURCE.match(NATIVE_DIALOG_CALL_RE) ?? []
    expect(calls).toEqual([])
  })

  it('wires the React-portal confirm modal (useConfirmDialog) in place of window.confirm', () => {
    expect(SOURCE).toMatch(/import\s*\{[^}]*\buseConfirmDialog\b[^}]*\}\s*from\s*['"][^'"]*ConfirmDialog['"]/)
    // The hook must be invoked and its `askConfirm` used for the destructive /
    // conflict prompts (delete + import id-conflict).
    expect(SOURCE).toMatch(/useConfirmDialog\s*\(\s*\)/)
    expect(SOURCE).toMatch(/await\s+askConfirm\s*\(/)
    // The dialog element must be rendered into the tree, else askConfirm never resolves.
    expect(SOURCE).toContain('{confirmDialog}')
  })

  it('wires a non-blocking toast (showNotice) in place of window.alert', () => {
    // Helper defined + auto-dismiss timer present.
    expect(SOURCE).toMatch(/const\s+showNotice\s*=\s*useCallback/)
    expect(SOURCE).toMatch(/setTimeout\(/)
    // Both info and error notices are emitted by the migrated handlers.
    expect(SOURCE).toMatch(/showNotice\(\s*['"]info['"]/)
    expect(SOURCE).toMatch(/showNotice\(\s*['"]error['"]/)
    // The toast is portalled to body via the dedicated class.
    expect(SOURCE).toContain('bundle-switcher-notice')
    expect(SOURCE).toMatch(/createPortal\(/)
  })

  it('clears the toast timer on unmount (no setState-after-unmount leak)', () => {
    expect(SOURCE).toMatch(/clearTimeout\(\s*noticeTimerRef\.current\s*\)/)
  })
})
