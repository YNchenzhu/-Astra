/**
 * Prose-edit verification reminder — closes the observe-act-verify loop
 * for DOCUMENT / TEXT work (2026-06 verify-depth uplift).
 *
 * ## Why
 *
 * Code edits get an automatic verification signal: the `lspDiagnostics`
 * collector feeds compiler / linter findings back to the model after
 * every tool batch. Prose edits (markdown, plain text, AsciiDoc, LaTeX,
 * …) have NO equivalent — nothing tells the model "re-check what you
 * just wrote". This workspace is used for writing / document tasks as
 * well as coding, so the verification gap is real: replaced-text
 * fragments, broken heading structure, and incoherent splices ship
 * silently.
 *
 * This collector watches the just-executed tool batch
 * (`state.toolUseBlocks` is still this iteration's batch at the
 * `post_tool` call site) for file-mutation tools targeting prose
 * extensions, and emits a `<system-reminder>` telling the model to
 * re-read the final document before treating the work as done.
 *
 * ## Gating
 *
 * - **On by default.** Disable via `POLE_PROSE_VERIFY_REMINDER=0`.
 * - Fires for main chat AND sub-agents (a delegated writing task needs
 *   the verification nudge just as much; cost is bounded by the
 *   throttles below).
 * - Per-scope throttles: minimum {@link MIN_ITERATIONS_BETWEEN_NUDGES}
 *   iterations between any two nudges, and a file already nudged is
 *   not re-nudged until {@link RENUDGE_FILE_AFTER_ITERATIONS}
 *   iterations later (covers "edit, nudge, edit again much later").
 * - `post_tool` call site only; no prose files in the batch → no-op,
 *   so pure-code sessions never see this.
 */

import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import {
  SIDE_CHANNEL_KIND,
  wrapSideChannelBody,
} from '../../../constants/sideChannelKinds'
import {
  isBuiltinFileMutationTool,
  extractWorkspaceFilePathFromToolInput,
} from '../../../tools/builtinToolAliases'

/** Extensions treated as prose / document targets (lowercase, with dot). */
export const PROSE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md', '.markdown', '.mdx',
  '.txt', '.text',
  '.rst', '.adoc', '.asciidoc',
  '.tex', '.org', '.rtf',
])

export const MIN_ITERATIONS_BETWEEN_NUDGES = 3
export const RENUDGE_FILE_AFTER_ITERATIONS = 10
const MAX_FILES_LISTED = 5
const MAX_SCOPE_BUCKETS = 32

interface ScopeTracking {
  lastNudgeIteration: number
  /** file path → iteration at which it was last included in a nudge. */
  nudgedAtByFile: Map<string, number>
}

const trackingByScope = new Map<string, ScopeTracking>()

function touchScope(scopeKey: string): ScopeTracking {
  let entry = trackingByScope.get(scopeKey)
  if (entry) {
    // LRU-touch.
    trackingByScope.delete(scopeKey)
    trackingByScope.set(scopeKey, entry)
    return entry
  }
  entry = { lastNudgeIteration: -Infinity, nudgedAtByFile: new Map() }
  trackingByScope.set(scopeKey, entry)
  while (trackingByScope.size > MAX_SCOPE_BUCKETS) {
    const oldest = trackingByScope.keys().next().value
    if (oldest === undefined || oldest === scopeKey) break
    trackingByScope.delete(oldest)
  }
  return entry
}

/** @internal Test-only seam. */
export function __resetProseVerifyReminderTrackingForTests(): void {
  trackingByScope.clear()
}

function isProseVerifyReminderEnabled(): boolean {
  const raw = process.env.POLE_PROSE_VERIFY_REMINDER?.trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'no') return false
  return true
}

/** Extract the lowercase extension (with dot) or '' when absent. */
function extOf(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot).toLowerCase()
}

/**
 * Pure helper — pick the prose-file targets out of a tool batch.
 * Exported for tests.
 */
export function collectProseTargets(
  toolUseBlocks: ReadonlyArray<{ name: string; input: Record<string, unknown> }>,
): string[] {
  const seen = new Set<string>()
  for (const block of toolUseBlocks) {
    if (!isBuiltinFileMutationTool(block.name)) continue
    const path = extractWorkspaceFilePathFromToolInput(block.input)
    if (!path) continue
    if (!PROSE_EXTENSIONS.has(extOf(path))) continue
    seen.add(path)
  }
  return [...seen]
}

export const proseEditVerifyReminderCollector: Collector = {
  name: 'prose_edit_verify_reminder',
  callSites: ['post_tool'],

  async run(ctx) {
    if (!isProseVerifyReminderEnabled()) return null
    const { state } = ctx

    const targets = collectProseTargets(state.toolUseBlocks)
    if (targets.length === 0) return null

    const agentCtx = getAgentContext()
    const convId = agentCtx?.streamConversationId?.trim() ?? ''
    const scopeKey = `${convId}:${agentCtx?.agentId ?? 'main'}`
    const tracking = touchScope(scopeKey)

    // Global cadence throttle for this scope.
    if (
      state.iteration - tracking.lastNudgeIteration <
      MIN_ITERATIONS_BETWEEN_NUDGES
    ) {
      return null
    }

    // Per-file re-nudge window: only files NOT nudged recently qualify.
    const fresh = targets.filter((p) => {
      const last = tracking.nudgedAtByFile.get(p)
      return last === undefined ||
        state.iteration - last >= RENUDGE_FILE_AFTER_ITERATIONS
    })
    if (fresh.length === 0) return null

    tracking.lastNudgeIteration = state.iteration
    for (const p of fresh) tracking.nudgedAtByFile.set(p, state.iteration)

    const listed = fresh.slice(0, MAX_FILES_LISTED).map((p) => `  - ${p}`)
    const overflow =
      fresh.length > MAX_FILES_LISTED
        ? `\n  … (+${fresh.length - MAX_FILES_LISTED} more)`
        : ''

    const body =
      `[Document edit verification] This tool batch modified ${fresh.length} document/prose file(s):\n` +
      `${listed.join('\n')}${overflow}\n` +
      'Unlike code, document edits get no compiler / linter / diagnostics feedback. ' +
      'Before treating this work as done, re-read the final version of each file (Read tool) and verify: ' +
      'content coherence around the edited region, heading / formatting structure, no leftover fragments ' +
      'from replaced text, and consistent terminology. This is background guidance — the only new work it ' +
      'asks for is the verification read.'

    state.appendixReport('P2_Q_compaction_reminder', {
      iteration: state.iteration,
      kind: 'prose_edit_verify_reminder',
      fileCount: fresh.length,
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
