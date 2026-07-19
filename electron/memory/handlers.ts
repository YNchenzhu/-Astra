/**
 * IPC handlers for the memory system.
 * Enhanced with upstream-style features: AI recall, system prompt, path validation, drain.
 *
 * F3 audit fix (2026-05): every channel is now wrapped in `validatedHandle`
 * with a Zod schema declared in `electron/ipc/schemas.ts`. Before this pass
 * the renderer could ship arbitrary shapes — including objects with
 * `__proto__` keys, megabyte-scale strings, or filenames with `../` —
 * straight into `service.createMemory` / `deleteMemory` / `updateMemory`.
 * The schemas don't replace the service-layer sandbox (which still resolves
 * filenames under known roots), they just kill obvious abuse + give the
 * caller a clear error instead of a silent half-success.
 */

import { app } from 'electron'
import path from 'node:path'
import * as service from './service'
import { reinitializeLspServerManager } from '../lsp/manager'
import { getWorkspacePath, setWorkspacePath } from '../tools/workspaceState'
import { reloadSkillsForWorkspace } from '../skills/reloadForWorkspace'
import { reconnectFilesystemMcpServersAfterWorkspaceChange } from '../mcp/handlers'
import { acceptWorkspacePathFromRenderer } from '../security/workspaceAccept'
import { readDiskSettings } from '../settings/settingsAccess'
import { rebuildAgentDefinitions } from '../tools/registry'
import { startWorkspaceIndexWatcher } from '../embedding/workspaceIndexWatcher'
import { validatedHandle } from '../ipc/validatedHandle'
import {
  memoryListArgs,
  memoryGetArgs,
  memoryCreateArgs,
  memoryUpdateArgs,
  memoryDeleteArgs,
  memorySetWorkspaceArgs,
  memoryRecallArgs,
  memoryRecallAiArgs,
  memoryScanMemdirArgs,
  memoryTeamSyncArgs,
  memoryLastRecalledArgs,
  memoryToggleEnabledArgs,
  memoryGetSystemPromptSectionArgs,
  memoryValidateDirectoryArgs,
  memoryResetRecallStateArgs,
  memoryDrainExtractionsArgs,
} from '../ipc/schemas'

/** Avoid duplicate LSP re-inits when workspace store + MemoryPanel both sync the same path. */
let lastLspWorkspaceSynced: string | null | undefined

