/**
 * Default thinking token budget for the main chat ALS (AC-7.5 main session).
 */

import { readDiskSettings } from '../settings/settingsAccess'

const MAX_COMPAT = 32768
const DEFAULT_ALWAYS_THINKING_CAP = 8192

export function resolveMainChatThinkingBudgetTokens(params: {
  maxTokens: number
  alwaysThinking?: boolean
  /** Renderer override (SendMessage IPC); takes precedence over disk. */
  explicitOverride?: number
}): number | undefined {
  const ex = params.explicitOverride
  if (typeof ex === 'number' && Number.isFinite(ex) && ex > 0) {
    return Math.min(Math.floor(ex), MAX_COMPAT)
  }
  const disk = readDiskSettings().thinkingBudgetTokens
  if (typeof disk === 'number' && Number.isFinite(disk) && disk > 0) {
    return Math.min(Math.floor(disk), MAX_COMPAT)
  }
  if (params.alwaysThinking) {
    return Math.min(params.maxTokens || DEFAULT_ALWAYS_THINKING_CAP, DEFAULT_ALWAYS_THINKING_CAP)
  }
  return undefined
}
