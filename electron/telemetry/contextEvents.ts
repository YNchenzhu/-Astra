/**
 * In-process telemetry ring buffer + append-only file for:
 *   1. ContextManager lifecycle events
 *      (`soft_clear` / `micro_compact` / `auto_compact` / `block` /
 *       `session_memory_compact` / `auto_compact_fallback_micro`)
 *   2. Provider-side error classification (`network` / `timeout` /
 *      `rate_limit` / `auth` / `context_length` / `gateway_400` /
 *      `gateway_500` / `unknown`) with provider id + model.
 *
 * Design goals:
 *   - Zero-cost when disabled (events are dropped before allocating).
 *   - Cheap append (ring buffer of 500 in-memory + line-delimited JSON file
 *     under `<userData>/logs/telemetry.ndjson`, capped via rotation).
 *   - Readable by both main-process (for bug-report bundle export) and
 *     renderer (via `telemetry:*` IPC) without crossing the process
 *     boundary for every append.
 *
 * Emission is intentionally one-way / fire-and-forget; consumers (tests,
 * renderer) poll `getRecentTelemetryEvents()` when they want a snapshot.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export type ContextEventKind =
  | 'soft_clear'
  | 'history_snip'
  | 'micro_compact'
  | 'auto_compact'
  | 'block_micro'
  /** Blocking tier whose forced micro reclaimed too little — escalated to LLM auto-compact (livelock fix, 2026-06). */
  | 'block_escalated_auto'
  | 'session_memory_compact'
  | 'auto_compact_fallback_micro'

export interface ContextTelemetryEvent {
  kind: 'context'
  ts: number
  action: ContextEventKind
  level: string
  estimatedTokensBefore?: number
  estimatedTokensAfter?: number
  /** Net tokens reclaimed by this action (before - after, never negative). */
  reclaimed?: number
  conversationId?: string
  agentId?: string
  model?: string
}

/** Loose classification so the same tag works across providers. */
export type ProviderErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'context_length'
  | 'overloaded'
  | 'timeout'
  | 'network'
  | 'gateway_400'
  | 'gateway_500'
  | 'abort'
  | 'tool_validation'
  | 'unknown'

export interface ProviderErrorTelemetryEvent {
  kind: 'provider_error'
  ts: number
  providerId: string
  /** Anthropic-compat / openai-compat / gemini-native etc. — wire label. */
  wire?: string
  model?: string
  errorKind: ProviderErrorKind
  httpStatus?: number
  message: string
  conversationId?: string
  agentId?: string
}

/**
 * Tracks whether code the agent wrote actually survived the user's review.
 *
 * Emitted by `electron/telemetry/keepRate.ts` at fixed time buckets (5min /
 * 30min / 180min) after each successful `edit_file` / `write_file` /
 * `multi_edit_file`. The signal answers: *did the user keep what the agent
 * wrote?* — the single the IDE-style harness-quality metric that captures
 * "the agent did a good job" without per-task labels.
 *
 *   - `kept`     : file content at the bucket time hashes identically to
 *                  the post-edit hash → user accepted the change (or
 *                  hasn't touched it)
 *   - `modified` : file still exists but the content drifted → user
 *                  edited it (still useful, but not "first-try-correct")
 *   - `reverted` : file content matches the *pre-edit* hash → user rolled
 *                  it back wholesale (a strong negative signal)
 *   - `gone`     : file no longer exists → user deleted it (also a
 *                  strong negative signal; common with throwaway scaffolds)
 */
export type KeepRateBucket = 'm5' | 'm30' | 'm180'
export type KeepRateOutcome = 'kept' | 'modified' | 'reverted' | 'gone'

export interface KeepRateTelemetryEvent {
  kind: 'keep_rate'
  ts: number
  /** Bucket the check fired at (5/30/180 minutes after the edit landed). */
  bucket: KeepRateBucket
  outcome: KeepRateOutcome
  /** The tool whose edit we anchored. */
  toolName: string
  /** Workspace-relative path when a workspace is open, else absolute. */
  filePath: string
  /** ms between the edit landing on disk and this check. */
  ageMs: number
  conversationId?: string
  agentId?: string
}

export type TelemetryEvent =
  | ContextTelemetryEvent
  | ProviderErrorTelemetryEvent
  | KeepRateTelemetryEvent

