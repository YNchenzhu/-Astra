/**
 * IPC handlers for Bundle lifecycle (list / activate / reload).
 *
 * All channels live under the `bundle:` namespace so they cannot collide
 * with existing IPC surface. Registration is one-shot via
 * `registerBundleHandlers(app, getMainWindow)` from `main.ts`.
 *
 * Activation side effects:
 *   1. `activateBundle` in the registry (triggers onActiveBundleChange listeners).
 *   2. Persist the new id to settings under `bundles.lastActive` so the
 *      choice survives restart.
 *   3. Broadcast `bundle:activated` to all open windows so renderer stores
 *      can refresh UI without polling.
 *
 * Subsequent phases (E1-E3) will hook additional listeners onto
 * `onActiveBundleChange` for conversation partitioning — those are added
 * at the subsystem level, not here.
 */

import fs from 'node:fs'
import path from 'node:path'
import { dialog, type App, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { validatedHandle } from './validatedHandle'
import {
  activateBundle,
  getActiveBundle,
  getActiveBundleId,
  getLoadErrors,
  listBundles,
  onActiveBundleChange,
  onBundleChange,
  reloadAndActivate,
  reloadBundles,
  resolveInitialActiveBundleId,
  saveAgentEntry,
  saveTeamEntry,
  saveBundleMeta,
  createBundle as createBundleEntry,
  deleteBundle as deleteBundleEntry,
  addAgent as addAgentEntry,
  removeAgent as removeAgentEntry,
  addTeam as addTeamEntry,
  removeTeam as removeTeamEntry,
  snapshotBundleForExport,
  importBundleFromJson,
} from '../agents/bundles/bundleRegistry'
import type { Bundle, PromptSection } from '../agents/bundles/types'
import { splitPromptIntoSections } from '../agents/bundles/bundleSerialize'
import { getBuiltInAgent } from '../agents/builtInAgents'
import { rebuildAgentDefinitions, toolRegistry } from '../tools/registry'
import { getAllSkills } from '../skills/skillTool'
import { peekMcpManagerIfInitialized } from '../mcp/handlers'
import { getActiveAgents } from '../agents/activeAgentRegistry'
import { clearAllVerificationGateState } from '../planning/verificationGateState'
import { clearAllPendingPlanVerification } from '../planning/planVerificationState'
import { clearActivePlan } from '../planning/planRuntime'
import { clearPlanStepGuardEpisodes } from '../ai/agenticLoop/planStepGuard'
import { clearPlanlessGuardState } from '../ai/agenticLoop/planlessImplementationGuard'
import { unspawnAndUntrackAgent } from '../agents/agentLifecycle'
import { asAgentId } from '../tools/ids'

import { BUNDLE_IPC_CHANNELS } from './bundleHandlersChannels'
import { readPersistedLastActiveBundleId, persistLastActiveBundleId } from './bundleHandlersSettings'
import { broadcastActivated, broadcastBundleChanged, broadcastBundleDeleted } from './bundleHandlersBroadcast'
import { invalidateAllSystemPromptMemoCaches } from '../ai/systemPrompt'
import {
  MAX_SHORT,
  MAX_LONG,
  agentPatchSchema,
  teamPatchSchema,
  bundlePatchSchema,
} from './bundleHandlersSchemas'
import { registerTryRunHandlers } from './bundleHandlersTryRun'

// ─── Public registration ─────────────────────────────────────────────

export interface BundleHandlersOptions {
  /** Invoked lazily to fetch the current main window — avoids capturing
   *  a stale reference before `createWindow()` runs. */
  getMainWindow: () => BrowserWindow | null | undefined
  /** Returns the current workspace path (for project-tier bundle dir). */
  getWorkspacePath: () => string | undefined | null
}

/**
 * Register all bundle IPC handlers. Call once from `app.whenReady`.
 * Safe to call even before `reloadBundles` has run — every handler
 * returns the current (possibly empty) registry state.
 */
export function registerBundleHandlers(
  app: App,
  { getMainWindow, getWorkspacePath }: BundleHandlersOptions,
): void {
  // bundle:list — return all loaded bundles + any load errors.
  validatedHandle(
    BUNDLE_IPC_CHANNELS.list,
    z.tuple([]),
    async () => ({
      bundles: listBundles(),
      activeId: getActiveBundleId() ?? null,
      errors: getLoadErrors(),
    }),
  )

  // bundle:get-active — return the active bundle (or null).
  validatedHandle(
    BUNDLE_IPC_CHANNELS.getActive,
    z.tuple([]),
    async () => ({
      bundle: getActiveBundle() ?? null,
      activeId: getActiveBundleId() ?? null,
    }),
  )

  // bundle:activate — switch active bundle, persist, broadcast.
  validatedHandle(
    BUNDLE_IPC_CHANNELS.activate,
    z.tuple([z.string().min(1)]),
    async (_event, [id]) => {
      const next = activateBundle(id) // throws if unknown
      await persistLastActiveBundleId(id)
      broadcastActivated(getMainWindow, next)
      return { bundle: next, activeId: next.meta.id }
    },
  )

  // bundle:reload — rescan preset/user/project tiers; preserve active
  // id when still present, otherwise fall back to code-dev / first.
  validatedHandle(
    BUNDLE_IPC_CHANNELS.reload,
    z.tuple([]),
    async () => {
      const workspacePath = getWorkspacePath() ?? undefined
      const previousActive = getActiveBundleId()
      const result = reloadBundles(app, workspacePath)

      // Re-resolve active: try to keep previous, fallback to last-persisted,
      // then to registry default.
      const persisted = readPersistedLastActiveBundleId()
      const preferred = previousActive ?? persisted
      const nextId = resolveInitialActiveBundleId(preferred)
      let active: Bundle | undefined
      if (nextId) {
        active = activateBundle(nextId)
        if (nextId !== previousActive) {
          await persistLastActiveBundleId(nextId)
          broadcastActivated(getMainWindow, active)
        }
      }

      return {
        bundles: result.loaded,
        errors: result.errors,
        activeId: active?.meta.id ?? null,
      }
    },
  )

  // bundle:get-load-errors — for UI diagnostics panel.
  validatedHandle(
    BUNDLE_IPC_CHANNELS.getLoadErrors,
    z.tuple([]),
    async () => getLoadErrors(),
  )

  // bundle:save-agent — apply a partial update to one agent inside a
  // bundle. Preset-sourced bundles are auto-forked into the user tier.
  // Returns the freshly persisted Bundle so the renderer can swap its
  // local copy atomically.
  validatedHandle(
    BUNDLE_IPC_CHANNELS.saveAgent,
    z.tuple([
      z.object({
        bundleId: z.string().min(1).max(256),
        agentType: z.string().min(1).max(256),
        patch: agentPatchSchema,
      }),
    ]),
    async (_event, [{ bundleId, agentType, patch }]) => {
      const workspacePath = getWorkspacePath() ?? undefined
      const persisted = saveAgentEntry(bundleId, agentType, patch, app, workspacePath)
      return { bundle: persisted, activeId: getActiveBundleId() ?? null }
    },
  )

  // bundle:save-team — Sprint 2c.1 counterpart to save-agent. Applies
  // a partial update to one team inside a bundle. Preset-sourced
  // bundles are auto-forked into the user tier.
  validatedHandle(
    BUNDLE_IPC_CHANNELS.saveTeam,
    z.tuple([
      z.object({
        bundleId: z.string().min(1).max(256),
        teamId: z.string().min(1).max(256),
        patch: teamPatchSchema,
      }),
    ]),
    async (_event, [{ bundleId, teamId, patch }]) => {
      const workspacePath = getWorkspacePath() ?? undefined
      const persisted = saveTeamEntry(bundleId, teamId, patch, app, workspacePath)
      return { bundle: persisted, activeId: getActiveBundleId() ?? null }
    },
  )

  // bundle:get-capability-catalog — list all names the Workbench's
  // capability editors (Tab 3) can offer as options. Renderer caches
  // the result for the session; call again to refresh after the user
  // registers new MCP servers or installs new skills.
  //
  // The three catalogs are independently computed, so a failure in
  // one (e.g. MCP manager not yet initialized) doesn't starve the
  // others. We prefer returning partial lists over surfacing an
  // error — the Workbench UI falls back to "just show what we have".
  validatedHandle(
    BUNDLE_IPC_CHANNELS.getCapabilityCatalog,
    z.tuple([]),
    async () => {
      // Tools: pull straight off the central registry. Includes every
      // tool that's ever been registered, including MCP proxy tools
      // (prefixed `mcp__…`) once a server is connected.
      const toolNames: string[] = (() => {
        try {
          return toolRegistry.list().slice().sort((a, b) => a.localeCompare(b))
        } catch (err) {
          console.warn('[bundleHandlers] toolRegistry.list failed:', err)
          return []
        }
      })()

      // Skills: loaded by the skill tool at app boot; empty array
      // until skills are loaded (normal for fresh installs).
      const skillNames: string[] = (() => {
        try {
          return getAllSkills()
            .map((s) => (typeof s.name === 'string' ? s.name : String(s)))
            .filter((n) => n.length > 0)
            .sort((a, b) => a.localeCompare(b))
        } catch {
          return []
        }
      })()

      // MCP servers: only the savedconnection names (not live status).
      // Using the peek accessor so we don't force the manager into
      // existence if no server has been configured yet.
      const mcpServerNames: string[] = (() => {
        const mgr = peekMcpManagerIfInitialized()
        if (!mgr) return []
        try {
          return mgr
            .loadConfigs()
            .map((c) => c.name)
            .filter((n) => typeof n === 'string' && n.length > 0)
            .sort((a, b) => a.localeCompare(b))
        } catch {
          return []
        }
      })()

      return {
        tools: toolNames,
        skills: skillNames,
        mcpServers: mcpServerNames,
      }
    },
  )

  // bundle:get-builtin-prompt — return the runtime system prompt for a
  // built-in agent, pre-split into structured sections the Workbench
  // can hand to its PromptSectionsEditor. Used by the "载入并转为可编辑"
  // action when the user wants to override a built-in agent's prompt.
  //
  // The `bundleId` argument is accepted for future-proofing (a custom
  // agent stored inside a Bundle may choose to re-base on its built-in
  // sibling) but Sprint 2b.1 only resolves built-in agents globally.
  validatedHandle(
    BUNDLE_IPC_CHANNELS.getBuiltinPrompt,
    z.tuple([
      z.object({
        bundleId: z.string().min(1).max(256),
        agentType: z.string().min(1).max(256),
      }),
    ]),
    async (_event, [{ agentType }]) => {
      const builtin = getBuiltInAgent(agentType)
      if (!builtin) {
        return {
          ok: false as const,
          error: `未找到名为 "${agentType}" 的内置智能体（该智能体可能由工作包自定义提供）。`,
        }
      }
      let raw = ''
      try {
        raw = builtin.getSystemPrompt() ?? ''
      } catch (err) {
        return {
          ok: false as const,
          error: `读取内置提示词失败：${(err as Error).message}`,
        }
      }
      const sections: PromptSection[] = splitPromptIntoSections(raw)
      return { ok: true as const, raw, sections }
    },
  )

  // bundle:save-meta — update bundle top-level / meta fields.
  validatedHandle(
    BUNDLE_IPC_CHANNELS.saveMeta,
    z.tuple([
      z.object({
        bundleId: z.string().min(1).max(256),
        patch: bundlePatchSchema,
      }),
    ]),
    async (_event, [{ bundleId, patch }]) => {
      const workspacePath = getWorkspacePath() ?? undefined
      const persisted = saveBundleMeta(
        bundleId,
        patch as Record<string, unknown>,
        app,
        workspacePath,
      )
      return { bundle: persisted, activeId: getActiveBundleId() ?? null }
    },
  )

  // bundle:create — new bundle (blank or forked from copyFromId).
  validatedHandle(
    BUNDLE_IPC_CHANNELS.create,
    z.tuple([
      z.object({
        id: z.string().min(1).max(128),
        name: z.string().max(MAX_SHORT).optional(),
        description: z.string().max(MAX_LONG).optional(),
        domain: z.string().max(MAX_SHORT).optional(),
        author: z.string().max(MAX_SHORT).optional(),
        copyFromId: z.string().max(256).optional(),
      }),
    ]),
    async (_event, [params]) => {
      const workspacePath = getWorkspacePath() ?? undefined
      const bundle = createBundleEntry(params, app, workspacePath)
      return { bundle, activeId: getActiveBundleId() ?? null }
    },
  )

  // bundle:delete — remove a non-preset bundle. Reassigns active to
  // `code-dev` (or the first remaining) if the deleted one was active.
  validatedHandle(
    BUNDLE_IPC_CHANNELS.delete,
    z.tuple([z.string().min(1).max(256)]),
    async (_event, [bundleId]) => {
      const workspacePath = getWorkspacePath() ?? undefined
      const outcome = deleteBundleEntry(bundleId, app, workspacePath)

      // Tell all renderers the bundle is gone so they can drop it
      // from their local list without a full re-fetch.
      broadcastBundleDeleted(getMainWindow, bundleId)

      // If active changed as a consequence, broadcast activation so
      // the renderer rehydrates (conversation partition, etc.).
      if (outcome.newActive) {
        broadcastActivated(getMainWindow, outcome.newActive)
        // Persist the fallback as last-active so startup lands there.
        try {
          await persistLastActiveBundleId(outcome.newActive.meta.id)
        } catch (err) {
          console.warn('[bundleHandlers] persist lastActive after delete failed:', err)
        }
      }

      return {
        deletedOnDisk: outcome.deletedOnDisk,
        newActiveId: outcome.newActive?.meta.id ?? null,
        deletedId: bundleId,
      }
    },
  )

  // bundle:add-agent — push a new agent onto a bundle's agents[].
  validatedHandle(
    BUNDLE_IPC_CHANNELS.addAgent,
    z.tuple([
      z.object({
        bundleId: z.string().min(1).max(256),
        seed: z.object({
          agentType: z.string().min(1).max(MAX_SHORT),
          displayName: z.string().max(MAX_SHORT).optional(),
          whenToUse: z.string().max(MAX_LONG).optional(),
          capability: z.string().max(MAX_LONG).optional(),
          systemPromptRaw: z.string().max(MAX_LONG * 4).optional(),
          isPrimary: z.boolean().optional(),
        }),
      }),
    ]),
    async (_event, [{ bundleId, seed }]) => {
      const workspacePath = getWorkspacePath() ?? undefined
      const persisted = addAgentEntry(bundleId, seed, app, workspacePath)
      return { bundle: persisted, activeId: getActiveBundleId() ?? null }
    },
  )

  // bundle:remove-agent — drop an agent from a bundle; rejected when
  // it's the last one or a team member references it.
  validatedHandle(
    BUNDLE_IPC_CHANNELS.removeAgent,
    z.tuple([
      z.object({
        bundleId: z.string().min(1).max(256),
        agentType: z.string().min(1).max(MAX_SHORT),
      }),
    ]),
    async (_event, [{ bundleId, agentType }]) => {
      const workspacePath = getWorkspacePath() ?? undefined
      const persisted = removeAgentEntry(bundleId, agentType, app, workspacePath)
      return { bundle: persisted, activeId: getActiveBundleId() ?? null }
    },
  )

  // bundle:add-team — append a new team (empty members by default).
  validatedHandle(
    BUNDLE_IPC_CHANNELS.addTeam,
    z.tuple([
      z.object({
        bundleId: z.string().min(1).max(256),
        seed: z.object({
          id: z.string().min(1).max(MAX_SHORT),
          name: z.string().max(MAX_SHORT).optional(),
          description: z.string().max(MAX_LONG).optional(),
          coordination: z
            .enum(['solo', 'parallel', 'sequential', 'swarm', 'coordinator'])
            .optional(),
        }),
      }),
    ]),
    async (_event, [{ bundleId, seed }]) => {
      const workspacePath = getWorkspacePath() ?? undefined
      const persisted = addTeamEntry(bundleId, seed, app, workspacePath)
      return { bundle: persisted, activeId: getActiveBundleId() ?? null }
    },
  )

  // bundle:remove-team — drop a team.
  validatedHandle(
    BUNDLE_IPC_CHANNELS.removeTeam,
    z.tuple([
      z.object({
        bundleId: z.string().min(1).max(256),
        teamId: z.string().min(1).max(MAX_SHORT),
      }),
    ]),
    async (_event, [{ bundleId, teamId }]) => {
      const workspacePath = getWorkspacePath() ?? undefined
      const persisted = removeTeamEntry(bundleId, teamId, app, workspacePath)
      return { bundle: persisted, activeId: getActiveBundleId() ?? null }
    },
  )

  // bundle:export — save the bundle's JSON to a user-chosen path.
  //
  // We bundle the `dialog.showSaveDialog` call into main so:
  //   1. The renderer doesn't need to handle file system paths.
  //   2. The save dialog is parented to the correct BrowserWindow
  //      (modal behavior on macOS, correct focus on Windows).
  validatedHandle(
    BUNDLE_IPC_CHANNELS.export,
    z.tuple([z.object({ bundleId: z.string().min(1).max(256) })]),
    async (_event, [{ bundleId }]) => {
      const bundle = snapshotBundleForExport(bundleId)
      if (!bundle) {
        return {
          ok: false as const,
          canceled: false,
          error: `未找到工作包 "${bundleId}"`,
        }
      }

      const win = getMainWindow()
      const defaultFilename = `${bundleId.replace(/[^a-z0-9_-]+/gi, '_')}.bundle.json`
      const saveResult = win
        ? await dialog.showSaveDialog(win, {
            title: '导出工作包',
            defaultPath: defaultFilename,
            filters: [{ name: '工作包 JSON', extensions: ['json'] }],
          })
        : await dialog.showSaveDialog({
            title: '导出工作包',
            defaultPath: defaultFilename,
            filters: [{ name: '工作包 JSON', extensions: ['json'] }],
          })

      if (saveResult.canceled || !saveResult.filePath) {
        return { ok: false as const, canceled: true }
      }

      try {
        // Pretty-print for human legibility when users peek the file.
        const content = JSON.stringify(bundle, null, 2)
        fs.writeFileSync(saveResult.filePath, content, 'utf-8')
        return { ok: true as const, filePath: saveResult.filePath }
      } catch (err) {
        return {
          ok: false as const,
          canceled: false,
          error: `写入失败:${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },
  )

  // bundle:import — read a user-chosen JSON file and install as a new
  // bundle. Returns a discriminated result the UI can branch on:
  //   - `canceled` — user dismissed dialog
  //   - `id-conflict` — a non-preset bundle has the same id; the UI
  //     offers "use suggested id / replace / cancel" then retries
  //   - `preset-conflict` — id hits a preset; UI must rename
  //   - `parse-error` / `write-error` — pass error text through
  //   - `ok` — success; bundle loaded into the registry
  validatedHandle(
    BUNDLE_IPC_CHANNELS.import,
    z.tuple([
      z
        .object({
          /** Caller-supplied file path (skips dialog) — used when UI
           *  retries after conflict. */
          filePath: z.string().max(8192).optional(),
          newId: z
            .string()
            .max(128)
            .regex(/^[a-z0-9_-]+$/i, { message: 'ID 只能包含字母/数字/下划线/破折号' })
            .optional(),
          replaceExisting: z.boolean().optional(),
        })
        .strict(),
    ]),
    async (_event, [{ filePath, newId, replaceExisting }]) => {
      const workspacePath = getWorkspacePath() ?? undefined

      let sourcePath = filePath
      if (!sourcePath) {
        const win = getMainWindow()
        const openResult = win
          ? await dialog.showOpenDialog(win, {
              title: '导入工作包',
              filters: [{ name: '工作包 JSON', extensions: ['json'] }],
              properties: ['openFile'],
            })
          : await dialog.showOpenDialog({
              title: '导入工作包',
              filters: [{ name: '工作包 JSON', extensions: ['json'] }],
              properties: ['openFile'],
            })
        if (openResult.canceled || openResult.filePaths.length === 0) {
          return { ok: false as const, canceled: true }
        }
        sourcePath = openResult.filePaths[0]
      }

      let raw: string
      try {
        raw = fs.readFileSync(sourcePath, 'utf-8')
      } catch (err) {
        return {
          ok: false as const,
          canceled: false,
          reason: 'parse-error' as const,
          error: `读取文件失败:${err instanceof Error ? err.message : String(err)}`,
        }
      }

      const outcome = importBundleFromJson(
        raw,
        path.basename(sourcePath),
        app,
        workspacePath,
        { newId, replaceExisting },
      )
      if (!outcome.ok) {
        return {
          ok: false as const,
          canceled: false,
          reason: outcome.reason,
          error: outcome.error,
          attemptedId: outcome.attemptedId,
          suggestedId: outcome.suggestedId,
          // Echo the file path so the UI can retry without re-opening
          // the system dialog.
          filePath: sourcePath,
        }
      }
      return {
        ok: true as const,
        bundle: outcome.bundle,
        usedId: outcome.usedId,
        replaced: outcome.replaced,
      }
    },
  )

  // ─── Sprint 2d.a: Try-Run (sandbox single-shot LLM preview) ────
  registerTryRunHandlers(app, getMainWindow, getWorkspacePath)

  // bundle:get-orchestrator-status — expose MultiAgentOrchestrator runtime
  // telemetry to the Workbench runtime panel.
  validatedHandle(
    BUNDLE_IPC_CHANNELS.getOrchestratorStatus,
    z.tuple([]),
    async () => {
      const { getMultiAgentOrchestrator } = await import(
        '../agents/multiAgentOrchestratorSingleton'
      )
      const orch = getMultiAgentOrchestrator()
      return orch.getRuntimeStatus()
    },
  )

  // Wire registry mutation listener → IPC broadcast. This is the
  // counterpart to `activated` for content changes. We register it
  // once per registerBundleHandlers call; the registry dedupes by
  // Set identity, so multiple calls (shouldn't happen in prod) would
  // still behave correctly.
  onBundleChange((bundle, info) => {
    broadcastBundleChanged(getMainWindow, bundle, info.reason)
    // Stage 8 — bundle content changed (agent saved, fork, reload).
    // The bundle's primary-agent prompt feeds the custom-system path's
    // `customSystemPrompt`, so a content edit to the active bundle
    // invalidates whatever userContext-layer / instruction-section memo
    // is sitting in `systemPrompt.ts`. Synchronous (audit fix) — a
    // dynamic import would resolve on a microtask, leaving a race
    // window where the next streamHandler call still sees stale cache.
    invalidateAllSystemPromptMemoCaches()
    // Tier fork fallout: if the active bundle was forked from preset
    // to user, downstream conversation partitioning keys on `bundleId`
    // (not tier), so no extra action is needed here. The broadcast
    // alone is sufficient — renderer-side bundleStore swaps the copy.
  })

  // 当 active bundle 切换 **或** 其内容变化时(activateBundle /
  // saveAgentEntry / addAgent / removeAgent / fork 等都会 emit),
  // 重建 Agent 工具的路由列表——这样主 AI 才能在用户切换 Bundle
  // 后立刻"看到"新 Bundle 里定义的智能体。否则路由列表是工具
  // 注册那一刻冻结的,Bundle 里加的"申报材料智能体"之类永远
  // 不会出现在主 AI 的可选 subagent_type 里。
  //
  // 当 bundle ID 真正发生变化时(不是同 bundle 内编辑 agent),
  // 还要清掉前一个 bundle 遗留的 running sub-agents 和 orchestrator
  // 注册树,避免跨 bundle 污染(医疗 bundle 的 agent 不该在切换到
  // 法律 bundle 后还能 SendMessage)。
  onActiveBundleChange((next, previous) => {
    if (!next) return
    const switched = previous !== undefined && previous.meta.id !== next.meta.id
    if (switched) {
      // Interrupt + unregister all running agents from the previous bundle.
      //
      // Previously this was two independent for-loops (one over the orchestrator
      // tree, one over the registry) which had to stay coverage-aligned by hand
      // — if a future spawn path registered into only one side, the other loop
      // would silently skip its agents. Now we drive everything from a single
      // `getActiveAgents()` snapshot and let `unspawnAndUntrackAgent` drop both
      // sides idempotently (see `agentLifecycle.ts`).
      try {
        for (const [agentId, agent] of getActiveAgents()) {
          if (agent.status !== 'running') continue
          try {
            agent.abortController?.abort()
          } catch {
            /* ignore */
          }
          try {
            unspawnAndUntrackAgent(asAgentId(agentId))
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore registry failures */
      }

      // Cross-work-package host-state hygiene. The verification gate, the
      // pending plan-verification tracker, and the active plan pointer are
      // all coding-oriented per-conversation state that must NOT survive a
      // work-package switch: a stale `mutationCount` from the code bundle
      // would otherwise mis-fire build/test verification nudges after the
      // user switches to (say) a writing bundle and back, and a leftover
      // plan pointer would surface the wrong work package's progress.
      try {
        clearAllVerificationGateState()
      } catch {
        /* ignore */
      }
      try {
        clearAllPendingPlanVerification()
      } catch {
        /* ignore */
      }
      try {
        clearActivePlan()
      } catch {
        /* ignore */
      }
      try {
        clearPlanStepGuardEpisodes()
      } catch {
        /* ignore */
      }
      try {
        clearPlanlessGuardState()
      } catch {
        /* ignore */
      }
    }
    try {
      rebuildAgentDefinitions(getWorkspacePath() ?? undefined, app.getPath('userData'))
    } catch (err) {
      console.warn('[bundleHandlers] rebuildAgentDefinitions on active change failed:', err)
    }
    // Stage 8 — bundle activation switched. The custom-system path
    // gates `customSystemPrompt` on the active bundle's primary agent,
    // and the userContext-layer cache key indirectly depends on bundle
    // content via the skill index. Drop the prompt memos so the next
    // turn rebuilds against the new bundle. Synchronous (audit fix).
    invalidateAllSystemPromptMemoCaches()
  })
}

// ─── Startup convenience ─────────────────────────────────────────────

/**
 * Bootstrap sequence meant to be invoked from `app.whenReady` AFTER
 * `setDiskSettingsLoader` is wired (so `readPersistedLastActiveBundleId`
 * returns the real value). Performs the initial scan + activation and
 * returns the chosen bundle so callers can use its metadata (e.g. to
 * title the main window).
 */
export function bootstrapBundles(
  app: App,
  workspacePath: string | undefined | null,
): Bundle | undefined {
  const persistedId = readPersistedLastActiveBundleId()
  return reloadAndActivate(app, workspacePath, persistedId)
}
