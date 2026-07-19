/**
 * Align Monaco's TypeScript/JavaScript worker with the opened workspace's tsconfig/jsconfig.
 *
 * Monaco's built-in TS/JS language service runs **entirely in-memory** (it
 * only knows about files opened as Monaco models). It is therefore not a
 * reliable source of cross-file diagnostics. In this app diagnostics are
 * owned by the subprocess LSP (see `electron/lsp/`); Monaco's worker is
 * kept around strictly for in-tab syntax highlighting, autocomplete inside
 * open models, hover, go-to-def, etc.
 *
 * What this file is responsible for:
 *   1. Discovering compilerOptions for the workspace. When the workspace
 *      uses TypeScript Project References (`"files": []` + `"references"`
 *      at the root), we walk every referenced project (and each project's
 *      `"extends"` chain) and merge compilerOptions into a single view that
 *      Monaco can consume. References whose `include` covers `src/` win,
 *      because Monaco has a single global compiler config and UI code is
 *      the dominant case.
 *   2. Pushing those options into `typescriptDefaults` / `javascriptDefaults`.
 *
 * What this file is NOT responsible for:
 *   - Toggling `noSemanticValidation` / `noSyntaxValidation`. Diagnostic
 *     gating is owned by `initMonacoDiagnostics` in `monacoDiagnostics.ts`,
 *     which disables Monaco's semantic diagnostics up front and keeps them
 *     disabled for the lifetime of the session. Doing it here too used to
 *     race with the LSP-health-driven toggle and re-enabled false positives.
 */

import type * as Monaco from 'monaco-editor'

/** Strip // and /* *\/ from JSON-ish config while respecting double-quoted strings. */
function stripLineCommentsOutsideStrings(line: string): string {
  let inStr = false
  let escaped = false
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (inStr) {
      if (c === '\\') escaped = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      continue
    }
    if (c === '/' && line[i + 1] === '/') {
      return line.slice(0, i).trimEnd()
    }
  }
  return line
}

function stripTsconfigJsonComments(raw: string): string {
  const noBlock = raw.replace(/\/\*[\s\S]*?\*\//g, '')
  const lines = noBlock.split('\n').map(stripLineCommentsOutsideStrings)
  return lines.join('\n').replace(/,(\s*[}\]])/g, '$1')
}

interface ParsedTsconfig {
  compilerOptions?: Record<string, unknown>
  extends?: string | string[]
  references?: Array<{ path?: unknown } | null | undefined>
  include?: unknown[]
  files?: unknown[]
}

