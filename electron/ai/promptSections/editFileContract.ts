import { EDIT_FILE_CONTRACT_BLOCK } from '../../constants/prompts/systemDirectives'
import type { SystemPromptSection } from './types'

/**
 * Hard runtime invariant for `read_file → edit_file` with `baseReadId`.
 * Only emitted when the caller declares the edit-file tool surface is
 * exposed (currently main chat only).
 *
 * Layer assignment: `system` (cache-friendly). The contract text is
 * session-stable — it only varies on `includeEditFileContract` which is a
 * per-agent capability flag set once, not a per-turn input. Hosting it in
 * `systemContext` keeps the cached prefix coherent and avoids a separate
 * uncached `userContext` block that was nearly always non-empty in
 * practice. Idempotent injection is still guarded by
 * `subagentSystemPrompt.EDIT_FILE_CONTRACT_MARKER`.
 */
export const editFileContractSection: SystemPromptSection = {
  id: 'edit-file-contract',
  owner: 'tooling',
  layer: 'system',
  build: ({ options }) => (options.includeEditFileContract ? EDIT_FILE_CONTRACT_BLOCK : ''),
}
