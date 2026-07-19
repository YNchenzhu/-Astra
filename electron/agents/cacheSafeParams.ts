/**
 * CacheSafeParams — serialisable snapshot of an agent run's "turn-end" surface.
 *
 * Mirrors upstream `src/utils/forkedAgent.ts > CacheSafeParams` + the
 * `saveCacheSafeParams` / `getLatestCacheSafeParams` snapshot slot in
 * `src/query/stopHooks.ts`.
 *
 * ## What it is
 *
 * A frozen, **plain-data** copy of everything a downstream worker needs to
 * reconstruct (or fork off) the main conversation:
 *
 *   - `systemPromptLayers` — the three-layer system prompt split (system /
 *     user / userMessage). Keeping the split rather than the merged string
 *     means an off-thread fork can re-merge with its own layer overrides.
 *   - `messages` — deep-cloned `apiMessages`. Cloning is mandatory: the
 *     parent agentic loop will keep mutating its own array after the
 *     snapshot is taken; without the clone the worker would see a moving
 *     target (or worse, mutate the parent's transcript mid-turn).
 *   - `agentId` / `streamConversationId` — routing keys so the worker can
 *     attribute its result back to the originating session.
 *   - `model` / `providerConfigName` — model + provider identity needed to
 *     re-create a stream call without re-resolving the alias chain.
 *   - `workspacePath` — captured cwd for tools that resolve relative paths.
 *   - `capturedAt` — wall clock the snapshot was taken (UI age, GC age).
 *
 * ## Who reads it
 *
 * 1. **Background research/analysis workers** — e.g. an off-line "what
 *    changed in this turn?" summariser that runs after the main agent has
 *    moved on. The snapshot is the only safe way to re-enter the same
 *    `messages` graph without racing the main loop's `syncAgentContextConversation`
 *    overwrite.
 * 2. **`/btw`-style side queries** (if/when added) — ask a parallel question
 *    on top of the prior turn's context without the main loop blocking on
 *    the answer.
 * 3. **Remote IM adapters** — Telegram / Lark / WeChat / DingTalk handlers
 *    that fan a turn out to a remote viewer. The serialisable shape means
 *    we can JSON-encode and ship it across the IPC boundary without
 *    leaking AbortControllers, AsyncLocalStorage references, etc.
 *
 * ## Who writes it
 *
 * Only the **main thread** (i.e. `AgentContext.agentId === 'main'`). Sub-
 * agents and forked children must never overwrite the slot — their context
 * is partial and may not contain the full turn history the parent saw. The
 * guard lives in {@link saveCacheSafeParamsFromContext}.
 *
 * The save itself is fired from {@link registerQueryStopHook} so every
 * query-loop exit path (completed / aborted / hook-stopped / max-turns)
 * lands one snapshot.
 */

import { registerQueryStopHook } from '../ai/agenticLoop/queryStopHooks'
import type { SystemPromptLayers } from '../ai/systemPrompt'
import type { AgentId } from '../tools/ids'
import { getAgentContext } from './agentContext'

/** Public, serialisable surface — plain data, no class instances. */
export interface CacheSafeParams {
  /** Wall-clock when the snapshot was taken (ms epoch). */
  capturedAt: number
  /**
   * Always the originating main agent for now (`'main'`); future expansion
   * may snapshot sub-agents under their own conversation key. Kept on the
   * struct so consumers don't need to peek at the storage key.
   */
  agentId: AgentId
  /** Renderer conversation id (parallel chat tabs); undefined for headless. */
  streamConversationId?: string
  /**
   * Three-layer system prompt split. `userMessageContext` ships separately
   * as a `<system-reminder>` user-meta message at `messages[0]` per the
   * builder contract — see `electron/ai/orchestrationContext.ts`.
   */
  systemPromptLayers?: SystemPromptLayers
  /** Merged system prompt string (already-rendered convenience copy). */
  systemPrompt: string
  /** Deep-cloned `apiMessages` from the active run. */
  messages: Array<Record<string, unknown>>
  /** Effective model id (post alias resolution). */
  model: string
  /** Provider config name — sufficient to re-resolve via providerConfig store. */
  providerConfigName?: string
  /** Captured `workspacePath` at snapshot time, for relative-path tools. */
  workspacePath?: string
}

/**
 * Per-conversation latest-snapshot slot, plus a `null`-key fallback for
 * headless / single-conversation runs. upstream's REPL keeps a single global
 * slot because it's single-conversation; our Electron main process serves
 * concurrent chat tabs (each with its own `streamConversationId`), so we
 * partition by key.
 */
const HEADLESS_KEY = '__headless__'
const latestSnapshots = new Map<string, CacheSafeParams>()

function snapshotKey(conversationId: string | undefined): string {
  const id = conversationId?.trim()
  return id && id.length > 0 ? id : HEADLESS_KEY
}

/**
 * Deep clone a value via `structuredClone` with a JSON fallback for old
 * runtimes / payloads with functions (which shouldn't appear in API
 * messages anyway). Matches the same defensive shape used by
 * `syncAgentContextConversation` and `deepCloneMessage` in forkSubagent.ts.
 */
function deepCloneJsonish<T>(value: T): T {
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(value)
    }
  } catch {
    /* fall through */
  }
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return value
  }
}

/**
 * Build a CacheSafeParams from explicit pieces. Pure — no I/O, no ALS read.
 * Use this when the caller already has the assembled fields (e.g. the
 * main-loop terminate path that knows the final `apiMessages`).
 */