function parseTsconfigLike(raw: string): ParsedTsconfig | null {
  try {
    const data = JSON.parse(stripTsconfigJsonComments(raw)) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    return data as ParsedTsconfig
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Tiny path helpers (no `path` module in the renderer)
// ---------------------------------------------------------------------------

function toUnix(p: string): string {
  return p.replace(/\\/g, '/')
}

function isAbsolutePath(p: string): boolean {
  const u = toUnix(p)
  // Windows drive (c:/), POSIX (/), UNC (\\host/...)
  return /^[a-zA-Z]:\//.test(u) || u.startsWith('/')
}

function dirname(p: string): string {
  const u = toUnix(p)
  const idx = u.lastIndexOf('/')
  if (idx < 0) return ''
  if (idx === 0) return '/'
  return u.slice(0, idx)
}

/** Join a relative path against a base dir with `..` / `.` resolution. */
function joinAndNormalize(base: string, rel: string): string {
  const normalized = toUnix(rel)
  const full = isAbsolutePath(normalized)
    ? normalized
    : `${toUnix(base).replace(/\/+$/, '')}/${normalized}`
  const parts = full.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') {
      if (out.length === 0) out.push(part)
      continue
    }
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..' && out[out.length - 1] !== '') {
        out.pop()
      } else {
        out.push(part)
      }
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

/**
 * Resolve a tsconfig reference path to an actual file path. Per TS docs, a
 * reference path may point to either a .json file or a directory (in which
 * case we append `tsconfig.json`). We can't `stat()` from the renderer, so
 * we apply the same "ends with .json?" heuristic the compiler uses.
 */
function resolveReferenceToConfigFile(baseDir: string, refPath: string): string {
  const joined = joinAndNormalize(baseDir, refPath)
  return joined.toLowerCase().endsWith('.json') ? joined : `${joined}/tsconfig.json`
}

/**
 * Resolve a `"extends"` value. Monaco's worker sees a closed world, so we
 * only support two common forms:
 *   - Relative path to a .json (e.g. "./base.json")
 *   - Relative path without extension (e.g. "./base" → "./base.json")
 * Package-name `extends` (e.g. "@tsconfig/strictest/tsconfig.json") would
 * need `node_modules` resolution from the renderer, which we deliberately
 * don't do. Those extends are silently skipped; the referenced project's
 * own compilerOptions still flow through.
 */
function resolveExtendsToConfigFile(baseDir: string, extendsValue: string): string | null {
  const trimmed = extendsValue.trim()
  if (!trimmed) return null
  // Absolute path → use as-is.
  if (isAbsolutePath(trimmed)) {
    return trimmed.toLowerCase().endsWith('.json') ? toUnix(trimmed) : `${toUnix(trimmed)}.json`
  }
  // Relative path — supported.
  if (trimmed.startsWith('.')) {
    const joined = joinAndNormalize(baseDir, trimmed)
    return joined.toLowerCase().endsWith('.json') ? joined : `${joined}.json`
  }
  // Package-name extends — skip (would require `node_modules` resolution).
  return null
}

// ---------------------------------------------------------------------------
// Tsconfig aggregation
// ---------------------------------------------------------------------------

interface ResolvedTsconfig {
  /** Resolved absolute tsconfig path (unix slashes). */
  path: string
  /** Flattened compilerOptions (extends chain applied, own options on top). */
  compilerOptions: Record<string, unknown>
  /** Resolved absolute paths of projects referenced by this config. */
  references: string[]
  /** Raw include patterns as declared in this config. */
  include: string[]
  /** Raw files list as declared in this config (used to detect solution configs). */
  files: string[]
}

type ReadFile = (
  filePath: string,
) => Promise<{ success: boolean; content?: string; error?: string }>

async function resolveTsconfig(
  filePath: string,
  read: ReadFile,
  visited: Set<string>,
): Promise<ResolvedTsconfig | null> {
  const normalized = toUnix(filePath)
  const visitKey = normalized.toLowerCase()
  if (visited.has(visitKey)) return null
  visited.add(visitKey)

  const res = await read(normalized)
  if (!res?.success || typeof res.content !== 'string') return null

  const parsed = parseTsconfigLike(res.content)
  if (!parsed) return null

  const baseDir = dirname(normalized)

  // `extends` may be a string or an array of strings (TS 5.0+). Merge each
  // base's compilerOptions, left-to-right.
  let compilerOptions: Record<string, unknown> = {}
  const extendsList: string[] = []
  if (typeof parsed.extends === 'string') {
    extendsList.push(parsed.extends)
  } else if (Array.isArray(parsed.extends)) {
    for (const e of parsed.extends) {
      if (typeof e === 'string') extendsList.push(e)
    }
  }
  for (const extendsValue of extendsList) {
    const basePath = resolveExtendsToConfigFile(baseDir, extendsValue)
    if (!basePath) continue
    const base = await resolveTsconfig(basePath, read, visited)
    if (base) compilerOptions = { ...compilerOptions, ...base.compilerOptions }
  }

  if (parsed.compilerOptions && typeof parsed.compilerOptions === 'object' && !Array.isArray(parsed.compilerOptions)) {
    compilerOptions = { ...compilerOptions, ...parsed.compilerOptions }
  }

  const references: string[] = []
  if (Array.isArray(parsed.references)) {
    for (const ref of parsed.references) {
      if (!ref || typeof ref !== 'object') continue
      const p = (ref as { path?: unknown }).path
      if (typeof p !== 'string' || !p.trim()) continue
      references.push(resolveReferenceToConfigFile(baseDir, p))
    }
  }

  const include: string[] = []
  if (Array.isArray(parsed.include)) {
    for (const pat of parsed.include) {
      if (typeof pat === 'string' && pat.trim()) include.push(pat)
    }
  }

  const files: string[] = []
  if (Array.isArray(parsed.files)) {
    for (const f of parsed.files) {
      if (typeof f === 'string') files.push(f)
    }
  }

  return { path: normalized, compilerOptions, references, include, files }
}

/**
 * Heuristic score indicating how likely this tsconfig is the "UI-primary"
 * one for Monaco purposes. Higher = more relevant. We prefer projects that
 * include `src/` because that is where the user's edited code lives; when
 * no project claims `src` we fall back to array order.
 */
function scoreTsconfigForUiPrimary(resolved: ResolvedTsconfig): number {
  let score = 0
  for (const pattern of resolved.include) {
    const normalized = pattern.replace(/\\/g, '/').toLowerCase()
    if (/(^|\/)src(\/|$)/.test(normalized) || normalized.startsWith('src')) {
      score += 100
    }
    if (/(^|\/)app(\/|$)/.test(normalized)) {
      score += 20
    }
  }
  const base = resolved.path.toLowerCase()
  if (base.endsWith('/tsconfig.app.json')) score += 50
  if (base.endsWith('/tsconfig.electron.json')) score += 10
  return score
}

/**
 * Aggregate compilerOptions across the root tsconfig and every project it
 * references, handling multi-level `extends` chains. When `src` is covered
 * by one of the referenced projects, its options win the merge — Monaco
 * can only carry one global compiler config, so UI code gets priority.
 */
async function aggregateWorkspaceCompilerOptions(
  rootPath: string,
  read: ReadFile,
): Promise<{
  compilerOptions: Record<string, unknown> | null
  primaryPath: string | null
} > {
  const normRoot = toUnix(rootPath).replace(/\/+$/, '')
  const root = await resolveTsconfig(
    `${normRoot}/tsconfig.json`,
    read,
    new Set(),
  )
  // Fall back to jsconfig.json if tsconfig.json is absent.
  const finalRoot =
    root ??
    (await resolveTsconfig(`${normRoot}/jsconfig.json`, read, new Set()))
  if (!finalRoot) return { compilerOptions: null, primaryPath: null }

  const isSolution =
    finalRoot.files.length === 0 &&
    finalRoot.references.length > 0 &&
    Object.keys(finalRoot.compilerOptions).length === 0

  if (!isSolution) {
    return {
      compilerOptions: finalRoot.compilerOptions,
      primaryPath: finalRoot.path,
    }
  }

  // Walk references. We only go one level deep by default — TS allows
  // nested solutions but this repo (and >99% of real-world configs) keeps
  // references flat. If we encounter a nested solution we still take its
  // compilerOptions (usually empty) without recursing further.
  const resolvedRefs: ResolvedTsconfig[] = []
  const visited = new Set<string>()
  for (const refPath of finalRoot.references) {
    const resolved = await resolveTsconfig(refPath, read, visited)
    if (resolved) resolvedRefs.push(resolved)
  }

  if (resolvedRefs.length === 0) {
    return {
      compilerOptions: finalRoot.compilerOptions,
      primaryPath: finalRoot.path,
    }
  }

  // Merge strategy:
  //   - Start from the root solution's own compilerOptions (typically empty).
  //   - Merge every reference in order, so later refs override earlier ones.
  //   - Move the highest-UI-score reference to the END of the merge list so
  //     its options win. Ties broken by original reference order.
  const scored = resolvedRefs.map((r, idx) => ({
    r,
    idx,
    score: scoreTsconfigForUiPrimary(r),
  }))
  const winner = scored.reduce((best, cur) => {
    if (cur.score > best.score) return cur
    if (cur.score === best.score && cur.idx < best.idx) return best
    return best
  }, scored[0])
  const ordered = scored
    .filter((s) => s !== winner)
    .sort((a, b) => a.idx - b.idx)
    .map((s) => s.r)
  ordered.push(winner.r)

  let merged: Record<string, unknown> = { ...finalRoot.compilerOptions }
  for (const refResolved of ordered) {
    merged = { ...merged, ...refResolved.compilerOptions }
  }

  return { compilerOptions: merged, primaryPath: winner.r.path }
}

// ---------------------------------------------------------------------------
// compilerOptions → Monaco enum mapping
// ---------------------------------------------------------------------------

function mapTarget(monacoApi: typeof Monaco, s: string): Monaco.languages.typescript.ScriptTarget | undefined {
  const { ScriptTarget } = monacoApi.languages.typescript
  const k = s.toLowerCase()
  const table: Record<string, Monaco.languages.typescript.ScriptTarget> = {
    es3: ScriptTarget.ES3,
    es5: ScriptTarget.ES5,
    es6: ScriptTarget.ES2015,
    es2015: ScriptTarget.ES2015,
    es2016: ScriptTarget.ES2016,
    es2017: ScriptTarget.ES2017,
    es2018: ScriptTarget.ES2018,
    es2019: ScriptTarget.ES2019,
    es2020: ScriptTarget.ES2020,
    es2021: ScriptTarget.ESNext,
    es2022: ScriptTarget.ESNext,
    es2023: ScriptTarget.ESNext,
    esnext: ScriptTarget.ESNext,
    json: ScriptTarget.JSON,
  }
  return table[k]
}

function mapModule(monacoApi: typeof Monaco, s: string): Monaco.languages.typescript.ModuleKind | undefined {
  const { ModuleKind } = monacoApi.languages.typescript
  const k = s.toLowerCase()
  const table: Record<string, Monaco.languages.typescript.ModuleKind> = {
    none: ModuleKind.None,
    commonjs: ModuleKind.CommonJS,
    amd: ModuleKind.AMD,
    umd: ModuleKind.UMD,
    system: ModuleKind.System,
    es2015: ModuleKind.ES2015,
    es6: ModuleKind.ES2015,
    es2020: ModuleKind.ES2015,
    es2022: ModuleKind.ES2015,
    esnext: ModuleKind.ESNext,
    node16: ModuleKind.ESNext,
    nodenext: ModuleKind.ESNext,
    preserve: ModuleKind.ESNext,
  }
  return table[k]
}

function mapModuleResolution(
  monacoApi: typeof Monaco,
  s: string,
): Monaco.languages.typescript.ModuleResolutionKind | undefined {
  const { ModuleResolutionKind } = monacoApi.languages.typescript
  const k = s.toLowerCase()
  if (k === 'classic') return ModuleResolutionKind.Classic
  if (
    k === 'node'
    || k === 'node10'
    || k === 'node16'
    || k === 'nodenext'
    || k === 'bundler'
  ) {
    return ModuleResolutionKind.NodeJs
  }
  return undefined
}

function mapJsx(monacoApi: typeof Monaco, s: string): Monaco.languages.typescript.JsxEmit | undefined {
  const { JsxEmit } = monacoApi.languages.typescript
  const k = s.toLowerCase()
  const table: Record<string, Monaco.languages.typescript.JsxEmit> = {
    preserve: JsxEmit.Preserve,
    react: JsxEmit.React,
    'react-native': JsxEmit.ReactNative,
    'react-jsx': JsxEmit.ReactJSX,
    'react-jsxdev': JsxEmit.ReactJSXDev,
  }
  return table[k]
}

function tsconfigCompilerOptionsToMonaco(
  monacoApi: typeof Monaco,
  co: Record<string, unknown>,
  workspaceRoot: string,
  previous: Monaco.languages.typescript.CompilerOptions,
): Monaco.languages.typescript.CompilerOptions {
  const out: Monaco.languages.typescript.CompilerOptions = { ...previous }

  const boolKeys = [
    'strict',
    'noImplicitAny',
    'strictNullChecks',
    'strictFunctionTypes',
    'strictBindCallApply',
    'strictPropertyInitialization',
    'noImplicitThis',
    'alwaysStrict',
    'allowJs',
    'checkJs',
    'noEmit',
    'skipLibCheck',
    'esModuleInterop',
    'allowSyntheticDefaultImports',
    'forceConsistentCasingInFileNames',
    'resolveJsonModule',
    'isolatedModules',
    'allowUmdGlobalAccess',
    'useDefineForClassFields',
    'noImplicitReturns',
    'noFallthroughCasesInSwitch',
    'noUnusedLocals',
    'noUnusedParameters',
    'allowImportingTsExtensions',
  ] as const

  for (const k of boolKeys) {
    if (k in co) {
      const v = co[k]
      if (typeof v === 'boolean') {
        (out as Record<string, unknown>)[k] = v
      }
    }
  }

  if (typeof co.baseUrl === 'string' && co.baseUrl.length > 0) {
    const unix = co.baseUrl.replace(/\\/g, '/').replace(/^\.\//, '')
    // `baseUrl` can legally be absolute (`/abs/path` or `C:/abs/path`);
    // in that case use it verbatim. Only when it's genuinely workspace-
    // relative do we join with the workspace root. The `.replace(/\/+/g,'/')`
    // flattener would previously mangle a Windows drive letter (`C:/...`)
    // into `C:/...` *after* an incorrect join — which silently broke TS
    // path resolution for users who set absolute `baseUrl`.
    const isAbs = /^[a-zA-Z]:\//.test(unix) || unix.startsWith('/')
    if (isAbs) {
      out.baseUrl = unix
    } else {
      const base = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
      out.baseUrl = `${base}/${unix}`.replace(/([^:])\/+/g, '$1/')
    }
  }

  if (co.paths && typeof co.paths === 'object' && !Array.isArray(co.paths)) {
    out.paths = co.paths as Monaco.languages.typescript.CompilerOptions['paths']
  }

  if (typeof co.target === 'string') {
    const m = mapTarget(monacoApi, co.target)
    if (m !== undefined) out.target = m
  }

  if (typeof co.module === 'string') {
    const m = mapModule(monacoApi, co.module)
    if (m !== undefined) out.module = m
  }

  if (typeof co.moduleResolution === 'string') {
    const m = mapModuleResolution(monacoApi, co.moduleResolution)
    if (m !== undefined) out.moduleResolution = m
  } else if (!out.moduleResolution) {
    out.moduleResolution = monacoApi.languages.typescript.ModuleResolutionKind.NodeJs
  }

  if (typeof co.jsx === 'string') {
    const m = mapJsx(monacoApi, co.jsx)
    if (m !== undefined) out.jsx = m
  }

  if (Array.isArray(co.lib) && co.lib.every((x) => typeof x === 'string')) {
    out.lib = co.lib as string[]
  }

  return out
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function sensibleDefaults(
  monacoApi: typeof Monaco,
  previous: Monaco.languages.typescript.CompilerOptions,
): Monaco.languages.typescript.CompilerOptions {
  return {
    ...previous,
    target: monacoApi.languages.typescript.ScriptTarget.ESNext,
    module: monacoApi.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monacoApi.languages.typescript.ModuleResolutionKind.NodeJs,
    allowJs: true,
    checkJs: false,
    strict: false,
    jsx: monacoApi.languages.typescript.JsxEmit.ReactJSX,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    skipLibCheck: true,
    isolatedModules: true,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    lib: ['ESNext', 'DOM', 'DOM.Iterable'],
  }
}

/**
 * Load `tsconfig.json` (including Project References) or `jsconfig.json`
 * from the workspace root and push merged compiler options into Monaco's
 * built-in TS/JS worker. Diagnostics mode is NOT touched here — see the
 * file-level comment for why.
 */
export async function applyWorkspaceTsConfigToMonaco(
  monacoApi: typeof Monaco,
  workspaceRoot: string | null | undefined,
): Promise<void> {
  const tsDefaults = (monacoApi.languages as { typescript?: { typescriptDefaults?: unknown; javascriptDefaults?: unknown } })
    .typescript
  const tsInst = tsDefaults?.typescriptDefaults as {
    getCompilerOptions: () => Monaco.languages.typescript.CompilerOptions
    setCompilerOptions: (o: Monaco.languages.typescript.CompilerOptions) => void
  } | undefined
  const jsInst = tsDefaults?.javascriptDefaults as {
    getCompilerOptions: () => Monaco.languages.typescript.CompilerOptions
    setCompilerOptions: (o: Monaco.languages.typescript.CompilerOptions) => void
  } | undefined
  if (!tsInst || !jsInst) return

  const root = typeof workspaceRoot === 'string' ? workspaceRoot.trim() : ''
  if (!root) {
    const fallback = sensibleDefaults(monacoApi, tsInst.getCompilerOptions() || {})
    fallback.strict = false
    tsInst.setCompilerOptions(fallback)
    jsInst.setCompilerOptions({ ...fallback })
    return
  }

  const read = window.electronAPI?.fs?.readFile
  if (!read) {
    const fallback = sensibleDefaults(monacoApi, tsInst.getCompilerOptions() || {})
    tsInst.setCompilerOptions(fallback)
    jsInst.setCompilerOptions({ ...fallback })
    return
  }

  const normRoot = root.replace(/[/\\]+$/, '')
  const unixRoot = normRoot.replace(/\\/g, '/')

  const { compilerOptions } = await aggregateWorkspaceCompilerOptions(
    normRoot,
    read,
  )

  if (!compilerOptions || Object.keys(compilerOptions).length === 0) {
    const fallback = sensibleDefaults(monacoApi, tsInst.getCompilerOptions() || {})
    tsInst.setCompilerOptions(fallback)
    jsInst.setCompilerOptions({ ...fallback })
    return
  }

  // Start from "sensible defaults" so that UI-critical options like DOM lib
  // and JSX are present even when a (possibly solution-style) tsconfig
  // forgets to declare them. User tsconfig wins the merge.
  const baseline = sensibleDefaults(monacoApi, tsInst.getCompilerOptions() || {})
  const merged = tsconfigCompilerOptionsToMonaco(
    monacoApi,
    compilerOptions,
    unixRoot,
    baseline,
  )
  tsInst.setCompilerOptions(merged)
  jsInst.setCompilerOptions({ ...merged })
}

// ---------------------------------------------------------------------------
// Exports for testing — not part of the stable public API.
// ---------------------------------------------------------------------------

export const __test__ = {
  parseTsconfigLike,
  aggregateWorkspaceCompilerOptions,
  scoreTsconfigForUiPrimary,
  resolveReferenceToConfigFile,
  resolveExtendsToConfigFile,
  joinAndNormalize,
  dirname,
}
