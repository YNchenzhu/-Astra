/**
 * LSP diagnostics collector — surfaces current authoritative LSP / Monaco
 * diagnostics to the model.
 *
 * upstream analog: `lsp_diagnostics` attachment
 * (`src/utils/attachments.ts#getLSPDiagnosticAttachments`,
 *  `src/utils/messages.ts` case `'lsp_diagnostics'`). upstream emits
 * an `<system-reminder>` user message listing per-file diagnostics
 * counts + the worst severity, so the model can react to new errors
 * without being asked.
 *
 * ## Data source
 *
 * Adapts `DiagnosticsHub.getAllAuthoritative()` to the upstream
 * format. We use the **authoritative** snapshot (Monaco-vs-LSP
 * arbitration already resolved) so the model sees the same picture
 * as the Problems panel.
 *
 * ## Gating
 *
 * - **On by default**. Disable via `POLE_LSP_DIAGNOSTICS_ATTACHMENT=0`.
 *
 *   Caveat: in an unhealthy codebase this collector re-emits the
 *   same diagnostic dump on every post_tool boundary, which can
 *   accumulate quickly. Hard caps in place
 *   (`MAX_FILES_REPORTED` = 15, `MAX_DIAGNOSTICS_PER_FILE` = 5)
 *   bound a single emission's size. Cadence is bounded twice:
 *   identical rendered bodies are hash-deduped (R4-M3), and a body
 *   that changed only cosmetically (per-severity totals unchanged —
 *   e.g. an error moved lines during an edit churn) is rate-limited
 *   to one emission per {@link MIN_REEMIT_GAP_ITERATIONS} iterations
 *   (2026-06 verify-depth uplift). A genuine totals change always
 *   emits immediately.
 * - Main chat by default — sub-agents have narrower scope and tools
 *   to query diagnostics directly when needed. Long-lived delegated
 *   agents (background teammates) can opt in via
 *   `POLE_LSP_DIAGNOSTICS_SUBAGENT=1`.
 * - Empty snapshot → no-op (nothing useful to say).
 *
 * ## Format
 *
 * Mirrors upstream's compressed shape rather than the raw LSP JSON
 * because most models cope better with terse human-readable text
 * than with nested JSON in `<system-reminder>` blobs.
 */

import { createHash } from 'node:crypto'
import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import {
  SIDE_CHANNEL_KIND,
  wrapSideChannelBody,
} from '../../../constants/sideChannelKinds'
import { getDiagnosticsHub } from '../../../diagnostics/DiagnosticsHub'

/**
 * Audit fix R4-M3 (2026-05) — per-conversation record of the last
 * emission. When the next post_tool boundary's snapshot hashes the
 * same, we skip emission so the model doesn't see N copies of
 * "error count: 12" across N silent post_tool ticks. Hash covers
 * the rendered body (after cap + truncation) so identical visible
 * content is the dedup criterion.
 *
 * 2026-06 verify-depth uplift — the record also carries the
 * per-severity totals + the iteration of the last emission so a
 * cosmetic churn (hash changed because an error moved lines, totals
 * identical) is rate-limited instead of re-emitted every boundary.
 *
 * Bounded by LRU eviction so the map cannot grow unbounded across
 * the host process lifetime.
 */
interface LastEmission {
  hash: string
  /** Canonical `${errors}/${warnings}/${info}` totals key. */
  totalsKey: string
  iteration: number
}

const LAST_EMITTED_BY_CONV = new Map<string, LastEmission>()
const LAST_EMITTED_MAX_BUCKETS = 32

/**
 * Minimum iterations between two emissions whose per-severity totals
 * are identical (but whose rendered bodies differ, e.g. positions
 * shifted during an edit). A genuine totals change bypasses this gap.
 */
export const MIN_REEMIT_GAP_ITERATIONS = 5

function recordLastEmission(convId: string, entry: LastEmission): void {
  // LRU-touch on hit.
  LAST_EMITTED_BY_CONV.delete(convId)
  LAST_EMITTED_BY_CONV.set(convId, entry)
  while (LAST_EMITTED_BY_CONV.size > LAST_EMITTED_MAX_BUCKETS) {
    const oldest = LAST_EMITTED_BY_CONV.keys().next().value
    if (oldest === undefined || oldest === convId) break
    LAST_EMITTED_BY_CONV.delete(oldest)
  }
}

/** @internal Test-only seam. */
export function __resetLspDiagnosticsHashCacheForTests(): void {
  LAST_EMITTED_BY_CONV.clear()
}

/** Env flag — feature is ON by default; only an explicit `0` disables. */
function isLspDiagnosticsAttachmentEnabled(): boolean {
  const raw = process.env.POLE_LSP_DIAGNOSTICS_ATTACHMENT?.trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'no') return false
  return true
}

/** Hard cap so a flood of errors can't blow up a single side-channel. */
const MAX_FILES_REPORTED = 15
const MAX_DIAGNOSTICS_PER_FILE = 5

