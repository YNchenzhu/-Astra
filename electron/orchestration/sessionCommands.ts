/**
 * Session commands — the only legal mutations to orchestration transcript (plan §4).
 *
 * the merge logic for each command kind now reads as "select the channel, hand it the
 * update". The legacy inline code (mergeSyntheticUserIntoTranscript, ad-hoc overflow check,
 * cloneTranscript on every branch) lives behind two channel instances built at module load:
 * `transcriptChannel` (LastValue<Array>) and `inboxChannel` (AppendList<KernelInboxItem>).
 * The user-facing API and event shapes are unchanged.
 */

import {
  createAppendListChannel,
  createLastValueChannel,
} from './channels'
import type {
  KernelInboxItem,
  KernelLoopState,
  TranscriptCommit,
  TranscriptCommitResult,
  TranscriptSnapshot,
} from './kernelTypes'
import {
  USER_INPUT_INBOX_SOURCE,
  cloneTranscript,
  createTranscriptSnapshot,
  fingerprintTranscript,
} from './kernelTypes'
import {
  KERNEL_USER_INPUT_MARKER,
  SIDE_CHANNEL_KIND,
  makeSideChannelUserMessage,
} from '../constants/sideChannelKinds'

export type SessionCommand =
  | {
      kind: 'SyncTranscriptFromRenderer'
      messages: Array<{ role: 'user' | 'assistant'; content: string | unknown }>
    }
  | { kind: 'ReplaceTranscript'; transcript: Array<Record<string, unknown>> }
  | { kind: 'EnqueueInbox'; item: KernelInboxItem }
  | { kind: 'ClearInbox' }
  /**
   * surgical removal of a single inbox item, matched by predicate.
   * Replaces the legacy "ClearInbox + re-enqueue remaining" pattern that
   * `consumeHumanResume` used to take to drop one entry. The predicate runs
   * over a snapshot of the inbox; the first matching item is removed,
   * subsequent matches are left alone (callers wanting bulk removal should
   * issue multiple commands).
   */
  | {
      kind: 'RemoveInboxItem'
      predicate: (item: KernelInboxItem) => boolean
    }
  | {
      kind: 'ApplyCompactionResult'
      transcript: Array<Record<string, unknown>>
    }

/**
 * Hard cap on inbox depth before we shed the oldest item.
 *
 * Inbox holds slash commands / synthetic user text / mailbox drafts queued
 * during a turn. The legitimate working set is small (typically <10) — only
 * pathological producers (cron storms, runaway scripted IPC) push it to
 * triple digits. At a few hundred items each containing model-bound text,
 * the next `flushInboxToTranscript` would build a multi-MB synthetic user
 * message that blows past the model's context window: the request fails
 * with `context_length_exceeded`, costs a wasted round-trip, and freezes
 * the UI while the failure unwinds. Capping here trades a verbose console
 * warning for a stable transcript.
 */
const MAX_INBOX_SIZE = 200

/**
 * module-singleton channels. The transcript channel is LastValue with deep clone via
 * `cloneTranscript`, matching the prior `cloneTranscript(transcript)` calls scattered through
 * the legacy switch. The inbox channel is AppendList with `MAX_INBOX_SIZE` overflow + the
 * throttled console warning the original code emitted.
 *
 * Both channels are stateless w.r.t. the kernel: `applySessionCommands` builds the next
 * `KernelLoopState` by calling `reduce` over the current value, so the channel objects can
 * (and should) live at module scope.
 */
const transcriptChannel = createLastValueChannel<Array<Record<string, unknown>>>(
  () => [],
  cloneTranscript,
)

/**
 * G2 — Items the AppendList overflow path is FORBIDDEN from evicting.
 *
 * `pending_human_resume` carries a queued user answer. Dropping it silently would mean
 * the user's reply to a HITL question is lost — the worst possible failure mode for
 * durable HITL. So when the inbox exceeds `MAX_INBOX_SIZE`, the overflow drops the
 * oldest **flushable** item (synthetic text, slash command, mailbox draft) and leaves
 * `pending_human_resume` items in place even if they're the absolute oldest.
 *
 * Trade-off: in extreme pathological cases an inbox could grow above MAX_INBOX_SIZE
 * because every flushable head got evicted but HITL entries remain. The flushers
 * (`flushInboxToTranscript`, `drainInboxForInnerIteration`) consume the flushable kinds
 * every iteration so this is a transient overshoot, not unbounded growth.
 */
const PROTECTED_INBOX_KINDS = new Set<KernelInboxItem['kind']>(['pending_human_resume'])

