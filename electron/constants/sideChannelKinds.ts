/**
 * Side-channel message **kind dictionary**.
 *
 * Every "host-injected" / "synthetic" user-role message that is NOT
 * something the user actually said funnels through this module:
 *
 *   1. A canonical XML envelope (`<system-reminder>` by default) is applied.
 *   2. An optional leading bracket marker (e.g. `[Pairing repair]`) gates
 *      idempotency, downstream pattern matching, and system-prompt parity.
 *   3. The emitted message carries `_convertedFromSystem: true` and
 *      `_sideChannelKind: <kind>` so subsequent passes (smoosh / merge /
 *      compact gating / telemetry) can recognise them without re-parsing
 *      the body.
 *
 * Bytes-on-the-wire **must not change** for migrated callers — the existing
 * `<system-reminder>` envelopes + marker lines are what the standing system
 * prompt and prompt cache fingerprints are conditioned on. The wrappers
 * below reproduce the historical strings exactly; only the production
 * mechanism is unified.
 */

import { SYSTEM_REMINDER_TAG } from './xml'

export const KERNEL_USER_INPUT_MARKER = '[User message (mid-turn)]'

/** Canonical id used as both the discriminator and the metadata flag value. */
export const SIDE_CHANNEL_KIND = {
  /** `<system-reminder type="user-meta-context">` — the `messages[0]` user-meta envelope (project memory / date / LSP). */
  userMetaContext: 'user_meta_context',
  /** `[Pairing repair]` — separator inserted after synthetic tool_result placeholders. */
  pairingRepair: 'pairing_repair',
  /** `[Previous tool batch ledger — host-generated]` — deterministic per-batch ledger. */
  toolBatchLedger: 'tool_batch_ledger',
  /** `[Previous tool execution summary (toolA, toolB)]` — LLM-generated tool-batch recap. */
  toolUseSummary: 'tool_use_summary',
  /** `[SendMessage / team mailbox]` — inter-agent mailbox injection. */
  sendMessageMailbox: 'send_message_mailbox',
  /** `[Stop hook reported an error — ...]` — Stop hook continuation prompt. */
  stopHookError: 'stop_hook_error',
  /** Background sub-agent terminal-state notice (delta + completed/failed/stopped). */
  subAgentUpdate: 'subagent_update',
  /** `[Prior conversation segment — auto-folded for context]`. */
  contextCollapseAuto: 'context_collapse_auto',
  /** `[Context collapse summaries — prior segments folded offline]`. */
  contextCollapseDrain: 'context_collapse_drain',
  /** `[Previous conversation was compacted to save context …]` — the post-compact authoritative recap. */
  compactSummary: 'compact_summary',
  /** Post-compact attachments (file hints / plan / deferred-tool delta / session memory). */
  postCompactAttachment: 'post_compact_attachment',
  /** `[pole-tool-pool-delta]` — transcript-anchored tool / agent listing delta. */
  toolPoolDelta: 'tool_pool_delta',
  /** `[Image budget note]` — earlier images dropped to keep request under the multi-image cap. */
  imageBudgetNote: 'image_budget_note',
  /** `[Provider attachment compatibility]` — provider stripped multimodal blocks. */
  attachmentCompat: 'attachment_compat',
  /** Stale-memory age notice (memdir). */
  memoryAgeNote: 'memory_age_note',
  /** `<skill-discovery>` body — first-iteration skill discovery. */
  skillDiscovery: 'skill_discovery',
  /** `<invoked-skills>` body — re-injected after compact. */
  invokedSkills: 'invoked_skills',
  /** Fork boilerplate (child directive marker — see `forkSubagent.ts`). */
  forkBoilerplate: 'fork_boilerplate',
  /**
   * `ITERATION LIMIT APPROACHING` / `ITERATION BUDGET 80% USED` —
   * iteration-boundary wrap-up directive.
   *
   * @deprecated The host no longer emits these directives. Both upstream
   * (upstream) and upstream official explicitly design AGAINST telling
   * the model to "wind down" when nearing budget — see
   * `compactionReminder` for the upstream-aligned replacement. The kind
   * is retained in the registry only so historical transcripts that
   * already contain these messages still parse / smoosh correctly.
   */
  iterationDirective: 'iteration_directive',
  /**
   * upstream parity (`messages.ts` case `'compaction_reminder'`):
   * "Auto-compact is enabled. When the context window is nearly full,
   * older messages will be automatically summarized so you can continue
   * working seamlessly. There is no need to stop or rush — you have
   * unlimited context through automatic compaction."
   *
   * One-shot per session, main chat only, gated on context usage ratio.
   * Counters the model's tendency to "rush to wrap up" when it senses
   * context pressure.
   */
  compactionReminder: 'compaction_reminder',
  /** `READ-ONLY SUB-AGENT TOOL BUDGET EXHAUSTED` — read-only sub-agent budget cap. */
  subAgentBudgetExhausted: 'subagent_budget_exhausted',
  /** Catch-all for any system→user converted body that doesn't match a named kind. */
  genericConvertedSystem: 'generic_converted_system',
  /**
   * Team Active Loop — lead-side inbox digest. Body is a `<team-inbox>`
   * XML block summarising idle_notification / task_assignment /
   * task_completion envelopes that arrived in the lead's mailbox since
   * the previous turn.
   *
   * Distinct from `sendMessageMailbox` so the model can tell apart
   * direct peer mail (which still flows through that kind) from the
   * lead-only "team status digest". See upstream-main
   * `src/utils/teammateMailbox.ts:3611-3660` for the reference fold +
   * dedup behaviour we mirror here.
   */
  teamInbox: 'team_inbox',
  /**
   * upstream parity (`src/utils/messages.ts` case `'todo_reminder'`):
   * "The TodoWrite tool hasn't been used recently … Here are the
   * existing contents of your todo list: [...]"
   *
   * Periodically nudges the agent to refresh / use the V1 TodoWrite
   * checklist when several assistant turns have passed without a
   * call. Carries the current snapshot so the model can resume
   * without re-listing. Throttled by a double cadence (turns since
   * last TodoWrite **and** turns since last reminder of this same
   * kind) — see `hostAttachments/staleTodoNudge.ts`.
   *
   * Active when V1 is enabled (`isTodoV1Enabled()`) — i.e. in
   * `'v1-only'` OR `'coexist'` deployment modes. The collector
   * additionally cross-mutes against recent V2 activity to avoid
   * pairing this with a `staleTaskNudge` on the same idle stretch.
   */
  staleTodoNudge: 'stale_todo_nudge',
  /**
   * upstream parity (`src/utils/messages.ts` case `'task_reminder'`):
   * "The task tools haven't been used recently … Here are the
   * existing tasks: [...]"
   *
   * V2 counterpart of {@link staleTodoNudge}. Pulls the snapshot
   * from `TaskManager.listTasks()`; same dual-cadence throttle.
   */
  staleTaskNudge: 'stale_task_nudge',
  /**
   * Background-task runtime notification — drain of
   * `electron/tools/tasks/notificationSystem.ts` pending queue
   * (task completed / failed / killed / stalled events from bash,
   * skill, agent, cron runtimes). upstream analog: `unified_tasks`
   * attachment family.
   *
   * Injected as a `<system-reminder>` so the model sees the
   * finished work in the next turn without polling.
   */
  taskRuntimeNotification: 'task_runtime_notification',
  /**
   * `[Active skill reminder]` — an inline skill session is still active;
   * the host re-surfaces "keep following the loaded `<skill-instructions>`
   * workflow step by step" after several turns of autonomous work.
   * Skill-adherence audit (2026-06): without periodic reinforcement the
   * SKILL.md body scrolls deep into history and the model drifts off the
   * skill's implement-then-verify cadence.
   */
  activeSkillReminder: 'active_skill_reminder',
  /**
   * `[Explicit skill mention]` — the current user turn references a loaded,
   * model-invocable skill by explicit `/name` or `@name` token. Deterministic
   * host detection (skill-attention uplift, 2026-07): the compact index and
   * TF-IDF discovery are probabilistic surfaces; an explicit user mention
   * deserves a guaranteed turn-entry nudge to invoke the Skill tool instead
   * of re-implementing the workflow from memory. One-shot per
   * (conversation, query+names) pair. See
   * `hostAttachments/explicitSkillMention.ts`.
   */
  explicitSkillMention: 'explicit_skill_mention',
  /**
   * `[System drive context]` — turn-entry task contract (current request
   * digest + inferred task type + quality gate + completion criteria).
   * Replace-in-place: at most ONE instance lives in the transcript; each
   * user-turn entry refreshes it via `replaceSideChannelKind` instead of
   * appending another copy. See `hostAttachments/systemDriveContext.ts`.
   */
  systemDriveContext: 'system_drive_context',
  /**
   * `[User message (mid-turn)]` — a REAL human message the user typed while
   * the agent was still working, delivered through the kernel inbox drain
   * (2026-07 复审 N2 fix). Unlike every other side-channel kind, the body IS
   * live user speech and carries the same authority as `<user-query>`: the
   * previous plumbing folded it into `genericConvertedSystem`, whose
   * declared contract ("NOT new instructions from the user") taught the
   * model to treat a genuine mid-turn redirect as background reference.
   * Synthetic host/kernel text (slash expansions, mailbox drafts) still
   * travels as `genericConvertedSystem` — only items whose enqueue source
   * is verified human input use this kind.
   */
  kernelUserInput: 'kernel_user_input',
} as const

