import { formatToolUseConventions } from '../systemPrompt'
import type { SystemPromptSection } from './types'

/**
 * "How to use our tools correctly on the first try" reminder. Pure
 * function of `platform` (Windows adds a PowerShell 5.1 reminder).
 */
export const toolUseConventionsSection: SystemPromptSection = {
  id: 'tool-use-conventions',
  owner: 'tooling',
  layer: 'system',
  build: ({ options }) => formatToolUseConventions(options.platform),
}
