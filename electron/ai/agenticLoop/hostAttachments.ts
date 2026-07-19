/**
 * Host-attachments orchestrator — upstream parity for
 * `src/utils/attachments.ts#getAttachmentMessages`.
 *
 * ## Why this exists
 *
 * upstream (and the official upstream architecture it mirrors) routes
 * every host-injected "meta" message through a single orchestration
 * point: `getAttachmentMessages`. That function calls 20-30 small
 * `maybe(label, async () => ...)` collectors in parallel, isolates each
 * failure, and yields a flat ordered list of `AttachmentMessage`
 * objects which the caller appends to `toolResults` (the user-role
 * tool_results array). The model then sees them as "system observations
 * attached to the prior tool batch" rather than fresh user instructions.
 *
 * Our pole historically scattered the equivalent injections across:
 *
 *   - `iteration.ts` (Host transcript inbox, inter-agent queue, the deleted
 *     wrap-up directives, the recently-added compaction_reminder)
 *   - `preModel.ts` (sub-agent terminal-output injection)
 *   - `noTools.ts` (inter-agent queue second pass, token budget reminder)
 *   - `stream.ts` (max-output recovery user message)
 *
 * Six call sites, each with its own try/catch policy (or none), each
 * with its own ordering invariant. When `<system-reminder>` injections
 * stack up under context pressure the model gets confused — see the
 * audit report (electron/ai/agenticLoop/loopShared.ts comments around
 * `_compactionReminderInjected`).
 *
 * This module is the upstream-aligned replacement. Each collector is a
 * pure-ish function that:
 *
 *   1. Accepts the {@link AttachmentContext} (state + call-site tag).
 *   2. Decides — based on its own gates — whether to fire.
 *   3. Returns zero or more {@link CollectorAction} values.
 *
 * The orchestrator runs all collectors that match the requested call
 * site in parallel (via `Promise.all`), isolates each failure with
 * {@link maybe}, and applies the actions in **a deterministic order**
 * defined by the static `COLLECTORS` array. Determinism matters because
 * the model perceives ordering — date_change before token_usage feels
 * different from the reverse.
 *
 * ## Call-site dispatch
 *
 * A collector declares which call sites it participates in via
 * {@link Collector.callSites}. Two are wired today:
 *
 *   - `'iteration_top'`   — start of the iteration body, before the
 *                            pre-model pipeline. Reserved for inputs
 *                            that must be visible to the FIRST stream
 *                            call of THIS iteration. Currently the
 *                            sole consumer is `pendingToolUseSummary`
 *                            (consumes the previous iteration's haiku
 *                            recap before this iteration's
 *                            `executeToolBatch` kicks off a new haiku).
 *   - `'post_tool'`       — after the tool batch executes, before the
 *                            next iteration's pre-model pipeline runs.
 *                            upstream's natural injection point. The
 *                            other collectors all live here.
 *
 * Phase A shipped the orchestrator + `compactionReminder`. Phase B
 * migrated the four pre-existing iter-top injection sites + added
 * `dateChange` / `tokenUsage`. Phase C added `pendingToolUseSummary`
 * + `lspDiagnostics`. Phase D filled the remaining upstream-equivalent
 * gaps (`mcpInstructionsDelta` / `agentListingDelta` / `buddyStateChange`
 * / `subAgentStatusDigest` / `contextEfficiency` / `outputStyle` /
 * `verifyPlanReminder`). The 2026-06 verify-depth uplift added
 * `proseEditVerifyReminder` (document-edit re-read nudge, the prose
 * counterpart to `lspDiagnostics`). All collectors run default-on;
 * the env flags `POLE_<NAME>=0` disable individual ones.
 */

import type { LoopState } from './loopShared'
import {
  readSideChannelKind,
  wrapSideChannelBody,
  SIDE_CHANNEL_KIND,
} from '../../constants/sideChannelKinds'
import type { SideChannelKind } from '../../constants/sideChannelKinds'

// ─── Public types ─────────────────────────────────────────────────────

