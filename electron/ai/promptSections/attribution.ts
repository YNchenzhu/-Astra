import { formatSystemAttributionSection } from '../systemPrompt'
import type { SystemPromptSection } from './types'

/**
 * Host attribution header — `Host: 星构Astra ... · workspace_fp=...`.
 * Plain text, sits at the very top of `systemContext` so prompt-cache
 * fingerprints stay aligned with the visible prefix.
 */
export const attributionSection: SystemPromptSection = {
  id: 'attribution',
  owner: 'core',
  layer: 'system',
  build: ({ options }) => formatSystemAttributionSection(options.cwd),
}
