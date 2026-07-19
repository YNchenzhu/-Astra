/**
 * IPC handlers for the user-settings file.
 *
 * Hosts:
 *   - `settings:get` — read the merged settings object
 *   - `settings:set` — sanitize → load → merge → save → fire side effects
 *   - `wireDiskSettingsAccess()` — registers the loader/writer so internal
 *     subsystems (bundles, LSP, conversation, etc.) persist through the
 *     same pathway instead of creating parallel settings files.
 */
import fs from 'node:fs'
import path from 'node:path'
import { app, type IpcMain } from 'electron'
import { validatedHandle } from '../validatedHandle'
import { settingsSetArgs } from '../schemas'
import { sanitizeSettingsMergePatch } from '../inputSanitizer'
import {
  loadSettings,
  saveSettings,
  withSerializedSave,
  withImmediateSave,
} from '../../settings/settingsStore'
import { setDiskSettingsLoader, setDiskSettingsWriter } from '../../settings/settingsAccess'
import { clearConfigCache } from '../../utils/config'
import { applySandboxFromSettingsRecord } from '../../utils/sandbox'
import { fireConfigChangeHooks } from '../../tools/hooks/runtimeHookBridges'
import { rebuildAgentDefinitions } from '../../tools/registry'
import { getWorkspacePath } from '../../tools/workspaceState'
import {
  applyRendererCustomAgentsFromMain,
  readPersistedCustomAgentsFile,
} from '../../agents/rendererCustomAgentsMain'
import { refreshToolWorkerFromMainDiskSettingsIfEnabled } from '../../tools/workerProcess/toolWorkerHost'

function diffChangedKeys(
  patch: Record<string, unknown>,
  prev: Record<string, unknown>,
  merged: Record<string, unknown>,
): string[] {
  return Object.keys(patch).filter((k) => {
    try {
      return JSON.stringify(prev[k]) !== JSON.stringify(merged[k])
    } catch {
      return true
    }
  })
}

export function registerSettingsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('settings:get', () => {
    return loadSettings()
  })

  validatedHandle('settings:set', settingsSetArgs, async (_event, [rawSettings]) => {
    // Zod guaranteed plain object at the root + no prototype-pollution keys.
    // `sanitizeSettingsMergePatch` does the deep, per-field cleanup (size
    // limits, nested forbidden keys, Date coercion, etc.).
    let settings: Record<string, unknown>
    try {
      settings = sanitizeSettingsMergePatch(rawSettings)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Invalid settings patch',
      }
    }
    try {
      let prev: Record<string, unknown> = {}
      let merged: Record<string, unknown> = {}
      await withSerializedSave(async () => {
        prev = loadSettings()
        merged = { ...prev, ...settings }
        saveSettings(merged)
      })
      const changedKeys = diffChangedKeys(settings, prev, merged)
      if (changedKeys.length > 0) {
        fireConfigChangeHooks(changedKeys)
      }
      if ('sandbox' in settings) {
        applySandboxFromSettingsRecord(merged.sandbox)
      }

      // Dynamic update of data storage paths at runtime
      const newDataStoragePath = (merged.dataStoragePath as string) || app.getPath('userData')
      const newAgentStoragePath = (merged.agentStoragePath as string) || path.join(app.getPath('userData'), '.agents')

      if ('dataStoragePath' in settings && newDataStoragePath) {
        try {
          if (!fs.existsSync(newDataStoragePath)) {
            fs.mkdirSync(newDataStoragePath, { recursive: true })
          }
          import('../../session/service').then(({ setSessionServiceDataStorage }) => {
            setSessionServiceDataStorage(newDataStoragePath)
          })
          import('../../conversation/service').then(({ setConversationServiceDataStorage }) => {
            setConversationServiceDataStorage(newDataStoragePath)
          })
          import('../../tools/cronScheduler').then(({ setCronSchedulerDataDir }) => {
            setCronSchedulerDataDir(newDataStoragePath)
          })
        } catch (e) {
          console.warn('[settings:set] Failed to update data storage path:', e)
        }
      }

      if ('agentStoragePath' in settings && newAgentStoragePath) {
        try {
          if (!fs.existsSync(newAgentStoragePath)) {
            fs.mkdirSync(newAgentStoragePath, { recursive: true })
          }
          // Rebuild agent definitions with the new path
          rebuildAgentDefinitions(getWorkspacePath(), app.getPath('userData'), newAgentStoragePath)
          // Refresh custom agents from the new path
          const persistedAgents = readPersistedCustomAgentsFile(newAgentStoragePath)
          if (persistedAgents.length > 0) {
            applyRendererCustomAgentsFromMain(persistedAgents, {
              workspacePath: getWorkspacePath(),
              userDataPath: newAgentStoragePath,
              agentStoragePath: undefined,
            })
          }
        } catch (e) {
          console.warn('[settings:set] Failed to update agent storage path:', e)
        }
      }

      clearConfigCache()
      refreshToolWorkerFromMainDiskSettingsIfEnabled()
      return { success: true, data: merged }
    } catch (error) {
      console.error('IPC settings:set failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })
}

/**
 * Subsystem 持久化入口：保持与 `settings:set` IPC 的 load → merge → save + hooks
 * 完整语义一致，避免各子系统自行写盘导致的"多套 settings 文件"分裂。
 */
export function wireDiskSettingsAccess(): void {
  setDiskSettingsLoader(() => loadSettings())
  setDiskSettingsWriter(async (partial) => {
    try {
      const prev = loadSettings()
      const merged = { ...prev, ...partial }
      await withImmediateSave(() => {
        saveSettings(merged)
      })
      const changedKeys = diffChangedKeys(partial, prev, merged)
      if (changedKeys.length > 0) {
        fireConfigChangeHooks(changedKeys)
      }
      refreshToolWorkerFromMainDiskSettingsIfEnabled()
    } catch (error) {
      console.error('[Main] diskSettingsWriter failed:', error)
      throw error
    }
  })
}
