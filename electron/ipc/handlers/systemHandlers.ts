/**
 * Miscellaneous system / UX IPC handlers that don't fit elsewhere.
 *
 *   - `clipboard:read-png-image`          clipboard PNG → base64 data
 *   - `renderer-prefs:get` / `:patch`     mirror localStorage ↔ userData
 *   - `tab-autocomplete:request-completion` / `:cancel`
 *   - `system:desktop-notify`             native OS notification
 *   - `debug:session-log`                 renderer → main NDJSON debug sink
 *                                         (uses `.on`, not `.handle`)
 */
import { app, clipboard, Notification, type IpcMain } from 'electron'
import { loadSettings } from '../../settings/settingsStore'
import { sendToMainWindow } from '../../window/mainWindow'
import { loadRendererPrefs, mergeRendererPrefs } from '../../rendererPrefs/store'
import { cancelTabCompletion, handleTabCompletion } from '../../autocomplete/handler'
import { emitSessionDebugLog } from '../../debugSessionLog'
import { taskRuntimeStore } from '../../tools/TaskRuntimeStore'
import { taskManager } from '../../tools/TaskManager'

export function registerSystemHandlers(ipcMain: IpcMain): void {
  // --- Clipboard: read PNG image from system clipboard ---
  ipcMain.handle('clipboard:read-png-image', () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    return img.toPNG().toString('base64')
  })

  // --- Renderer prefs: mirror localStorage <-> userData ---
  ipcMain.handle('renderer-prefs:get', () => {
    return loadRendererPrefs(app.getPath('userData'))
  })

  ipcMain.handle('renderer-prefs:patch', (_event, patch: Record<string, string>) => {
    mergeRendererPrefs(app.getPath('userData'), patch)
    return { ok: true }
  })

  // --- Tab autocomplete ---
  ipcMain.handle('tab-autocomplete:request-completion', async (_event, params: unknown) => {
    const req = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    return handleTabCompletion(
      {
        prefix: typeof req.prefix === 'string' ? req.prefix : '',
        suffix: typeof req.suffix === 'string' ? req.suffix : '',
        language: typeof req.language === 'string' ? req.language : undefined,
        filePath: typeof req.filePath === 'string' ? req.filePath : undefined,
      },
      loadSettings(),
    )
  })

  ipcMain.handle('tab-autocomplete:cancel', () => {
    cancelTabCompletion()
    return { ok: true }
  })

  // --- Desktop notification ---
  ipcMain.handle('system:desktop-notify', (_event, params: unknown) => {
    const p = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    const title = typeof p.title === 'string' ? p.title : '星构Astra'
    const body = typeof p.body === 'string' ? p.body : ''
    if (Notification.isSupported()) {
      new Notification({ title, body }).show()
    }
    return { ok: true }
  })

  // Renderer → main NDJSON debug sink. Preload forwards `debug:session-log`
  // events to this `ipcMain.on` listener so the main process can append a
  // structured line to repo-root `debug-e88e1a.log` (gated by the
  // `ASTRA_AGENT_DEBUG_LOG` env flag). Without this listener the preload
  // `send` is silently dropped — see `electron/preload.ts` and `electron/
  // debugSessionLog.ts` for the other half of the wiring.
  ipcMain.on('debug:session-log', (_event, payload) => {
    try {
      if (payload && typeof payload === 'object') {
        emitSessionDebugLog(payload as Record<string, unknown>)
      }
    } catch (err) {
      console.warn('[Main] debug:session-log handler failed:', err)
    }
  })
}

/**
 * Wire the task runtime output bus to the renderer's `ai:stream-event`
 * channel. NOTE: must use the same channel the renderer subscribes to via
 * `ai.onStreamEvent`; `useTaskOutput` consumes `task:output-chunk` through
 * that same event pipe.
 */
export function wireTaskRuntimeOutputBridge(): void {
  taskRuntimeStore.onChunkAppended((event) => {
    sendToMainWindow('ai:stream-event', {
      type: 'task:output-chunk',
      taskId: event.taskId,
      stream: event.stream,
      text: event.text,
      timestamp: event.timestamp,
      status: event.status,
    })
  })
}

/**
 * Wire the V2 TaskManager lifecycle stream to the renderer's
 * `ai:stream-event` channel. upstream parity for the `fs.watch` +
 * in-process signal pair that `useTasksV2` consumes in the upstream
 * REPL — 星构Astra reuses the existing IPC pipe so a single
 * subscription on the renderer side surfaces both V1 tool-result
 * driven todos AND V2 task lifecycle deltas.
 *
 * The renderer's `taskListSlice` subscribes to `task-v2:lifecycle`
 * events and merges them into its `tasksV2` map.
 */
export function wireTaskManagerV2LifecycleBridge(): void {
  taskManager.subscribe((event) => {
    // Payload field names match `StreamEvent.taskV2Event` /
    // `StreamEvent.taskV2Task` so the renderer's typed selector
    // doesn't need to cast through `Record<string, unknown>`.
    sendToMainWindow('ai:stream-event', {
      type: 'task-v2:lifecycle',
      taskV2Event: event.type,
      taskV2Task: event.task,
    })
  })
}
