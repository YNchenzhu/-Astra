/**
 * PowerShell tool validation: upstream-style heuristics + shared shell chain checks
 * ({@link validateBashCommand} companion mode) + cmdlet path danger.
 */

import { appendCode } from '../bash/commandAnalysis'
import type { BashSecurityCode } from '../bash/bashCodes'
import type { SecurityAnalysis } from '../bash/validateBashCommand'
import { validateBashCommand } from '../bash/validateBashCommand'
import { applyPowerShellPathDeny } from '../bash/pathDanger'
import { applyPowerShellHeuristicDenies } from './powershellHeuristics'
import { isPowerShellPipelineReadOnly } from './powershellReadOnly'
import { getPrimaryWorkspaceRoot } from '../../security/workspaceAccess'
import path from 'node:path'

export type { SecurityAnalysis }

function resolveCwd(explicit?: string): string {
  if (typeof explicit === 'string' && explicit.trim()) {
    return path.resolve(explicit.trim())
  }
  return getPrimaryWorkspaceRoot() ?? process.cwd()
}

/**
 * Full validation for the **PowerShell** registry tool (Windows).
 */
export function validatePowerShellCommand(
  command: string,
  opts?: { cwd?: string },
): SecurityAnalysis {
  const cwd = resolveCwd(opts?.cwd)
  const codes: BashSecurityCode[] = []
  const reasons: string[] = []

  const psDenied = applyPowerShellHeuristicDenies(command, codes, reasons)

  const bash = validateBashCommand(command, {
    defaultShell: 'powershell',
    cwd,
    companionForPowerShell: true,
  })

  for (const c of bash.codes) {
    appendCode(codes, c)
  }
  reasons.push(...bash.reasons)

  const pathDenied = applyPowerShellPathDeny(cwd, bash.commandAnalysis, codes, reasons)

  let verdict = bash.verdict
  if (psDenied || pathDenied) {
    verdict = 'deny'
  }

  const isReadOnly = verdict === 'allow' && isPowerShellPipelineReadOnly(command)

  return {
    verdict,
    reasons,
    codes,
    isReadOnly,
    commandAnalysis: bash.commandAnalysis,
  }
}

export function isPowerShellCommandReadOnly(command: string, opts?: { cwd?: string }): boolean {
  const a = validatePowerShellCommand(command, opts)
  return a.verdict === 'allow' && a.isReadOnly
}