/**
 * Where the orchestrator is being invoked from. Collectors filter on
 * this to decide whether their gates apply.
 *
 *   - `'iteration_top'`     — start of each inner iteration, before the model call.
 *   - `'post_tool'`         — after a tool batch resolves (the upstream
 *                             `getAttachmentMessages` analog). Skipped on
 *                             no-tool turns (no tool batch runs).
 *   - `'no_tools_continue'` — no-tool turn that decided to CONTINUE
 *                             (stop-hook / token-budget / guard nudge).
 *                             Runs the inbox / notifications / digest
 *                             collectors that would otherwise be starved
 *                             until the next tool batch. Invoked from
 *                             `noTools.ts` between the assistant reply and
 *                             the continuation directive so the directive
 *                             stays the transcript tail. Pure-nudge
 *                             collectors (reminders) deliberately stay
 *                             `post_tool`-only to avoid double-nudging.
 */
export type AttachmentCallSite =
  | 'iteration_top'
  | 'post_tool'
  | 'no_tools_continue'

export interface AttachmentContext {
  readonly state: LoopState
  readonly systemPrompt: string
  readonly callSite: AttachmentCallSite
}

/**
 * What a collector wants the orchestrator to do with its output.
 *
 *   - `push_message`        — append a brand-new user-role message
 *                              (typical for `<system-reminder>` blobs).
 *                              The orchestrator does NOT merge with the
 *                              previous user message; `normalizeMessagesForAPI`
 *                              handles wire-level merging downstream.
 *   - `concat_to_last_user` — append text to the most recent user
 *                              message. Currently unused by any shipped
 *                              collector (`pendingToolUseSummary` switched
 *                              to `push_message` with a `toolUseSummary`
 *                              side-channel kind); retained for collectors
 *                              that want to fold text into the prior user
 *                              turn without creating a fresh meta turn.
 */
export type CollectorAction =
  | {
      readonly kind: 'push_message'
      readonly message: Record<string, unknown>
      readonly sideChannelKind?: SideChannelKind
      /**
       * Replace-in-place: when set, every prior standalone side-channel
       * message of this kind is removed from the transcript before the
       * push, so at most ONE instance survives. Used by turn-entry
       * contracts (`system_drive_context`) that must refresh per user
       * turn instead of stacking a copy every turn.
       */
      readonly replaceSideChannelKind?: SideChannelKind
    }
  | {
      readonly kind: 'concat_to_last_user'
      readonly text: string
    }

export interface CollectorRunResult {
  readonly actions?: CollectorAction | ReadonlyArray<CollectorAction>
  readonly requiresConversationSync?: boolean
}

export interface Collector {
  /** Telemetry tag, also used by `maybe()` for error attribution. */
  readonly name: string
  /** Call sites this collector participates in. */
  readonly callSites: ReadonlyArray<AttachmentCallSite>
  /**
   * Returns the actions to apply. May return `null` (no-op),
   * a single action, or an array. Errors are caught by the
   * orchestrator and logged; do NOT swallow them here unless
   * the swallow is part of the collector's contract.
   */
  readonly run: (
    ctx: AttachmentContext,
  ) => Promise<CollectorAction | ReadonlyArray<CollectorAction> | CollectorRunResult | null>
}

/** Per-collector outcome surfaced to the orchestrator caller (for telemetry). */
export interface CollectorOutcome {
  readonly name: string
  readonly ok: boolean
  readonly actionCount: number
  readonly error?: unknown
  /**
   * 2026-07 injection-budget uplift — true when the collector was NOT run
   * because the per-invocation injection budget was already exhausted by
   * higher-priority collectors. A shed collector's `run()` is never
   * invoked, so any internal delta/latch state it would have consumed
   * stays intact and it fires naturally on a later iteration.
   */
  readonly shed?: boolean
}

export interface OrchestratorResult {
  readonly outcomes: ReadonlyArray<CollectorOutcome>
  readonly appliedActions: number
  readonly requiresConversationSync: boolean
  /** Names of collectors shed by the injection budget (registry order). */
  readonly shedCollectors: ReadonlyArray<string>
}

// ─── Injection budget (2026-07 uplift) ─────────────────────────────────

/**
 * Priority tier for budget shedding. NOT the same thing as registry
 * order: registry order is the model's PERCEPTION order among whatever
 * gets injected; priority decides WHAT gets injected when many
 * collectors fire on the same iteration.
 *
 *   - `critical` — queue drains and one-shot deliveries whose content is
 *     lost (or duplicated later at higher cost) if not delivered NOW:
 *     kernel inbox (user mid-turn input!), inter-agent mail, sub-agent
 *     outputs, task-runtime notifications. NEVER shed, and exempt from
 *     budget accounting entirely.
 *   - `high`   — actionable environment signals the model should see
 *     promptly (LSP diagnostics, MCP instruction deltas, active-skill
 *     workflow directives).
 *   - `normal` — standing advisories and hygiene reminders. Deferrable:
 *     each re-derives from now-state and re-fires on a later iteration.
 *   - `low`    — purely informational notices.
 */
