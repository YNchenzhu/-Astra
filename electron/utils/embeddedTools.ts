/**
 * When "embedded search" is enabled, Glob/Grep are omitted from the model tool list —
 * search is expected via shell aliases (upstream embeddedTools analogue).
 *
 * Env overrides disk: `ASTRA_EMBEDDED_SEARCH=1|0` or `true|false`.
 */

import { readDiskSettings } from '../settings/settingsAccess'

export function hasEmbeddedSearchTools(): boolean {
  const v = process.env.ASTRA_EMBEDDED_SEARCH ?? process.env.EMBEDDED_SEARCH_TOOLS
  if (v !== undefined && String(v).trim() !== '') {
    const t = String(v).trim().toLowerCase()
    if (t === '0' || t === 'false' || t === 'no') return false
    return t === '1' || t === 'true' || t === 'yes'
  }
  const s = readDiskSettings()
  return s.embeddedSearchTools === true
}

export function shouldHideGlobGrepForEmbeddedSearch(registryToolName: string): boolean {
  if (!hasEmbeddedSearchTools()) return false
  return registryToolName === 'glob' || registryToolName === 'grep'
}
