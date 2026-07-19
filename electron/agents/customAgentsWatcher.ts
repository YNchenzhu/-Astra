/**
 * Watches all custom-agent source directories (user-global / user-app /
 * project / user-configured extras) so edits made with a text editor,
 * `git pull`, or another Claude-family tool hot-reload in the UI without
 * needing a manual refresh.
 *
 * Migration note: Uses fileWatcherManager (worker_threads) instead of direct
 * chokidar instance to keep the main process event loop responsive.
 * Kept intentionally thin: delegates to fileWatcherManager with a
 * 150 ms debounce, and a single `onChange` fan-out. The actual agent
 * re-scan + IPC broadcast lives in `main.ts` — this module is purely the
 * FS plumbing.
 */

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileWatcherManager } from '../watchers/fileWatcherManager'
import { PROJECT_AGENT_DIR_RELATIVE_PATHS } from './customAgents'

function expandHome(p: string): string {
  if (!p) return p
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1).replace(/^[/\\]+/, ''))
  }
  return p
}

function agentDirsFromParams(params: {
  workspacePath: string | null | undefined
  userDataPath: string | null | undefined
  extraDirs: readonly string[]
}): string[] {
  const dirs: string[] = []
  // User-global (~/.claude/agents)
  dirs.push(path.join(os.homedir(), '.claude', 'agents'))
  // User-app (Electron userData agents/)
  if (params.userDataPath) {
    dirs.push(path.join(params.userDataPath, 'agents'))
  }
  // Project-level agent dirs. Mirror the scan list used by
  // `loadProjectScopedAgents` so the watcher + loader never disagree about
  // which paths produce custom agents (covers both `.claude/agents/` and the
  // the IDE-ecosystem `.cursor/agents/`).
  if (params.workspacePath) {
    for (const rel of PROJECT_AGENT_DIR_RELATIVE_PATHS) {
      dirs.push(path.join(params.workspacePath, rel))
    }
  }
  // Extra dirs (absolute; expand ~)
  for (const d of params.extraDirs) {
    if (d && typeof d === 'string') dirs.push(expandHome(d))
  }
  // Deduplicate
  return Array.from(new Set(dirs.map((d) => path.normalize(d))))
}

export interface StartCustomAgentsWatcherParams {
  workspacePath: string | null | undefined
  userDataPath: string | null | undefined
  extraDirs: readonly string[]
  onChange: () => void
  /** Override the default 150 ms debounce (mainly for tests). */
  debounceMs?: number
}

const WATCHER_ID = 'custom-agents'

/**
 * Start watching every known custom-agent source dir. Returns a dispose
 * function that closes the watcher. Safe to call repeatedly — the
 * caller is expected to dispose the previous handle first.
 */
export function startCustomAgentsWatcher(
  params: StartCustomAgentsWatcherParams,
): () => void {
  const dirs = agentDirsFromParams(params)
  // Ensure parent dirs exist
  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      try {
        fs.mkdirSync(d, { recursive: true })
      } catch {
        // Permission denied / cross-drive etc. — skip silently
      }
    }
  }

  const debounceMs = typeof params.debounceMs === 'number' && params.debounceMs >= 0
    ? params.debounceMs
    : 150

  let disposed = false

  void fileWatcherManager.startWatcher({
    id: WATCHER_ID,
    paths: dirs,
    debounceMs,
    options: {
      ignoreInitial: true,
      depth: 1,
      // ignored filtering is handled by the caller's onChange — the scan
      // runs on every event anyway and ignores non-MD/JSON internally.
      // Functions cannot be cloned across postMessage (worker boundary).
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
    },
    onChange: () => {
      if (disposed) return
      try {
        params.onChange()
      } catch (e) {
        console.warn('[customAgentsWatcher] onChange threw:', e)
      }
    },
    onError: (err) => {
      // Non-fatal; a missing dir or permission blip shouldn't kill the watcher.
      console.warn('[customAgentsWatcher] watcher error:', err)
    },
  })

  return () => {
    disposed = true
    void fileWatcherManager.stopWatcher(WATCHER_ID)
  }
}