export type AttachmentPriority = 'critical' | 'high' | 'normal' | 'low'

/**
 * Central priority registry, keyed by collector `name`. Kept beside
 * {@link COLLECTORS} so the two lists are reviewed together. Unlisted
 * names (future collectors) default to `'normal'` — the safe tier for
 * anything reminder-shaped.
 */
export const COLLECTOR_PRIORITY: Readonly<Record<string, AttachmentPriority>> = {
  // Queue drains / one-shot deliveries — must never be shed.
  pending_tool_use_summary: 'critical',
  kernel_inbox: 'critical',
  inter_agent_queue: 'critical',
  task_runtime_notifications: 'critical',
  team_inbox: 'critical',
  sub_agent_outputs: 'critical',
  sub_agent_status_digest: 'critical',
  // Actionable environment signals.
  mcp_instructions_delta: 'high',
  lsp_diagnostics: 'high',
  active_skill_reminder: 'high',
  // Per-step budget escalations are control directives (the hard variant
  // also just mutated TaskManager state) — must not be starved by the
  // reminder crowd.
  plan_step_budget: 'high',
  plan_step_scope: 'normal',
  objective_conflict: 'high',
  // Deterministic user-signal: the current turn names a loaded skill via
  // /name or @name. High — it is a direct instruction-adjacent signal for
  // THIS turn; shedding it means the model may re-implement the skill's
  // workflow from memory. The once-per-pair latch keys on message content,
  // so a shed run re-fires identically on the next iteration-top pass.
  explicit_skill_mention: 'high',
  // Turn-entry task contract — the "read this before acting" layer for
  // intent + quality. High (not critical): replace-in-place means a shed
  // occurrence is re-derived losslessly at the next turn entry.
  system_drive_context: 'high',
  // Standing advisories / hygiene reminders.
  agent_listing_delta: 'normal',
  buddy_state_change: 'normal',
  output_style: 'normal',
  date_change: 'normal',
  token_usage: 'normal',
  prose_edit_verify_reminder: 'normal',
  verify_plan_reminder: 'normal',
  stale_todo_nudge: 'normal',
  stale_task_nudge: 'normal',
  compaction_reminder: 'normal',
  // Purely informational.
  context_efficiency: 'low',
  drift_score_monitor: 'low',
}

const PRIORITY_RANK: Readonly<Record<AttachmentPriority, number>> = {
  critical: 3,
  high: 2,
  normal: 1,
  low: 0,
}

function priorityOf(collector: Collector): AttachmentPriority {
  return COLLECTOR_PRIORITY[collector.name] ?? 'normal'
}

/**
 * Per-invocation budget for NON-critical collectors. Without it, a bad
 * iteration can stack five-plus `<system-reminder>` messages after one
 * tool batch (diagnostics + status digest + stale-todo + token-usage +
 * compaction…) — exactly the "injections stack up and the model gets
 * confused" failure mode this orchestrator's header describes. Ordering
 * alone doesn't bound volume; this does.
 *
 * Semantics:
 *   - `critical` collectors always run and apply; they consume no budget.
 *   - Everything else runs in priority order (high → normal → low; ties
 *     by registry index). Before EACH run the remaining budget is
 *     checked; once exhausted, remaining collectors are shed WITHOUT
 *     running (their internal latches stay unconsumed, so nothing is
 *     lost — they re-fire on a later, quieter iteration).
 *   - Budget discovered exceeded only AFTER a run (the collector emitted
 *     more than the remainder) still applies that collector's actions —
 *     dropping post-run output would silently lose latched deltas — and
 *     then closes the gate for the rest.
 *
 * Operator tuning (read per invocation so tests / live ops can adjust):
 *   - `POLE_ATTACHMENT_BUDGET=0`             disable (legacy unlimited)
 *   - `POLE_ATTACHMENT_BUDGET_MAX_MESSAGES`  actions per invocation (default 3)
 *   - `POLE_ATTACHMENT_BUDGET_MAX_CHARS`     chars per invocation (default 8000)
 */
export const ATTACHMENT_BUDGET_DEFAULT_MAX_MESSAGES = 3
export const ATTACHMENT_BUDGET_DEFAULT_MAX_CHARS = 8_000