// ─────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────

/** Ring buffer size (events). Bigger → more history for bug reports. */
const RING_CAPACITY = 500
/** Hard cap on the on-disk log before rotation. */
const LOG_MAX_BYTES = 2 * 1024 * 1024

function telemetryEnabled(): boolean {
  // Default: on. Opt-out via `POLE_DISABLE_TELEMETRY=1` for users who
  // don't want any disk writes (e.g. read-only sandboxes).
  return process.env.POLE_DISABLE_TELEMETRY !== '1'
}

function resolveLogDir(): string {
  const override = process.env.ASTRA_TELEMETRY_DIR?.trim()
  if (override) return path.resolve(override)
  try {
    // Late-bound electron import — in tests / non-electron contexts fall back
    // to os.tmpdir() so unit tests don't need any setup. Matches the
    // pattern used in `tools/toolResultBudget.ts`.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronMod = require('electron') as typeof import('electron')
    if (typeof electronMod.app?.getPath === 'function') {
      return path.join(electronMod.app.getPath('userData'), 'logs')
    }
  } catch {
    /* not in electron */
  }
  return path.join(os.tmpdir(), 'astra-telemetry')
}

function logFilePath(): string {
  return path.join(resolveLogDir(), 'telemetry.ndjson')
}

// ─────────────────────────────────────────────────────────────────────────
// In-memory ring
// ─────────────────────────────────────────────────────────────────────────

const ring: TelemetryEvent[] = []

function pushRing(e: TelemetryEvent): void {
  ring.push(e)
  if (ring.length > RING_CAPACITY) ring.shift()
}

// ─────────────────────────────────────────────────────────────────────────
// File rotation
// ─────────────────────────────────────────────────────────────────────────

let diskWriteFailed = false

function tryAppendToDisk(e: TelemetryEvent): void {
  if (diskWriteFailed) return
  try {
    const dir = resolveLogDir()
    fs.mkdirSync(dir, { recursive: true })
    const fp = logFilePath()
    // Rotate when the file exceeds LOG_MAX_BYTES. One-shot rename to
    // `.1.ndjson`; retain just one previous generation to keep disk usage
    // bounded.
    try {
      const stat = fs.statSync(fp)
      if (stat.size > LOG_MAX_BYTES) {
        const rotated = fp.replace(/\.ndjson$/, '.1.ndjson')
        try {
          fs.rmSync(rotated, { force: true })
        } catch {
          /* ignore */
        }
        fs.renameSync(fp, rotated)
      }
    } catch {
      /* no existing file — fall through */
    }
    fs.appendFileSync(fp, `${JSON.stringify(e)}\n`, 'utf8')
  } catch {
    // Disk may be read-only (sandbox) or the electron `app` module might
    // be unavailable at the call site (e.g. cold-start before ready). Fail
    // silently and give up further disk writes for the rest of this
    // process — ring buffer remains.
    diskWriteFailed = true
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Public emission
// ─────────────────────────────────────────────────────────────────────────

export function emitContextTelemetryEvent(
  event: Omit<ContextTelemetryEvent, 'kind' | 'ts'>,
): void {
  if (!telemetryEnabled()) return
  const e: ContextTelemetryEvent = {
    kind: 'context',
    ts: Date.now(),
    ...event,
  }
  pushRing(e)
  tryAppendToDisk(e)
}

export function emitProviderErrorTelemetryEvent(
  event: Omit<ProviderErrorTelemetryEvent, 'kind' | 'ts'>,
): void {
  if (!telemetryEnabled()) return
  const e: ProviderErrorTelemetryEvent = {
    kind: 'provider_error',
    ts: Date.now(),
    ...event,
  }
  pushRing(e)
  tryAppendToDisk(e)
}

export function emitKeepRateTelemetryEvent(
  event: Omit<KeepRateTelemetryEvent, 'kind' | 'ts'>,
): void {
  if (!telemetryEnabled()) return
  const e: KeepRateTelemetryEvent = {
    kind: 'keep_rate',
    ts: Date.now(),
    ...event,
  }
  pushRing(e)
  tryAppendToDisk(e)
}

// ─────────────────────────────────────────────────────────────────────────
// Classification helper for provider errors
// ─────────────────────────────────────────────────────────────────────────

/**
 * Heuristic mapping from an error value to a stable {@link ProviderErrorKind}.
 * Used by the various provider clients to tag events without each one
 * reimplementing the same switch.
 */
export function classifyProviderError(
  error: unknown,
  httpStatus?: number,
): ProviderErrorKind {
  const status = httpStatus ?? readStatus(error)
  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'auth'
    if (status === 429) return 'rate_limit'
    if (status === 413) return 'context_length'
    if (status === 529) return 'overloaded'
    if (status >= 400 && status < 500) return 'gateway_400'
    if (status >= 500) return 'gateway_500'
  }
  const msg =
    error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const lower = msg.toLowerCase()
  if (/abort|cancel/.test(lower)) return 'abort'
  if (/timeout|etimedout|timed out/.test(lower)) return 'timeout'
  if (/econnrefused|econnreset|fetch failed|network/.test(lower)) return 'network'
  if (/context.*length|prompt.*too.*long|too many tokens|max.*tokens.*exceeded/.test(lower)) {
    return 'context_length'
  }
  if (/invalid.*api.*key|unauthori[sz]ed|authentication/.test(lower)) return 'auth'
  if (/rate limit/.test(lower)) return 'rate_limit'
  if (/overload/.test(lower)) return 'overloaded'
  return 'unknown'
}

function readStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const rec = error as Record<string, unknown>
    if (typeof rec.status === 'number') return rec.status
    if (typeof rec.statusCode === 'number') return rec.statusCode
    const resp = rec.response as Record<string, unknown> | undefined
    if (resp && typeof resp.status === 'number') return resp.status
  }
  return undefined
}

