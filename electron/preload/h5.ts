/**
 * H5 / remote-access bridge. Mirrors `electron/h5/h5Handlers.ts`.
 */
import { ipcRenderer } from 'electron'

export interface H5StatusPayload {
  settings: {
    enabled: boolean
    tokenPreview: string | null
    allowedOrigins: string[]
    publicBaseUrl: string | null
    host: string
    port: number
    hasToken: boolean
  }
  server: { running: boolean; host: string; port: number; lanAddress: string | null; lanAddresses: string[] }
  error?: string
}

export interface H5ConfigPatch {
  enabled?: boolean
  allowedOrigins?: string[]
  publicBaseUrl?: string | null
  host?: string
  port?: number
}

export interface H5Api {
  getStatus: () => Promise<H5StatusPayload>
  setConfig: (patch: H5ConfigPatch) => Promise<H5StatusPayload>
  generateToken: () => Promise<{ token: string; preview: string; status: H5StatusPayload }>
  start: () => Promise<H5StatusPayload>
  stop: () => Promise<H5StatusPayload>
}

export function buildH5Api(): H5Api {
  return {
    getStatus: () => ipcRenderer.invoke('h5:get-status'),
    setConfig: (patch) => ipcRenderer.invoke('h5:set-config', patch),
    generateToken: () => ipcRenderer.invoke('h5:generate-token'),
    start: () => ipcRenderer.invoke('h5:start'),
    stop: () => ipcRenderer.invoke('h5:stop'),
  }
}
