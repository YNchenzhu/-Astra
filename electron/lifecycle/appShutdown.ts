import { app, BrowserWindow, ipcMain } from 'electron'
import { cancelAllPendingInteractions } from '../ai/interactionState'
import { cancelStream } from '../ai/streamHandler'
import { terminateAllActiveSubAgentWorkers } from '../agents/activeSubAgentWorkers'
import {
  shutdownStaleWatcher,
  shutdownUndoQueue,
  shutdownWal,
} from '../diff'
import { shutdownDiffTxIpc } from '../diff/diffTxIpc'
import { stopWorkspaceIndexWatcher } from '../embedding/workspaceIndexWatcher'
import { disposeEventDrivenNetwork } from '../events/EventDrivenNetwork'
import { stopWorkspaceExplorerWatcher } from '../fs/workspaceExplorerWatcher'
import { indexerManager } from '../indexing/IndexerManager'
import { disposeCustomAgentsWatcherNow } from '../ipc/handlers/agentsHandlers'
import { shutdownLspServerManager } from '../lsp/manager'
import { drainPendingExtractions } from '../memory/service'
import { terminateMemoryWorker } from '../memory/memoryWorkerClient'
import { getSharedMcpManager } from '../mcp/handlers'
import { markCleanShutdown } from '../paths/cacheHealthCheck'
import { hasPendingSettingsSave, waitForPendingSaves } from '../settings/settingsStore'
import { dispose as disposeSkillChangeDetector } from '../skills/skillChangeDetector'
import { killAllSessions } from '../terminal/handler'
import { shutdownCronScheduler } from '../tools/cronScheduler'
import { stopFileWatcher } from '../tools/hooks/fileWatcher'
import { stopRemoteTriggerServer } from '../tools/remoteTriggerServer'
import { killAllShellTasks } from '../tools/tasks/ShellTaskManager'
import { killAllTasks } from '../tools/tasks/taskDispatcher'
import { shutdownAsrtIfRunning } from '../utils/sandbox/asrtAdapter'
import { fileWatcherManager } from '../watchers/fileWatcherManager'
import { createMainWindow, getMainWindow } from '../window/mainWindow'
import { forceKillAllAppOwnedChildProcesses } from './appOwnedChildProcesses'
import { shutdownAppOwnedTmuxResources } from './appOwnedTmuxResources'
import { beginAppShutdown, isAppShutdownInProgress } from './shutdownState'

const GLOBAL_CLEANUP_TIMEOUT_MS = 5000

