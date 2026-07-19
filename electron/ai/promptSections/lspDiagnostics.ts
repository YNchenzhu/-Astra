import { formatLspPassiveDiagnosticsSection } from '../systemPrompt'
import type { SystemPromptSection } from './types'

/**
 * Passive LSP diagnostic batch drained for this turn. Empty when no
 * notifications were drained — the legacy renderer suppresses the
 * whole block in that case, so byte-equality requires returning '' too.
 */
export const lspDiagnosticsSection: SystemPromptSection = {
  id: 'lsp-passive-diagnostics',
  owner: 'tooling',
  layer: 'user-meta',
  build: ({ options }) => formatLspPassiveDiagnosticsSection(options.lspPassiveDiagnosticsContext ?? ''),
}