export type SideChannelKind =
  (typeof SIDE_CHANNEL_KIND)[keyof typeof SIDE_CHANNEL_KIND]

/**
 * Metadata describing every side-channel kind in the dictionary.
 *
 * `marker` is the **first-line bracket marker** the historical emission
 * already used (or `null` when the kind has no marker — typically because
 * the body itself is a structured XML block like `<invoked-skills>`).
 *
 * `humanLabel` is for the system-prompt declaration only; the model never
 * sees it inside the message body.
 *
 * `wireOpenTag` / `wireCloseTag` are the **exact** outer tag strings used
 * on the wire — they must not be reformatted (no extra whitespace).
 */
export interface SideChannelKindSpec {
  readonly kind: SideChannelKind
  readonly marker: string | null
  readonly humanLabel: string
  readonly wireOpenTag: string
  readonly wireCloseTag: string
  /**
   * The host no longer emits this kind — it is kept in the registry only so
   * historical transcripts still parse. Deprecated kinds are excluded from
   * the system-prompt declaration (`renderSideChannelKindsSystemPromptBlock`):
   * advertising a signal that will never arrive teaches the model to expect
   * (and worry about) phantom messages.
   */
  readonly deprecated?: true
  /**
   * Attention weight for the system-prompt declaration. `'act'` kinds carry
   * events or directives that can change what the model should do next
   * (sub-agent finished/failed, hook error, inbound mail, budget exhausted,
   * skill workflow directive). Everything else is status/reference recap.
   * The declaration renders the two groups separately so urgent signals do
   * not visually flatten into routine bookkeeping ("format homogenization"
   * audit, 2026-07). Wire bytes of the emissions themselves are unaffected.
   */
  readonly attention?: 'act'
}

