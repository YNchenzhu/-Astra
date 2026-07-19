/**
 * LSP type definitions.
 *
 * Adapted from upstream's types for the Electron architecture.
 */

/** Server lifecycle state */
export type LspServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

/**
 * LSP server configuration.
 * Each server is scoped to a set of file extensions.
 */
export interface LspServerConfig {
  /** Command to start the language server (e.g. "typescript-language-server") */
  command: string
  /** Command-line arguments */
  args?: string[]
  /** Extra environment variables */
  env?: Record<string, string>
  /** Working directory for the server process */
  workspaceFolder?: string
  /** Map of file extension → language ID (e.g. ".ts" → "typescript") */
  extensionToLanguage: Record<string, string>
  /** Server-specific initialization options */
  initializationOptions?: Record<string, unknown>
  /** Workspace configuration values answered for workspace/configuration (optional) */
  settings?: Record<string, unknown>
  /** Declared transport; only stdio is implemented */
  transport?: 'stdio' | 'socket'
  /** Maximum restart attempts (default: 3) */
  maxRestarts?: number
  /** Startup timeout in milliseconds */
  startupTimeout?: number
  /**
   * Audit #16 — user-declared bundled LSP support.
   *
   * When set, the server is launched from `bundled-lsp/node_modules/<bundledPackage>/<bundledScript>`
   * via Electron-as-Node (packaged) or plain `node` (dev/tests), independent of the
   * hard-coded `BUNDLED_ENTRY` map. This lets `.lsp.json` authors ship their own
   * language servers without patching the host.
   */
  bundledPackage?: string
  /** Relative entry script under the bundled package (required when `bundledPackage` is set). */
  bundledScript?: string
}

/**
 * Resolved config with a unique scope name.
 * Loaded from settings or .lsp.json files.
 */
export interface ScopedLspServerConfig extends LspServerConfig {
  /** Unique scope identifier (e.g. "typescript", "python") */
  scope: string
}
