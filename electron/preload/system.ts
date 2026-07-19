/**
 * Platform / UX surfaces that don't fit a domain elsewhere.
 *
 *   - `system.*`             native OS notification
 *   - `window.*`             frameless chrome controls (min / max / close)
 *   - `clipboard.*`          system clipboard (PNG read)
 *   - `rendererPrefs.*`      localStorage ↔ userData mirror
 *   - `tabAutocomplete.*`    inline completion channel
 *   - `buddy.*`              onboarding buddy pet state
 *   - `debugSessionLog`      renderer → main NDJSON debug sink
 */
import { ipcRenderer } from 'electron'

export interface SystemApi {
  notify: (params: {
    title: string
    body?: string
    silent?: boolean
    onlyWhenMinimized?: boolean
    mode?: 'off' | 'minimized' | 'background' | 'always'
  }) => Promise<{ success: boolean; skipped?: boolean; error?: string }>
}

export function buildSystemApi(): SystemApi {
  return {
    notify: (params) => ipcRenderer.invoke('system:desktop-notify', params),
  }
}

export interface WindowApi {
  minimize: () => Promise<void>
  maximize: () => Promise<void>
  close: () => Promise<void>
}

export function buildWindowApi(): WindowApi {
  return {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
  }
}

export interface ClipboardApi {
  /** Native clipboard image (PNG); use when `paste` has no usable file items (common on Windows + Snipping Tool). */
  readPngImage: () => Promise<
    | { ok: false }
    | { ok: true; base64: string; mediaType: 'image/png'; size: number }
  >
}

export function buildClipboardApi(): ClipboardApi {
  return {
    readPngImage: () => ipcRenderer.invoke('clipboard:read-png-image'),
  }
}

export interface RendererPrefsApi {
  get: () => Promise<Record<string, string> | null>
  patch: (patch: Record<string, string>) => Promise<{ success: boolean; error?: string }>
}

export function buildRendererPrefsApi(): RendererPrefsApi {
  return {
    get: () => ipcRenderer.invoke('renderer-prefs:get'),
    patch: (patch) => ipcRenderer.invoke('renderer-prefs:patch', patch),
  }
}

export interface TabAutocompleteApi {
  requestCompletion: (params: {
    prefix: string
    suffix: string
    language: string
    filePath: string
    recentSnippets: Array<{ path: string; content: string }>
  }) => Promise<{ completion: string; latencyMs: number }>
  cancel: () => Promise<void>
}

export function buildTabAutocompleteApi(): TabAutocompleteApi {
  return {
    requestCompletion: (params) =>
      ipcRenderer.invoke('tab-autocomplete:request-completion', params),
    cancel: () => ipcRenderer.invoke('tab-autocomplete:cancel'),
  }
}

export interface BuddyApi {
  get: () => Promise<Record<string, unknown>>
  hatch: (seed?: string) => Promise<Record<string, unknown>>
  setSpecies: (species: string) => Promise<Record<string, unknown>>
  update: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>
  tick: () => Promise<{
    tick: number
    frame: number
    blink: boolean
    showBubble: boolean
    petAt: number | null
  }>
  pet: () => Promise<{ ok: boolean }>
}

export function buildBuddyApi(): BuddyApi {
  return {
    get: () => ipcRenderer.invoke('buddy:get'),
    hatch: (seed) => ipcRenderer.invoke('buddy:hatch', seed),
    setSpecies: (species) => ipcRenderer.invoke('buddy:set-species', species),
    update: (patch) => ipcRenderer.invoke('buddy:update', patch),
    tick: () => ipcRenderer.invoke('buddy:tick'),
    pet: () => ipcRenderer.invoke('buddy:pet'),
  }
}

/**
 * Writes NDJSON to repo-root debug-e88e1a.log via main process.
 * Uses `.send` (one-way) — not `.invoke` — because the renderer never needs
 * a reply and we want zero impact on a slow main process.
 */
export type DebugSessionLog = (payload: Record<string, unknown>) => void

export function buildDebugSessionLog(): DebugSessionLog {
  return (payload) => ipcRenderer.send('debug:session-log', payload)
}
