import type { SessionId } from './ids'
import type { PluginManifest } from './plugin'

// ============================================================================
// Command System Types
// ============================================================================

/**
 * Where a command/skill was loaded from.
 */
export type CommandLoadedFrom =
  | 'commands_DEPRECATED'
  | 'skills'
  | 'plugin'
  | 'managed'
  | 'bundled'
  | 'mcp'

/**
 * Declares which auth/provider environments a command is available in.
 */
export type CommandAvailability =
  | 'claude-ai'
  | 'console'

/**
 * Base command metadata shared across all command variants.
 */
export interface CommandBase {
  availability?: CommandAvailability[]
  description: string
  hasUserSpecifiedDescription?: boolean
  isEnabled?: () => boolean
  isHidden?: boolean
  name: string
  aliases?: string[]
  isMcp?: boolean
  argumentHint?: string
  whenToUse?: string
  version?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  loadedFrom?: CommandLoadedFrom
  kind?: 'workflow'
  immediate?: boolean
  isSensitive?: boolean
  userFacingName?: () => string
}

/**
 * Result types that local commands can return.
 */
export type LocalCommandResult =
  | { type: 'text'; value: string }
  | { type: 'compact'; compactionResult?: Record<string, unknown>; displayText?: string }
  | { type: 'skip' }

/**
 * How to display a command result in the conversation.
 */
export type CommandResultDisplay = 'skip' | 'system' | 'user'

/**
 * Callback when a command completes.
 */
export type LocalJSXCommandOnDone = (
  result?: string,
  options?: {
    display?: CommandResultDisplay
    shouldQuery?: boolean
    metaMessages?: string[]
    nextInput?: string
    submitNextInput?: boolean
  },
) => void

/**
 * Where a session can be resumed from.
 */
export type ResumeEntrypoint =
  | 'cli_flag'
  | 'slash_command_picker'
  | 'slash_command_session_id'
  | 'slash_command_title'
  | 'fork'

/**
 * Extended context for JSX command execution.
 */
export type LocalJSXCommandContext = {
  setMessages?: (updater: (prev: unknown[]) => unknown[]) => void
  options?: {
    dynamicMcpConfig?: Record<string, unknown>
    theme?: string
  }
  onChangeAPIKey?: () => void
  resume?: (
    sessionId: SessionId,
    entrypoint: ResumeEntrypoint,
  ) => Promise<void>
}

/**
 * A prompt command expands into model-visible content blocks.
 */
export type PromptCommand = CommandBase & {
  type: 'prompt'
  progressMessage: string
  contentLength: number
  argNames?: string[]
  allowedTools?: string[]
  model?: string
  source: string
  pluginInfo?: {
    pluginManifest: PluginManifest
    repository: string
  }
  disableNonInteractive?: boolean
  hooks?: Record<string, unknown>
  skillRoot?: string
  context?: 'inline' | 'fork'
  agent?: string
  effort?: string
  paths?: string[]
  getPromptForCommand: (
    args: string,
    context: Record<string, unknown>,
  ) => Promise<unknown[]>
}

/**
 * A locally-implemented command (non-JSX).
 */
export type LocalCommand = CommandBase & {
  type: 'local'
  supportsNonInteractive: boolean
  load: () => Promise<{ call: (args: string, context: Record<string, unknown>) => Promise<LocalCommandResult> }>
}

/**
 * A locally-implemented JSX command that renders UI.
 */
export type LocalJSXCommand = CommandBase & {
  type: 'local-jsx'
  load: () => Promise<{
    call: (
      onDone: LocalJSXCommandOnDone,
      context: Record<string, unknown> & LocalJSXCommandContext,
      args: string,
    ) => Promise<unknown>
  }>
}

/**
 * Discriminated union of all command variants.
 */
export type Command = PromptCommand | LocalCommand | LocalJSXCommand

/**
 * Resolves the user-visible name, falling back to `cmd.name` when not overridden.
 */
export function getCommandName(cmd: CommandBase): string {
  return cmd.userFacingName?.() ?? cmd.name
}

/**
 * Resolves whether the command is enabled, defaulting to true.
 */
export function isCommandEnabled(cmd: CommandBase): boolean {
  return cmd.isEnabled?.() ?? true
}
