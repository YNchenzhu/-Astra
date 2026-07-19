/**
 * FS watcher → LSP bridge.
 *
 * Keeps the running LSP servers in sync with the working tree when files
 * change outside Monaco (git pull, external editor, build output, rename,
 * delete, …). Without this, diagnostics for files that aren't currently
 * open in a tab would stop updating the moment the user touches the disk
 * from the terminal.
 *
 * How it cooperates with Monaco's own lifecycle:
 *
 *   - Monaco is the source of truth for files the user is actively editing
 *     (renderer → `lsp:sync-document` already calls `manager.open/change/close/save`).
 *   - The FS watcher here only fires for the *other* files — the ones Monaco
 *     hasn't opened. A cheap `manager.isFileOpen` check gates every event so
 *     we never clobber the Monaco buffer.
 *
 * Special-case config files (tsconfig.json, pyrightconfig.json, package.json,
 * pyproject.toml, …) are forwarded to every running server via
 * `workspace/didChangeWatchedFiles` so they can rebuild their project graphs.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { FSWatcher } from 'chokidar'
import { pathToFileURL } from 'node:url'
import type { LSPServerManager } from './LSPServerManager'
import { readWorkspaceScanSettings } from './workspaceScanSettings'

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
  'target',
])

/**
 * Project-configuration files that should trigger a server re-scan when they
 * change on disk. Key is the basename (case-sensitive on Linux; we compare
 * case-insensitively to match Windows semantics).
 */
const WATCHED_CONFIG_BASENAMES = new Set([
  'tsconfig.json',
  'jsconfig.json',
  'pyrightconfig.json',
  'pyproject.toml',
  'setup.cfg',
  'setup.py',
  'package.json',
  'deno.json',
  'deno.jsonc',
  'tsconfig.base.json',
])

/** LSP FileChangeType. See vscode-languageserver-protocol. */
const FILE_CHANGE_TYPE = {
  Created: 1,
  Changed: 2,
  Deleted: 3,
} as const

export interface LspFsWatcherHandle {
  stop(): Promise<void>
}

export interface LspFsWatcherOptions {
  /** Debounce for rapid-fire writes (e.g. editor save then formatter run). */
  debounceMs?: number
}

function isUnderIgnoredDir(rel: string): boolean {
  for (const seg of rel.split('/')) {
    if (HARD_IGNORE_DIRS.has(seg)) return true
  }
  return false
}