const REMINDER_OPEN = `<${SYSTEM_REMINDER_TAG}>`
const REMINDER_CLOSE = `</${SYSTEM_REMINDER_TAG}>`
const USER_META_OPEN = `<${SYSTEM_REMINDER_TAG} type="user-meta-context">`

export const SIDE_CHANNEL_KIND_SPECS: Readonly<
  Record<SideChannelKind, SideChannelKindSpec>
> = {
  [SIDE_CHANNEL_KIND.userMetaContext]: {
    kind: SIDE_CHANNEL_KIND.userMetaContext,
    marker: null,
    humanLabel: 'user-meta context (project memory / date / LSP — reference, not instruction)',
    wireOpenTag: USER_META_OPEN,
    wireCloseTag: REMINDER_CLOSE,
  },
  [SIDE_CHANNEL_KIND.pairingRepair]: {
    kind: SIDE_CHANNEL_KIND.pairingRepair,
    marker: '[Pairing repair]',
    humanLabel: 'synthetic tool_result placeholder separator (not a fresh user-reported error)',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
  },
  [SIDE_CHANNEL_KIND.toolBatchLedger]: {
    kind: SIDE_CHANNEL_KIND.toolBatchLedger,
    marker: '[Previous tool batch ledger — host-generated]',
    humanLabel: 'deterministic per-batch ledger (skip re-doing successful actions)',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
  },
  [SIDE_CHANNEL_KIND.toolUseSummary]: {
    kind: SIDE_CHANNEL_KIND.toolUseSummary,
    marker: '[Previous tool execution summary',
    humanLabel: 'LLM-generated tool-batch recap',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
  },
  [SIDE_CHANNEL_KIND.sendMessageMailbox]: {
    kind: SIDE_CHANNEL_KIND.sendMessageMailbox,
    marker: '[SendMessage / team mailbox]',
    humanLabel: 'inter-agent mailbox delivery',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
    attention: 'act',
  },
  [SIDE_CHANNEL_KIND.stopHookError]: {
    kind: SIDE_CHANNEL_KIND.stopHookError,
    marker: '[Stop hook reported an error',
    humanLabel: 'Stop-hook continuation prompt (host nudge, not user instruction)',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
    attention: 'act',
  },
  [SIDE_CHANNEL_KIND.subAgentUpdate]: {
    kind: SIDE_CHANNEL_KIND.subAgentUpdate,
    marker: '[Background sub-agents — new output since your last reply]',
    humanLabel: 'background sub-agent terminal status + delta',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
    attention: 'act',
  },
  [SIDE_CHANNEL_KIND.contextCollapseAuto]: {
    kind: SIDE_CHANNEL_KIND.contextCollapseAuto,
    marker: '[Prior conversation segment — auto-folded for context',
    humanLabel: 'auto-folded prior conversation segment (authoritative recap)',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
  },
  [SIDE_CHANNEL_KIND.contextCollapseDrain]: {
    kind: SIDE_CHANNEL_KIND.contextCollapseDrain,
    marker: '[Context collapse summaries',
    humanLabel: 'queued collapse summaries (offline-folded earlier segments)',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
  },
  [SIDE_CHANNEL_KIND.compactSummary]: {
    kind: SIDE_CHANNEL_KIND.compactSummary,
    marker: '[Previous conversation was compacted to save context',
    humanLabel: 'post-compact authoritative summary of everything before the boundary',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
  },
  [SIDE_CHANNEL_KIND.postCompactAttachment]: {
    kind: SIDE_CHANNEL_KIND.postCompactAttachment,
    marker: '[Post-compact',
    humanLabel: 'post-compact warmup (file hints / plan / session memory / tool delta)',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
  },
  [SIDE_CHANNEL_KIND.toolPoolDelta]: {
    kind: SIDE_CHANNEL_KIND.toolPoolDelta,
    marker: '[pole-tool-pool-delta]',
    humanLabel: 'tool / MCP / agent availability changed vs the last transcript snapshot',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
  },
  [SIDE_CHANNEL_KIND.imageBudgetNote]: {
    kind: SIDE_CHANNEL_KIND.imageBudgetNote,
    marker: '[Image budget note]',
    humanLabel: 'earlier image attachments dropped to keep request under per-request cap',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
  },
  [SIDE_CHANNEL_KIND.attachmentCompat]: {
    kind: SIDE_CHANNEL_KIND.attachmentCompat,
    marker: '[Provider attachment compatibility]',
    humanLabel: 'provider stripped multimodal blocks for compatibility',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
  },
  [SIDE_CHANNEL_KIND.memoryAgeNote]: {
    kind: SIDE_CHANNEL_KIND.memoryAgeNote,
    marker: null,
    humanLabel: 'memory-age advisory (recall result is stale)',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
  },
  [SIDE_CHANNEL_KIND.skillDiscovery]: {
    kind: SIDE_CHANNEL_KIND.skillDiscovery,
    marker: null,
    humanLabel: 'skill discovery surface (first-iteration hint, optional to use)',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
  },
  [SIDE_CHANNEL_KIND.invokedSkills]: {
    kind: SIDE_CHANNEL_KIND.invokedSkills,
    marker: null,
    humanLabel: 'invoked-skills body (re-injected after compact)',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
  },
  [SIDE_CHANNEL_KIND.forkBoilerplate]: {
    kind: SIDE_CHANNEL_KIND.forkBoilerplate,
    marker: null,
    humanLabel: 'fork directive boilerplate handed to a child agent',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
  },
  [SIDE_CHANNEL_KIND.iterationDirective]: {
    kind: SIDE_CHANNEL_KIND.iterationDirective,
    marker: null,
    humanLabel: 'host wrap-up directive nearing iteration budget',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
    // No longer emitted (see the kind's @deprecated JSDoc). Kept for
    // historical-transcript parsing only — must NOT be declared in the
    // system prompt.
    deprecated: true,
  },
  [SIDE_CHANNEL_KIND.compactionReminder]: {
    kind: SIDE_CHANNEL_KIND.compactionReminder,
    marker: null,
    humanLabel:
      'automatic context-management is active; the model should keep working at its normal pace',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
  },
  [SIDE_CHANNEL_KIND.subAgentBudgetExhausted]: {
    kind: SIDE_CHANNEL_KIND.subAgentBudgetExhausted,
    marker: null,
    humanLabel: 'read-only sub-agent tool budget exhausted; stop calling tools',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
    attention: 'act',
  },
  [SIDE_CHANNEL_KIND.genericConvertedSystem]: {
    kind: SIDE_CHANNEL_KIND.genericConvertedSystem,
    marker: null,
    humanLabel: 'generic system→user converted text',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
  },
  [SIDE_CHANNEL_KIND.teamInbox]: {
    kind: SIDE_CHANNEL_KIND.teamInbox,
    marker: null,
    humanLabel:
      'team active-loop inbox digest (idle / task assignment / completion events from teammates)',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
    attention: 'act',
  },
  [SIDE_CHANNEL_KIND.staleTodoNudge]: {
    kind: SIDE_CHANNEL_KIND.staleTodoNudge,
    // 2026-05 audit: was `null` originally because the body text alone
    // was deemed sufficient to identify the message. That broke
    // `computeTurnCounts` in this collector, which calls
    // `readSideChannelKind(msg)` against history scanned from
    // `state.apiMessages` — when the typed `_sideChannelKind` flag is
    // not present (e.g. on a transcript loaded from disk after restart),
    // `detectSideChannelKindFromText` skips all `marker: null` specs and
    // returns `genericConvertedSystem`. The kind then never matched the
    // `SIDE_CHANNEL_KIND.staleTodoNudge` equality check above the
    // recursion point and the double-cadence throttle silently reduced
    // to "fire every 10 assistant turns". Pairing the spec with a
    // first-line bracket marker and emitting that marker at the top of
    // the body restores authoritative body-based detection for the
    // resume-from-disk path. The typed flag remains primary for the
    // common case (now also preserved on `state.apiMessages` after the
    // iteration normalize switched to `stripInternalMeta: false`).
    marker: '[Stale todo reminder]',
    humanLabel:
      'the V1 TodoWrite checklist has not been updated recently — respond (if at all) with TodoWrite, not the V2 task tools; at most one of the stale todo/task reminders fires per idle stretch',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
  },
  [SIDE_CHANNEL_KIND.staleTaskNudge]: {
    kind: SIDE_CHANNEL_KIND.staleTaskNudge,
    // Same rationale as `staleTodoNudge` above — see comment there.
    marker: '[Stale task reminder]',
    humanLabel:
      'the V2 task list has not been updated recently — respond (if at all) with TaskCreate / TaskUpdate, not TodoWrite; at most one of the stale todo/task reminders fires per idle stretch',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
  },
  [SIDE_CHANNEL_KIND.taskRuntimeNotification]: {
    kind: SIDE_CHANNEL_KIND.taskRuntimeNotification,
    marker: null,
    humanLabel:
      'background task runtime delivered a completion / failure / kill / stall notification while the agent was thinking',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
    attention: 'act',
  },
  [SIDE_CHANNEL_KIND.activeSkillReminder]: {
    kind: SIDE_CHANNEL_KIND.activeSkillReminder,
    // Bracket marker (same rationale as staleTodoNudge): the collector's
    // cadence gate scans history for prior reminders of this kind, and on
    // transcripts loaded from disk the typed `_sideChannelKind` flag may be
    // stripped — the first-line marker keeps body-based detection working.
    marker: '[Active skill reminder]',
    humanLabel:
      'inline skill session still active — keep following the loaded <skill-instructions> workflow step by step',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
    attention: 'act',
  },
  [SIDE_CHANNEL_KIND.explicitSkillMention]: {
    kind: SIDE_CHANNEL_KIND.explicitSkillMention,
    // Bracket marker (same rationale as activeSkillReminder): the collector's
    // once-per-pair latch is in-memory, but disk-resumed transcripts may have
    // the typed `_sideChannelKind` flag stripped — the first-line marker keeps
    // body-based detection (smoosh / compact / telemetry) working.
    marker: '[Explicit skill mention]',
    humanLabel:
      'the current user turn explicitly references loaded skill(s) by /name or @name — invoke the Skill tool early unless the mention is clearly incidental',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
    attention: 'act',
  },
  [SIDE_CHANNEL_KIND.systemDriveContext]: {
    kind: SIDE_CHANNEL_KIND.systemDriveContext,
    // Bracket marker (same rationale as staleTodoNudge): the orchestrator's
    // replace-in-place pass scans history via `readSideChannelKind`, and on
    // transcripts loaded from disk the typed `_sideChannelKind` flag may be
    // stripped — the first-line marker keeps body-based detection working.
    marker: '[System drive context]',
    humanLabel:
      'turn-entry task contract (current request + task type + quality gate + completion criteria) — background, refreshed per user turn',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
  },
  [SIDE_CHANNEL_KIND.kernelUserInput]: {
    kind: SIDE_CHANNEL_KIND.kernelUserInput,
    // Bracket marker so disk-resumed transcripts (typed flag stripped) still
    // classify the body as live user speech instead of generic host text.
    marker: KERNEL_USER_INPUT_MARKER,
    humanLabel:
      'EXCEPTION — this body IS a real user message typed while you were working: treat it as a live user instruction with the same authority as <user-query>, not as host background',
    wireOpenTag: REMINDER_OPEN,
    wireCloseTag: REMINDER_CLOSE,
    attention: 'act',
  },
}

