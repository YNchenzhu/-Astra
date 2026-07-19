import type { SystemPromptSection } from './types'

/**
 * Companion / buddy intro block.
 *
 * Audit P0-2a (2026-05): previously `electron/buddy/service.ts#buildBuddySystemPrompt`
 * was defined but never consumed by the prompt assembly pipeline — the
 * `buddyStateChange` host-attachment collector emitted *delta* updates assuming
 * the model already knew who the companion was, but no section ever introduced
 * the companion in the first place.
 *
 * This section lands in the user-meta layer (same layer as `<project-memory>`
 * and `<session-context>`) because it is descriptive background, not a fresh
 * user instruction. Caller (`streamHandler.ts` via `MainOrchestrationContext`)
 * pre-renders the body with `buildBuddySystemPrompt(getBuddyState())` and
 * passes it through `options.buddyPromptBody` so this section stays pure.
 *
 * Returns empty when:
 *   - buddy disabled / muted (`buildBuddySystemPrompt` already returns '')
 *   - caller did not opt in (field omitted or empty string)
 */
export const buddyStateSection: SystemPromptSection = {
  id: 'buddy-state',
  owner: 'buddy',
  layer: 'user-meta',
  build: ({ options }) => {
    const body = (options.buddyPromptBody ?? '').trim()
    if (!body) return ''
    return body
  },
}