function isInjectionBudgetEnabled(): boolean {
  const raw = process.env.POLE_ATTACHMENT_BUDGET?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
}

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function resolveInjectionBudget(): { maxMessages: number; maxChars: number } {
  return {
    maxMessages: parsePositiveIntEnv(
      process.env.POLE_ATTACHMENT_BUDGET_MAX_MESSAGES,
      ATTACHMENT_BUDGET_DEFAULT_MAX_MESSAGES,
    ),
    maxChars: parsePositiveIntEnv(
      process.env.POLE_ATTACHMENT_BUDGET_MAX_CHARS,
      ATTACHMENT_BUDGET_DEFAULT_MAX_CHARS,
    ),
  }
}

/** Rough char size of an action, for the char half of the budget. */
export function estimateActionChars(action: CollectorAction): number {
  if (action.kind === 'concat_to_last_user') return action.text.length
  const content = (action.message as { content?: unknown }).content
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    let n = 0
    for (const block of content as Array<Record<string, unknown>>) {
      if (typeof block?.text === 'string') n += block.text.length
    }
    return n
  }
  return 0
}

// ─── Failure isolation (upstream `maybe` analog) ────────────────────────

/**
 * upstream parity (`src/utils/attachments.ts#maybe`).
 *
 * Wraps a collector invocation so a thrown error returns the empty
 * action list. Logs via `console.warn` keyed by the collector name;
 * full telemetry is the caller's job (it has the structured
 * `CollectorOutcome` from {@link runCollectors}).
 */
async function maybe(
  collector: Collector,
  ctx: AttachmentContext,
): Promise<{
  actions: ReadonlyArray<CollectorAction>
  requiresConversationSync: boolean
  outcome: CollectorOutcome
}> {
  try {
    const raw = await collector.run(ctx)
    const structured =
      raw != null &&
      !Array.isArray(raw) &&
      !('kind' in raw)
        ? raw as CollectorRunResult
        : null
    const rawActions = structured?.actions ?? (structured ? null : raw)
    const actions: ReadonlyArray<CollectorAction> = rawActions == null
      ? []
      : Array.isArray(rawActions)
        ? rawActions
        : [rawActions as CollectorAction]
    return {
      actions,
      requiresConversationSync: structured?.requiresConversationSync === true,
      outcome: {
        name: collector.name,
        ok: true,
        actionCount: actions.length,
      },
    }
  } catch (err) {
    console.warn(`[hostAttachments] collector "${collector.name}" failed:`, err)
    return {
      actions: [],
      requiresConversationSync: false,
      outcome: {
        name: collector.name,
        ok: false,
        actionCount: 0,
        error: err,
      },
    }
  }
}

// ─── Action application ────────────────────────────────────────────────

/**
 * Apply a single action to `state.apiMessages`. Pure-ish — mutates the
 * array in place (matches existing iteration-body convention) but
 * returns the action mode for caller telemetry.
 *
 * Exported for unit testing.
 */
export function applyAction(
  state: LoopState,
  action: CollectorAction,
): void {
  if (action.kind === 'push_message') {
    if (action.replaceSideChannelKind) {
      // Replace-in-place: drop every prior standalone side-channel message
      // of this kind (typed flag preferred; falls back to body-marker
      // detection for transcripts loaded from disk). Only whole user-role
      // side-channel messages are candidates — tool_result user turns have
      // array content and a different kind, so they never match.
      state.apiMessages = state.apiMessages.filter(
        (m) =>
          m.role !== 'user' ||
          readSideChannelKind(m) !== action.replaceSideChannelKind,
      )
    }
    state.apiMessages.push(action.message)
    return
  }
  // 'concat_to_last_user'
  const lastUserIdx = findLastUserMessageIndex(state.apiMessages)
  if (lastUserIdx < 0) {
    // No user message to attach to — fall back to a standalone push so
    // the text isn't silently dropped. Wrap in the generic side-channel
    // envelope to keep the smoosh/merge pipeline happy.
    state.apiMessages.push({
      role: 'user',
      content: wrapSideChannelBody(
        SIDE_CHANNEL_KIND.genericConvertedSystem,
        action.text,
      ),
      _convertedFromSystem: true,
      _sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
    })
    return
  }
  const lastMsg = state.apiMessages[lastUserIdx]!
  const c = lastMsg.content
  if (typeof c === 'string') {
    state.apiMessages[lastUserIdx] = { ...lastMsg, content: `${c}\n\n${action.text}` }
  } else if (Array.isArray(c)) {
    state.apiMessages[lastUserIdx] = {
      ...lastMsg,
      content: [
        ...(c as Array<Record<string, unknown>>),
        { type: 'text', text: action.text },
      ],
    }
  } else {
    // Unknown shape — push as a new message rather than corrupting.
    state.apiMessages.push({
      role: 'user',
      content: wrapSideChannelBody(
        SIDE_CHANNEL_KIND.genericConvertedSystem,
        action.text,
      ),
      _convertedFromSystem: true,
      _sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
    })
  }
}