/**
 * Wrap `body` in the canonical envelope for `kind`. Idempotent: if `body`
 * already begins with the opening tag for this kind, returned verbatim
 * (mirroring `normalizeMessagesForAPI.convertSystemToUser` and the
 * `invokedSkillsRegistry` ad-hoc check). Caller still controls leading /
 * trailing newlines around the body when migrating exact strings.
 */
export function wrapSideChannelBody(kind: SideChannelKind, body: string): string {
  const spec = SIDE_CHANNEL_KIND_SPECS[kind]
  const trimmed = body.trim()
  if (trimmed.startsWith(spec.wireOpenTag) && trimmed.endsWith(spec.wireCloseTag)) {
    return trimmed
  }
  return `${spec.wireOpenTag}\n${body}\n${spec.wireCloseTag}`
}

/**
 * Build a user-role message object for `kind`. Always sets:
 *   - `role: 'user'`
 *   - `content: wrapSideChannelBody(kind, body)`
 *   - `_convertedFromSystem: true` (downstream smoosh/merge contract)
 *   - `_sideChannelKind: <kind>` (typed discriminator)
 * Callers may pass `extra` to merge additional fields (e.g.
 * `_compactBoundary: true` for the compact-summary message).
 */
export function makeSideChannelUserMessage(
  kind: SideChannelKind,
  body: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    role: 'user' as const,
    content: wrapSideChannelBody(kind, body),
    _convertedFromSystem: true as const,
    _sideChannelKind: kind,
    ...(extra ?? {}),
  }
}

