/**
 * Electron main-process entry point.
 *
 * Kept deliberately thin — the real work is split across:
 *
 *   electron/settings/settingsStore.ts       persistence
 *   electron/window/mainWindow.ts            BrowserWindow lifecycle
 *   electron/ipc/handlers/*Handlers.ts       per-domain IPC registration
 *   electron/lifecycle/appBootstrap.ts       app.whenReady orchestration
 *   electron/lifecycle/appShutdown.ts        before-quit / activate / quit
 *
 * Only things that MUST run before `app.whenReady()` live here:
 *   1. Bundle data layout + Chromium cache health check (must precede
 *      any `disk-cache-dir` switch and any `app.whenReady` opening a
 *      file handle to the cache dir).
 *   2. Command-line switches (`--disk-cache-dir`,
 *      `disableHardwareAcceleration`) — Electron freezes them after
 *      ready.
 *   3. Bundle-file logging (so early crashes still produce a log).
 *   4. Global process error traps so uncaught shutdown races don't
 *      surface as crash dialogs.
 */
import { app } from 'electron'

import {
  ensureBundleDataLayout,
  getBundleChromiumCacheDir,
  getBundleLogsDir,
} from './paths/bundleDataPaths'
import { runCacheHealthCheck } from './paths/cacheHealthCheck'
import {
  attachConsoleToBundleLog,
  initBundleFileLogging,
} from './logging/bundleLogger'
import { bootstrapApp } from './lifecycle/appBootstrap'
import { installAppLifecycleHandlers } from './lifecycle/appShutdown'


/** Install-side root: user memory, Chromium disk cache, main.log */
const BUNDLE_DATA_ROOT = ensureBundleDataLayout(app)

// Crash/kill recovery: if the previous run didn't mark a clean shutdown,
// purge Chromium's HTTP / Code / GPU / Dawn / blob / SW cache dirs now,
// BEFORE `app.whenReady()` opens any handle to them. Prevents the
// cascading `ERR_CACHE_READ_FAILURE` + blank-UI symptom seen after the
// app is force-closed (Windows "App not responding" dialog, Task Manager
// kill, OS reboot during streaming).
runCacheHealthCheck(app)
app.commandLine.appendSwitch('disk-cache-dir', getBundleChromiumCacheDir(app))
initBundleFileLogging(getBundleLogsDir(app))
attachConsoleToBundleLog()

if (process.platform === 'win32' && process.env.ASTRA_DISABLE_GPU !== '0') {
  app.disableHardwareAcceleration()
}

process.env.APP_ROOT = __dirname

// Prevent child_process "Object has been destroyed" during shutdown from crashing the app
process.on('uncaughtException', (error) => {
  if (error instanceof TypeError && error.message.includes('has been destroyed')) {
    return
  }
  console.error('Uncaught exception:', error)
})

// Prevent unhandled promise rejections from crashing the process
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason)
})

installAppLifecycleHandlers()

app.whenReady().then(() => bootstrapApp(BUNDLE_DATA_ROOT)).catch((err) => {
  console.error('[Main] Bootstrap failed:', err)
  // Attempt to show an error dialog before exiting. `dialog` is loaded
  // lazily inside the catch to avoid adding a top-level import that could
  // itself throw during an already-failed bootstrap.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dialog } = require('electron')
    dialog.showErrorBox(
      '启动失败',
      `应用程序初始化失败:\n\n${err instanceof Error ? err.message : String(err)}\n\n请检查日志文件或重新安装应用。`,
    )
  } catch {
    // Dialog failed too — just exit
  }
  app.exit(1)
})
