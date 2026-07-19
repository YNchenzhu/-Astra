/**
 * Browser-facing settings bridge for H5 mode.
 *
 * The phone reuses the desktop renderer, whose settings store hydrates from
 * `electronAPI.settings.get()`. In browser mode that call must return the
 * DESKTOP's persisted settings so the UI shows the user's real API configs /
 * model / permissions — otherwise the phone looks like a brand-new user.
 *
 * Secrets (API keys) are masked on the way out so they never travel to the
 * phone; on save, a value left masked is treated as "unchanged" and the real
 * secret on disk is preserved. The server uses its OWN (unmasked) settings for
 * actual model calls (see `h5ChatBridge.resolveActiveProvider`), so the phone
 * never needs the raw keys.
 */
import { loadSettings, saveSettings } from '../settings/settingsStore'

const SECRET_TOP_KEYS = [
  'apiKey',
  'embeddingApiKey',
  'rerankApiKey',
  'webSearchBraveApiKey',
  'webSearchBaiduApiKey',
]

/**
 * Settings keys that the browser/H5 surface may NEITHER read NOR write. Parity
 * with upstream's `isH5AccessControlRequest`: the H5 access control itself (token
 * hash, enabled flag, allowed origins) lives in the same on-disk settings blob,
 * so without this denylist a phone could (a) read `h5Access.tokenHash` via
 * `GET /api/settings`, and (b) re-enable / disable / re-origin H5 access via
 * `POST /api/settings` — i.e. change its own remote-access control. H5 access is
 * desktop-IPC-only; it is stripped on read and force-preserved on write.
 */
const LOCAL_ONLY_TOP_KEYS = ['h5Access']

function maskSecret(v: unknown): unknown {
  if (typeof v !== 'string' || !v) return v
  if (v.length <= 8) return '••••'
  return `${v.slice(0, 4)}••••${v.slice(-2)}`
}

function isMasked(v: unknown): boolean {
  return typeof v === 'string' && v.includes('••••')
}

/** Desktop settings with all secret keys masked, for the browser UI. */
export function getBrowserSettings(): Record<string, unknown> {
  const s = { ...loadSettings() }
  for (const k of SECRET_TOP_KEYS) {
    if (s[k]) s[k] = maskSecret(s[k])
  }
  if (Array.isArray(s.apiConfigs)) {
    s.apiConfigs = (s.apiConfigs as Array<Record<string, unknown>>).map((c) => ({
      ...c,
      apiKey: c.apiKey ? maskSecret(c.apiKey) : c.apiKey,
    }))
  }
  if (s.manualConfig && typeof s.manualConfig === 'object') {
    const mc = { ...(s.manualConfig as Record<string, unknown>) }
    if (mc.apiKey) mc.apiKey = maskSecret(mc.apiKey)
    s.manualConfig = mc
  }
  // Environment variables frequently hold tokens/keys — mask their values too so
  // the phone never receives the raw secret (it doesn't need it; the server uses
  // its own unmasked settings for actual calls).
  if (Array.isArray(s.envVars)) {
    s.envVars = (s.envVars as Array<Record<string, unknown>>).map((e) => ({
      ...e,
      value: e.value ? maskSecret(e.value) : e.value,
    }))
  }
  // Never expose desktop-only control surfaces (H5 access token hash / enabled /
  // origins) to the browser. They are managed exclusively over Electron IPC.
  for (const k of LOCAL_ONLY_TOP_KEYS) delete s[k]
  return s
}

/** Persist settings from the browser, preserving real secrets where masked. */
export function saveBrowserSettings(incoming: Record<string, unknown>): void {
  const current = loadSettings()
  const merged: Record<string, unknown> = { ...current, ...incoming }

  // Desktop-only control surfaces can never be changed from the browser/H5:
  // always restore the on-disk value, ignoring whatever the phone sent. This
  // stops a token holder from re-enabling / disabling / re-origining H5 access
  // (or clobbering its token hash) through the generic settings endpoint.
  for (const k of LOCAL_ONLY_TOP_KEYS) {
    if (k in current) merged[k] = current[k]
    else delete merged[k]
  }

  for (const k of SECRET_TOP_KEYS) {
    if (isMasked(merged[k])) merged[k] = current[k]
  }

  if (Array.isArray(merged.apiConfigs)) {
    const curById = new Map(
      (Array.isArray(current.apiConfigs) ? (current.apiConfigs as Array<Record<string, unknown>>) : [])
        .map((c) => [c.id as string, c]),
    )
    merged.apiConfigs = (merged.apiConfigs as Array<Record<string, unknown>>).map((c) => {
      if (isMasked(c.apiKey)) {
        const cur = curById.get(c.id as string)
        return { ...c, apiKey: (cur?.apiKey as string) ?? '' }
      }
      return c
    })
  }

  if (
    merged.manualConfig &&
    typeof merged.manualConfig === 'object' &&
    isMasked((merged.manualConfig as Record<string, unknown>).apiKey)
  ) {
    const curMc = (current.manualConfig && typeof current.manualConfig === 'object'
      ? (current.manualConfig as Record<string, unknown>)
      : {}) as Record<string, unknown>
    merged.manualConfig = {
      ...(merged.manualConfig as Record<string, unknown>),
      apiKey: (curMc.apiKey as string) ?? '',
    }
  }

  // Restore real env-var values when the phone sent the masked placeholder back,
  // so a settings save from the phone never wipes the real secrets on disk.
  if (Array.isArray(merged.envVars)) {
    const curById = new Map(
      (Array.isArray(current.envVars) ? (current.envVars as Array<Record<string, unknown>>) : [])
        .map((e) => [e.id as string, e]),
    )
    merged.envVars = (merged.envVars as Array<Record<string, unknown>>).map((e) => {
      if (isMasked(e.value)) {
        const cur = curById.get(e.id as string)
        return { ...e, value: (cur?.value as string) ?? '' }
      }
      return e
    })
  }

  saveSettings(merged)
}