/**
 * Maximum byte window — measured from the start of the message body — within
 * which a marker must appear to be classified as authoritative. Markers
 * historically live on the first body line right after the opening tag; a
 * tight window prevents collisions like a compact summary that LEGITIMATELY
 * mentions another marker phrase in the middle of its LLM-generated text.
 *
 * Empirical headroom: longest marker is ~58 chars, opening tag + newline is
 * 19 chars, gives ~80 chars total — 256 is generous without inviting drift.
 */
const MARKER_DETECTION_WINDOW = 256

/**
 * Classify a message body by its first non-empty marker line. Returns
 * `null` for genuine user text. Used by smoosh / compact selection /
 * telemetry to know "this came from the host, not the user".
 *
 * Detection rules (anti-collision):
 *   1. Body must begin with `<system-reminder` (any attribute).
 *   2. Attributed opener `<system-reminder type="user-meta-context">` short-
 *      circuits to `userMetaContext`.
 *   3. Otherwise look for any registry marker **within the first
 *      {@link MARKER_DETECTION_WINDOW} chars** — far enough to clear the
 *      opening tag + a long marker line, tight enough that a marker mention
 *      buried inside an LLM-generated body (e.g. compact summary text
 *      referencing "[Previous tool batch ledger]") does NOT misclassify.
 */