function findLastUserMessageIndex(
  messages: ReadonlyArray<Record<string, unknown>>,
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i
  }
  return -1
}

// ─── Collector registry & orchestrator entry ───────────────────────────

/**
 * Static, deterministically-ordered collector list. upstream's
 * `getAttachments` uses three static arrays (`userInputAttachments`,
 * `allThreadAttachments`, `mainThreadAttachments`) and concatenates
 * them; we use one flat list and call-site filtering.
 *
 * Ordering is part of the contract: collectors near the top run /
 * apply BEFORE collectors near the bottom when sharing a call site.
 * This is the model's perception order — earlier items appear first
 * in the message stream after a `Promise.all` resolves (collectors run
 * concurrently but results are applied sequentially in registry order).
 *
 * `pendingToolUseSummary`, `systemDriveContext`, `objectiveConflict` and
 * `explicitSkillMention` are the `iteration_top` collectors; every other
 * registered collector
 * runs at `post_tool`. The `COLLECTORS` array below is the canonical
 * registry (count it, don't trust a hardcoded number here — past
 * revisions let the inline tally go stale). See the docstring just
 * above it for the semantic grouping rationale.
 */
import { compactionReminderCollector } from './hostAttachments/compactionReminder'
import { kernelInboxCollector } from './hostAttachments/kernelInbox'
import { interAgentQueueCollector } from './hostAttachments/interAgentQueue'
import { teamInboxCollector } from './hostAttachments/teamInbox'
import { subAgentOutputsCollector } from './hostAttachments/subAgentOutputs'
import { subAgentStatusDigestCollector } from './hostAttachments/subAgentStatusDigest'
import { dateChangeCollector } from './hostAttachments/dateChange'
import { tokenUsageCollector } from './hostAttachments/tokenUsage'
import { pendingToolUseSummaryCollector } from './hostAttachments/pendingToolUseSummary'
import { lspDiagnosticsCollector } from './hostAttachments/lspDiagnostics'
import { proseEditVerifyReminderCollector } from './hostAttachments/proseEditVerifyReminder'
import { mcpInstructionsDeltaCollector } from './hostAttachments/mcpInstructionsDelta'
import { agentListingDeltaCollector } from './hostAttachments/agentListingDelta'
import { buddyStateChangeCollector } from './hostAttachments/buddyStateChange'
import { contextEfficiencyCollector } from './hostAttachments/contextEfficiency'
import { outputStyleCollector } from './hostAttachments/outputStyle'
import { verifyPlanReminderCollector } from './hostAttachments/verifyPlanReminder'
import { activeSkillReminderCollector } from './hostAttachments/activeSkillReminder'
import { staleTodoNudgeCollector } from './hostAttachments/staleTodoNudge'
import { staleTaskNudgeCollector } from './hostAttachments/staleTaskNudge'
import { taskRuntimeNotificationsCollector } from './hostAttachments/taskRuntimeNotifications'
import { planStepBudgetCollector } from './hostAttachments/planStepBudget'
import { planStepScopeCollector } from './hostAttachments/planStepScope'
import { objectiveConflictCollector } from './hostAttachments/objectiveConflict'
import { explicitSkillMentionCollector } from './hostAttachments/explicitSkillMention'
import { systemDriveContextCollector } from './hostAttachments/systemDriveContext'
import { driftScoreMonitorCollector } from './hostAttachments/driftScoreMonitor'

