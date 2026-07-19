/**
 * Incremental system-reminder injector — Phase C of upstream
 * alignment.
 *
 * upstream surfaces deltas (skill list changed, memory aging out)
 * through fresh `<system-reminder>` messages instead of re-injecting
 * the full reference catalogue every turn. This module is the
 * conversation-aware bookkeeper: on each turn the caller asks
 * `collectPendingReminders(conversationId, snapshot)` and gets a list
 * of one-shot reminder strings to append to the user-meta block.
 *
 * The module owns no IO; the caller passes the current world snapshot
 * (skill names + version, recalled memories with age). This keeps the
 * module trivially testable and avoids coupling to settings access /
 * memory storage internals.
 */

export interface RecalledMemoryAgeSnapshot {
  name: string
  ageDays: number
}

export interface SystemReminderSnapshot {
  /**
   * Monotonic counter from `skillTool.getSkillsVersion()`. Used to
   * detect "skills changed since last turn".
   */
  skillsVersion: number
  /** Current auto-invocation skill names. Order does not matter. */
  skillNames: string[]
  /** Recalled memories surfaced this turn (the ones the model will see). */
  recalledMemories?: RecalledMemoryAgeSnapshot[]
}

export interface PendingReminder {
  /** Stable id per reminder kind; useful for tests / log correlation. */
  id: string
  /** Body text — caller wraps it in `<system-reminder>` at injection site. */
  body: string
}

/**
 * Threshold above which a recalled memory triggers a one-shot
 * staleness reminder. Mirrors `memoryFreshnessReminder`'s heuristic
 * but at a stricter cutoff so the per-recall note (already attached
 * inside `<project-memory>`) is not duplicated for fresh entries.
 */
export const STALE_MEMORY_AGE_DAYS = 90

interface ConversationState {
  lastSkillsVersion: number
  lastSkillNames: Set<string>
  notifiedStaleMemoryNames: Set<string>
}

/**
 * Audit fix (P2) — bounded per-conversation bookkeeping. Without a cap
 * the `states` Map grew unbounded across the host's lifetime, since
 * Electron main never restarts and conversation ids are unique per
 * chat. 32 buckets matches `promptDiagnostics`' ceiling so the memory
 * footprint stays predictable across our diagnostics modules.
 *
 * Map preserves insertion order; eviction pops the oldest key. Touching
 * a bucket on hit re-inserts it as the newest so frequently-active
 * chats survive eviction.
 */
const MAX_BUCKETS_REMINDER = 32

const states = new Map<string, ConversationState>()

function getOrInit(conversationId: string): ConversationState {
  const existing = states.get(conversationId)
  if (existing) {
    // Touch: re-insert as newest so LRU eviction targets cold chats.
    states.delete(conversationId)
    states.set(conversationId, existing)
    return existing
  }
  const fresh: ConversationState = {
    lastSkillsVersion: -1,
    lastSkillNames: new Set(),
    notifiedStaleMemoryNames: new Set(),
  }
  states.set(conversationId, fresh)
  while (states.size > MAX_BUCKETS_REMINDER) {
    const oldest = states.keys().next().value
    if (oldest === undefined || oldest === conversationId) break
    states.delete(oldest)
  }
  return fresh
}

function formatSkillDelta(added: string[], removed: string[]): string | null {
  if (added.length === 0 && removed.length === 0) return null
  const parts: string[] = []
  if (added.length > 0) parts.push(`added: ${added.sort().join(', ')}`)
  if (removed.length > 0) parts.push(`removed: ${removed.sort().join(', ')}`)
  return `Available skills changed since the last turn — ${parts.join('; ')}. Invoke via the Skill tool; see the compact skill index for the full list.`
}

/**
 * Returns the list of reminders to append to this turn's user-meta
 * block. Calling this advances the bookkeeping cursor, so the same
 * reminder is not re-emitted on the following turn.
 *
 * Callers MUST pass a stable `conversationId`. Passing `''` returns
 * `[]` without side effects (avoids cross-conversation leakage).
 */
export function collectPendingReminders(
  conversationId: string,
  snapshot: SystemReminderSnapshot,
): PendingReminder[] {
  const id = conversationId.trim()
  if (!id) return []
  const state = getOrInit(id)
  const reminders: PendingReminder[] = []

  const currentNames = new Set(snapshot.skillNames)
  const isFirstObservation = state.lastSkillsVersion === -1
  if (!isFirstObservation && snapshot.skillsVersion !== state.lastSkillsVersion) {
    const added: string[] = []
    const removed: string[] = []
    for (const n of currentNames) if (!state.lastSkillNames.has(n)) added.push(n)
    for (const n of state.lastSkillNames) if (!currentNames.has(n)) removed.push(n)
    const body = formatSkillDelta(added, removed)
    if (body) {
      reminders.push({ id: 'skill-version-change', body })
    }
  }
  // Advance bookkeeping AFTER comparing.
  state.lastSkillsVersion = snapshot.skillsVersion
  state.lastSkillNames = currentNames

  if (snapshot.recalledMemories?.length) {
    const staleNames: string[] = []
    for (const mem of snapshot.recalledMemories) {
      if (mem.ageDays < STALE_MEMORY_AGE_DAYS) continue
      if (state.notifiedStaleMemoryNames.has(mem.name)) continue
      staleNames.push(`${mem.name} (${mem.ageDays} days old)`)
      state.notifiedStaleMemoryNames.add(mem.name)
    }
    if (staleNames.length > 0) {
      reminders.push({
        id: 'stale-memory-warning',
        body:
          `One-time staleness check — recalled memory items written long ago: ${staleNames.join('; ')}. ` +
          `Verify them against current code/state before relying on the contents.`,
      })
    }
  }

  return reminders
}

/**
 * Format a list of reminders for appending to the user-meta context.
 *
 * Audit fix R4-L3 (2026-05): previously this wrapped the reminders
 * in a nested `<system-reminder>` block. The user-meta context is
 * itself wrapped in `<system-reminder type="user-meta-context">` by
 * `prependUserContext`, so the result was a tag inside a tag —
 * two competing framing signals that the model parsed unpredictably.
 * Now emit a labelled markdown section that lives plainly inside
 * the outer user-meta wrap, sharing the same "background, not a
 * fresh instruction" framing as the rest of the block.
 *
 * Returns '' when the list is empty so the caller can no-op cleanly.
 */
export function formatRemindersForUserMeta(reminders: PendingReminder[]): string {
  if (reminders.length === 0) return ''
  const lines: string[] = ['# Incremental reminders']
  for (const r of reminders) lines.push(`- ${r.body}`)
  return lines.join('\n')
}

/** @internal Test-only seam. */
export function __resetSystemReminderStateForTests(): void {
  states.clear()
}