export function detectSideChannelKindFromText(text: string): SideChannelKind | null {
  if (typeof text !== 'string') return null
  if (!text) return null
  const trimmed = text.trimStart()
  if (!trimmed.startsWith(`<${SYSTEM_REMINDER_TAG}`)) return null

  if (trimmed.startsWith(SIDE_CHANNEL_KIND_SPECS[SIDE_CHANNEL_KIND.userMetaContext].wireOpenTag)) {
    return SIDE_CHANNEL_KIND.userMetaContext
  }

  const window = trimmed.slice(0, MARKER_DETECTION_WINDOW)
  for (const spec of Object.values(SIDE_CHANNEL_KIND_SPECS)) {
    if (!spec.marker) continue
    if (window.includes(spec.marker)) return spec.kind
  }
  return SIDE_CHANNEL_KIND.genericConvertedSystem
}

/**
 * `isHostSideChannelMessage(msg)` — true when the message was synthesized
 * by the host (either flagged by `_sideChannelKind` / `_convertedFromSystem`
 * or detectable from the body envelope). Does not crack open arrays —
 * structured user messages with tool_result blocks are NOT side-channel.
 */
export function isHostSideChannelMessage(msg: Record<string, unknown>): boolean {
  if (msg._sideChannelKind) return true
  if (msg._convertedFromSystem === true) return true
  const c = msg.content
  if (typeof c !== 'string') return false
  return detectSideChannelKindFromText(c) !== null
}

