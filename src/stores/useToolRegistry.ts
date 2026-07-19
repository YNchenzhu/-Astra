import { create } from 'zustand'
import type {
  Tool,
  Tools,
  ToolMessage,
  ToolUseBlock,
  ToolResultBlock,
  ToolProgressData,
  AgenticLoopState,
  AgenticLoopConfig,
  PermissionRequest,
  AgenticTurnResult,
} from '../types/tool'
import { findToolByName } from '../types/tool'

// ============================================================================
// Tool Registry Store
// ============================================================================

interface ToolRegistryState {
  tools: Tool[]
  enabledTools: Set<string>
  isLoaded: boolean

  registerTool: (tool: Tool) => void
  registerTools: (tools: Tool[]) => void
  unregisterTool: (name: string) => void
  enableTool: (name: string) => void
  disableTool: (name: string) => void
  toggleTool: (name: string) => void
  getEnabledTools: () => Tools
  findTool: (name: string) => Tool | undefined
  setLoaded: (loaded: boolean) => void
}

export const useToolRegistry = create<ToolRegistryState>((set, get) => ({
  tools: [],
  enabledTools: new Set<string>(),
  isLoaded: false,

  registerTool: (tool) =>
    set((s) => ({
      tools: [...s.tools.filter((t) => t.name !== tool.name), tool],
      enabledTools: new Set([...s.enabledTools, tool.name]),
    })),

  registerTools: (newTools) =>
    set((s) => {
      const existingNames = new Set(s.tools.map((t) => t.name))
      const unique = newTools.filter((t) => !existingNames.has(t.name))
      const merged = [...s.tools, ...unique]
      return {
        tools: merged,
        enabledTools: new Set([...s.enabledTools, ...unique.map((t) => t.name)]),
      }
    }),

  unregisterTool: (name) =>
    set((s) => ({
      tools: s.tools.filter((t) => t.name !== name),
      enabledTools: (() => {
        const next = new Set(s.enabledTools)
        next.delete(name)
        return next
      })(),
    })),

  enableTool: (name) =>
    set((s) => ({
      enabledTools: new Set([...s.enabledTools, name]),
    })),

  disableTool: (name) =>
    set((s) => {
      const next = new Set(s.enabledTools)
      next.delete(name)
      return { enabledTools: next }
    }),

  toggleTool: (name) =>
    set((s) => {
      const next = new Set(s.enabledTools)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return { enabledTools: next }
    }),

  getEnabledTools: () => {
    const { tools, enabledTools } = get()
    return tools.filter((t) => enabledTools.has(t.name) && t.isEnabled())
  },

  findTool: (name) => findToolByName(get().tools, name),

  setLoaded: (loaded) => set({ isLoaded: loaded }),
}))

// ============================================================================
// Agentic Loop Store
// ============================================================================

interface AgenticLoopMessage {
  role: 'user' | 'assistant' | 'tool_result'
  content: string
  toolUses?: ToolUseBlock[]
  toolUseId?: string
  isError?: boolean
  timestamp: number
}

/**
 * Project an `AgenticLoopMessage` (has `timestamp`, `toolUseId` string)
 * onto the stricter `ToolMessage` discriminated union consumed by
 * `ToolUseContext.messages` / the `config.onMessage` callback. Used to
 * replace scattered `as any` casts where the types only differed in the
 * presence of `timestamp` and slightly different optional fields.
 */
function toToolMessage(m: AgenticLoopMessage): ToolMessage {
  if (m.role === 'user') {
    return { role: 'user', content: m.content }
  }
  if (m.role === 'assistant') {
    return { role: 'assistant', content: m.content, toolUses: m.toolUses }
  }
  return {
    role: 'tool_result',
    content: m.content,
    toolUseId: m.toolUseId ?? '',
    isError: m.isError,
  }
}

interface AgenticLoopStateData {
  state: AgenticLoopState
  messages: AgenticLoopMessage[]
  currentToolUses: ToolUseBlock[]
  toolResults: ToolResultBlock[]
  activeProgress: ToolProgressData | null
  turnCount: number
  maxTurns: number
  error: string | null
  pendingPermission: PermissionRequest | null

