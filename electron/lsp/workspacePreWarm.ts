/**
 * Workspace pre-warm: scan the trusted workspace and `didOpen` every file that
 * one of the running LSP servers cares about. This is the single biggest step
 * toward VS Code-level problem-panel coverage: without it, only files the user
 * has actively opened in Monaco will ever show diagnostics, which differs
 * dramatically from VS Code (tsserver/pyright in `diagnosticMode: workspace`
 * report the whole project graph).
 *
 * Design notes:
 *   - Scan is a synchronous directory walk (no globs); we intentionally avoid
 *     pulling `chokidar` / `globby` here because pre-warm runs once per
 *     workspace and its cost is dominated by `fs.readFileSync`.
 *   - We batch files per language-server, limit concurrency, and yield to the
 *     event loop between batches so the renderer IPC queue stays responsive.
 *   - We respect (a) the built-in ignore directory list, (b) `.gitignore`
 *     patterns via `createLocationGitignoreFilter`, and (c) the user-provided
 *     `lspWorkspaceScan.exclude` fragments.
 *   - Hard caps `maxFilesPerLanguage` and `maxTotalFiles` protect against
 *     pathological monorepos; when a cap trips we log the decision and stop
 *     opening more for that bucket (the FS watcher will still pick up later
 *     edits, so the user can always open remaining files by hand).
 */

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import type { LSPServerManager } from './LSPServerManager'
import { createLocationGitignoreFilter } from './gitIgnoreFilter'
import { readWorkspaceScanSettings } from './workspaceScanSettings'

/** Directory names we never descend into regardless of gitignore. */
const HARD_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.vscode',
  '.idea',
  '.cursor',
  '.claude',
  'dist',
  'dist-electron',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vite',
  'coverage',
  '.pytest_cache',
  '__pycache__',
  '.venv',
  'venv',
  'target', // rust-analyzer
])

export interface PreWarmSummary {
  totalOpened: number
  totalSkipped: number
  byServer: Record<string, number>
  elapsedMs: number
  hitLanguageCap: string[]
  hitGlobalCap: boolean
  disabled: boolean
  aborted: boolean
}

export interface PreWarmOptions {
  /** Concurrency per server batch. Default 8. */
  concurrency?: number
  /** Files per batch before yielding back to the event loop. Default 200. */
  batchSize?: number
  /** Optional abort signal so reinit/shutdown can stop pre-warm mid-flight. */
  signal?: { aborted: boolean }
}

interface ServerScanTarget {
  scope: string
  extensions: Set<string>
  files: string[]
  languageCapHit: boolean
}

function buildExtraExcludeMatcher(patterns: readonly string[]): (rel: string) => boolean {
  if (patterns.length === 0) return () => false
  const regexes: RegExp[] = []
  for (const raw of patterns) {
    const pat = raw.replace(/\\+/g, '/').replace(/^\/+/, '').trim()
    if (!pat) continue
    const escaped = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    try {
      regexes.push(new RegExp(`^${escaped}$`, 'i'))
    } catch {
      // malformed pattern — skip silently; UI validation will catch it later
    }
  }
  return (rel: string): boolean => {
    if (regexes.length === 0) return false
    const segments = rel.split('/')
    for (const r of regexes) {
      if (r.test(rel)) return true
      for (const seg of segments) if (r.test(seg)) return true
    }
    return false
  }
}

/**
 * Scan the workspace directory tree and partition matching files per server scope.
 */
async function collectCandidateFiles(
  workspacePath: string,
  serversByExt: Map<string, string>,
  options: {
    gitignoreFilter: (absPath: string) => boolean
    extraExcludeMatcher: (rel: string) => boolean
    maxFilesPerLanguage: number
    maxTotalFiles: number
    signal?: { aborted: boolean }
  },
): Promise<{
  targets: Map<string, ServerScanTarget>
  totalSkipped: number
  hitGlobalCap: boolean
}> {
  const targets = new Map<string, ServerScanTarget>()
  let totalSkipped = 0
  let totalCollected = 0
  let hitGlobalCap = false

  const stack: string[] = [workspacePath]
  while (stack.length > 0) {
    if (options.signal?.aborted) break
    const dir = stack.pop()!
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (options.signal?.aborted) break
      const absolute = path.join(dir, entry.name)
      const rel = path.relative(workspacePath, absolute).replace(/\\/g, '/')
      if (!rel || rel.startsWith('..')) continue

      if (entry.isSymbolicLink()) continue // avoid symlink loops

      if (entry.isDirectory()) {
        if (HARD_IGNORE_DIRS.has(entry.name)) continue
        // Skip dotfiles / dotdirs except .config-style ones users might want
        if (entry.name.startsWith('.') && !entry.name.startsWith('.config')) continue
        if (options.gitignoreFilter(absolute)) continue
        if (options.extraExcludeMatcher(rel)) continue
        stack.push(absolute)
        continue
      }
      if (!entry.isFile()) continue

      const ext = path.extname(entry.name).toLowerCase()
      if (!ext) continue
      const scope = serversByExt.get(ext)
      if (!scope) continue
      if (options.gitignoreFilter(absolute)) continue
      if (options.extraExcludeMatcher(rel)) continue

      let target = targets.get(scope)
      if (!target) {
        target = { scope, extensions: new Set(), files: [], languageCapHit: false }
        targets.set(scope, target)
      }
      target.extensions.add(ext)

      if (target.files.length >= options.maxFilesPerLanguage) {
        if (!target.languageCapHit) target.languageCapHit = true
        totalSkipped++
        continue
      }
      if (totalCollected >= options.maxTotalFiles) {
        hitGlobalCap = true
        totalSkipped++
        continue
      }

      target.files.push(absolute)
      totalCollected++
    }
  }

  return { targets, totalSkipped, hitGlobalCap }
}

