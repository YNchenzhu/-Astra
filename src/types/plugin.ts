// ============================================================================
// Plugin System Types
// ============================================================================

/**
 * Plugin component types that a plugin can provide.
 */
export type PluginComponent =
  | 'commands'
  | 'agents'
  | 'skills'
  | 'hooks'
  | 'output-styles'

/**
 * Plugin repository information.
 */
export interface PluginRepository {
  url: string
  branch: string
  lastUpdated?: string
  commitSha?: string
}

/**
 * Top-level plugin configuration.
 */
export interface PluginConfig {
  repositories: Record<string, PluginRepository>
}

/**
 * Plugin author metadata.
 */
export interface PluginAuthor {
  name: string
  email?: string
  url?: string
}

/**
 * Plugin manifest from marketplace or local source.
 */
export interface PluginManifest {
  name: string
  version: string
  description: string
  author?: PluginAuthor | string
  license?: string
  repository?: string
  homepage?: string
  bugs?: string
  commands?: string | string[] | Record<string, CommandMetadata>
  agents?: string | string[]
  skills?: string | string[]
  hooks?: Record<string, unknown>
  mcpServers?: Record<string, unknown>
  lspServers?: Record<string, unknown>
  settings?: Record<string, unknown>
  dependencies?: Record<string, string>
}

/**
 * Per-command metadata from plugin manifest.
 */
export interface CommandMetadata {
  description?: string
  argumentHint?: string
  whenToUse?: string
  version?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
}

/**
 * Definition for a built-in plugin that ships with the application.
 */
export interface BuiltinPluginDefinition {
  name: string
  description: string
  version?: string
  skills?: Array<{
    name: string
    description: string
    argumentHint?: string
  }>
  hooks?: Record<string, unknown>
  mcpServers?: Record<string, Record<string, unknown>>
  isAvailable?: () => boolean
  defaultEnabled?: boolean
}

/**
 * A fully loaded plugin with resolved paths and configuration.
 */
export interface LoadedPlugin {
  name: string
  manifest: PluginManifest
  path: string
  source: string
  repository: string
  enabled?: boolean
  isBuiltin?: boolean
  sha?: string
  commandsPath?: string
  commandsPaths?: string[]
  commandsMetadata?: Record<string, CommandMetadata>
  agentsPath?: string
  agentsPaths?: string[]
  skillsPath?: string
  skillsPaths?: string[]
  outputStylesPath?: string
  outputStylesPaths?: string[]
  hooksConfig?: Record<string, unknown>
  mcpServers?: Record<string, Record<string, unknown>>
  lspServers?: Record<string, Record<string, unknown>>
  settings?: Record<string, unknown>
}

/**
 * Discriminated union of plugin error types.
 * Each error type has specific contextual data for better debugging.
 */
export type PluginError =
  | {
      type: 'path-not-found'
      source: string
      plugin?: string
      path: string
      component: PluginComponent
    }
  | {
      type: 'git-auth-failed'
      source: string
      plugin?: string
      gitUrl: string
      authType: 'ssh' | 'https'
    }
  | {
      type: 'git-timeout'
      source: string
      plugin?: string
      gitUrl: string
      operation: 'clone' | 'pull'
    }
  | {
      type: 'network-error'
      source: string
      plugin?: string
      url: string
      details?: string
    }
  | {
      type: 'manifest-parse-error'
      source: string
      plugin?: string
      manifestPath: string
      parseError: string
    }
  | {
      type: 'manifest-validation-error'
      source: string
      plugin?: string
      manifestPath: string
      validationErrors: string[]
    }
  | {
      type: 'plugin-not-found'
      source: string
      pluginId: string
      marketplace: string
    }
  | {
      type: 'marketplace-not-found'
      source: string
      marketplace: string
      availableMarketplaces: string[]
    }
  | {
      type: 'marketplace-load-failed'
      source: string
      marketplace: string
      reason: string
    }
  | {
      type: 'mcp-config-invalid'
      source: string
      plugin: string
      serverName: string
      validationError: string
    }
  | {
      type: 'mcp-server-suppressed-duplicate'
      source: string
      plugin: string
      serverName: string
      duplicateOf: string
    }
  | {
      type: 'lsp-config-invalid'
      source: string
      plugin: string
      serverName: string
      validationError: string
    }
  | {
      type: 'hook-load-failed'
      source: string
      plugin: string
      hookPath: string
      reason: string
    }
  | {
      type: 'component-load-failed'
      source: string
      plugin: string
      component: PluginComponent
      path: string
      reason: string
    }
  | {
      type: 'mcpb-download-failed'
      source: string
      plugin: string
      url: string
      reason: string
    }
  | {
      type: 'mcpb-extract-failed'
      source: string
      plugin: string
      mcpbPath: string
      reason: string
    }
  | {
      type: 'mcpb-invalid-manifest'
      source: string
      plugin: string
      mcpbPath: string
      validationError: string
    }
  | {
      type: 'lsp-server-start-failed'
      source: string
      plugin: string
      serverName: string
      reason: string
    }
  | {
      type: 'lsp-server-crashed'
      source: string
      plugin: string
      serverName: string
      exitCode: number | null
      signal?: string
    }
  | {
      type: 'lsp-request-timeout'
      source: string
      plugin: string
      serverName: string
      method: string
      timeoutMs: number
    }
  | {
      type: 'lsp-request-failed'
      source: string
      plugin: string
      serverName: string
      method: string
      error: string
    }
  | {
      type: 'marketplace-blocked-by-policy'
      source: string
      plugin?: string
      marketplace: string
      blockedByBlocklist?: boolean
      allowedSources: string[]
    }
  | {
      type: 'dependency-unsatisfied'
      source: string
      plugin: string
      dependency: string
      reason: 'not-enabled' | 'not-found'
    }
  | {
      type: 'plugin-cache-miss'
      source: string
      plugin: string
      installPath: string
    }
  | {
      type: 'generic-error'
      source: string
      plugin?: string
      error: string
    }

