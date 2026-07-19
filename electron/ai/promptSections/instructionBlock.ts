import { getCachedSystemPromptInstructionSection } from '../systemPrompt'
import type { SystemPromptSection } from './types'

/**
 * Identity + chat-mode + tone + faithful-reporting + anti-action-
 * hallucination + delegation block. Cached against outputStyle + language
 * so the body string is reused across turns when those inputs are stable.
 *
 * Intentionally kept as a single section — the underlying string is
 * load-bearing and tightly coupled (multiple `Stage X` audit fixes are
 * encoded inside). Future splits should land in `renderSystemPromptInstructionSection`
 * with byte-equivalent output and an updated registry entry.
 */
export const instructionBlockSection: SystemPromptSection = {
  id: 'instruction-block',
  owner: 'core',
  layer: 'system',
  build: ({ options }) =>
    getCachedSystemPromptInstructionSection(
      options.outputStyle ?? 'default',
      options.language ?? '',
    ),
}
