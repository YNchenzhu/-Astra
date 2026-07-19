/**
 * Main BrowserWindow lifecycle.
 *
 * Extracted from `electron/main.ts`. Owns:
 *   - single-instance window creation
 *   - renderer-crash auto-reload with circuit-breaker (3 crashes / 30 s)
 *   - lifecycle-log sink wiring so `bundleLogger` can push into the
 *     renderer's `应用` Output tab
 *
 * Callers get the live window handle through {@link getMainWindow} and
 * can broadcast events with {@link sendToMainWindow}.
 */
import path from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { setLifecycleLogSink } from '../logging/bundleLogger'
import { requestAppQuitFromWindowClose } from '../lifecycle/shutdownState'

/** Only ever hand off http(s) URLs to the OS browser — never file:/custom protocols. */
function openExternally(url: string): void {
  if (/^https?:\/\//i.test(url)) {
    void shell.openExternal(url).catch(() => {
      /* OS handler missing — nothing sensible to do */
    })
  }
}

let mainWindow: BrowserWindow | null = null

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/**
 * Best-effort `webContents.send` that no-ops when the window is absent
 * or destroyed. Used by the many IPC bridges that need to push events to
 * the renderer after startup.
 */
export function sendToMainWindow(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send(channel, ...args)
    } catch {
      /* ignore send errors during reload */
    }
  }
}

export function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus()
    return mainWindow
  }

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: '星构Astra',
    // Windows/Linux window + taskbar icon (esp. dev, where the exe icon is
    // Electron's default). Vite copies public/ into dist/, so the packaged
    // path mirrors the `loadFile('../dist/index.html')` layout below.
    icon: VITE_DEV_SERVER_URL
      ? path.join(__dirname, '../public/Astra_CZ_rounded_transparent.ico')
      : path.join(__dirname, '../dist/Astra_CZ_rounded_transparent.ico'),
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // Disable Chromium's background throttling. Without this, when the
      // window loses focus / is occluded, requestAnimationFrame is throttled
      // to ~1Hz and timers are clamped to 1s. That breaks the streaming
      // delta batcher (`src/stores/chat/streamingDeltaBatcher.ts`) — AI
      // deltas pile up in the pending map while the user is in another
      // window, and on return the renderer has to catch up on a large
      // backlog. Combined with `disableHardwareAcceleration` + frameless
      // windows on Windows (software compositor sometimes skips a paint on
      // restore), the UI looks frozen until something forces a relayout.
      backgroundThrottling: false,
    },
    // macOS: keep the traffic-light buttons via hiddenInset.
    // Windows/Linux: `hiddenInset` is a no-op and falls back to the native
    // title bar, which stacks on top of our in-app dark title bar. Use a
    // fully frameless window there so only our custom title bar is shown.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : { frame: false }),
    autoHideMenuBar: true,
  })

  // AI chat renders model-supplied links with `target="_blank"`. Without a
  // window-open handler Electron's default is to spawn a NEW BrowserWindow
  // that loads the remote page with our preload — both a UX bug and an
  // attack surface. Route http(s) to the system browser and deny everything
  // else (file:, custom schemes, …).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url)
    return { action: 'deny' }
  })

  // Same-frame navigation guard: a plain `<a href>` (no target) or a
  // scripted `location.href =` would replace the whole renderer with a
  // remote page. Allow only our own dev-server / packaged-file origins.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isInternal = VITE_DEV_SERVER_URL
      ? url.startsWith(VITE_DEV_SERVER_URL)
      : url.startsWith('file://') || url.startsWith('data:')
    if (!isInternal) {
      event.preventDefault()
      openExternally(url)
    }
  })

  mainWindow.webContents.on('did-finish-load', () => {
    // Route bundle-logger lines (console.* mirror) to the renderer
    // `lifecycle-log` channel so the "应用" Output tab actually receives
    // entries. Without this the `onLifecycleLog` subscriber is inert.
    setLifecycleLogSink((payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          mainWindow.webContents.send('lifecycle-log', payload)
        } catch {
          /* ignore send errors during reload */
        }
      }
    })
  })

  // Prevent renderer crashes from cascading into app quit.
  // Uses a short-window counter: if the renderer gones 3+ times within
  // 30 s we stop auto-reloading and show an in-window error page so the
  // user can recover manually (fixes infinite reload loop on persistent
  // crashes, e.g. bad GPU drivers).
  const crashTimestamps: number[] = []
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Main] Renderer process gone:', details.reason)
    const now = Date.now()
    while (crashTimestamps.length > 0 && now - crashTimestamps[0] > 30_000) {
      crashTimestamps.shift()
    }
    crashTimestamps.push(now)
    if (crashTimestamps.length >= 3) {
      crashTimestamps.length = 0
      if (mainWindow && !mainWindow.isDestroyed()) {
        const html =
          `<html><body style="font-family:sans-serif;padding:32px;color:#cdd6f4;background:#1e1e2e">` +
          `<h2>渲染进程反复崩溃</h2>` +
          `<p>原因：${String(details.reason).replace(/[<>&]/g, '')}。</p>` +
          `<p>已停止自动重载以避免死循环。你可以：</p>` +
          `<ul><li>关闭窗口后重新打开应用</li>` +
          `<li>若在 Windows 下出现 GPU 相关崩溃，尝试设置环境变量 ASTRA_DISABLE_GPU 后重启</li></ul>` +
          `<button onclick="location.reload()">尝试再次重载</button>` +
          `</body></html>`
        mainWindow.webContents
          .loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
          .catch(() => { /* ignore */ })
      }
      return
    }
    if (!mainWindow?.isDestroyed()) {
      mainWindow?.webContents.reload()
    }
  })

  // Safety net for the Windows software-compositor "no-paint-on-restore"
  // glitch. Even with backgroundThrottling disabled, Chromium with
  // `disableHardwareAcceleration` + `frame:false` on Windows sometimes
  // does not request a fresh frame when the window comes back from
  // blurred / minimized state — the renderer holds the last painted
  // bitmap and input feels frozen until the user resizes the window.
  // `webContents.invalidate()` forces a single repaint, costing nothing
  // when the compositor was already going to repaint on its own.
  const requestRepaint = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    try {
      mainWindow.webContents.invalidate()
    } catch {
      /* ignore — window may be tearing down */
    }
  }
  mainWindow.on('focus', requestRepaint)
  mainWindow.on('restore', requestRepaint)
  mainWindow.on('show', requestRepaint)

  mainWindow.on('close', (event) => {
    requestAppQuitFromWindowClose(event, () => app.quit())
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    setLifecycleLogSink(null)
    // BUG-I5 fix: drop in-flight teammate runs as soon as the window
    // they reported into is gone. Without this, a teammate could keep
    // making API calls (and burning tokens) for minutes after the user
    // closed the window. Using a dynamic import keeps this module
    // free of an agents/* dependency cycle.
    import('../agents/teammateRunner')
      .then(({ cancelAllTeammateRuns }) => {
        try {
          cancelAllTeammateRuns()
        } catch (err) {
          console.warn('[mainWindow] cancelAllTeammateRuns failed:', err)
        }
      })
      .catch((err) => {
        console.warn('[mainWindow] failed to load teammateRunner for cleanup:', err)
      })
  })

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  return mainWindow
}