async function drainBatch(
  manager: LSPServerManager,
  batch: string[],
  concurrency: number,
): Promise<number> {
  let opened = 0
  // Run `concurrency` in-flight at a time; resolves when every file is done.
  let cursor = 0
  const inFlight: Promise<void>[] = []

  const take = async (): Promise<void> => {
    while (cursor < batch.length) {
      const idx = cursor++
      const filePath = batch[idx]
      try {
        const content = await fs.readFile(filePath, 'utf8')
        await manager.openFile(filePath, content)
        opened++
      } catch (err) {
        // Skip unreadable files; pre-warm is best-effort.
        console.warn(
          `[LSP pre-warm] skipped ${filePath}: ${(err as Error).message}`,
        )
      }
    }
  }

  for (let i = 0; i < Math.max(1, concurrency); i++) {
    inFlight.push(take())
  }
  await Promise.all(inFlight)
  return opened
}

/**
 * Pre-warm a LSP server manager against a workspace root.
 *
 * Returns a summary suitable for the Settings → LSP panel; throws only on
 * argument errors (missing manager / workspace path). File-level failures
 * are swallowed — they surface in the "skipped" counter instead.
 */
export async function preWarmWorkspaceForLsp(
  manager: LSPServerManager,
  workspacePath: string,
  options: PreWarmOptions = {},
): Promise<PreWarmSummary> {
  const start = Date.now()
  const summary: PreWarmSummary = {
    totalOpened: 0,
    totalSkipped: 0,
    byServer: {},
    elapsedMs: 0,
    hitLanguageCap: [],
    hitGlobalCap: false,
    disabled: false,
    aborted: false,
  }

  if (!manager) throw new Error('preWarmWorkspaceForLsp: manager is required')
  if (typeof workspacePath !== 'string' || workspacePath.trim() === '') {
    summary.disabled = true
    summary.elapsedMs = Date.now() - start
    return summary
  }

  const settings = readWorkspaceScanSettings()
  if (!settings.enabled) {
    summary.disabled = true
    summary.elapsedMs = Date.now() - start
    return summary
  }

  const trimmedWorkspace = path.resolve(workspacePath.trim())
  try {
    const st = fsSync.statSync(trimmedWorkspace)
    if (!st.isDirectory()) {
      summary.disabled = true
      summary.elapsedMs = Date.now() - start
      return summary
    }
  } catch {
    summary.disabled = true
    summary.elapsedMs = Date.now() - start
    return summary
  }

  // Build extension → server scope lookup. Use the first registered server per
  // extension (same precedence as `getServerForFile`).
  const serversByExt = new Map<string, string>()
  for (const [scope, instance] of manager.getAllServers()) {
    for (const ext of Object.keys(instance.config.extensionToLanguage ?? {})) {
      const lower = ext.toLowerCase()
      if (!serversByExt.has(lower)) serversByExt.set(lower, scope)
    }
  }
  if (serversByExt.size === 0) {
    summary.elapsedMs = Date.now() - start
    return summary
  }

  const gitignoreFilter = createLocationGitignoreFilter(trimmedWorkspace)
  const extraExcludeMatcher = buildExtraExcludeMatcher(settings.exclude)

  const { targets, totalSkipped, hitGlobalCap } = await collectCandidateFiles(
    trimmedWorkspace,
    serversByExt,
    {
      gitignoreFilter,
      extraExcludeMatcher,
      maxFilesPerLanguage: settings.maxFilesPerLanguage,
      maxTotalFiles: settings.maxTotalFiles,
      signal: options.signal,
    },
  )
  summary.totalSkipped = totalSkipped
  summary.hitGlobalCap = hitGlobalCap

  const concurrency = Math.max(1, Math.min(32, options.concurrency ?? 8))
  const batchSize = Math.max(1, options.batchSize ?? 200)

  for (const target of targets.values()) {
    if (options.signal?.aborted) {
      summary.aborted = true
      break
    }
    if (target.languageCapHit) summary.hitLanguageCap.push(target.scope)

    let openedForScope = 0
    for (let i = 0; i < target.files.length; i += batchSize) {
      if (options.signal?.aborted) {
        summary.aborted = true
        break
      }
      const batch = target.files.slice(i, i + batchSize)
      openedForScope += await drainBatch(manager, batch, concurrency)
      // Yield to the event loop so IPC / window updates can still happen.
      await new Promise((r) => setImmediate(r))
    }
    summary.byServer[target.scope] = openedForScope
    summary.totalOpened += openedForScope
  }

  summary.elapsedMs = Date.now() - start
  console.log(
    `[LSP pre-warm] opened=${summary.totalOpened} skipped=${summary.totalSkipped}` +
      ` elapsedMs=${summary.elapsedMs} byServer=${JSON.stringify(summary.byServer)}` +
      (summary.hitLanguageCap.length > 0
        ? ` hitLanguageCap=${summary.hitLanguageCap.join(',')}`
        : '') +
      (summary.hitGlobalCap ? ' hitGlobalCap=true' : '') +
      (summary.aborted ? ' aborted=true' : ''),
  )
  return summary
}
