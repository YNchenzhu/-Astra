/**
 * Single source of truth for packages that must stay OUTSIDE the rolldown
 * bundle of every Electron main-process / worker entry (see vite.config.ts).
 *
 * Anything listed here is resolved from `node_modules` at runtime, which
 * means it MUST also be shipped by `electron-builder.json`:
 *   - `files`      → a `node_modules/<pkg>/...` glob (inside the asar)
 *   - `asarUnpack` → additionally, for native `.node` addons / spawned
 *                    binaries that cannot run from inside an asar archive.
 *
 * `electron/packagingConsistency.test.ts` enforces that sync — if you add a
 * package here and forget the electron-builder side, dev keeps working (repo
 * node_modules) but the packaged app dies with "Cannot find module". The
 * test fails first.
 *
 * Why each package is external:
 *   - node-pty: native addon, must be loaded from node_modules at runtime
 *   - zod: CJS interop is broken by Rollup (__esmMin init_external undefined)
 *   - sharp + @img/*: native addon, resolves platform binary via
 *     require.resolve at runtime — bundling breaks that resolution
 *   - onnxruntime-node: native .node addon; bundler replaces its runtime
 *     `require.resolve()` with a static path that no longer matches the
 *     real on-disk layout
 *   - @huggingface/transformers: uses `import.meta.url` internally to
 *     resolve WASM/ONNX assets; rolldown emitting CJS replaces that with
 *     {} → fails at runtime when pipeline() resolves model assets
 *   - @napi-rs/canvas + canvas: optional PDF-rendering fallback; carry
 *     per-platform prebuilt `.node` binaries that rolldown cannot bundle
 *   - pdfjs-dist: ESM build uses `import.meta.url` + `createRequire()`;
 *     bundling to CJS breaks both
 *   - @vscode/ripgrep: resolves the `rg` binary via `__dirname`-relative
 *     path — bundling breaks it; binary itself must be asar-unpacked
 */

/** Exact package ids that must stay external. */
export const EXTERNAL_PACKAGES = [
  'node-pty',
  'zod',
  'sharp',
  'onnxruntime-node',
  'onnxruntime-common',
  '@huggingface/transformers',
  '@napi-rs/canvas',
  'canvas',
  'pdfjs-dist',
  '@vscode/ripgrep',
] as const

/** Id prefixes (deep imports / platform-suffixed sibling packages). */
export const EXTERNAL_PREFIXES = [
  '@img/',
  '@huggingface/transformers/',
  '@napi-rs/canvas-',
  'pdfjs-dist/',
  '@vscode/ripgrep-',
] as const

/**
 * External packages that are intentionally NOT shipped by electron-builder:
 *   - canvas: optional peer of pdfjs-dist; we ship @napi-rs/canvas instead.
 *     The runtime probe in electron/attachments/pdf.ts tolerates absence.
 */
export const EXTERNAL_NOT_SHIPPED = ['canvas'] as const

/** Rollup/rolldown `external` predicate shared by every electron entry. */
export function isElectronExternal(id: string): boolean {
  if ((EXTERNAL_PACKAGES as readonly string[]).includes(id)) return true
  return EXTERNAL_PREFIXES.some((p) => id.startsWith(p))
}