// upstream-equivalent attachments handled OUTSIDE this orchestrator (the
// remaining ones are all implemented and registered below):
//
//   - `deferred_tools_delta` (upstream name) — IMPLEMENTED, lives in
//     `electron/context/toolPoolTranscriptDeltas.ts`. Spliced inside
//     the `runQueryLoopPreModelSteps` pipeline (`tool_result_budget`
//     phase) rather than as a host-attachment collector. Reason: the
//     transcript-anchored marker (`pole-dtd:v1`) is embedded INSIDE
//     a regular user message so dedup / compact-boundary scans see it
//     as part of the same envelope as other pre-model normalisations.
//   - `agent_listing_delta` (upstream name) — IMPLEMENTED, but split
//     across TWO mechanisms that serve different audiences:
//       1. `electron/context/toolPoolTranscriptDeltas.ts` emits a
//          machine-readable `pole-ald:v1` marker in the pre-model
//          pipeline (replay-safe across resume).
//       2. The `agentListingDeltaCollector` registered at `post_tool`
//          below emits a human-readable `[Agent registry updated]`
//          body when `agentRegistryRevision` bumps. Effectively dormant
//          today because `getBuiltInAgents()` is compile-time static;
//          fires when a future plugin / MCP / workspace-loader calls
//          `bumpAgentDefinitionRevision()`.
//     They co-exist on purpose: the marker is for transcript replay
//     (no model attention), the collector body is for the model.
//   - `companion_intro` (upstream's name) — subsumed by our
//     `buddy_state_change` (first observation per conversation acts
//     as intro; subsequent changes also surface).
//
// Implementation notes for items that DIVERGE from upstream behaviour:
//
//   - `context_efficiency` — upstream's variant is action-demanding
//     ("call SnipTool to free context"); we don't expose SnipTool,
//     so ours is INFORMATIONAL ONLY ("context has grown N tokens;
//     host will manage"). Avoids contradicting `compactionReminder`'s
//     "no need to rush" message.
//   - `output_style` — upstream treats outputStyle as a CLI feature
//     with its own subsystem; we hook the existing
//     `appearanceSlice.outputStyle` setting and only emit on DELTA
//     (style switch) since the system prompt already conveys the
//     current style.
//   - `verify_plan_reminder` — wired against our own
//     `electron/planning/planVerificationState.ts` + the new
//     `VerifyPlanExecutionTool` rather than upstream's
//     `pendingPlanVerification` appState (different state machine).

/**
 * Ordering matches upstream's `getAttachments` semantic grouping:
 *
 *   1. Orchestration / queue drains — events that happened BETWEEN
 *      iterations (kernel inbox, inter-agent mailbox, sub-agent
 *      terminal status / status digest). The model sees them as
 *      "what changed while I was thinking".
 *   2. Registry / config deltas — environment changes (MCP
 *      instructions, agent listing, buddy state, output style).
 *      "New news about the environment."
 *   3. Background context advisories — derived from now-state
 *      (date, token usage, LSP diagnostics, context efficiency).
 *   4. Behavioural reminders — general guidance, not "new news"
 *      (verify_plan_reminder, compaction_reminder).
 *
 * `pendingToolUseSummary` / `systemDriveContext` / `objectiveConflict` /
 * `explicitSkillMention` are the `iteration_top` collectors (see their
 * docstrings for why they cannot move post-tool). They run at a different
 * call site so their registry position relative to the post-tool block
 * matters only among themselves (summary → drive contract → conflict
 * nudge → explicit skill mention).
 */