const inboxChannel = createAppendListChannel<KernelInboxItem>({
  maxSize: MAX_INBOX_SIZE,
  cloneItem: (item) => ({ ...item }),
  onOverflow(dropped, dropCount) {
    if (dropCount === 1 || dropCount % 50 === 0) {
      console.warn(
        `[sessionCommands] inbox overflow: dropped oldest item ` +
          `(kind=${dropped?.kind}; size>${MAX_INBOX_SIZE}; total drops=${dropCount}). ` +
          `Inbox is producing faster than PrepareContext can drain.`,
      )
    }
  },
})

/**
 * G2 — Custom enqueue that respects {@link PROTECTED_INBOX_KINDS}. The base
 * `inboxChannel.reduce` does naive FIFO eviction; this wrapper only evicts non-protected
 * heads. When the head IS protected and we still need to make room, scan forward for the
 * oldest non-protected item and evict it instead. When ALL items are protected (rare —
 * means ≥ 200 unanswered HITL prompts queued), we let the inbox grow above the cap and
 * log a warning so the operator knows.
 */
function enqueueRespectingProtection(
  inbox: KernelInboxItem[],
  item: KernelInboxItem,
): KernelInboxItem[] {
  // Fast path: under the cap → ordinary reduce keeps order.
  if (inbox.length < MAX_INBOX_SIZE) {
    return inboxChannel.reduce(inbox, item)
  }
  // At cap → find the oldest non-protected item and drop it; preserve protected ones.
  const next = inbox.slice()
  let dropIdx = -1
  for (let i = 0; i < next.length; i++) {
    if (!PROTECTED_INBOX_KINDS.has(next[i].kind)) {
      dropIdx = i
      break
    }
  }
  if (dropIdx >= 0) {
    const dropped = next[dropIdx]
    next.splice(dropIdx, 1)
    next.push(item)
    // Mirror the legacy throttled warning surface so telemetry consumers stay aligned.
    console.warn(
      `[sessionCommands] inbox overflow (protection-aware): dropped item kind=${dropped.kind} ` +
        `to make room for ${item.kind} (size=${MAX_INBOX_SIZE} reached; HITL items preserved).`,
    )
    return next
  }
  // All-protected pathological case — accept the over-cap growth and warn loudly.
  // Better to slightly exceed the limit than to drop a user's queued answer.
  console.warn(
    `[sessionCommands] inbox cap exceeded with all-protected items (${inbox.length}); ` +
      `accepting overflow rather than dropping a HITL resume. Investigate stuck HITL ` +
      `pumps if this warning persists.`,
  )
  next.push(item)
  return next
}

function mapRendererMessageToApi(
  m: { role: 'user' | 'assistant'; content: string | unknown },
): Record<string, unknown> {
  return {
    role: m.role,
    content: m.content,
  }
}

/**
 * Detect tool_result blocks in a user-turn block array.
 *
 * Anthropic / OpenAI tool-using wire formats require that a user turn delivering tool results
 * contain **only** `tool_result` blocks (mixing `text` blocks into the same array violates the
 * contract on several provider gateways). So when the tail user turn is already carrying tool
 * results, synthetic inbox text must be pushed as a fresh user turn rather than appended inline.
 */
/**
 * Apply session commands to orchestration state. Transcript edits happen only here.
 *
 * every branch goes through the module-singleton channels (`transcriptChannel`,
 * `inboxChannel`). The output stays byte-for-byte identical to the pre-P1.3 implementation;
 * the win is that the merge rules are declared once at the top of the file and the body
 * is now "build update payload + reduce".
 */
