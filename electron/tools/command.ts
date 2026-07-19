/**
 * Command system types — re-exports + cursor-ui-clone extensions.
 *
 * Re-exports canonical types from src/types/command.ts.
 * Adds cursor-ui-clone-specific framework types.
 */

import type { MCPServerConfig } from '../mcp/transport'

export type {
  CommandLoadedFrom,
  CommandAvailability,
  CommandBase,
  LocalCommandResult,
  CommandResultDisplay,
  LocalJSXCommandOnDone,
  ResumeEntrypoint,
  PromptCommand,
  Command,
} from '../../src/types/command'
export { getCommandName, isCommandEnabled } from '../../src/types/command'

/** Execution context for local JSX commands (cursor-ui-clone specific) */
export type LocalJSXCommandContext = {
  canUseTool?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>
  setMessages: (updater: (prev: unknown[]) => unknown[]) => void
  options: {
    dynamicMcpConfig?: Record<string, MCPServerConfig>
  }
}
