/**
 * Bridge so terminal / tools can read the same on-disk settings as `main.ts` `loadSettings`,
 * without importing `main` (circular deps). Registered once from `app.whenReady`.
 */

import { parseDefaultShell, type DefaultShellId } from '../utils/defaultShellSpawn'

let diskSettingsLoader: () => Record<string, unknown> = () => ({})

/**
 * In the tool **utilityProcess** only: main posts a structured-clone snapshot
 * on every RPC (and on init) so `readDiskSettings()` / WebSearch key resolvers
 * see the same merged settings as the main process. Unset in the Electron
 * main bundle — only `electron/tools/workerProcess/workerSideState` calls
 * {@link setToolWorkerDiskSettingsOverride} from the child.
 */
let toolWorkerDiskSettingsOverride: Record<string, unknown> | null = null

export function setDiskSettingsLoader(loader: () => Record<string, unknown>): void {
  diskSettingsLoader = loader
}

export function setToolWorkerDiskSettingsOverride(
  snapshot: Record<string, unknown> | null,
): void {
  toolWorkerDiskSettingsOverride = snapshot
}

export function readDiskSettings(): Record<string, unknown> {
  if (toolWorkerDiskSettingsOverride) {
    return toolWorkerDiskSettingsOverride
  }
  try {
    return diskSettingsLoader()
  } catch {
    return {}
  }
}

export function readDefaultShellId(): DefaultShellId {
  return parseDefaultShell(readDiskSettings().defaultShell)
}

/**
 * 统一的"合并式"磁盘写入入口。`main.ts` 启动阶段通过 {@link setDiskSettingsWriter}
 * 注入真实实现（内部会走与 `settings:set` IPC 相同的 load/merge/save + hooks 链路）。
 *
 * 子系统（如 `electron/context/handlers.ts`）调用此接口时不必知道 settings 文件路径、
 * 加密细节或合并策略，只提交本子系统关心的 partial —— 由主进程集中保证原子合并与
 * PostToolUse/config hook 触发。未注入前调用返回 false，呼叫方应接受"该次不落盘"语义。
 */
let diskSettingsWriter: (partial: Record<string, unknown>) => Promise<void> | void = () => {
  /* not yet wired */
}

export function setDiskSettingsWriter(
  writer: (partial: Record<string, unknown>) => Promise<void> | void,
): void {
  diskSettingsWriter = writer
}

export async function writeDiskSettingsPartial(
  partial: Record<string, unknown>,
): Promise<void> {
  try {
    await diskSettingsWriter(partial)
    // CTX-02: invalidate system prompt caches when settings change
    // so that skills/rules/instruction updates take effect immediately.
    try {
      const { invalidateAllSystemPromptMemoCaches } = await import('../ai/systemPrompt')
      if (typeof invalidateAllSystemPromptMemoCaches === 'function') {
        invalidateAllSystemPromptMemoCaches()
      }
    } catch { /* cache invalidation is advisory */ }
  } catch (err) {
    console.error('[settingsAccess] Failed to persist partial settings:', err)
  }
}
