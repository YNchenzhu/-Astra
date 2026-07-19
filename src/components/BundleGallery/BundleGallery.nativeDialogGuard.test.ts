/**
 * Regression guard for the native-dialog → non-blocking-UI migration in
 * `BundleGallery.tsx` (the work-package card gallery overlay).
 *
 * Same rationale as `BundleSwitcher.nativeDialogGuard.test.ts`: native
 * `window.alert` / `window.confirm` detach the chat composer's Chinese-IME
 * channel on Windows, locking the input for ~20s after activate / export /
 * import. The fix uses the React-portal `useConfirmDialog` modal + inline
 * toast, and dispatches `pole:refocus-chat-input` after the native OS file
 * dialogs behind export/import.
 *
 * Source-level assertions (no jsdom in this workspace).
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('./BundleGallery.tsx', import.meta.url), 'utf8')

const NATIVE_DIALOG_CALL_RE = /window\s*\.\s*(alert|confirm|prompt)\s*\(/g

describe('BundleGallery native-dialog migration', () => {
  it('has zero native window.alert / window.confirm CALL sites', () => {
    const calls = SOURCE.match(NATIVE_DIALOG_CALL_RE) ?? []
    expect(calls).toEqual([])
  })

  it('wires the React-portal confirm modal (useConfirmDialog) in place of window.confirm', () => {
    expect(SOURCE).toMatch(/import\s*\{[^}]*\buseConfirmDialog\b[^}]*\}\s*from\s*['"][^'"]*ConfirmDialog['"]/)
    expect(SOURCE).toMatch(/useConfirmDialog\s*\(\s*\)/)
    expect(SOURCE).toMatch(/await\s+askConfirm\s*\(/)
    expect(SOURCE).toContain('{confirmDialog}')
  })

  it('wires a non-blocking toast (showNotice) in place of window.alert', () => {
    expect(SOURCE).toMatch(/const\s+showNotice\s*=\s*useCallback/)
    expect(SOURCE).toMatch(/setTimeout\(/)
    expect(SOURCE).toMatch(/showNotice\(\s*['"]info['"]/)
    expect(SOURCE).toMatch(/showNotice\(\s*['"]error['"]/)
  })

  it('clears the toast timer on unmount (no setState-after-unmount leak)', () => {
    expect(SOURCE).toMatch(/clearTimeout\(\s*noticeTimerRef\.current\s*\)/)
  })

  it('re-attaches the chat composer IME after the native export/import file dialog', () => {
    expect(SOURCE).toContain('pole:refocus-chat-input')
  })
})