/**
 * Result of a plugin loading operation.
 */
export interface PluginLoadResult {
  enabled: LoadedPlugin[]
  disabled: LoadedPlugin[]
  errors: PluginError[]
}

/**
 * Helper to get a display message from any PluginError.
 */
export function getPluginErrorMessage(error: PluginError): string {
  switch (error.type) {
    case 'generic-error':
      return error.error
    case 'path-not-found':
      return `Path not found: ${error.path} (${error.component})`
    case 'git-auth-failed':
      return `Git authentication failed (${error.authType}): ${error.gitUrl}`
    case 'git-timeout':
      return `Git ${error.operation} timeout: ${error.gitUrl}`
    case 'network-error':
      return `Network error: ${error.url}${error.details ? ` - ${error.details}` : ''}`
    case 'manifest-parse-error':
      return `Manifest parse error: ${error.parseError}`
    case 'manifest-validation-error':
      return `Manifest validation failed: ${error.validationErrors.join(', ')}`
    case 'plugin-not-found':
      return `Plugin ${error.pluginId} not found in marketplace ${error.marketplace}`
    case 'marketplace-not-found':
      return `Marketplace ${error.marketplace} not found`
    case 'marketplace-load-failed':
      return `Marketplace ${error.marketplace} failed to load: ${error.reason}`
    case 'mcp-config-invalid':
      return `MCP server ${error.serverName} invalid: ${error.validationError}`
    case 'hook-load-failed':
      return `Hook load failed: ${error.reason}`
    case 'component-load-failed':
      return `${error.component} load failed from ${error.path}: ${error.reason}`
    case 'mcpb-download-failed':
      return `Failed to download MCPB from ${error.url}: ${error.reason}`
    case 'mcpb-extract-failed':
      return `Failed to extract MCPB ${error.mcpbPath}: ${error.reason}`
    case 'mcpb-invalid-manifest':
      return `MCPB manifest invalid at ${error.mcpbPath}: ${error.validationError}`
    case 'lsp-config-invalid':
      return `Plugin "${error.plugin}" has invalid LSP server config for "${error.serverName}": ${error.validationError}`
    case 'lsp-server-start-failed':
      return `Plugin "${error.plugin}" failed to start LSP server "${error.serverName}": ${error.reason}`
    case 'lsp-server-crashed':
      if (error.signal) {
        return `Plugin "${error.plugin}" LSP server "${error.serverName}" crashed with signal ${error.signal}`
      }
      return `Plugin "${error.plugin}" LSP server "${error.serverName}" crashed with exit code ${error.exitCode ?? 'unknown'}`
    case 'lsp-request-timeout':
      return `Plugin "${error.plugin}" LSP server "${error.serverName}" timed out on ${error.method} request after ${error.timeoutMs}ms`
    case 'lsp-request-failed':
      return `Plugin "${error.plugin}" LSP server "${error.serverName}" ${error.method} request failed: ${error.error}`
    case 'marketplace-blocked-by-policy':
      if (error.blockedByBlocklist) {
        return `Marketplace '${error.marketplace}' is blocked by enterprise policy`
      }
      return `Marketplace '${error.marketplace}' is not in the allowed marketplace list`
    case 'dependency-unsatisfied': {
      const hint =
        error.reason === 'not-enabled'
          ? 'disabled — enable it or remove the dependency'
          : 'not found in any configured marketplace'
      return `Dependency "${error.dependency}" is ${hint}`
    }
    case 'plugin-cache-miss':
      return `Plugin "${error.plugin}" not cached at ${error.installPath} — run /plugins to refresh`
    case 'mcp-server-suppressed-duplicate': {
      const dup = error.duplicateOf.startsWith('plugin:')
        ? `server provided by plugin "${error.duplicateOf.split(':')[1] ?? '?'}"`
        : `already-configured "${error.duplicateOf}"`
      return `MCP server "${error.serverName}" skipped — same command/URL as ${dup}`
    }
  }
}