/**
 * Read the kind of a message, preferring the typed flag and falling back
 * to body parsing.
 */
export function readSideChannelKind(
  msg: Record<string, unknown>,
): SideChannelKind | null {
  const tagged = msg._sideChannelKind
  if (typeof tagged === 'string' && tagged in SIDE_CHANNEL_KIND_SPECS) {
    return tagged as SideChannelKind
  }
  const c = msg.content
  if (typeof c !== 'string') return null
  return detectSideChannelKindFromText(c)
}

/**
 * F1 (2026-07 会话审计) — unwrap the REAL user text carried by a
 * `kernel_user_input` message.
 *
 * The mid-turn user-input delivery (N2 fix) travels inside the canonical
 * `<system-reminder>` envelope with the `[User message (mid-turn)]`
 * marker line, which made it INVISIBLE to the extraction-layer machinery
 * that treats envelopes as host noise: compact's verbatim user-turn
 * preservation, `extractCurrentUserQueryText` (anchor / drive contract /
 * objective validation), and turn-boundary attribution. This helper is
 * their shared special-case: given any message, return the user's actual
 * words when the message is a kernel-user-input delivery, else `null`.
 *
 * Handles both the in-memory shape (typed `_sideChannelKind` flag) and
 * the disk-resumed shape (flag stripped; marker-based detection).
 */