export function applySessionCommands(
  state: KernelLoopState,
  commands: SessionCommand[],
): KernelLoopState {
  // Snapshot inputs so we never alias the caller's references.
  let transcript: Array<Record<string, unknown>> = transcriptChannel.snapshot(state.transcript)
  let inbox: KernelInboxItem[] = state.inbox.slice()
  let transcriptRevision = state.transcriptRevision
  let transcriptFingerprint = state.transcriptFingerprint

  const replaceTranscript = (next: Array<Record<string, unknown>>): void => {
    transcript = transcriptChannel.reduce(transcript, next)
    transcriptRevision += 1
    transcriptFingerprint = fingerprintTranscript(transcript)
  }

  for (const cmd of commands) {
    switch (cmd.kind) {
      case 'SyncTranscriptFromRenderer':
        replaceTranscript(cmd.messages.map(mapRendererMessageToApi))
        break
      case 'ReplaceTranscript':
        replaceTranscript(cmd.transcript)
        break
      case 'EnqueueInbox':
        // G2 — protect HITL signals from FIFO eviction; everything else still drops oldest.
        inbox = enqueueRespectingProtection(inbox, cmd.item)
        break
      case 'ClearInbox':
        inbox = inboxChannel.empty()
        break
      case 'RemoveInboxItem': {
        // surgical single-item removal. Walk once, drop first match,
        // preserve original order for the rest. Faster + simpler than the legacy
        // clear+re-enqueue dance, and respects PROTECTED_INBOX_KINDS implicitly
        // (predicate is callers responsibility — for HITL consumeHumanResume the
        // predicate explicitly targets `pending_human_resume` so protected items
        // are intentionally removed when their toolUseId matches).
        const idx = inbox.findIndex(cmd.predicate)
        if (idx >= 0) {
          inbox = [...inbox.slice(0, idx), ...inbox.slice(idx + 1)]
        }
        break
      }
      case 'ApplyCompactionResult':
        replaceTranscript(cmd.transcript)
        break
    }
  }

  return {
    ...state,
    transcript,
    transcriptRevision,
    transcriptFingerprint,
    inbox,
  }
}

/** Versioned transcript compare-and-swap. Stale AgentLoop commits never overwrite Kernel state. */
export function applyTranscriptCommit(
  state: KernelLoopState,
  commit: TranscriptCommit,
): { state: KernelLoopState; result: TranscriptCommitResult } {
  if (commit.baseRevision !== state.transcriptRevision) {
    return {
      state,
      result: {
        ok: false,
        kind: 'revision_conflict',
        expectedRevision: commit.baseRevision,
        actualRevision: state.transcriptRevision,
      },
    }
  }
  const next = applySessionCommands(state, [
    { kind: 'ReplaceTranscript', transcript: commit.messages },
  ])
  return { state: next, result: { ok: true, snapshot: createTranscriptSnapshot(next) } }
}

/**
 * Flush inbox into transcript as synthetic user text (kernel runs this in PrepareContext).
 * Appendix A Steps 25–26 analogue: queued slash / synthetic text is merged into the user-visible
 * transcript, then the inbox is cleared (items considered consumed; correlate via `inboxItemId` from IPC).
 */
export function drainInboxToTranscript(
  state: KernelLoopState,
): { state: KernelLoopState; snapshot?: TranscriptSnapshot } {
  if (state.inbox.length === 0) return { state }

  const syntheticParts: string[] = []
  const userInputParts: string[] = []
  const retained: KernelLoopState['inbox'] = []
  let flushableCount = 0

  for (const item of state.inbox) {
    if (item.kind === 'pending_human_resume') {
      retained.push(item)
      continue
    }
    flushableCount += 1
    if (item.kind === 'synthetic_user_text') {
      const text = item.text.trim()
      if (item.source === USER_INPUT_INBOX_SOURCE) userInputParts.push(text)
      else syntheticParts.push(text)
    } else if (item.kind === 'slash_command') {
      syntheticParts.push(`[/${item.name}${item.args ? ` ${item.args}` : ''}]`)
    } else if (item.kind === 'inter_agent_mailbox_draft') {
      syntheticParts.push(
        `**Mailbox (draft)**\n${item.lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}`,
      )
    }
  }

  if (flushableCount === 0) return { state }

  const syntheticBody = syntheticParts.filter(Boolean).join('\n\n')
  const userInputBody = userInputParts.filter(Boolean).join('\n\n')
  const transcript = cloneTranscript(state.transcript)
  if (syntheticBody) {
    transcript.push(
      makeSideChannelUserMessage(SIDE_CHANNEL_KIND.genericConvertedSystem, syntheticBody),
    )
  }
  if (userInputBody) {
    transcript.push(
      makeSideChannelUserMessage(
        SIDE_CHANNEL_KIND.kernelUserInput,
        `${KERNEL_USER_INPUT_MARKER}\n${userInputBody}`,
      ),
    )
  }

  const commands: SessionCommand[] = [{ kind: 'ClearInbox' }]
  if (syntheticBody || userInputBody) {
    commands.unshift({ kind: 'ReplaceTranscript', transcript })
  }
  for (const item of retained) commands.push({ kind: 'EnqueueInbox', item })
  const next = applySessionCommands(state, commands)
  return syntheticBody || userInputBody
    ? { state: next, snapshot: createTranscriptSnapshot(next) }
    : { state: next }
}

export function flushInboxToTranscript(state: KernelLoopState): KernelLoopState {
  return drainInboxToTranscript(state).state
}
