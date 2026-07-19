/**
 * Settings persistence layer for the main process.
 *
 * Extracted from `electron/main.ts`. Owns the on-disk `星构Astra-settings.json`
 * file, its load / save primitives, and the two serialization pathways used
 * by upstream callers:
 *
 *   - `withSerializedSave(task)` — the `settings:set` IPC path. Each queued
 *     task reads the freshest on-disk state before merging so concurrent
 *     invocations can't race through `load → merge → save` and clobber one
 *     another.
 *
 *   - `withImmediateSave(task)` — the `setDiskSettingsWriter` subsystem path.
 *     Does NOT chain, so background subsystem writes don't have to wait
 *     behind UI-initiated writes, but still registers the in-flight
 *     reference as `pendingSettingsSave` so `before-quit` can wait on it.
 *
 * This module has no dependency on `BrowserWindow` / IPC — it's pure
 * persistence. Side-effecting concerns (hooks, sandbox re-apply, path
 * reloads) live in `electron/ipc/handlers/settingsHandlers.ts`.
 */
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { writeJsonFileAtomic } from '../fs/atomicWrite'
import {
  decryptSettingsSecretsInPlace,
  encryptSettingsSecretsForDisk,
} from './secretsAtRest'

let SETTINGS_PATH: string | null = null
let pendingSettingsSave: Promise<void> | null = null

/**
 * Serialized writer chain for `settings:set`. Fast concurrent calls used to
 * race through `loadSettings() → merge → saveSettings()`, letting the later
 * write overwrite the earlier one (dropping fields). We now queue every
 * request through this chain so each invocation reads the freshest on-disk
 * state before merging, and the writes are guaranteed observable in arrival
 * order.
 */
let settingsWriteChain: Promise<void> = Promise.resolve()

export function getSettingsPath(): string {
  if (!SETTINGS_PATH) {
    SETTINGS_PATH = path.join(app.getPath('userData'), '星构Astra-settings.json')
  }
  return SETTINGS_PATH
}

function ensureSettingsDir(): void {
  const dir = path.dirname(getSettingsPath())
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function buildDefaultSettings(): Record<string, unknown> {
  return {
    providerId: 'anthropic',
    apiKey: '',
    model: 'claude-sonnet-4-20250514',
    baseUrl: '',
    maxTokens: 64000,
    awsRegion: '',
    projectId: '',
    theme: 'dark',
    outputStyle: 'default',
    language: '',
    uiLocale: 'zh-CN',
    dataStoragePath: app.getPath('userData'),
    agentStoragePath: path.join(app.getPath('userData'), '.agents'),
    injectLspPassiveDiagnostics: true,
    /**
     * Legacy upstream §9.3 gate: when `true`, passive LSP diagnostics are
     * only drained into the system prompt when the agent's tool listing
     * includes a shell execution tool. Defaults `false` so plan-mode and
     * file-only sub-agents still receive diagnostics.
     */
    lspPassiveDiagnosticsRequireShellTool: false,
    /** `legacy`: missing trust file ⇒ all folders trusted. `strict`: missing file ⇒ none trusted. */
    workspaceTrustMode: 'legacy',
  }
}

export function loadSettings(): Record<string, unknown> {
  try {
    ensureSettingsDir()
    const settingsPath = getSettingsPath()
    if (fs.existsSync(settingsPath)) {
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
      decryptSettingsSecretsInPlace(raw)
      return raw
    }
  } catch (error) {
    console.error('Failed to load settings:', error)
  }
  return buildDefaultSettings()
}

export function saveSettings(settings: Record<string, unknown>): void {
  try {
    ensureSettingsDir()
    const settingsPath = getSettingsPath()
    const forDisk = encryptSettingsSecretsForDisk(settings)
    writeJsonFileAtomic(settingsPath, forDisk)
  } catch (error) {
    console.error('Failed to save settings:', error)
    throw error
  }
}

export async function waitForPendingSaves(): Promise<void> {
  if (!pendingSettingsSave) return

  try {
    await Promise.race([
      pendingSettingsSave,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Settings save timeout')), 5000),
      ),
    ])
  } catch (error) {
    console.error('Error waiting for pending saves:', error)
  }
}

export function hasPendingSettingsSave(): boolean {
  return pendingSettingsSave !== null
}

/**
 * Serialized variant: chain the task behind all prior queued writes.
 * The chain is kept pinned even if the task rejects so later calls
 * still serialize instead of fanning out.
 */
export async function withSerializedSave(task: () => Promise<void> | void): Promise<void> {
  const savePromise = settingsWriteChain.then(async () => {
    await task()
  })
  settingsWriteChain = savePromise.catch(() => undefined)
  pendingSettingsSave = savePromise
  try {
    await savePromise
  } finally {
    if (pendingSettingsSave === savePromise) {
      pendingSettingsSave = null
    }
  }
}

/**
 * Non-chained variant used by `setDiskSettingsWriter` so subsystem
 * writes can proceed in parallel with UI-driven `settings:set` queue.
 * Still registers the in-flight reference as `pendingSettingsSave`
 * so `before-quit` can wait on it.
 */
export async function withImmediateSave(task: () => Promise<void> | void): Promise<void> {
  const savePromise = (async () => {
    await Promise.resolve()
    await task()
  })()
  pendingSettingsSave = savePromise
  try {
    await savePromise
  } finally {
    if (pendingSettingsSave === savePromise) {
      pendingSettingsSave = null
    }
  }
}