/** Map HubSeverity (1=Error, 2=Warning, 3=Info, 4=Hint) to label. */
function severityLabel(sev: number): string {
  switch (sev) {
    case 1: return 'error'
    case 2: return 'warn'
    case 3: return 'info'
    case 4: return 'hint'
    default: return `sev${sev}`
  }
}

export const lspDiagnosticsCollector: Collector = {
  name: 'lsp_diagnostics',
  callSites: ['post_tool'],

  async run(ctx) {
    if (!isLspDiagnosticsAttachmentEnabled()) return null
    const { state } = ctx

    const agentCtx = getAgentContext()
    const isMainChat = !agentCtx?.agentId || agentCtx.agentId === 'main'
    // 2026-06 verify-depth uplift — long-lived delegated agents can opt
    // in; default stays main-chat-only (sub-agents are typically short-
    // lived and budget-capped).
    if (!isMainChat && process.env.POLE_LSP_DIAGNOSTICS_SUBAGENT !== '1') {
      return null
    }

    let snapshot
    try {
      snapshot = getDiagnosticsHub().getAllAuthoritative()
    } catch {
      // Hub not initialised (e.g. headless test rigs) → silent skip.
      return null
    }
    if (!snapshot.length) return null

    const lines: string[] = []
    let totalErrors = 0
    let totalWarnings = 0
    let totalInfo = 0
    let filesReported = 0

    for (const file of snapshot) {
      if (file.diagnostics.length === 0) continue
      if (filesReported >= MAX_FILES_REPORTED) {
        const remaining = snapshot.length - filesReported
        if (remaining > 0) lines.push(`… (+${remaining} more files)`)
        break
      }

      const errs = file.diagnostics.filter((d) => d.severity === 1).length
      const wrns = file.diagnostics.filter((d) => d.severity === 2).length
      const info = file.diagnostics.filter((d) => d.severity === 3).length
      totalErrors += errs
      totalWarnings += wrns
      totalInfo += info

      const top = file.diagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE)
      const items = top
        .map((d) => {
          const line = (d.range?.start?.line ?? 0) + 1
          const col = (d.range?.start?.character ?? 0) + 1
          const src = d.source ? `[${d.source}] ` : ''
          return `  ${severityLabel(d.severity)} ${line}:${col} ${src}${d.message.trim()}`
        })
        .join('\n')
      const overflow =
        file.diagnostics.length > MAX_DIAGNOSTICS_PER_FILE
          ? `\n  … (+${file.diagnostics.length - MAX_DIAGNOSTICS_PER_FILE} more)`
          : ''
      lines.push(`- ${file.uri} (${file.diagnostics.length})\n${items}${overflow}`)
      filesReported++
    }
    if (!lines.length) return null

    const totals =
      `${totalErrors} error(s), ${totalWarnings} warning(s), ${totalInfo} info`
    const body =
      `LSP / Monaco diagnostics (authoritative): ${totals}\n\n` +
      lines.join('\n')

    // Audit fix R4-M3 (2026-05) — only emit when the rendered body
    // changed since the last emission for this conversation. Without
    // this, every post_tool boundary in a long edit session re-sent
    // the same "12 errors in foo.ts" block, so the model saw 20+
    // identical reminders and treated them as cumulative ("errors
    // are getting worse") even when nothing changed. Conversation id
    // is the per-chat scope; on a missing id we skip the dedup
    // (legacy behaviour).
    const convId = agentCtx?.streamConversationId?.trim()
    if (convId) {
      const hash = createHash('sha256').update(body).digest('hex')
      const totalsKey = `${totalErrors}/${totalWarnings}/${totalInfo}`
      const last = LAST_EMITTED_BY_CONV.get(convId)
      if (last?.hash === hash) {
        // Same diagnostic surface as the previous emission — no-op.
        return null
      }
      // 2026-06 verify-depth uplift — cosmetic-churn throttle: the body
      // changed but every per-severity total is identical (typically an
      // error shifting line numbers while the model edits around it).
      // Rate-limit to one emission per MIN_REEMIT_GAP_ITERATIONS. The
      // stored record is intentionally NOT updated on the skip path so
      // the gap measures from the last emission the model actually saw.
      if (
        last &&
        last.totalsKey === totalsKey &&
        state.iteration - last.iteration < MIN_REEMIT_GAP_ITERATIONS
      ) {
        return null
      }
      recordLastEmission(convId, { hash, totalsKey, iteration: state.iteration })
    }

    state.appendixReport('P2_Q_compaction_reminder', {
      iteration: state.iteration,
      kind: 'lsp_diagnostics',
      filesReported,
      totalErrors,
      totalWarnings,
      totalInfo,
    })

    return {
      kind: 'push_message',
      sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      message: {
        role: 'user',
        content: wrapSideChannelBody(
          SIDE_CHANNEL_KIND.genericConvertedSystem,
          body,
        ),
        _convertedFromSystem: true,
        _sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      },
    }
  },
}
