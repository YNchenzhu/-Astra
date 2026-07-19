/**
 * Dangerous path detection for rm/rmdir/mv — adapted from upstream
 * `src/utils/permissions/pathValidation.ts` `isDangerousRemovalPath`.
 */

import path from 'node:path'
import { homedir } from 'node:os'
import type { BashSecurityCode } from './bashCodes'
import { BashSecurityCode as C } from './bashCodes'
import type { CommandAnalysis } from './commandAnalysis'
import { appendCode } from './commandAnalysis'

const WINDOWS_DRIVE_ROOT_REGEX = /^[A-Za-z]:\/?$/
const WINDOWS_DRIVE_CHILD_REGEX = /^[A-Za-z]:\/[^/]+$/

export function isDangerousRemovalPath(resolvedPath: string): boolean {
  const forwardSlashed = resolvedPath.replace(/[\\/]+/g, '/')

  if (forwardSlashed === '*' || forwardSlashed.endsWith('/*')) {
    return true
  }

  const normalizedPath =
    forwardSlashed === '/' ? forwardSlashed : forwardSlashed.replace(/\/$/, '')

  if (normalizedPath === '/') {
    return true
  }

  if (WINDOWS_DRIVE_ROOT_REGEX.test(normalizedPath)) {
    return true
  }

  const normalizedHome = homedir().replace(/[\\/]+/g, '/')
  if (normalizedPath === normalizedHome) {
    return true
  }

  const parentDir = path.posix.dirname(normalizedPath)
  if (parentDir === '/') {
    return true
  }

  if (WINDOWS_DRIVE_CHILD_REGEX.test(normalizedPath)) {
    return true
  }

  return false
}

