/**
 * Companion intro attachment — ported from upstream (early version).
 *
 * @deprecated Audit P0-2b (2026-05): superseded by
 * `electron/buddy/service.ts#buildBuddySystemPrompt`, which is now wired into
 * the prompt-section registry via `electron/ai/promptSections/buddyState.ts`.
 *
 * The two functions in this file emit a nearly verbatim duplicate of
 * `buildBuddySystemPrompt` (same `# Companion` heading, same "small ... named
 * ... beside the user's input box ... separate watcher" body). `buildBuddySystemPrompt`
 * is the strict superset (it also surfaces rarity / shiny / stats / personality).
 *
 * The dedup guard below — "skip if any `role === 'system'` message already
 * contains the companion name" — also no longer matches the production
 * injection site (the registry places the buddy section in the user-meta
 * layer, not in a `role: 'system'` message), so the two would BOTH inject
 * if both were called, producing a model-visible duplicate.
 *
 * Kept exported for source compatibility in case a bundle or downstream
 * consumer still imports these symbols. New callers MUST use
 * `buildBuddySystemPrompt` from `electron/buddy/service.ts` and let the
 * prompt-section registry handle injection — do not call these directly.
 */

import { getCompanion } from './companion'
import { getGlobalConfig } from '../utils/config'
interface Message {
  role: string
  content?: string
}

/** @deprecated See file-level note. Use `buildBuddySystemPrompt`. */
export function companionIntroText(name: string, species: string): string {
  return `# Companion

A small ${species} named ${name} sits beside the user's input box and occasionally comments in a speech bubble. You're not ${name} — it's a separate watcher.

When the user addresses ${name} directly (by name), its bubble will answer. Your job in that moment is to stay out of the way: respond in ONE line or less, or just answer any part of the message meant for you. Don't explain that you're not ${name} — they know. Don't narrate what ${name} might say — the bubble handles that.`
}

/** @deprecated See file-level note. Use `buildBuddySystemPrompt` + the prompt-section registry. */
export function getCompanionIntroAttachment(
  messages: Message[] | undefined,
): string {
  const companion = getCompanion()
  if (!companion) return ''
  if (getGlobalConfig().companionMuted) return ''

  // Skip if already announced for this companion
  for (const msg of messages ?? []) {
    if (msg.role === 'system' && msg.content?.includes(companion.name)) {
      return ''
    }
  }

  return companionIntroText(companion.name, companion.species)
}