export const COLLECTORS: ReadonlyArray<Collector> = [
  // iteration_top
  pendingToolUseSummaryCollector,
  // System-drive context (turn-entry task contract) — current request
  // digest + inferred task type + quality gate + completion criteria,
  // replace-in-place (one live instance per conversation). Registered
  // BEFORE objectiveConflict so the contract lands first and the
  // conflict nudge (when it fires on the same turn entry) reads as a
  // follow-up question about that contract. Quality-gate / completion-
  // criteria sections self-gate on the active bundle: only the default
  // (no bundle) and `code-dev` workpack get the host-authored gates —
  // other domain workpacks drive quality via their own bundle prompt.
  systemDriveContextCollector,
  // Objective-conflict check (2026-07 uplift #12) — fires on the first
  // iteration of a turn when the new user message shares zero informative
  // tokens with the recorded objective, so a redirected task updates its
  // goal instead of having the stale one recited all session.
  objectiveConflictCollector,
  // Explicit skill mention (skill-attention uplift, 2026-07) — the current
  // user turn references a loaded skill via /name or @name. Registered
  // AFTER the drive contract / conflict nudge so the model reads "here is
  // the task" before "the user named a skill for it". First-iteration,
  // main-chat, once per (query, names) pair.
  explicitSkillMentionCollector,
  // post_tool — order matters (upstream parity):
  //   1. orchestration / queue drains (events between iterations)
  kernelInboxCollector,
  interAgentQueueCollector,
  // Background task runtime drain (bash/skill/agent/cron completions
  // queued in `notificationSystem.ts`). upstream analog: the
  // `unified_tasks` attachment family in `getAttachmentMessages`.
  // Sits in the "queue drains" group because each XML payload is a
  // discrete "event that happened between iterations" — not a
  // standing reminder.
  taskRuntimeNotificationsCollector,
  // Team Active Loop (PR-4) — lead-side digest of teammate idle / task
  // assignment / completion events. Runs after `interAgentQueueCollector`
  // because that one drains peer-DM mailbox content addressed to
  // sub-agents; the lead-side digest is a distinct mailbox and the two
  // never overlap.
  teamInboxCollector,
  subAgentOutputsCollector,
  subAgentStatusDigestCollector,
  //   2. registry / config deltas (new news about the environment)
  mcpInstructionsDeltaCollector,
  agentListingDeltaCollector,
  buddyStateChangeCollector,
  outputStyleCollector,
  //   3. background context advisories (derived from now-state)
  dateChangeCollector,
  tokenUsageCollector,
  lspDiagnosticsCollector,
  // Prose counterpart to `lspDiagnostics`: code edits get diagnostics
  // fed back automatically; document/prose edits get this re-read
  // verification nudge instead (2026-06 verify-depth uplift).
  proseEditVerifyReminderCollector,
  contextEfficiencyCollector,
  // Goal-drift score monitor (2026-07 uplift #3) — opt-in
  // (`POLE_DRIFT_MONITOR=1`) quantitative drift measurement; emits
  // telemetry every K iterations and a soft notice on very low scores.
  driftScoreMonitorCollector,
  //   4. behavioural reminders (general guidance, last)
  // Active-skill reminder runs FIRST in this group: when an inline skill
  // session is live, its workflow governs how the model should execute
  // the remaining reminders' subject matter (plan steps, todo hygiene),
  // so skill adherence is the most actionable of the behavioural nudges.
  activeSkillReminderCollector,
  // Plan-step budget (2026-07 uplift #8) — per-step iteration budget for
  // the active plan: soft nudge at N iterations on one step, hard
  // fail-and-advance at M. Runs before the plan-verification reminder
  // because "this step is stuck" is more actionable than "remember to
  // verify the plan" when both fire on the same iteration.
  planStepBudgetCollector,
  // Plan-step scope check (2026-07 uplift #4) — the spatial counterpart to
  // the budget above: edits repeatedly landing outside every step's
  // declared file scope get one reconcile nudge per step.
  planStepScopeCollector,
  verifyPlanReminderCollector,
  // Stale-{todo,task} nudge — upstream parity for the
  // `getTodoReminderAttachments` / `getTaskReminderAttachments`
  // pair. 星构Astra coexist extension (2026-05): the two collectors
  // are NO LONGER mode-mutually-exclusive. In `'coexist'` (default)
  // BOTH can fire on the same idle stretch; each self-gates on its
  // own surface's `isEnabled()`, on per-surface tool-availability,
  // AND on a cross-surface mute window (recent activity on the
  // OTHER surface suppresses self — see each collector's
  // `CROSS_SURFACE_MUTE_TURNS`). They sit between `verifyPlanReminder`
  // and `compactionReminder` because all three are "behavioural
  // reminders" the model should see in a deterministic order —
  // plan verification (most actionable) → todo/task hygiene →
  // compaction reassurance (most passive).
  staleTodoNudgeCollector,
  staleTaskNudgeCollector,
  compactionReminderCollector,
]

/**
 * Run all collectors registered for `ctx.callSite`, isolate failures
 * with `maybe()`, and apply actions to `ctx.state.apiMessages`. Returns
 * structured outcomes for telemetry / dashboards.
 *
 * Behaviour invariants:
 *
 *   1. Order matters — actions apply in registry order (not promise
 *      resolution order). A failing collector does not block others.
 *   2. When `requiresConversationSync` is true, the caller MUST invoke
 *      `state.syncConversation()` to propagate action-based or direct
 *      transcript mutations. The orchestrator deliberately does NOT call
 *      it itself so callers can batch multiple call-site invocations.
 *   3. Empty result (no actions applied) is the common case — the
 *      gate evaluation cost is intentionally low so this is OK to
 *      call on every iteration.
 *   4. 2026-07 injection budget — `critical` collectors run concurrently
 *      and always apply. Non-critical collectors run SEQUENTIALLY in
 *      priority order (high → normal → low, ties by registry index) with
 *      a per-invocation budget gate BEFORE each run; once the budget is
 *      exhausted the rest are shed unrun (state untouched → they re-fire
 *      later). Whatever ran still applies in registry order, so the
 *      model's perception order is unchanged from the legacy behaviour.
 */
