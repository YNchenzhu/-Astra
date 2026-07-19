/**
 * upstream report §4.2 — CLAUDE_CODE_SIMPLE-style narrow tool surface (main chat + sub-agents).
 *
 * When enabled, only **read_file**, **edit_file**, and **bash** are exposed / eligible in tool lists
 * and sub-agent resolution (plus normal deferred-discovery rules still apply to listed tools).
 */

import type { Tool } from '../tools/types'

/** Canonical registry names (lowercase `bash` matches product registry). */
export const SIMPLE_TOOLSET_NAME_SET = new Set<string>(['read_file', 'edit_file', 'bash'])

function envTruthy(v: string | undefined): boolean {
  if (!v) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

/**
 * `ASTRA_SIMPLE_TOOLSET=1` or `CLAUDE_CODE_SIMPLE=1` (upstream env name).
 */
export function isSimpleToolsetMode(): boolean {
  return (
    envTruthy(process.env.ASTRA_SIMPLE_TOOLSET) ||
    envTruthy(process.env.CLAUDE_CODE_SIMPLE)
  )
}

export function toolAllowedInSimpleToolset(tool: Pick<Tool, 'name'>): boolean {
  if (!isSimpleToolsetMode()) return true
  return SIMPLE_TOOLSET_NAME_SET.has(tool.name)
}
