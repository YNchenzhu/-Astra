/**
 * Persist sub-agent sidechain timeline to disk (upstream report §7.7 — transcript recovery
 * when no in-memory active agent). Written during {@link finalizeSubAgentLifecycle} before
 * the in-memory sidechain is cleared.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { SubAgentSidechainEntry } from './subAgentSidechainTranscript'
import { asAgentId, type AgentId } from '../tools/ids'

export const SUBAGENT_SIDECHAIN_DISK_SCHEMA = 'astra.subagent-sidechain.v1' as const

// ============================================================
// Disk retention (audit 3) — TTL-based opportunistic GC
// ============================================================

/**
 * How long a sidechain snapshot lingers on disk before being swept by the
 * opportunistic GC. `SendMessage`'s disk-recovery path (see
 * `sendMessageDiskRecovery.ts`) reads these files when a previously
 * terminated agent is woken back up; 7 days covers the realistic window
 * a user would resume a conversation across before the snapshot
 * stops being useful. Override via `POLE_SUBAGENT_SIDECHAIN_TTL_MS`.
 */
const DEFAULT_SIDECHAIN_TTL_MS = 7 * 24 * 60 * 60 * 1000

function readSidechainTtlMs(): number {
  const raw = process.env.POLE_SUBAGENT_SIDECHAIN_TTL_MS?.trim()
  if (!raw) return DEFAULT_SIDECHAIN_TTL_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SIDECHAIN_TTL_MS
  // Floor at 60s so a typo can't disable retention (and so tests can run
  // pruning deterministically with a small but non-zero window).
  return Math.max(60_000, Math.floor(n))
}

/**
 * Hard cap on the number of snapshot files kept on disk regardless of
 * age. Protects against a runaway burst of short-lived sub-agents
 * filling the workspace with files faster than the TTL expires them.
 * Override via `POLE_SUBAGENT_SIDECHAIN_MAX_FILES`.
 */
const DEFAULT_SIDECHAIN_MAX_FILES = 500

function readSidechainMaxFiles(): number {
  const raw = process.env.POLE_SUBAGENT_SIDECHAIN_MAX_FILES?.trim()
  if (!raw) return DEFAULT_SIDECHAIN_MAX_FILES
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SIDECHAIN_MAX_FILES
  return Math.max(16, Math.floor(n))
}

/** How often opportunistic GC runs at most (avoids per-write directory scans). */
const SIDECHAIN_SWEEP_INTERVAL_MS = 15 * 60 * 1000
let lastSidechainSweepAt = 0

export interface SubAgentDiskSnapshot {
  schema: typeof SUBAGENT_SIDECHAIN_DISK_SCHEMA
  agentId: AgentId
  agentType: string
  name?: string
  teamName?: string
  streamConversationId?: string
  parentAgentId?: string
  endedAt: number
  /** Best-effort: last sidechain `complete` summary contained success=true */
  lastRunLikelySuccess?: boolean
  entries: SubAgentSidechainEntry[]
}

export function sanitizeAgentIdForPath(agentId: AgentId): string {
  return agentId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'agent'
}

export function getSubagentSidechainDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.claude', 'subagent-sidechains')
}

export function persistSubAgentSidechainSnapshot(
  workspaceRoot: string,
  snapshot: Omit<SubAgentDiskSnapshot, 'schema'>,
): void {
  if (!workspaceRoot.trim() || !snapshot.agentId.trim() || snapshot.entries.length === 0) return
  const dir = getSubagentSidechainDir(workspaceRoot)
  fs.mkdirSync(dir, { recursive: true })
  const full: SubAgentDiskSnapshot = {
    schema: SUBAGENT_SIDECHAIN_DISK_SCHEMA,
    ...snapshot,
  }
  const fp = path.join(dir, `${sanitizeAgentIdForPath(snapshot.agentId)}.json`)
  fs.writeFileSync(fp, JSON.stringify(full, null, 2), 'utf-8')
  // Audit 3: opportunistic GC — every persist call is a chance to drop
  // expired snapshots. Throttled to {@link SIDECHAIN_SWEEP_INTERVAL_MS}
  // so a burst of sub-agent terminations doesn't pay for N readdir()
  // scans. Errors swallowed — retention is best-effort and must never
  // sink the snapshot write.
  try {
    maybePruneSubAgentSidechains(workspaceRoot)
  } catch (err) {
    console.warn('[subAgentSidechainDisk] opportunistic prune failed:', err)
  }
}

/** Internal: TTL-throttled sweep. Public callers should use {@link pruneSubAgentSidechainDir}. */
function maybePruneSubAgentSidechains(workspaceRoot: string): void {
  const now = Date.now()
  if (now - lastSidechainSweepAt < SIDECHAIN_SWEEP_INTERVAL_MS) return
  lastSidechainSweepAt = now
  pruneSubAgentSidechainDir(workspaceRoot)
}

export interface PruneSubAgentSidechainResult {
  scanned: number
  removedExpired: number
  removedOverflow: number
}

/**
 * Unconditional sweep of the sidechain directory. Removes:
 *   1. Any snapshot whose `endedAt` (falls back to file mtime) is older
 *      than the configured TTL.
 *   2. If files still exceed {@link DEFAULT_SIDECHAIN_MAX_FILES} after
 *      step 1, the oldest by `endedAt` until the cap is met.
 *
 * Returns counts for callers (tests, telemetry, future "session info"
 * panel) that want visibility into how much was reclaimed.
 *
 * Safe to call on a non-existent directory (returns zeros) and on files
 * that fail to parse (silently ignored — corruption shouldn't block
 * other cleanup).
 */
