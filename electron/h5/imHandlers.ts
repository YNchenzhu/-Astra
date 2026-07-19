/**
 * IPC handlers for the Settings → IM panel (WeChat credentials + pairing).
 * Reads/writes `~/.claude/adapters.json` via {@link imConfig}.
 */
import type { IpcMain } from 'electron'
import { z } from 'zod'
import { validatedHandle } from '../ipc/validatedHandle'
import { generatePairingCode, loadImConfig, saveImConfig, unbindWechat } from './imConfig'
import { getH5ServerStatus, startH5Server } from './h5Server'
import { pollWechatLogin, startWechatLogin } from './wechatBinding'
import {
  getWechatSidecarStatus,
  restartWechatSidecar,
  startWechatSidecar,
  stopWechatSidecar,
} from './wechatSidecar'

const imConfigPatch = z.tuple([
  z.object({
    serverUrl: z.string().optional(),
    defaultProjectDir: z.string().optional(),
    wechat: z
      .object({
        accountId: z.string().optional(),
        baseUrl: z.string().optional(),
        botToken: z.string().optional(),
        allowedUsers: z.array(z.string()).optional(),
      })
      .optional(),
  }),
])

/** Suggested `ADAPTER_SERVER_URL` derived from the running H5 server. */
function suggestedServerUrl(): string {
  const { running, host, port } = getH5ServerStatus()
  if (!running || !port) return ''
  const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return `ws://${h}:${port}`
}

export function registerImHandlers(_ipcMain: IpcMain): void {
  validatedHandle('im:get-config', z.tuple([]), () => ({
    config: loadImConfig(),
    suggestedServerUrl: suggestedServerUrl(),
  }))

  validatedHandle('im:set-config', imConfigPatch, async (_event, [patch]) => {
    const config = saveImConfig(patch as Parameters<typeof saveImConfig>[0])
    // Bounce the sidecar so credential / workdir edits take effect. Ensure the
    // bridge server is up first (it auto-runs once WeChat is bound).
    if (config.wechat.hasBotToken && config.wechat.accountId) {
      await startH5Server()
      restartWechatSidecar()
    }
    return { config, suggestedServerUrl: suggestedServerUrl() }
  })

  validatedHandle('im:generate-pairing-code', z.tuple([]), () => {
    const { code, expiresAt } = generatePairingCode()
    return { code, expiresAt, config: loadImConfig() }
  })

  // ── WeChat QR bot-account binding ──────────────────────────────
  validatedHandle('im:wechat-start-login', z.tuple([]), async () => {
    return startWechatLogin()
  })

  validatedHandle('im:wechat-poll-login', z.tuple([z.string().min(1)]), async (_event, [sessionKey]) => {
    const result = await pollWechatLogin(sessionKey)
    // On success the credentials are already persisted; bring the bridge server
    // up (it auto-runs once WeChat is bound) and (re)launch the sidecar.
    if (result.connected) {
      await startH5Server()
      restartWechatSidecar()
    }
    return { ...result, config: loadImConfig() }
  })

  validatedHandle('im:wechat-unbind', z.tuple([]), () => {
    stopWechatSidecar()
    return { config: unbindWechat() }
  })

  // ── WeChat adapter sidecar (bundled, auto-managed) ─────────────
  validatedHandle('im:wechat-sidecar-status', z.tuple([]), () => getWechatSidecarStatus())
  validatedHandle('im:wechat-sidecar-start', z.tuple([]), () => startWechatSidecar())
  validatedHandle('im:wechat-sidecar-stop', z.tuple([]), () => {
    stopWechatSidecar()
    return getWechatSidecarStatus()
  })
}
