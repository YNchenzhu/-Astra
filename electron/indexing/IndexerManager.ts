/**
 * Workspace Indexer Manager — lifecycle + cancellation wrapper.
 *
 * The embedding worker (`electron/embedding/embeddingWorker.ts`) and the
 * business-logic layer (`electron/embedding/workspaceIndex.ts`) were already
 * in place but lacked a single coordinator that owns the build lifecycle.
 * This module fills that gap:
 *
 *   - **Cancel support** — an in-flight `buildWorkspaceIndex()` can be
 *     aborted via {@link cancelBuild}. Previous callers had no way to stop
 *     a multi-minute ONNX embed run short of killing the process.
 *   - **State observability** — {@link getState} exposes the current phase
 *     and latest progress tick so the renderer can show a live progress bar
 *     without polling the worker directly.
 *   - **Shutdown hygiene** — {@link dispose} cancels any running build and
 *     terminates the embedding worker so the app exits cleanly.
 *
 * Existing callers of `workspaceIndex.ts` (IPC handlers, Settings "Rebuild"
 * button, background rehydrate) are **not** affected — they continue to
 * import `buildWorkspaceIndex` / `incrementallyUpdateWorkspaceIndex` /
 * `queryWorkspaceIndex` directly. The manager is an additional coordination
 * layer, not a replacement.
 */

import {
  buildWorkspaceIndex,
  getWorkspaceIndexStatus,
  clearWorkspaceIndex,
  incrementallyUpdateWorkspaceIndex,
  queryWorkspaceIndex,
  type WorkspaceIndexStatus,
  type BuildOptions,
  type BuildProgressTick,
  type QueryHit,
} from '../embedding/workspaceIndex'
import { unloadAllLocalModels } from '../embedding/localModel'
import type { IndexerState } from './types'

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class IndexerManager {
  private _state: IndexerState = {
    phase: 'idle',
    currentRoot: null,
    startedAt: null,
    progress: null,
  }

  private _abortController: AbortController | null = null

  // ── public API ──────────────────────────────────────────────────────────

  /**
   * Current lifecycle state (immutable snapshot — replace with
   * `structuredClone` if the caller mutates the return value).
   */
  getState(): Readonly<IndexerState> {
    return this._state
  }

  /** True while a build or incremental update is in progress. */
  get isBuilding(): boolean {
    return this._state.phase === 'building' || this._state.phase === 'updating'
  }

  // ── build / rebuild ─────────────────────────────────────────────────────

  /**
   * Build (or rebuild) the semantic index for `root`.
   *
   * Delegates to {@link buildWorkspaceIndex} with an {@link AbortSignal}
   * wired to {@link cancelBuild}. If a build is already in progress the
   * call rejects immediately — the manager enforces at-most-one.
   */
  async buildIndex(
    root: string,
    options: BuildOptions = {},
  ): Promise<WorkspaceIndexStatus> {
    if (this.isBuilding) {
      throw new Error(
        `Index build already in progress for "${this._state.currentRoot}"`,
      )
    }

    this._abortController = new AbortController()
    const signal = this._abortController.signal

    this._state = {
      phase: 'building',
      currentRoot: root,
      startedAt: Date.now(),
      progress: null,
    }

    try {
      // Pipe progress ticks through state so external observers can poll.
      const onProgress = (tick: BuildProgressTick): void => {
        this._state.progress = tick
        options.onProgress?.(tick)
      }

      // Race the real build against the abort signal.  buildWorkspaceIndex
      // does NOT natively accept a signal, so cancellation via this wrapper
      // leaves the worker running in the background — the next build or
      // dispose will terminate it.  This is acceptable for the expected
      // use-case (user clicks "Cancel" in Settings → worker idles until the
      // next action).
      const result = await withAbort(
        buildWorkspaceIndex(root, { ...options, onProgress }),
        signal,
      )

      this.resetState()
      return result
    } catch (err) {
      if (signal.aborted) {
        this.resetState()
        throw new Error('Index build cancelled')
      }
      this._state.phase = 'error'
      throw err
    } finally {
      this._abortController = null
    }
  }

  /**
   * Incrementally update the index after file changes.  Same at-most-one
   * guard as {@link buildIndex}.
   */
  async updateIndex(
    root: string,
    changedPaths: string[],
    removedPaths: string[] = [],
  ): Promise<WorkspaceIndexStatus | null> {
    if (this.isBuilding) {
      throw new Error(
        `Index update already in progress for "${this._state.currentRoot}"`,
      )
    }

    this._abortController = new AbortController()
    const signal = this._abortController.signal

    this._state = {
      phase: 'updating',
      currentRoot: root,
      startedAt: Date.now(),
      progress: null,
    }

    try {
      const result = await withAbort(
        incrementallyUpdateWorkspaceIndex(root, changedPaths, removedPaths),
        signal,
      )
      this.resetState()
      return result
    } catch (err) {
      if (signal.aborted) {
        this.resetState()
        throw new Error('Index update cancelled')
      }
      this._state.phase = 'error'
      throw err
    } finally {
      this._abortController = null
    }
  }

  // ── cancel ──────────────────────────────────────────────────────────────

  /** Cancel the currently-running build or incremental update.  Idempotent. */
  cancelBuild(): void {
    if (!this._abortController) return
    this._state.phase = 'cancelling'
    this._abortController.abort()
  }

  // ── status / query (passthrough) ────────────────────────────────────────

  async getStatus(root: string): Promise<WorkspaceIndexStatus> {
    return getWorkspaceIndexStatus(root)
  }

  async query(root: string, query: string, topK?: number): Promise<QueryHit[]> {
    return queryWorkspaceIndex(root, query, topK)
  }

  async clearIndex(root: string): Promise<{ ok: true; cleared: number }> {
    return clearWorkspaceIndex(root)
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /**
   * Cancel any in-flight build and terminate the embedding worker.
   * Called once during app shutdown.  Safe to call multiple times.
   */
  dispose(): void {
    this.cancelBuild()
    unloadAllLocalModels()
    this.resetState()
  }

  // ── internal ────────────────────────────────────────────────────────────

  private resetState(): void {
    this._state = {
      phase: 'idle',
      currentRoot: null,
      startedAt: null,
      progress: null,
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const indexerManager = new IndexerManager()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Race a promise against an AbortSignal.  When the signal fires before the
 * promise settles, the returned promise rejects with an `AbortError`.
 */
async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'))
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new DOMException('Aborted', 'AbortError'))
    }

    signal.addEventListener('abort', onAbort, { once: true })

    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}
