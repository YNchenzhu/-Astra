/**
 * VerifyPlanExecution tool — model-callable closure for the
 * post-`ExitPlanMode` verification cycle.
 *
 * ## Lifecycle
 *
 *   1. Model calls `ExitPlanMode` → user approves → `finalizeExitPlanMode`
 *      writes a `PendingPlanVerification` entry keyed by the
 *      conversation id (see `planVerificationState.ts`).
 *   2. Model implements the plan over N iterations.
 *   3. `verify_plan_reminder` collector nudges the model after
 *      ≥ 5 iterations if it hasn't called this tool yet.
 *   4. Model calls `VerifyPlanExecution` with a `verificationReport`
 *      summarising what was completed / skipped / deviated.
 *   5. Tool returns success, the pending-verification state is
 *      cleared, the reminder stops firing.
 *
 * ## v2 — deterministic cross-checks (2026-06 verify-depth uplift)
 *
 * v1 was pure prompt-template: it recorded the report and cleared the
 * reminder with zero server-side validation, so the "verification" was
 * only as honest as the model's self-report. v2 adds two deterministic,
 * zero-LLM checks before clearing:
 *
 *   1. **Open-todo gate (blocking).** If the calling agent's TodoWrite
 *      list still has `pending` / `in_progress` items, the pending
 *      entry is NOT cleared and the result lists the open items. The
 *      model must finish (or explicitly re-status) them and re-call.
 *      Rationale: the todo list is the model's own declared plan
 *      decomposition — verifying "done" while it disagrees is the
 *      exact premature-completion failure this tool exists to catch.
 *   2. **Diagnostics advisory (non-blocking).** Error-severity LSP /
 *      Monaco diagnostics are surfaced as an advisory in the output.
 *      Non-blocking because errors may pre-date the plan or be
 *      unrelated. Degrades silently when the DiagnosticsHub is
 *      unavailable or empty — prose / document workspaces (no
 *      compiler, no linter) never see code-centric noise.
 *
 * Still NOT here: automatic test execution (project-specific, heavy,
 * and meaningless for non-code work — the workspace is also used for
 * writing / document tasks).
 */

import type { ToolResult, ToolUseContext } from './types'
import { buildTool } from './buildTool'
import { verifyPlanExecutionInputZod } from './toolInputZod'
import {
  clearPendingPlanVerification,
  getPendingPlanVerification,
} from '../planning/planVerificationState'
import { getAgentContext } from '../agents/agentContext'
import { getTodos } from './TodoWriteTool'
import { getDiagnosticsHub } from '../diagnostics/DiagnosticsHub'

/** Max open-todo items echoed back in the blocking result. */
const MAX_OPEN_TODOS_LISTED = 5

/**
 * Count error-severity diagnostics from the authoritative hub snapshot.
 * Returns `null` when the hub is unavailable (headless rigs) or empty —
 * callers treat `null` as "nothing to say" so non-code workspaces get
 * zero code-centric output. Exported for tests.
 */
export function countErrorDiagnostics(): { errors: number; files: number } | null {
  let snapshot
  try {
    snapshot = getDiagnosticsHub().getAllAuthoritative()
  } catch {
    return null
  }
  if (!snapshot?.length) return null
  let errors = 0
  let files = 0
  for (const file of snapshot) {
    const fileErrors = file.diagnostics.filter((d) => d.severity === 1).length
    if (fileErrors > 0) {
      errors += fileErrors
      files++
    }
  }
  return errors > 0 ? { errors, files } : null
}

