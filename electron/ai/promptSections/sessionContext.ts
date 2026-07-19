import type { SystemPromptSection } from './types'

/**
 * Per-conversation session ledger (running todo list, files touched,
 * recent errors). Rendered as `<session-context>` so the model reads it
 * as reference, not instruction.
 */
export const sessionContextSection: SystemPromptSection = {
  id: 'session-context',
  owner: 'session',
  layer: 'user-meta',
  build: ({ options }) => {
    const sess = (options.sessionContext ?? '').trim()
    if (!sess) return ''
    return `# Current Session
<session-context>
${sess}
</session-context>`
  },
}
