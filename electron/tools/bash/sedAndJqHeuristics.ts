/**
 * Lightweight sed/jq checks — subset of upstream `sedValidation.ts` + jq guards
 * without `tryParseShellCommand` / full tokenizer.
 */

import type { BashSecurityCode } from './bashCodes'
import { BashSecurityCode as C } from './bashCodes'
import { appendCode } from './commandAnalysis'

function sedInplaceInSegment(seg: string): boolean {
  if (!/\bsed\b/.test(seg)) return false
  if (/\s--in-place(?:=\S*)?/.test(seg)) return true
  return /\s-i[\d=.]|\s-i\s|\s-i$/.test(seg)
}

function commandHasSedInplace(command: string): boolean {
  if (!/\bsed\b/.test(command)) return false
  return command.split('|').some((seg) => sedInplaceInSegment(seg))
}

/** In-place sed: warn (still executable like other warns). */
export function applySedInplaceWarn(command: string, codes: BashSecurityCode[], reasons: string[]): void {
  if (!commandHasSedInplace(command)) return
  appendCode(codes, C.SED_INPLACE)
  reasons.push('sed in-place edit (-i/--in-place): prefer dedicated file edit tools; review carefully')
}

/** jq calling system() — deny (upstream JQ_SYSTEM_FUNCTION). */
export function applyJqSystemDeny(command: string, codes: BashSecurityCode[], reasons: string[]): void {
  const trimmed = command.trim()
  if (!/^\s*jq\b/m.test(trimmed) && !/(?:^|[;&|])\s*jq\b/.test(command)) return
  if (/\bsystem\s*\(/.test(command)) {
    appendCode(codes, C.JQ_SYSTEM)
    reasons.push('jq: system() call — denied')
  }
}
