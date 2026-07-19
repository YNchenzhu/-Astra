import { formatEnvironmentSection } from '../systemPrompt'
import type { SystemPromptSection } from './types'

/**
 * Session-stable environment block (cwd / platform / shell / OS).
 * Always emitted, even when memory / LSP / session are empty — the
 * model needs to know where it is operating from.
 */
export const environmentSection: SystemPromptSection = {
  id: 'environment',
  owner: 'environment',
  layer: 'user-meta',
  build: ({ options }) => formatEnvironmentSection(options.cwd, options.platform),
}