/** Strip surrounding quotes; expand leading `~/` and standalone `~` to home (upstream tilde-safe subset). */
export function expandTildeSimple(raw: string): string {
  const unquoted = raw.replace(/^['"]|['"]$/g, '')
  if (unquoted === '~' || unquoted.startsWith('~/')) {
    const h = homedir()
    if (unquoted === '~') return h
    return path.join(h, unquoted.slice(2))
  }
  return unquoted
}

/**
 * Positional args after skipping flags; respects `--` (upstream PATH_EXTRACTORS note).
 */
export function extractPositionalArgs(args: string[]): string[] {
  const out: string[] = []
  let afterDdash = false
  for (const arg of args) {
    if (afterDdash) {
      out.push(arg)
      continue
    }
    if (arg === '--') {
      afterDdash = true
      continue
    }
    if (arg.startsWith('-') && arg !== '-') continue
    out.push(arg)
  }
  return out
}

function resolveUserPath(cwd: string, p: string): string {
  const expanded = expandTildeSimple(p)
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded)
}

/**
 * Reject `~user`, `~+`, paths with `$` / `%` / `$(` that static analysis cannot match shell expansion (upstream).
 */
export function hasUnapprovedPathExpansionToken(p: string): boolean {
  const s = p.replace(/^['"]|['"]$/g, '')
  if (s.startsWith('~') && s !== '~' && !s.startsWith('~/')) {
    return true
  }
  if (/[$%]/.test(s) || /\$\(/.test(s)) {
    return true
  }
  return false
}

/**
 * Simulate the working directory each chain segment executes under, by
 * tracking literal `cd` segments (`cd / && rmdir foo` must resolve `foo`
 * against `/`, not the initial cwd — audit B-P0-4).
 *
 * Returns one entry per analysis (the cwd in effect when that segment runs).
 * `null` means "statically unknown" (cd target used expansion / `cd -`);
 * callers must then skip relative-path resolution rather than resolve
 * against a known-wrong base.
 */
export function computePerSegmentCwds(
  initialCwd: string,
  analyses: CommandAnalysis[],
): (string | null)[] {
  const out: (string | null)[] = []
  let cur: string | null = initialCwd
  for (const a of analyses) {
    out.push(cur)
    if (a.commandBaseName.toLowerCase() !== 'cd') continue
    const targets = extractPositionalArgs(a.args)
    if (targets.length === 0) {
      cur = homedir() // bare `cd`
      continue
    }
    const rawTarget = targets[0]!
    if (rawTarget === '-' || hasUnapprovedPathExpansionToken(rawTarget)) {
      cur = null
      continue
    }
    const expanded = expandTildeSimple(rawTarget)
    if (path.isAbsolute(expanded)) {
      cur = path.resolve(expanded)
    } else if (cur !== null) {
      try {
        cur = path.resolve(cur, expanded)
      } catch {
        cur = null
      }
    }
    // relative cd on an unknown base stays unknown
  }
  return out
}

/**
 * For `rmdir`, `mv` (and `rm` if ever removed from blanket deny): block dangerous resolved targets.
 *
 * @param perSegmentCwds Optional per-segment cwd simulation from
 *   {@link computePerSegmentCwds}. When a segment's cwd is `null`
 *   (statically unknown after a dynamic `cd`), relative targets are
 *   skipped — resolving them against a known-wrong base produced
 *   false allows. Absolute / tilde targets are always checked.
 */
export function applyDangerousPathDeny(
  cwd: string,
  analyses: CommandAnalysis[],
  codes: BashSecurityCode[],
  reasons: string[],
  perSegmentCwds?: (string | null)[],
): boolean {
  let denied = false
  for (let i = 0; i < analyses.length; i++) {
    const a = analyses[i]!
    const base = a.commandBaseName.toLowerCase()
    if (base !== 'rmdir' && base !== 'mv') {
      continue
    }
    const segCwd = perSegmentCwds ? (perSegmentCwds[i] ?? cwd) : cwd

    const paths = extractPositionalArgs(a.args)
    if (paths.length === 0) continue

    for (const raw of paths) {
      if (hasUnapprovedPathExpansionToken(raw)) {
        appendCode(codes, C.PATH_DANGEROUS_TARGET)
        reasons.push(
          `Path argument may use shell expansion not validated statically: ${raw.slice(0, 120)}`,
        )
        denied = true
        continue
      }
      const expanded = expandTildeSimple(raw)
      if (segCwd === null && !path.isAbsolute(expanded)) {
        // cwd unknown after a dynamic `cd` — cannot resolve a relative
        // target, and resolving against the stale initial cwd is exactly
        // the false-allow this parameter exists to fix.
        continue
      }
      let resolved: string
      try {
        resolved = resolveUserPath(segCwd ?? cwd, raw)
      } catch {
        continue
      }
      if (isDangerousRemovalPath(resolved)) {
        appendCode(codes, C.PATH_DANGEROUS_TARGET)
        reasons.push(`Dangerous path target for ${base}: ${resolved}`)
        denied = true
      }
    }
  }
  return denied
}

/** Args after cmdlet name: collect -Path / -LiteralPath values and remaining positionals. */
export function extractPowerShellPathArguments(args: string[]): string[] {
  const out: string[] = []
  let i = 0
  while (i < args.length) {
    const a = args[i]
    const al = a.toLowerCase()
    if (al === '-path' || al === '-literalpath' || al === '-lp') {
      if (i + 1 < args.length) {
        out.push(args[i + 1]!)
        i += 2
        continue
      }
    }
    if (al.startsWith('-') && al !== '-') {
      i++
      continue
    }
    out.push(a)
    i++
  }
  return out
}

const PS_PATH_CMDLETS = new Set([
  'remove-item',
  'ri',
  'rm',
  'rmdir',
  'del',
  'erase',
  'rd',
  'move-item',
  'mi',
  'mv',
])

/**
 * Dangerous targets for PowerShell Remove-Item / Move-Item (upstream PowerShellTool pathValidation analogue).
 */
export function applyPowerShellPathDeny(
  cwd: string,
  analyses: CommandAnalysis[],
  codes: BashSecurityCode[],
  reasons: string[],
): boolean {
  let denied = false
  for (const a of analyses) {
    const base = a.commandBaseName.toLowerCase()
    if (!PS_PATH_CMDLETS.has(base)) {
      continue
    }
    const paths = extractPowerShellPathArguments(a.args)
    if (paths.length === 0) continue

    for (const raw of paths) {
      if (hasUnapprovedPathExpansionToken(raw)) {
        appendCode(codes, C.PATH_DANGEROUS_TARGET)
        reasons.push(
          `PowerShell path may use expansion not validated statically: ${raw.slice(0, 120)}`,
        )
        denied = true
        continue
      }
      let resolved: string
      try {
        resolved = resolveUserPath(cwd, raw)
      } catch {
        continue
      }
      if (isDangerousRemovalPath(resolved)) {
        appendCode(codes, C.PATH_DANGEROUS_TARGET)
        reasons.push(`Dangerous path for ${base}: ${resolved}`)
        denied = true
      }
    }
  }
  return denied
}
