import fs from 'node:fs'
import path from 'node:path'
import { resolveWorkspaceMemoryDir } from './storage'
import { checkTeamMemSecrets } from './teamMemSecretGuard'

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function getTeamMemoryDir(workspacePath: string): string {
  return path.join(workspacePath, '.claude', 'team-memory')
}

export function deleteTeamMemory(
  workspacePath: string,
  filename: string,
): boolean {
  try {
    const filePath = path.join(getTeamMemoryDir(workspacePath), filename)
    if (!fs.existsSync(filePath)) return false
    fs.unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}

function listMdFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
}

/**
 * True when `srcFile` is new or strictly newer than `dstFile` — i.e. a sync
 * would copy it. Split out from the copy itself (audit I-4) so callers can
 * gate the expensive read + secret-scan on "would this even copy?" and avoid
 * re-reading every unchanged file on every sync.
 */
function shouldCopyNewer(srcFile: string, dstFile: string): boolean {
  if (!fs.existsSync(srcFile)) return false
  if (!fs.existsSync(dstFile)) return true
  return fs.statSync(srcFile).mtimeMs > fs.statSync(dstFile).mtimeMs
}

/** Information about a file the secret guard refused to export. */
export interface BlockedSecretReport {
  filename: string
  /** User-facing rejection reason from {@link checkTeamMemSecrets}. */
  reason: string
}

/**
 * Sync project memories under `.claude/memory` ↔ `.claude/team-memory` in the
 * same workspace.
 *
 * Both directions are gated by {@link checkTeamMemSecrets} — a file containing
 * recognisable credentials (API keys, PEM private keys, …) is skipped and
 * surfaced in `blockedSecrets` rather than copied. Export (project → team)
 * stops the local AI/user from leaking a key to collaborators; import
 * (team → project) stops a teammate's file — which may carry a credential
 * that predates their guard — from landing in local memory where it would be
 * recalled into the model context (audit M7).
 */
export function syncTeamMemory(
  workspacePath: string,
): {
  exported: number
  imported: number
  teamDir: string
  blockedSecrets: BlockedSecretReport[]
} {
  const localDir = resolveWorkspaceMemoryDir(workspacePath)
  const teamDir = getTeamMemoryDir(workspacePath)

  ensureDir(localDir)
  ensureDir(teamDir)

  let exported = 0
  let imported = 0
  const blockedSecrets: BlockedSecretReport[] = []

  for (const filename of listMdFiles(localDir)) {
    const src = path.join(localDir, filename)
    const dst = path.join(teamDir, filename)
    // I-4: only read + secret-scan files we'd actually copy (new / newer),
    // instead of re-reading every unchanged file on every sync.
    if (!shouldCopyNewer(src, dst)) continue
    let content = ''
    try {
      content = fs.readFileSync(src, 'utf-8')
    } catch {
      // Unreadable source — skip silently (a later sync will retry once the
      // file becomes readable). Don't propagate to importer's view either.
      continue
    }
    const rejection = checkTeamMemSecrets(content)
    if (rejection) {
      blockedSecrets.push({ filename, reason: rejection })
      console.warn(`[teamSync] refused to export ${filename}: ${rejection}`)
      continue
    }
    fs.copyFileSync(src, dst)
    exported++
  }

  for (const filename of listMdFiles(teamDir)) {
    const src = path.join(teamDir, filename)
    const dst = path.join(localDir, filename)
    // Audit M7: defense-in-depth on the IMPORT direction too. A teammate's
    // file may carry a credential that predates their guard (or was added by
    // an older client); pulling it into local project memory would let it be
    // recalled into the model context. Scan before copying in; skip + report
    // matches the export-side behaviour. I-4: gate on shouldCopyNewer first.
    if (!shouldCopyNewer(src, dst)) continue
    let content = ''
    try {
      content = fs.readFileSync(src, 'utf-8')
    } catch {
      continue
    }
    const rejection = checkTeamMemSecrets(content)
    if (rejection) {
      blockedSecrets.push({ filename, reason: rejection })
      console.warn(`[teamSync] refused to import ${filename}: ${rejection}`)
      continue
    }
    fs.copyFileSync(src, dst)
    imported++
  }

  return { exported, imported, teamDir, blockedSecrets }
}
