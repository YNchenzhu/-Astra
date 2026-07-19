/**
 * IM adapter config bridge. Mirrors `electron/h5/imHandlers.ts`.
 */
import { ipcRenderer } from 'electron'

export interface ImPairedUser {
  userId: string | number
  displayName: string
  pairedAt: number
}

export interface ImConfigView {
  serverUrl: string
  defaultProjectDir: string
  wechat: {
    accountId: string
    baseUrl: string
    botTokenPreview: string | null
    hasBotToken: boolean
    allowedUsers: string[]
    pairedUsers: ImPairedUser[]
  }
  pairing: { active: boolean; expiresAt: number | null }
}

export interface ImConfigPatch {
  serverUrl?: string
  defaultProjectDir?: string
  wechat?: {
    accountId?: string
    baseUrl?: string
    botToken?: string
    allowedUsers?: string[]
  }
}

export interface ImConfigResult {
  config: ImConfigView
  suggestedServerUrl: string
}

export interface WechatStartResult {
  sessionKey: string
  qrDataUrl: string
  message: string
}

export interface WechatPollResult {
  connected: boolean
  status: string
  message: string
  config: ImConfigView
}

export interface WechatSidecarStatus {
  running: boolean
  error: string | null
  bundleAvailable: boolean
}

export interface ImApi {
  getConfig: () => Promise<ImConfigResult>
  setConfig: (patch: ImConfigPatch) => Promise<ImConfigResult>
  generatePairingCode: () => Promise<{ code: string; expiresAt: number; config: ImConfigView }>
  wechatStartLogin: () => Promise<WechatStartResult>
  wechatPollLogin: (sessionKey: string) => Promise<WechatPollResult>
  wechatUnbind: () => Promise<{ config: ImConfigView }>
  wechatSidecarStatus: () => Promise<WechatSidecarStatus>
  wechatSidecarStart: () => Promise<WechatSidecarStatus>
  wechatSidecarStop: () => Promise<WechatSidecarStatus>
}

export function buildImApi(): ImApi {
  return {
    getConfig: () => ipcRenderer.invoke('im:get-config'),
    setConfig: (patch) => ipcRenderer.invoke('im:set-config', patch),
    generatePairingCode: () => ipcRenderer.invoke('im:generate-pairing-code'),
    wechatStartLogin: () => ipcRenderer.invoke('im:wechat-start-login'),
    wechatPollLogin: (sessionKey) => ipcRenderer.invoke('im:wechat-poll-login', sessionKey),
    wechatUnbind: () => ipcRenderer.invoke('im:wechat-unbind'),
    wechatSidecarStatus: () => ipcRenderer.invoke('im:wechat-sidecar-status'),
    wechatSidecarStart: () => ipcRenderer.invoke('im:wechat-sidecar-start'),
    wechatSidecarStop: () => ipcRenderer.invoke('im:wechat-sidecar-stop'),
  }
}