function isConfigFile(absolutePath: string): boolean {
  const base = path.basename(absolutePath).toLowerCase()
  return WATCHED_CONFIG_BASENAMES.has(base)
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
      /* ignore malformed pattern */
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
 * Start a chokidar-backed FS bridge for the given manager + workspace. Returns
 * a handle whose `stop()` tears everything down cleanly. If the workspace
 * scan setting is disabled, or chokidar can't be loaded, this returns a
 * no-op handle (so the caller doesn't have to special-case those paths).
 */
export async function startLspFsWatcherBridge(
  manager: LSPServerManager,
  workspacePath: string,
  options: LspFsWatcherOptions = {},
): Promise<LspFsWatcherHandle> {
  const debounceMs = Math.max(0, options.debounceMs ?? 150)

  const noop: LspFsWatcherHandle = { stop: async () => {} }

  if (!manager || typeof workspacePath !== 'string' || !workspacePath.trim()) return noop

  const settings = readWorkspaceScanSettings()
  if (!settings.enabled) return noop

  const trimmed = path.resolve(workspacePath.trim())
  const extraExcludeMatcher = buildExtraExcludeMatcher(settings.exclude)

  // Collect all extensions every running server cares about so the watcher
  // payload stays small — we don't want chokidar walking into `assets/` etc
  // just to ignore those file types.
  const watchedExtensions = new Set<string>()
  for (const [, instance] of manager.getAllServers()) {
    for (const ext of Object.keys(instance.config.extensionToLanguage ?? {})) {
      watchedExtensions.add(ext.toLowerCase())
    }
  }
  if (watchedExtensions.size === 0) return noop

  let chokidar: typeof import('chokidar')
  try {
    chokidar = await import('chokidar')
  } catch (err) {
    console.warn(
      `[LSP fs-watcher] chokidar unavailable, skipping bridge: ${(err as Error).message}`,
    )
    return noop
  }

  const watcher: FSWatcher = chokidar.watch(trimmed, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 80 },
    ignored: (p: string) => {
      const rel = path.relative(trimmed, path.resolve(p)).replace(/\\/g, '/')
      if (!rel || rel === '.' || rel.startsWith('..')) return false
      if (isUnderIgnoredDir(rel)) return true
      if (extraExcludeMatcher(rel)) return true
      return false
    },
  })

  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let stopped = false

  function relevantExtension(absolute: string): boolean {
    const ext = path.extname(absolute).toLowerCase()
    return watchedExtensions.has(ext)
  }

  /** True if this file's diagnostics are currently owned by Monaco. */
  function monacoOwnsBuffer(absolute: string): boolean {
    try {
      return manager.isFileOpen(absolute)
    } catch {
      return false
    }
  }

  function schedule(absolute: string, fn: () => Promise<void> | void): void {
    const existing = debounceTimers.get(absolute)
    if (existing) clearTimeout(existing)
    debounceTimers.set(
      absolute,
      setTimeout(async () => {
        debounceTimers.delete(absolute)
        if (stopped) return
        try {
          await fn()
        } catch (err) {
          console.warn(
            `[LSP fs-watcher] handler failed for ${absolute}: ${(err as Error).message}`,
          )
        }
      }, debounceMs),
    )
  }

  function notifyWatchedFiles(
    absolute: string,
    changeType: 1 | 2 | 3,
  ): void {
    const uri = pathToFileURL(absolute).href
    for (const [, instance] of manager.getAllServers()) {
      if (instance.state !== 'running') continue
      void instance
        .sendNotification('workspace/didChangeWatchedFiles', {
          changes: [{ uri, type: changeType }],
        })
        .catch((err) => {
          // Ignore: servers that don't register for this notification will
          // simply receive it once and log "no handler"; not a real error.
          console.debug(
            `[LSP fs-watcher] didChangeWatchedFiles ${uri} → ${instance.name} ignored: ${(err as Error).message}`,
          )
        })
    }
  }

  watcher.on('add', (raw: string) => {
    const absolute = path.isAbsolute(raw) ? raw : path.join(trimmed, raw)
    if (isConfigFile(absolute)) {
      notifyWatchedFiles(absolute, FILE_CHANGE_TYPE.Created)
      return
    }
    if (!relevantExtension(absolute)) return
    if (monacoOwnsBuffer(absolute)) return
    schedule(absolute, async () => {
      const content = await fs.readFile(absolute, 'utf8').catch(() => null)
      if (content === null) return
      if (monacoOwnsBuffer(absolute)) return
      await manager.openFile(absolute, content)
    })
  })

  watcher.on('change', (raw: string) => {
    const absolute = path.isAbsolute(raw) ? raw : path.join(trimmed, raw)
    if (isConfigFile(absolute)) {
      notifyWatchedFiles(absolute, FILE_CHANGE_TYPE.Changed)
      return
    }
    if (!relevantExtension(absolute)) return
    if (monacoOwnsBuffer(absolute)) return
    schedule(absolute, async () => {
      const content = await fs.readFile(absolute, 'utf8').catch(() => null)
      if (content === null) return
      if (monacoOwnsBuffer(absolute)) return
      // openFile handles both "never opened" and "already open outside Monaco"
      // cases by bumping the version + sending a didChange.
      await manager.openFile(absolute, content)
    })
  })

  watcher.on('unlink', (raw: string) => {
    const absolute = path.isAbsolute(raw) ? raw : path.join(trimmed, raw)
    if (isConfigFile(absolute)) {
      notifyWatchedFiles(absolute, FILE_CHANGE_TYPE.Deleted)
      return
    }
    if (!relevantExtension(absolute)) return
    if (monacoOwnsBuffer(absolute)) return
    schedule(absolute, async () => {
      try {
        await manager.closeFile(absolute)
      } catch {
        // server may have already dropped the doc; ignore
      }
    })
  })

  watcher.on('error', (err) => {
    console.warn('[LSP fs-watcher] chokidar error:', (err as Error).message)
  })

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    for (const t of debounceTimers.values()) clearTimeout(t)
    debounceTimers.clear()
    try {
      await watcher.close()
    } catch {
      // ignore
    }
  }

  return { stop }
}