export function extractKernelUserInputBody(
  msg: Record<string, unknown>,
): string | null {
  if (msg.role !== 'user') return null
  if (readSideChannelKind(msg) !== SIDE_CHANNEL_KIND.kernelUserInput) return null
  const c = msg.content
  if (typeof c !== 'string') return null
  const spec = SIDE_CHANNEL_KIND_SPECS[SIDE_CHANNEL_KIND.kernelUserInput]
  let body = c.trim()
  if (body.startsWith(spec.wireOpenTag)) body = body.slice(spec.wireOpenTag.length)
  if (body.endsWith(spec.wireCloseTag)) body = body.slice(0, -spec.wireCloseTag.length)
  body = body.trim()
  const marker = spec.marker
  if (marker && body.startsWith(marker)) body = body.slice(marker.length)
  const text = body.trim()
  return text.length > 0 ? text : null
}

/**
 * Human-readable enumeration of side-channel kinds, suitable for inclusion
 * in the host runtime contract section of the system prompt. Keep this
 * deterministic (sorted by kind id) so prompt cache fingerprints are
 * stable across registry-iteration order changes.
 */
export function renderSideChannelKindsSystemPromptBlock(): string {
  const renderRow = (s: SideChannelKindSpec): string => {
    const opener = s.marker
      ? `\`${s.marker}\` inside \`<${SYSTEM_REMINDER_TAG}>\``
      : `\`<${SYSTEM_REMINDER_TAG}${
          s.wireOpenTag.includes('type=') ? ' type="user-meta-context"' : ''
        }>\``
    return `- ${opener} — ${s.humanLabel}.`
  }
  const declared = Object.values(SIDE_CHANNEL_KIND_SPECS)
    .filter((s) => s.kind !== SIDE_CHANNEL_KIND.genericConvertedSystem)
    // Deprecated kinds are never emitted anymore — declaring them teaches
    // the model to anticipate signals that will never arrive.
    .filter((s) => !s.deprecated)
    .slice()
    .sort((a, b) => a.kind.localeCompare(b.kind))
  const actRows = declared.filter((s) => s.attention === 'act').map(renderRow)
  const backgroundRows = declared.filter((s) => s.attention !== 'act').map(renderRow)
  return [
    '## Side-channel kinds the host may inject',
    'All entries below are wrapped in `<system-reminder>` tags. With ONE exception they are host-injected context, never live user instructions; never apologise for or echo their contents back to the user. The exception is `[User message (mid-turn)]`, whose body is a REAL user message relayed while you were working — obey it like any user turn. Kinds fall into two attention tiers — check the tier before deciding how much weight to give a reminder.',
    '',
    '### Events / directives — may change what you do next (read these carefully)',
    ...actRows,
    '',
    '### Status / reference recaps — background bookkeeping (consult, do not act on or re-do)',
    ...backgroundRows,
  ].join('\n')
}
