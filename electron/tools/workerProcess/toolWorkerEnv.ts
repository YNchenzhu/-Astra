/**
 * Single source of truth for "should tool execution route through the
 * utilityProcess?". Used by {@link import('../registry').ToolRegistry} and
 * {@link import('./toolWorkerHost').refreshToolWorkerFromMainDiskSettingsIfEnabled}.
 */

/** Opt out explicitly (packaged app defaults to ON). */
export function isToolWorkerDispatchEnabled(): boolean {
  const v = process.env.ASTRA_TOOL_WORKER?.trim().toLowerCase()
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false
  if (v === '1' || v === 'true' || v === 'on') return true
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron')
    if (typeof app?.isPackaged === 'boolean' && app.isPackaged) return true
  } catch {
    /* vitest / non-electron */
  }
  return false
}