async function runCleanupStep(
  name: string,
  action: () => void | Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${name} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
  } catch (err) {
    console.warn(`[Main] ${name} cleanup failed:`, err)
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function flushRendererBeforeQuit(): Promise<void> {
  const mainWindow = getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return
  await new Promise<void>((resolve) => {
    const onDone = (): void => {
      clearTimeout(timeout)
      ipcMain.removeListener('lifecycle:renderer-flush-done', onDone)
      resolve()
    }
    const timeout = setTimeout(onDone, 1500)
    ipcMain.once('lifecycle:renderer-flush-done', onDone)
    try {
      mainWindow.webContents.send('lifecycle:before-quit-flush')
    } catch {
      onDone()
    }
  })
}

async function stopAllWatchers(): Promise<void> {
  await Promise.allSettled([
    stopFileWatcher(),
    stopWorkspaceExplorerWatcher(),
    stopWorkspaceIndexWatcher(),
    disposeSkillChangeDetector(),
  ])
  disposeCustomAgentsWatcherNow()
  await fileWatcherManager.dispose()
}

function runImmediateShutdownSweep(): void {
  try { cancelStream() } catch { /* ignore */ }
  try { cancelAllPendingInteractions() } catch { /* ignore */ }
  try { killAllSessions() } catch (err) { console.warn('[Main] killAllSessions failed:', err) }
  try { killAllShellTasks() } catch (err) { console.warn('[Main] killAllShellTasks failed:', err) }
  try { terminateAllActiveSubAgentWorkers() } catch (err) {
    console.warn('[Main] active sub-agent worker termination failed:', err)
  }
  try { forceKillAllAppOwnedChildProcesses() } catch (err) {
    console.warn('[Main] app-owned child process cleanup failed:', err)
  }
  try { shutdownAppOwnedTmuxResources() } catch (err) {
    console.warn('[Main] app-owned tmux cleanup failed:', err)
  }
  try { indexerManager.dispose() } catch (err) { console.warn('[Main] indexer dispose failed:', err) }
  try { disposeEventDrivenNetwork() } catch (err) {
    console.warn('[Main] event network dispose failed:', err)
  }
  try { shutdownStaleWatcher() } catch (err) { console.warn('[Main] shutdownStaleWatcher failed:', err) }
  try { shutdownUndoQueue() } catch (err) { console.warn('[Main] shutdownUndoQueue failed:', err) }
  try { shutdownWal() } catch (err) { console.warn('[Main] shutdownWal failed:', err) }
  try { shutdownDiffTxIpc() } catch (err) { console.warn('[Main] shutdownDiffTxIpc failed:', err) }
}

async function cleanupAppResources(): Promise<void> {
  runImmediateShutdownSweep()

  const mcpManager = getSharedMcpManager()
  await Promise.all([
    runCleanupStep('renderer flush', flushRendererBeforeQuit, 1700),
    runCleanupStep('task shutdown', killAllTasks, 2800),
    runCleanupStep('cron scheduler', shutdownCronScheduler, 1500),
    runCleanupStep('LSP servers', shutdownLspServerManager, 1800),
    runCleanupStep(
      'MCP servers',
      () => mcpManager?.disconnectAll() ?? Promise.resolve(),
      1800,
    ),
    runCleanupStep('file watchers', stopAllWatchers, 1800),
    runCleanupStep('sandbox runtime', shutdownAsrtIfRunning, 1200),
    runCleanupStep('remote trigger server', stopRemoteTriggerServer, 800),
    runCleanupStep('settings persistence', async () => {
      if (hasPendingSettingsSave()) await waitForPendingSaves()
    }, 800),
    runCleanupStep('memory extraction', drainPendingExtractions, 800),
    runCleanupStep('H5 server', async () => {
      const { stopWechatSidecar } = await import('../h5/wechatSidecar')
      const { stopH5Server } = await import('../h5/h5Server')
      stopWechatSidecar()
      await stopH5Server()
    }, 1800),
    runCleanupStep('tool worker', async () => {
      const { disposeToolWorkerHostIfCreated } = await import(
        '../tools/workerProcess/toolWorkerHost'
      )
      await disposeToolWorkerHostIfCreated()
    }, 1200),
    runCleanupStep('sub-agent worker pool', async () => {
      const { getSubAgentWorkerPool } = await import('../agents/subAgentWorkerPool')
      getSubAgentWorkerPool()?.shutdown()
    }, 800),
  ])

  terminateMemoryWorker()
  runImmediateShutdownSweep()

  try {
    const { flushThinkingStreamModelPersistence } = await import(
      '../context/anthropicThinkingTranscript'
    )
    flushThinkingStreamModelPersistence()
  } catch {
    /* ignore */
  }
}

export function installAppLifecycleHandlers(): void {
  app.on('before-quit', async (event) => {
    if (!beginAppShutdown()) return
    event.preventDefault()

    const cleanupTimeout = setTimeout(() => {
      console.warn('[Main] Cleanup timeout reached, forcing quit')
      runImmediateShutdownSweep()
      app.exit(0)
    }, GLOBAL_CLEANUP_TIMEOUT_MS)

    try {
      await cleanupAppResources()
      markCleanShutdown(app)
      clearTimeout(cleanupTimeout)
      app.quit()
    } catch (err) {
      console.error('[Main] Cleanup failed:', err)
      clearTimeout(cleanupTimeout)
      runImmediateShutdownSweep()
      app.exit(0)
    }
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('activate', () => {
    if (!isAppShutdownInProgress() && BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
}