export function pruneSubAgentSidechainDir(workspaceRoot: string): PruneSubAgentSidechainResult {
  const dir = getSubagentSidechainDir(workspaceRoot)
  if (!workspaceRoot.trim() || !fs.existsSync(dir)) {
    return { scanned: 0, removedExpired: 0, removedOverflow: 0 }
  }

  const ttl = readSidechainTtlMs()
  const maxFiles = readSidechainMaxFiles()
  const cutoff = Date.now() - ttl

  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return { scanned: 0, removedExpired: 0, removedOverflow: 0 }
  }

  const entries: { fp: string; ageRef: number }[] = []
  let removedExpired = 0
  for (const name of files) {
    const fp = path.join(dir, name)
    let endedAt = 0
    try {
      const raw = JSON.parse(fs.readFileSync(fp, 'utf-8')) as Partial<SubAgentDiskSnapshot>
      if (typeof raw?.endedAt === 'number' && Number.isFinite(raw.endedAt)) {
        endedAt = raw.endedAt
      }
    } catch {
      /* parse failure falls through to mtime-only reference */
    }
    let mtimeMs = 0
    try {
      mtimeMs = fs.statSync(fp).mtimeMs
    } catch {
      mtimeMs = 0
    }
    // The "age reference" is the LATER of `endedAt` and `mtimeMs`. This
    // matters in two cases:
    //   (a) `endedAt` is intentionally tiny (test fixtures using `42`,
    //       or future bugs setting a default-zero); the file's mtime
    //       still says it was just written, so it must be kept.
    //   (b) A user manually `touch`es a snapshot file to "rescue" it
    //       from impending GC — we honor that by extending its lifetime.
    // A snapshot is only considered expired when BOTH the internal
    // `endedAt` and the on-disk mtime are older than `cutoff`.
    const ageRef = Math.max(endedAt, mtimeMs)
    if (ageRef > 0 && ageRef < cutoff) {
      try {
        fs.unlinkSync(fp)
        removedExpired++
      } catch {
        /* ignore — likely raced with another sweep / external delete */
      }
      continue
    }
    entries.push({ fp, ageRef })
  }

  let removedOverflow = 0
  if (entries.length > maxFiles) {
    entries.sort((a, b) => a.ageRef - b.ageRef) // oldest first
    const overflow = entries.slice(0, entries.length - maxFiles)
    for (const { fp } of overflow) {
      try {
        fs.unlinkSync(fp)
        removedOverflow++
      } catch {
        /* ignore */
      }
    }
  }

  return { scanned: files.length, removedExpired, removedOverflow }
}

/** @internal Reset the sweep throttle. Tests that exercise pruning behaviour need this. */
export function __resetSubAgentSidechainSweepThrottleForTests(): void {
  lastSidechainSweepAt = 0
}

export function loadSubAgentDiskSnapshotByAgentId(
  workspaceRoot: string,
  agentId: AgentId,
): SubAgentDiskSnapshot | null {
  const fp = path.join(
    getSubagentSidechainDir(workspaceRoot),
    `${sanitizeAgentIdForPath(agentId)}.json`,
  )
  try {
    if (!fs.existsSync(fp)) return null
    const raw = JSON.parse(fs.readFileSync(fp, 'utf-8')) as SubAgentDiskSnapshot
    if (raw?.schema !== SUBAGENT_SIDECHAIN_DISK_SCHEMA || !raw.agentId || !Array.isArray(raw.entries))
      return null
    return raw
  } catch {
    return null
  }
}

/**
 * Resolve by exact agent id file first, then scan `.json` for `name` or `agentId` match (bounded).
 */
export function findSubAgentDiskSnapshot(
  workspaceRoot: string,
  lookupId: string,
): SubAgentDiskSnapshot | null {
  const key = lookupId.trim()
  if (!key) return null
  const direct = loadSubAgentDiskSnapshotByAgentId(workspaceRoot, asAgentId(key))
  if (direct) return direct
  const dir = getSubagentSidechainDir(workspaceRoot)
  if (!fs.existsSync(dir)) return null
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  for (const f of files.slice(0, 200)) {
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(dir, f), 'utf-8'),
      ) as SubAgentDiskSnapshot
      if (raw?.schema !== SUBAGENT_SIDECHAIN_DISK_SCHEMA) continue
      if (raw.agentId === key || raw.name === key) return raw
    } catch {
      /* ignore */
    }
  }
  return null
}

const MAX_PROMPT_SNIP = 14_000

export function formatSidechainSnapshotForRecoveryPrompt(
  snap: SubAgentDiskSnapshot,
  inboundBody: string,
): string {
  const lines = snap.entries.map((e) => `- [${e.kind}] ${e.summary}`)
  let body = lines.join('\n')
  if (body.length > MAX_PROMPT_SNIP) {
    body = `${body.slice(0, MAX_PROMPT_SNIP)}\n\n[…sidechain truncated]`
  }
  return (
    `You are being started again after a prior sub-agent run was persisted to disk (report §7.7).\n` +
    `Prior agentId: ${snap.agentId}\n` +
    `Prior agentType: ${snap.agentType}\n` +
    (snap.teamName ? `Team: ${snap.teamName}\n` : '') +
    `Ended (UTC ms): ${snap.endedAt}\n\n` +
    `### Prior sidechain (compact)\n${body || '(empty)'}\n\n` +
    `### New inbound message\n${inboundBody.trim()}`
  )
}
