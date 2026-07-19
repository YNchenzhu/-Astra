/**
 * Plugin system types — runtime constants + type re-exports.
 *
 * HooksSettings is a cursor-ui-clone-specific shape used by the hook config system.
 * All other plugin types are re-exported from the canonical src/types/plugin.ts.
 */

import type { MCPServerConfig } from '../mcp/transport'
import type { LspServerConfig } from '../lsp/types'
import type { SkillDefinition } from '../skills/types'

/** Simple alias for hook settings — matches what setHooksConfig() accepts. */
export type HooksSettings = Array<{
  id: string
  event: string
  command: string
  enabled: boolean
  matcher?: string
  async?: boolean
  asyncRewake?: boolean
}>

// ============================================================================
// Type Re-exports (canonical definitions in src/types/plugin.ts)
// ============================================================================

export type {
  PluginComponent,
  PluginRepository,
  PluginConfig,
  PluginAuthor,
  PluginManifest,
  CommandMetadata,
  BuiltinPluginDefinition,
  PluginError,
  PluginLoadResult,
} from '../../src/types/plugin'
export { getPluginErrorMessage } from '../../src/types/plugin'

// ============================================================================
// the IDE-UI-Clone specific extension: LoadedPlugin with framework types
// ============================================================================

/**
 * A plugin loaded from a git repository or local path.
 * Extends the canonical LoadedPlugin with cursor-ui-clone's framework types.
 */
export type LoadedPlugin = {
  name: string
  /** Owning plugin id / package name */
  source: string
  /** Repository identifier (e.g. GitHub URL or local path) */
  repository: string
  enabled?: boolean
  isBuiltin?: boolean
  sha?: string
  commandsPath?: string
  commandsPaths?: string[]
  agentsPath?: string
  agentsPaths?: string[]
  skillsPath?: string
  skillsPaths?: string[]
  outputStylesPath?: string
  outputStylesPaths?: string[]
  hooksConfig?: HooksSettings
  mcpServers?: Record<string, MCPServerConfig>
  lspServers?: Record<string, LspServerConfig>
  skills?: SkillDefinition[]
  settings?: Record<string, unknown>
}