export async function runCollectors(
  ctx: AttachmentContext,
): Promise<OrchestratorResult> {
  return runCollectorsWith(COLLECTORS, ctx)
}

/**
 * Core orchestration over an explicit collector list. Production always
 * passes {@link COLLECTORS}; exported so tests can exercise the budget /
 * shedding semantics with synthetic collectors.
 */
export async function runCollectorsWith(
  collectors: ReadonlyArray<Collector>,
  ctx: AttachmentContext,
): Promise<OrchestratorResult> {
  const eligible = collectors.filter((c) => c.callSites.includes(ctx.callSite))

  const budgetEnabled = isInjectionBudgetEnabled()
  const budget = resolveInjectionBudget()

  // Partition preserving registry index (needed for final apply order).
  const criticals: Array<{ collector: Collector; index: number }> = []
  const rest: Array<{ collector: Collector; index: number }> = []
  for (let i = 0; i < eligible.length; i++) {
    const collector = eligible[i]!
    if (budgetEnabled && priorityOf(collector) === 'critical') {
      criticals.push({ collector, index: i })
    } else {
      rest.push({ collector, index: i })
    }
  }

  type Settled = {
    index: number
    actions: ReadonlyArray<CollectorAction>
    requiresConversationSync: boolean
    outcome: CollectorOutcome
  }
  const settled: Settled[] = []

  // Critical collectors — concurrent, never shed, budget-exempt.
  const criticalResults = await Promise.all(
    criticals.map(async ({ collector, index }) => ({
      index,
      ...(await maybe(collector, ctx)),
    })),
  )
  settled.push(...criticalResults)

  if (!budgetEnabled) {
    // Legacy path: everything concurrent, nothing shed.
    const legacyResults = await Promise.all(
      rest.map(async ({ collector, index }) => ({
        index,
        ...(await maybe(collector, ctx)),
      })),
    )
    settled.push(...legacyResults)
  } else {
    // Non-critical collectors — sequential in priority order with a
    // pre-run budget gate. Sequencing is what makes "shed without
    // running" possible: a skipped collector's internal latch/delta
    // state is never consumed, so nothing is lost — it fires on a
    // later, quieter iteration instead.
    const ordered = [...rest].sort((a, b) => {
      const pr = PRIORITY_RANK[priorityOf(b.collector)] - PRIORITY_RANK[priorityOf(a.collector)]
      return pr !== 0 ? pr : a.index - b.index
    })
    let remainingMessages = budget.maxMessages
    let remainingChars = budget.maxChars
    for (const { collector, index } of ordered) {
      if (remainingMessages <= 0 || remainingChars <= 0) {
        settled.push({
          index,
          actions: [],
          requiresConversationSync: false,
          outcome: { name: collector.name, ok: true, actionCount: 0, shed: true },
        })
        continue
      }
      const result = await maybe(collector, ctx)
      settled.push({ index, ...result })
      // Deduct AFTER the run. Overflow discovered post-run still applies
      // (dropping would lose latched state) — it just closes the gate.
      for (const action of result.actions) {
        remainingMessages -= 1
        remainingChars -= estimateActionChars(action)
      }
    }
  }

  // Apply in registry order regardless of run order — the model's
  // perception order is part of the orchestrator contract.
  settled.sort((a, b) => a.index - b.index)
  let applied = 0
  for (const { actions } of settled) {
    for (const action of actions) {
      applyAction(ctx.state, action)
      applied++
    }
  }

  const shedCollectors = settled
    .filter((s) => s.outcome.shed === true)
    .map((s) => s.outcome.name)
  if (shedCollectors.length > 0) {
    console.warn(
      `[hostAttachments] injection budget exhausted at callSite=${ctx.callSite}; ` +
        `shed ${shedCollectors.length} collector(s): ${shedCollectors.join(', ')}`,
    )
  }

  return {
    outcomes: settled.map((s) => s.outcome),
    appliedActions: applied,
    requiresConversationSync:
      applied > 0 || settled.some((s) => s.requiresConversationSync),
    shedCollectors,
  }
}