export function createCacheSafeParams(input: {
  agentId: AgentId
  streamConversationId?: string
  systemPrompt: string
  systemPromptLayers?: SystemPromptLayers
  messages: Array<Record<string, unknown>>
  model: string
  providerConfigName?: string
  workspacePath?: string
}): CacheSafeParams {
  return {
    capturedAt: Date.now(),
    agentId: input.agentId,
    streamConversationId: input.streamConversationId,
    systemPrompt: input.systemPrompt,
    systemPromptLayers: input.systemPromptLayers
      ? deepCloneJsonish(input.systemPromptLayers)
      : undefined,
    messages: deepCloneJsonish(input.messages),
    model: input.model,
    providerConfigName: input.providerConfigName,
    workspacePath: input.workspacePath,
  }
}

/**
 * Save a snapshot for the given conversation. Idempotent — overwrites the
 * slot. Caller is responsible for gating (see
 * {@link saveCacheSafeParamsFromContext} for the main-thread-only rule).
 */
export function saveCacheSafeParams(params: CacheSafeParams): void {
  latestSnapshots.set(snapshotKey(params.streamConversationId), params)
}

/**
 * Pull the latest snapshot for a conversation. Returns `undefined` when
 * the conversation has not yet completed a turn (or was cleared).
 */
export function getLatestCacheSafeParams(
  conversationId: string | undefined,
): CacheSafeParams | undefined {
  return latestSnapshots.get(snapshotKey(conversationId))
}

/**
 * Clear a single conversation's slot (e.g. on chat close). Returns the
 * pre-clear snapshot, if any — useful for one-shot consumers that want
 * "take and clear" semantics.
 */
export function clearCacheSafeParams(
  conversationId: string | undefined,
): CacheSafeParams | undefined {
  const key = snapshotKey(conversationId)
  const prev = latestSnapshots.get(key)
  latestSnapshots.delete(key)
  return prev
}

/** Test-only: drop every snapshot regardless of conversation. */
export function __resetAllCacheSafeParamsForTests(): void {
  latestSnapshots.clear()
}

/**
 * Snapshot the current ALS AgentContext if and only if we're on the main
 * thread (`agentId === 'main'`). Sub-agents and forked children never get
 * to write the slot — their messages array is a fork of the main one and
 * would corrupt downstream consumers that expect the user's actual
 * transcript.
 *
 * Returns the saved snapshot, or `null` if no save happened (no ALS
 * context, or non-main agent).
 */
export function saveCacheSafeParamsFromContext(extra?: {
  /** Override for tests / kernel paths that compute these outside ALS. */
  systemPrompt?: string
  providerConfigName?: string
  workspacePath?: string
}): CacheSafeParams | null {
  const ctx = getAgentContext()
  if (!ctx) return null
  // Sub-agents and forked workers must NOT clobber the main snapshot.
  if (ctx.agentId !== 'main') return null

  const params = createCacheSafeParams({
    agentId: ctx.agentId,
    streamConversationId: ctx.streamConversationId,
    systemPrompt: extra?.systemPrompt ?? ctx.systemPrompt ?? '',
    systemPromptLayers: ctx.systemPromptLayers,
    messages: ctx.messages,
    model: ctx.model ?? '',
    providerConfigName: extra?.providerConfigName,
    workspacePath: extra?.workspacePath,
  })
  saveCacheSafeParams(params)
  return params
}

/**
 * Priority slot for the snapshot hook in the unified query-stop-hooks
 * pipeline. upstream parity § 0-99 = state-capture band: snapshots run
 * **before** memory extraction / dream scheduling / UI surface updates
 * so those later hooks can read `getLatestCacheSafeParams()` and see a
 * coherent turn-end view. Legacy `registerTerminationCleanup` calls
 * land at priority 100 (see `queryTermination.ts`) so this 10 slot
 * comfortably stays ahead of them.
 */
export const CACHE_SAFE_PARAMS_HOOK_PRIORITY = 10

/**
 * Wire snapshot saving into the agentic-loop termination cleanup pipeline.
 *
 * Migration note (§A1 of the 5-piece-set wiring): this used to call
 * `registerTerminationCleanup` (which assigned an implicit priority of
 * 100). It now registers directly on {@link registerQueryStopHook} with
 * explicit priority {@link CACHE_SAFE_PARAMS_HOOK_PRIORITY} = 10 so
 * downstream consumers in the legacy bracket can `await
 * getLatestCacheSafeParams(...)` and reliably see the snapshot. The
 * legacy `runTerminationCleanup` path still drives the same hook list
 * via the queryStopHooks generator — both surfaces converge on a
 * single ordered pipeline.
 *
 * Every query loop exit path (completed / aborted / max_turns / hook
 * stopped / iteration boundary) lands a snapshot for the main thread.
 * Failure inside the hook is caught + logged by the queryStopHooks
 * generator itself, so a failed snapshot never cascades into the
 * user-facing exit notification.
 */
let snapshotHookInstalled = false
export function installCacheSafeParamsSnapshotHook(): () => void {
  if (snapshotHookInstalled) {
    return () => {
      /* already installed — caller-side cleanup is a no-op */
    }
  }
  snapshotHookInstalled = true
  const unregister = registerQueryStopHook({
    name: 'cacheSafeParams.snapshot',
    priority: CACHE_SAFE_PARAMS_HOOK_PRIORITY,
    run: () => {
      saveCacheSafeParamsFromContext()
    },
  })
  return () => {
    unregister()
    snapshotHookInstalled = false
  }
}