  setState: (state: AgenticLoopState) => void
  addMessage: (message: AgenticLoopMessage) => void
  setMessages: (messages: AgenticLoopMessage[]) => void
  setCurrentToolUses: (toolUses: ToolUseBlock[]) => void
  addToolResult: (result: ToolResultBlock) => void
  setActiveProgress: (progress: ToolProgressData | null) => void
  incrementTurn: () => void
  setError: (error: string | null) => void
  setPendingPermission: (request: PermissionRequest | null) => void
  reset: () => void
  runAgenticLoop: (config: AgenticLoopConfig) => Promise<AgenticTurnResult>
}

const INITIAL_LOOP_STATE: Omit<AgenticLoopStateData, 'setState' | 'addMessage' | 'setMessages' | 'setCurrentToolUses' | 'addToolResult' | 'setActiveProgress' | 'incrementTurn' | 'setError' | 'setPendingPermission' | 'reset' | 'runAgenticLoop'> = {
  state: 'idle',
  messages: [],
  currentToolUses: [],
  toolResults: [],
  activeProgress: null,
  turnCount: 0,
  maxTurns: 20,
  error: null,
  pendingPermission: null,
}

export const useAgenticLoop = create<AgenticLoopStateData>((set, get) => ({
  ...INITIAL_LOOP_STATE,

  setState: (state) => set({ state }),

  addMessage: (message) =>
    set((s) => ({ messages: [...s.messages, message] })),

  setMessages: (messages) => set({ messages }),

  setCurrentToolUses: (toolUses) => set({ currentToolUses: toolUses }),

  addToolResult: (result) =>
    set((s) => ({ toolResults: [...s.toolResults, result] })),

  setActiveProgress: (progress) => set({ activeProgress: progress }),

  incrementTurn: () =>
    set((s) => ({ turnCount: s.turnCount + 1 })),

  setError: (error) => set({ error, state: error ? 'error' : 'idle' }),

  setPendingPermission: (request) =>
    set({ pendingPermission: request, state: request ? 'waiting_permission' : 'idle' }),

  reset: () => set(INITIAL_LOOP_STATE),

  runAgenticLoop: async (config): Promise<AgenticTurnResult> => {
    const { findTool } = useToolRegistry.getState()
    const maxTurns = config.maxTurns || get().maxTurns

    set({
      state: 'running',
      turnCount: 0,
      error: null,
    })

    let turn = 0
    const messages: AgenticLoopMessage[] = []

    try {
      while (turn < maxTurns && !config.abortController.signal.aborted) {
        turn++
        set({ turnCount: turn })

        // The actual API call would happen here via the Electron main process
        // For now, this is the structural loop that the backend will plug into
        const lastAssistantMsg = messages[messages.length - 1]
        if (lastAssistantMsg?.role === 'assistant') {
          const toolUses = lastAssistantMsg.toolUses
          if (!toolUses || toolUses.length === 0) {
            return {
              messages: messages.map(toToolMessage),
              totalTurns: turn,
              isComplete: true,
              stopReason: 'end_turn',
            }
          }

          set({ currentToolUses: toolUses })

          // Process each tool use
          for (const toolUse of toolUses) {
            if (config.abortController.signal.aborted) {
              return {
                messages: messages.map(toToolMessage),
                totalTurns: turn,
                isComplete: false,
                stopReason: 'cancelled',
              }
            }

            const tool = findTool(toolUse.name)
            if (!tool) {
              const errorMsg: AgenticLoopMessage = {
                role: 'tool_result',
                content: `Unknown tool: ${toolUse.name}`,
                toolUseId: toolUse.id,
                isError: true,
                timestamp: Date.now(),
              }
              messages.push(errorMsg)
              config.onMessage(toToolMessage(errorMsg))
              continue
            }

            // `Tool` is the union `ReturnType<typeof buildTool>` whose
            // methods expect `z.infer<SpecificInput>`. We only know the
            // tool at runtime, so thread concrete values through `unknown`
            // at the one dispatch boundary and keep everything else typed.
            type ToolContext = Parameters<typeof tool.checkPermissions>[1]
            const toolContext = {
              messages: messages.map(toToolMessage),
              abortController: config.abortController,
              permissionMode: 'default',
            } as unknown as ToolContext

            type ToolInput = Parameters<typeof tool.checkPermissions>[0]
            const toolInput = toolUse.input as unknown as ToolInput

            const permResult = await tool.checkPermissions(toolInput, toolContext)

            if (permResult.behavior === 'deny') {
              const errorMsg: AgenticLoopMessage = {
                role: 'tool_result',
                content: `Permission denied: ${permResult.message}`,
                toolUseId: toolUse.id,
                isError: true,
                timestamp: Date.now(),
              }
              messages.push(errorMsg)
              config.onMessage(toToolMessage(errorMsg))
              continue
            }

            if (permResult.behavior === 'ask') {
              const permissionRequest: PermissionRequest = {
                toolName: toolUse.name,
                toolUseId: toolUse.id,
                input: toolUse.input,
                description: permResult.message,
                // `BuiltTool`'s default isDestructive is a 0-arg thunk;
                // overrides take 1 arg. Cast to unknown then a loose
                // function type so both shapes call-check.
                isDestructive: tool.isDestructive
                  ? (tool.isDestructive as unknown as (input?: unknown) => boolean)(toolUse.input)
                  : false,
              }
              set({ pendingPermission: permissionRequest, state: 'waiting_permission' })

              const permResponse = await config.onPermissionRequest(permissionRequest)
              set({ pendingPermission: null, state: 'running' })

              if (permResponse.behavior === 'deny') {
                const deniedMsg: AgenticLoopMessage = {
                  role: 'tool_result',
                  content: 'User denied permission',
                  toolUseId: toolUse.id,
                  isError: true,
                  timestamp: Date.now(),
                }
                messages.push(deniedMsg)
                config.onMessage(toToolMessage(deniedMsg))
                continue
              }
            }

            // Execute tool
            config.onToolUse(toolUse)

            try {
              // After the deny-branch above, `permResult.behavior` is
              // `'allow' | 'ask'`; both variants carry optional
              // `updatedInput`. No cast needed — the narrowing sticks.
              const input = (permResult.updatedInput ?? toolUse.input) as unknown as ToolInput
              const result = await tool.call(
                input,
                toolContext,
                (progress) => config.onProgress(progress.data),
              )

              const resultMsg: AgenticLoopMessage = {
                role: 'tool_result',
                content: typeof result.data === 'string' ? result.data : JSON.stringify(result.data),
                toolUseId: toolUse.id,
                isError: false,
                timestamp: Date.now(),
              }
              messages.push(resultMsg)

              const resultBlock: ToolResultBlock = {
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: resultMsg.content,
              }
              config.onToolResult(resultBlock)
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err)
              const errorMsg: AgenticLoopMessage = {
                role: 'tool_result',
                content: `Tool error: ${message}`,
                toolUseId: toolUse.id,
                isError: true,
                timestamp: Date.now(),
              }
              messages.push(errorMsg)

              const resultBlock: ToolResultBlock = {
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: errorMsg.content,
                is_error: true,
              }
              config.onToolResult(resultBlock)
            }
          }

          set({ currentToolUses: [] })
        }

        // If no messages were added this turn, we're done
        // (In production, the API call would go here)
        break
      }

      config.onComplete()
      return {
        messages: messages.map(toToolMessage),
        totalTurns: turn,
        isComplete: turn < maxTurns,
        stopReason: turn >= maxTurns ? 'max_turns' : 'end_turn',
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      set({ error: error.message, state: 'error' })
      config.onError(error)
      return {
        messages: messages.map(toToolMessage),
        totalTurns: turn,
        isComplete: false,
        stopReason: 'error',
      }
    }
  },
}))
