/**
 * Todo/Task mode switch — 星构Astra extension of upstream's
 * `src/utils/tasks.ts#isTodoV2Enabled`.
 *
 * ## What "mode" means here
 *
 * 星构Astra intentionally diverges from upstream. upstream treats V1
 * (TodoWrite) and V2 (TaskCreate / TaskUpdate / TaskList / TaskGet) as
 * **mutually exclusive** — interactive REPL gets V2, SDK / headless gets
 * V1. 星构Astra's product surface is always GUI, and the two tool
 * families serve **complementary** UX roles:
 *
 *   - **V1 / TodoWrite** — ephemeral in-conversation checklist. The model
 *     plans `3–7` short steps, the user sees them appear live in the task
 *     panel, the whole list auto-clears when all items reach `completed`.
 *     No persistence, no owner, no dependencies. Cheap and immediate.
 *   - **V2 / Task*** — durable managed tasks. Persisted to disk
 *     (`v2-task-manager.json`), carry `owner` for cross-agent claim,
 *     `blockedBy` dependencies, lifecycle events for memory extraction.
 *     Survive restarts; suitable for "project tasks" the user / other
 *     agents reference across conversations.
 *
 * ## Modes
 *
 *   - `'coexist'` (default) — both V1 and V2 are registered AND enabled
 *     simultaneously. The model picks per-task: short conversational
 *     plan → TodoWrite; long-lived / cross-agent work → TaskCreate. The
 *     system prompt teaches the model the heuristic; the two stale
 *     nudges coordinate so the user never sees both fire about the same
 *     idle stretch.
 *   - `'v2-only'` — legacy upstream "interactive" parity: only Task*
 *     are visible to the model; TodoWrite hidden. Useful when a
 *     deployment wants the persistence guarantees end-to-end.
 *   - `'v1-only'` — legacy upstream "headless" parity: only TodoWrite
 *     visible; Task* hidden. Useful for SDK / scripted contexts.
 *
 * ## Resolution order (highest priority first)
 *
 *   1. `readDiskSettings().todoMode === 'coexist' | 'v2-only' | 'v1-only'`
 *      — user-visible toggle exposed through Settings (no env var
 *      required). Survives restarts.
 *   2. Legacy env override `ASTRA_TODO_V1` / `CLAUDE_CODE_TODO_V1`
 *      truthy → behave as `'v1-only'`. Kept so existing CI / scripts
 *      that set the env don't break.
 *   3. Default → `'coexist'`.
 *
 * ## Mid-process flips ARE supported
 *
 * The mode is read on every call (no caching, for test injectability)
 * and — unlike the pre-coexist design — flipping mid-process IS
 * supported because `registryAgentTools.initAgentTools()` now registers
 * BOTH `TodoWrite` and the `Task*` quad unconditionally. The mode only
 * narrows VISIBILITY via each tool's `isEnabled()` gate, which
 * `toolRegistry.getAll()` consumers honour on every read.
 *
 * What gets refreshed on a mid-process flip:
 *   - `Tool.isEnabled()` gates → next `getAll()` reflects the new mode
 *   - `getAlwaysAvailableSubagentTools()` → next sub-agent spawn sees the union
 *   - Stale-{todo,task} nudge collectors → next post-tool call gates correctly
 *   - `loadConversation`'s V1 restore branch → next conversation load
 *
 * What stays stale until the next process restart:
 *   - The cached system prompt (`renderTaskManagementBullet` output). The
 *     `writeDiskSettingsPartial` path in `settingsAccess.ts` triggers
 *     `invalidateAllSystemPromptMemoCaches`, so flipping via the
 *     Settings UI / IPC handler IS picked up. Env-var changes mid-process
 *     are NOT — they're a developer-only escape hatch.
 *
 * Net consequence: changing `settings.todoMode` via the Settings UI
 * takes effect immediately (modulo the next tool-list build). Env-var
 * flips ideally happen before `electron:dev` launches. Tests freely
 * flip mid-test by mocking `readDiskSettings()` or setting
 * `ASTRA_TODO_MODE` — both layers are re-read on every gate check.
 */

import { readDiskSettings } from '../settings/settingsAccess'

const V1_ENV_KEYS = [
  'ASTRA_TODO_V1',
  'CLAUDE_CODE_TODO_V1',
] as const

export type TodoMode = 'coexist' | 'v1-only' | 'v2-only'

function readEnvVarSafe(key: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } }
  return g.process?.env?.[key]
}

function envTruthy(raw: string | undefined): boolean {
  if (!raw) return false
  const s = raw.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

/** Resolve the current mode. Reads disk settings + env on every call. */
export function getTodoMode(): TodoMode {
  // 1. Explicit disk setting wins.
  let fromDisk: unknown
  try {
    fromDisk = readDiskSettings().todoMode
  } catch {
    fromDisk = undefined
  }
  if (fromDisk === 'coexist' || fromDisk === 'v1-only' || fromDisk === 'v2-only') {
    return fromDisk
  }

  // 2. Explicit env override (`ASTRA_TODO_MODE=coexist|v1-only|v2-only`).
  const explicit = readEnvVarSafe('ASTRA_TODO_MODE')?.trim().toLowerCase()
  if (explicit === 'coexist' || explicit === 'v1-only' || explicit === 'v2-only') {
    return explicit
  }

  // 3. Legacy single-flag env override (upstream compat) → V1-only.
  for (const key of V1_ENV_KEYS) {
    if (envTruthy(readEnvVarSafe(key))) return 'v1-only'
  }

  // 4. Default to coexist.
  return 'coexist'
}

/**
 * `true` when both V1 + V2 surfaces are simultaneously active.
 * In this mode the model is taught (via system prompt) to pick
 * TodoWrite for ephemeral session checklists and TaskCreate for
 * durable cross-conversation work.
 */
export function isTodoCoexistMode(): boolean {
  return getTodoMode() === 'coexist'
}

/**
 * `true` when V2 (TaskManager-backed Task* tools) should be exposed
 * to the model. Returns `true` in `'coexist'` and `'v2-only'`.
 *
 * Kept as the primary export to preserve all existing call sites —
 * they continue to mean "V2 is available".
 */
export function isTodoV2Enabled(): boolean {
  const mode = getTodoMode()
  return mode === 'coexist' || mode === 'v2-only'
}

/**
 * `true` when V1 (TodoWrite) should be exposed to the model.
 * Returns `true` in `'coexist'` and `'v1-only'`.
 */
export function isTodoV1Enabled(): boolean {
  const mode = getTodoMode()
  return mode === 'coexist' || mode === 'v1-only'
}
