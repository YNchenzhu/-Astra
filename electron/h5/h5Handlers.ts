/**
 * IPC handlers for the H5 / remote-access settings panel.
 *
 * Non-secret config also lives in the main settings file and is reachable via
 * `settings:get/set`, but token generation (raw token shown once) and server
 * lifecycle control need dedicated channels so secrets never round-trip
 * through the generic settings blob.
 */
import type { IpcMain } from 'electron'
import { z } from 'zod'
import { validatedHandle } from '../ipc/validatedHandle'
import {
  generateAndStoreH5Token,
  loadH5Settings,
  saveH5Settings,
  toH5StatusForRenderer,
} from './h5Settings'
import { getH5ServerStatus, startH5Server, stopH5Server } from './h5Server'

const h5ConfigPatch = z.tuple([
  z.object({
    enabled: z.boolean().optional(),
    allowedOrigins: z.array(z.string()).optional(),
    publicBaseUrl: z.string().nullable().optional(),
    host: z.string().optional(),
    port: z.number().int().positive().max(65535).optional(),
  }),
])

function statusPayload() {
  return {
    settings: toH5StatusForRenderer(loadH5Settings()),
    server: getH5ServerStatus(),
  }
}

export function registerH5Handlers(_ipcMain: IpcMain): void {
  validatedHandle('h5:get-status', z.tuple([]), () => statusPayload())

  validatedHandle('h5:set-config', h5ConfigPatch, async (_event, [patch]) => {
    // Enabling requires a token first — otherwise the server would run with no
    // way for anyone to authenticate (and the UI would silently look "on").
    if (patch.enabled === true && !loadH5Settings().tokenHash) {
      return { ...statusPayload(), error: '请先生成访问 Token，再启用 H5 访问。' }
    }
    // Disabling invalidates the active token (parity with the documented "禁用
    // 即失效" behavior + upstream's disable()): clear the hash/preview so a later
    // re-enable forces a fresh token instead of silently reviving the old one.
    const effectivePatch =
      patch.enabled === false
        ? { ...patch, tokenHash: null, tokenPreview: null }
        : patch
    const next = saveH5Settings(effectivePatch as Parameters<typeof saveH5Settings>[0])
    // Apply server lifecycle to match the new desired state.
    try {
      if (next.enabled) {
        await startH5Server()
      } else {
        await stopH5Server()
      }
    } catch (err) {
      return {
        ...statusPayload(),
        error: err instanceof Error ? err.message : String(err),
      }
    }
    return statusPayload()
  })

  validatedHandle('h5:generate-token', z.tuple([]), () => {
    const { token, preview } = generateAndStoreH5Token()
    return { token, preview, status: statusPayload() }
  })

  validatedHandle('h5:start', z.tuple([]), async () => {
    try {
      await startH5Server()
    } catch (err) {
      return { ...statusPayload(), error: err instanceof Error ? err.message : String(err) }
    }
    return statusPayload()
  })

  validatedHandle('h5:stop', z.tuple([]), async () => {
    await stopH5Server()
    return statusPayload()
  })
}