// ─────────────────────────────────────────────────────────────────────────
// Read-side API (for IPC handlers / bug report export)
// ─────────────────────────────────────────────────────────────────────────

export interface GetRecentTelemetryOptions {
  /** Max events to return from most recent first. */
  limit?: number
  /** When set, only events with `ts >= sinceMs` are returned. */
  sinceMs?: number
  /** Restrict to a single kind. */
  kind?: 'context' | 'provider_error' | 'keep_rate'
}

export function getRecentTelemetryEvents(
  options?: GetRecentTelemetryOptions,
): TelemetryEvent[] {
  const opts = options ?? {}
  const limit = Math.max(1, Math.min(opts.limit ?? RING_CAPACITY, RING_CAPACITY))
  let src = ring
  if (opts.sinceMs != null) {
    const s = opts.sinceMs
    src = src.filter((e) => e.ts >= s)
  }
  if (opts.kind) {
    src = src.filter((e) => e.kind === opts.kind)
  }
  // Most recent first.
  return src.slice(-limit).reverse()
}

/** Test-only hook — clear both ring and mark disk writing as healthy. */
export function __resetTelemetryForTests(): void {
  ring.length = 0
  diskWriteFailed = false
}

/** For bug-report bundle export: returns the on-disk path (or null when disabled). */
export function getTelemetryLogFilePath(): string | null {
  if (!telemetryEnabled()) return null
  return logFilePath()
}

/** Count events by kind for a quick summary. */
export function summarizeRecentTelemetry(sinceMs?: number): {
  total: number
  context: Partial<Record<ContextEventKind, number>>
  providerErrors: Partial<Record<ProviderErrorKind, number>>
  keepRate: Partial<Record<KeepRateBucket, Partial<Record<KeepRateOutcome, number>>>>
} {
  const ctxCounts: Partial<Record<ContextEventKind, number>> = {}
  const errCounts: Partial<Record<ProviderErrorKind, number>> = {}
  const krCounts: Partial<Record<KeepRateBucket, Partial<Record<KeepRateOutcome, number>>>> = {}
  let total = 0
  for (const e of ring) {
    if (sinceMs != null && e.ts < sinceMs) continue
    total++
    if (e.kind === 'context') {
      ctxCounts[e.action] = (ctxCounts[e.action] ?? 0) + 1
    } else if (e.kind === 'provider_error') {
      errCounts[e.errorKind] = (errCounts[e.errorKind] ?? 0) + 1
    } else {
      const bucket = (krCounts[e.bucket] ??= {})
      bucket[e.outcome] = (bucket[e.outcome] ?? 0) + 1
    }
  }
  return { total, context: ctxCounts, providerErrors: errCounts, keepRate: krCounts }
}