export function registerMemoryHandlers(_ipcMain: Electron.IpcMain): void {
  // `_ipcMain` retained as a parameter for API stability (other registrars in
  // electron/main.ts call it positionally); `validatedHandle` resolves the
  // singleton itself, so we no longer need to thread the instance through.

  validatedHandle('memory:list', memoryListArgs, () => {
    return service.listMemories()
  })

  validatedHandle('memory:get', memoryGetArgs, (_event, [filename]) => {
    return service.getMemory(filename)
  })

  validatedHandle('memory:create', memoryCreateArgs, (_event, [params]) => {
    return service.createMemory(params)
  })

  validatedHandle('memory:update', memoryUpdateArgs, (_event, [params]) => {
    return service.updateMemory(params)
  })

  validatedHandle('memory:delete', memoryDeleteArgs, (_event, [filename]) => {
    return { success: service.deleteMemory(filename) }
  })

  validatedHandle(
    'memory:set-workspace',
    memorySetWorkspaceArgs,
    (_event, [workspacePath]) => {
      // Audit fix A2 (2026-05) — gate renderer-supplied workspace paths
      // through the trust boundary before propagating them anywhere. Without
      // this, the renderer could rebase `setWorkspacePath` to an arbitrary
      // location and the G12 fix in `skill:reload` (which trusts
      // `getWorkspacePath()`) would be bypassed.
      const outcome = acceptWorkspacePathFromRenderer(workspacePath, {
        source: 'memory:set-workspace',
      })
      if (!outcome.ok) {
        throw new Error(outcome.reason)
      }
      const trustedPath = outcome.effective || null
      service.setActiveWorkspace(trustedPath ?? '')
      setWorkspacePath(trustedPath)
      service.resetMemoryRecallState()
      void reconnectFilesystemMcpServersAfterWorkspaceChange().catch((err) =>
        console.warn('[MCP] reconnect filesystem MCP after workspace change:', err),
      )

      // LSP 重启去重标记必须同步更新(两个调用点可能在同一 tick 连续同
      // 步同一路径),但实际 reinit 推迟到下面的 setImmediate 里执行。
      const userData = app.getPath('userData')
      const root = trustedPath ?? undefined
      const key = root ?? null
      const shouldReinitLsp = key !== lastLspWorkspaceSynced
      if (shouldReinitLsp) lastLspWorkspaceSynced = key

      // 2026-07 性能修复:技能重载 / Agent 重建 / LSP 重启都是同步扫盘
      // 或进程级重活,此前串行挡在 IPC 返回之前 —— 渲染进程要等它们全部
      // 跑完才能发出文件树请求,大工作区下左侧栏白屏数秒。
      //
      // 推迟策略:先留一个 150ms 的宽限窗口,让渲染进程在收到本 IPC 的
      // 返回后发出的 fs:file-tree 请求先到达并完成(depth=1 只需几次
      // readdir,毫秒级);三块重活之间再用 setImmediate 让步,即使窗口
      // 没赶上,晚到的文件树 readdir 也能插在重活块之间执行。若期间工作
      // 区又被切换(快速连开两个文件夹),用 getWorkspacePath() 比对后
      // 跳过过期任务。
      const DEFERRED_WARMUP_GRACE_MS = 150
      const yieldToLoop = () => new Promise<void>((r) => setImmediate(r))
      setTimeout(() => {
        void (async () => {
          if (getWorkspacePath() !== trustedPath) return
          try {
            reloadSkillsForWorkspace(trustedPath)
          } catch (err) {
            console.warn('[memory:set-workspace] deferred skills reload failed:', err)
          }

          await yieldToLoop()
          if (getWorkspacePath() !== trustedPath) return
          try {
            const st = readDiskSettings()
            // Fallback must match every other call site (appBootstrap /
            // settingsHandlers / agentsHandlers / settingsStore defaults):
            // `userData/.agents`. The previous `process.resourcesPath` fallback
            // pointed at a read-only, nonexistent dir in packaged builds
            // (Program Files\...\resources\.agents) — custom agents silently
            // vanished after a workspace switch when the settings file predated
            // the `agentStoragePath` key.
            const agentStoragePath =
              (typeof st.agentStoragePath === 'string' && st.agentStoragePath.trim()
                ? st.agentStoragePath.trim()
                : path.join(app.getPath('userData'), '.agents'))
            rebuildAgentDefinitions(getWorkspacePath(), agentStoragePath, undefined)
          } catch (err) {
            console.warn('[memory:set-workspace] deferred agent rebuild failed:', err)
          }

          await yieldToLoop()
          if (getWorkspacePath() !== trustedPath) return
          if (shouldReinitLsp) {
            try {
              reinitializeLspServerManager(root, userData, {
                bypassOpenclaudeNotStarted: true,
              })
            } catch (err) {
              console.warn('[memory:set-workspace] deferred LSP reinit failed:', err)
            }
          }

          void startWorkspaceIndexWatcher(trustedPath).catch((err) =>
            console.warn('[workspaceIndexWatcher] start after workspace change:', err),
          )
        })()
      }, DEFERRED_WARMUP_GRACE_MS)

      return { success: true }
    },
  )

  validatedHandle(
    'memory:recall-for-prompt',
    memoryRecallArgs,
    (_event, [userMessage]) => {
      return service.recallForPrompt(userMessage)
    },
  )

  validatedHandle(
    'memory:recall-for-prompt-ai',
    memoryRecallAiArgs,
    async (_event, [payload]) => {
      // Back-compat: legacy callers pass a bare userMessage. New callers can
      // pass an object `{ userMessage, alreadySurfaced }` so renderer-side
      // ad-hoc invocations don't lose dedup against memories already
      // surfaced earlier in the same conversation. (`opts.shared` is
      // intentionally NOT forwarded — the shared query embedding is a
      // main-process compute artefact and isn't transferable across IPC.)
      if (
        typeof payload === 'object' &&
        payload !== null &&
        !Array.isArray(payload) &&
        ('userMessage' in payload || 'alreadySurfaced' in payload)
      ) {
        const obj = payload as {
          userMessage?: unknown
          alreadySurfaced?: ReadonlyArray<string>
        }
        const surfacedSet = Array.isArray(obj.alreadySurfaced)
          ? new Set(obj.alreadySurfaced.filter((s): s is string => typeof s === 'string'))
          : undefined
        return service.recallForPromptAI(obj.userMessage, surfacedSet)
      }
      return service.recallForPromptAI(payload)
    },
  )

  validatedHandle('memory:scan-memdir', memoryScanMemdirArgs, () => {
    return service.scanMemdir()
  })

  validatedHandle('memory:team-sync', memoryTeamSyncArgs, () => {
    return service.runTeamMemorySync()
  })

  validatedHandle('memory:last-recalled', memoryLastRecalledArgs, () => {
    return service.getLastRecalledForUi()
  })

  validatedHandle(
    'memory:toggle-enabled',
    memoryToggleEnabledArgs,
    (_event, [{ filename, enabled }]) => {
      return service.toggleMemoryEnabled(filename, enabled)
    },
  )

  validatedHandle(
    'memory:get-system-prompt-section',
    memoryGetSystemPromptSectionArgs,
    (_event, [autoMemoryEnabled]) => {
      return service.getMemorySystemPromptSection(autoMemoryEnabled)
    },
  )

  validatedHandle(
    'memory:validate-directory',
    memoryValidateDirectoryArgs,
    (_event, [dir]) => {
      return service.validateMemoryDirectory(dir)
    },
  )

  validatedHandle('memory:reset-recall-state', memoryResetRecallStateArgs, () => {
    service.resetMemoryRecallState()
    return { success: true }
  })

  validatedHandle('memory:drain-extractions', memoryDrainExtractionsArgs, async () => {
    await service.drainPendingExtractions()
    return { success: true }
  })
}
