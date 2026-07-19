import type { z } from 'zod'
import type { PermissionMode, PermissionResult } from './permissions'

// ============================================================================
// Tool execution result + registry types
// ============================================================================

export type ToolInputSchema = {
  type: 'object'
  properties: Record<string, { type: string; description: string; enum?: string[] }>
  required?: string[]
}

export type ToolDefinition = {
  name: string
  description: string
  inputSchema: ToolInputSchema
}

export type ToolExecutionResult = {
  toolUseId: string
  toolName: string
  success: boolean
  content: string
  error?: string
  duration: number
}

export type ToolPermission = {
  toolName: string
  allowed: boolean
  reason?: string
}

export type ToolRegistry = Record<string, ToolDefinition>

export interface ITool {
  name: string
  description: string
  inputSchema: ToolInputSchema
  execute(input: Record<string, unknown>): Promise<string>
}

// ============================================================================
// Tool Progress Types
// ============================================================================

export type ToolProgressData =
  | { type: 'bash'; command: string; cwd: string }
  | { type: 'file_read'; filePath: string }
  | { type: 'file_write'; filePath: string }
  | { type: 'file_edit'; filePath: string; oldText?: string; newText?: string }
  | { type: 'search'; pattern: string; results: number }
  | { type: 'mcp'; serverName: string; toolName: string }
  | { type: 'generic'; message: string }

export type ToolProgress<P extends ToolProgressData = ToolProgressData> = {
  toolUseId: string
  data: P
}

// ============================================================================
// Validation
// ============================================================================

export type ValidationResult =
  | { result: true }
  | { result: false; message: string; errorCode: number }

// ============================================================================
// Core Tool Types
// ============================================================================

export type ToolInputJSONSchema = {
  type: 'object'
  properties?: Record<string, unknown>
}

export type ToolResult<T = unknown> = {
  data: T
  toolUseId?: string
  isStreaming?: boolean
  contentBlocks?: string[]
}

export type ToolCallProgress<P extends ToolProgressData = ToolProgressData> = (
  progress: ToolProgress<P>,
) => void

export type AnyObject = z.ZodType<{ [key: string]: unknown }>

export type ToolUseContext = {
  messages: ToolMessage[]
  abortController: AbortController
  workspacePath?: string
  isNonInteractive?: boolean
  permissionMode: PermissionMode
  setToolJSX?: (jsx: unknown) => void
  onProgress?: ToolCallProgress
}

// ============================================================================
// Tool Message Types (for agentic loop)
// ============================================================================

export type ToolMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string
      toolUses?: ToolUseBlock[]
    }
  | { role: 'tool_result'; content: string; toolUseId: string; isError?: boolean }

export type ToolUseBlock = {
  id: string
  name: string
  input: Record<string, unknown>
}

export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

// ============================================================================
// Tool Definition
// ============================================================================

const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isReadOnly: () => false,
  isDestructive: () => false,
  checkPermissions: (input: Record<string, unknown>): Promise<PermissionResult> =>
    Promise.resolve({ behavior: 'allow', updatedInput: input }),
  userFacingName: (...args: unknown[]) => (args[1] as string) || '',
}

type DefaultableToolKeys = keyof typeof TOOL_DEFAULTS

export type ToolDef<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  name: string
  description: string
  inputSchema: Input
  inputJSONSchema?: ToolInputJSONSchema
  aliases?: string[]

  call(
    args: z.infer<Input>,
    context: ToolUseContext,
    onProgress?: ToolCallProgress<P>,
  ): Promise<ToolResult<Output>>

  prompt(options: {
    tools: Tools
  }): Promise<string>

  validateInput?(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<ValidationResult>

  checkPermissions(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<PermissionResult>

  isEnabled(): boolean
  isReadOnly(input: z.infer<Input>): boolean
  isDestructive?(input: z.infer<Input>): boolean
  userFacingName(input: Partial<z.infer<Input>> | undefined): string

  isSearchOrReadCommand?(input: z.infer<Input>): {
    isSearch: boolean
    isRead: boolean
  }

  getToolUseSummary?(input: Partial<z.infer<Input>> | undefined): string | null

  searchHint?: string

  maxResultSizeChars?: number
}

type BuiltTool<D extends AnyToolDef> = Omit<D, DefaultableToolKeys> & {
  [K in DefaultableToolKeys]: K extends keyof D
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? D[K] extends (...args: any[]) => any
      ? D[K]
      : (typeof TOOL_DEFAULTS)[K]
    : (typeof TOOL_DEFAULTS)[K]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolDef = ToolDef<any, any, any>

type ToolDefInput<D extends AnyToolDef> = Omit<D, DefaultableToolKeys> & Partial<Pick<D, DefaultableToolKeys>> & {
  name: string
  description: string
  inputSchema: D['inputSchema']
  call: D['call']
  prompt: D['prompt']
}

export function buildTool<D extends AnyToolDef>(def: ToolDefInput<D>): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,
    ...def,
    userFacingName: def.userFacingName
      ? def.userFacingName
      : () => def.name,
  } as BuiltTool<D>
}

export type Tool = ReturnType<typeof buildTool>

export type Tools = readonly Tool[]

// ============================================================================
// Tool Helpers
// ============================================================================

export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false)
}

export function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find((t) => toolMatchesName(t, name))
}

// ============================================================================
// Agentic Loop Types
// ============================================================================

export type AgenticLoopState = 'idle' | 'running' | 'waiting_permission' | 'error'

export type AgenticLoopConfig = {
  maxTurns?: number
  maxTokens?: number
  abortController: AbortController
  onMessage: (message: ToolMessage) => void
  onToolUse: (toolUse: ToolUseBlock) => void
  onToolResult: (result: ToolResultBlock) => void
  onProgress: (progress: ToolProgressData) => void
  onPermissionRequest: (request: PermissionRequest) => Promise<PermissionResponse>
  onComplete: () => void
  onError: (error: Error) => void
}

export type PermissionRequest = {
  toolName: string
  toolUseId: string
  input: Record<string, unknown>
  description: string
  isDestructive: boolean
}

export type PermissionResponse = {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
}

export type AgenticTurnResult = {
  messages: ToolMessage[]
  totalTurns: number
  isComplete: boolean
  stopReason: 'end_turn' | 'max_turns' | 'error' | 'cancelled'
}