export const verifyPlanExecutionTool = buildTool({
  name: 'VerifyPlanExecution',
  description:
    'Acknowledge that the implementation matches a previously-approved plan (from ExitPlanMode). Provide a structured verification report covering what was completed, skipped, or deviated. The host cross-checks your TodoWrite list: if open (pending/in_progress) items remain, the pending-verification entry is NOT cleared and you must finish or re-status them first. Outstanding error-severity diagnostics are surfaced as an advisory.',
  zInputSchema: verifyPlanExecutionInputZod,
  inputSchema: [
    {
      name: 'planId',
      type: 'string',
      description: 'Optional plan identifier from a prior ExitPlanMode result.',
    },
    {
      name: 'verificationReport',
      type: 'string',
      description:
        'Structured report: completed steps / skipped / deviations / tests run.',
    },
  ],
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(
    { planId, verificationReport },
    _ctx?: ToolUseContext,
  ): Promise<ToolResult> {
    const agentCtx = getAgentContext()
    const conversationId = agentCtx?.streamConversationId?.trim()
    if (!conversationId) {
      // No conversation context — accept the report at face value
      // without clearing any state. Best-effort path for direct API
      // / scripted invocations.
      return {
        success: true,
        output:
          'Verification report recorded (no conversation context to clear).',
      }
    }

    const pending = getPendingPlanVerification(conversationId)

    // ── v2 check 1: open-todo gate (blocking) ──
    // Only applies while a pending-verification entry actually exists:
    // without one there is nothing to protect (the tool degenerates to
    // v1 record-and-acknowledge), and the blocking message would lie
    // ("entry was NOT cleared" with no entry present).
    //
    // The todo list is keyed by agentId ('main' for the main chat —
    // same key `activeTodoPanelGuard` / `goalRecitation` read).
    const todoKey = agentCtx?.agentId ?? 'main'
    const openTodos = pending
      ? getTodos(todoKey).filter(
          (t) => t.status === 'pending' || t.status === 'in_progress',
        )
      : []
    if (openTodos.length > 0) {
      const listed = openTodos
        .slice(0, MAX_OPEN_TODOS_LISTED)
        .map((t) => `  - [${t.status}] ${t.content.replace(/\s+/g, ' ').trim()}`)
      const overflow =
        openTodos.length > MAX_OPEN_TODOS_LISTED
          ? `\n  … (+${openTodos.length - MAX_OPEN_TODOS_LISTED} more)`
          : ''
      return {
        success: true,
        output:
          `Verification NOT accepted — your TodoWrite list still has ${openTodos.length} open item(s):\n` +
          `${listed.join('\n')}${overflow}\n` +
          'The pending-verification entry was NOT cleared. Finish the open items (or explicitly mark them completed/cancelled via TodoWrite if they no longer apply), then call VerifyPlanExecution again.',
      }
    }

    // If the model supplied a planId, surface a mismatch when the
    // stored plan id differs. This is informational — we still clear
    // the entry, because the model has demonstrated awareness of the
    // verification cycle.
    let mismatch: string | undefined
    if (pending && planId && planId !== pending.planId) {
      mismatch =
        `Note: provided planId "${planId}" does not match the pending entry's planId ` +
        `"${pending.planId}". Clearing the pending entry anyway based on report submission.`
    }

    clearPendingPlanVerification(conversationId)

    const summaryLines: string[] = [
      pending
        ? `Verification acknowledged for plan "${pending.planId}". Pending-verification reminder cleared.`
        : 'Verification report recorded. No matching pending-verification entry was active.',
    ]
    if (mismatch) summaryLines.push(mismatch)

    // ── v2 check 2: diagnostics advisory (non-blocking) ──
    // Silent for prose / document workspaces (hub empty or absent).
    const diagSummary = countErrorDiagnostics()
    if (diagSummary) {
      summaryLines.push(
        `Advisory: ${diagSummary.errors} error-severity diagnostic(s) across ${diagSummary.files} file(s) are currently outstanding. ` +
          'If any relate to the plan implementation, fix them before reporting completion to the user; otherwise note them as pre-existing in your report.',
      )
    }

    summaryLines.push(
      `Report preview: ${verificationReport.slice(0, 200).replace(/\s+/g, ' ').trim()}${
        verificationReport.length > 200 ? '…' : ''
      }`,
    )

    return {
      success: true,
      output: summaryLines.join('\n'),
    }
  },
})
