/**
 * Assistant avatar for welcome screen + AI chat + title bar.
 *
 * Current artwork: `src/assets/app-icon.png` (256×256, alpha-keyed, rounded
 * corners) — generated from `public/Astra_CZ_rounded_transparent.ico` (the
 * app icon used by electron-builder / BrowserWindow / favicon), so every
 * surface that shows the brand mark uses the same image.
 *
 * Previous artwork `src/assets/assistant-avatar.png` (gold compass, generated
 * from `assistant-avatar.jpg` via `scripts/strip-avatar-white-bg.mjs`) is kept
 * on disk as the old source but no longer referenced.
 */
import assistantAvatarUrl from './assets/app-icon.png?url'

export { assistantAvatarUrl }
