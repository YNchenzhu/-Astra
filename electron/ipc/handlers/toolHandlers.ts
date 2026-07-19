/**
 * Tool-registry IPC handlers exposed directly to the renderer UI.
 *
 *   - `tool:list`        list all registered tools + model-facing definitions
 *   - `tool:execute-ui`  renderer-initiated tool execution (allowlisted)
 *
 * `tool:execute-ui` does NOT go through the agentic loop's PreToolUse hooks
 * / PermissionManager, so it's strictly limited to read-only / low-risk
 * tools. Destructive tools (`bash`, `write_file`, `edit_file`, …) must be
 * triggered by the model through the audited agent flow, never by direct
 * IPC from the UI. This fixes the "renderer can bypass agent gates" gap
 * documented in `electron/tools/fileMutationGuard.ts`.
 */
import type { IpcMain } from 'electron'
import { toolRegistry } from '../../tools/registry'
import { getToolDefinitions } from '../../tools/schema'

const UI_EXECUTABLE_TOOLS = new Set<string>([
  'read_file',
  'Read',
  'list_files',
  'LS',
  'glob',
  'Glob',
  'grep',
  'Grep',
  'web_search',
  'WebSearch',
  'web_fetch',
  'WebFetch',
])

export function registerToolIpcHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('tool:list', () => {
    return {
      tools: toolRegistry.list(),
      definitions: getToolDefinitions(),
    }
  })

  ipcMain.handle('tool:execute-ui', async (_event, toolName: string, input: Record<string, unknown>) => {
    if (!UI_EXECUTABLE_TOOLS.has(toolName)) {
      return {
        success: false,
        error: `Tool "${toolName}" cannot be invoked directly from the UI. Route it through the agent instead.`,
      }
    }
    return toolRegistry.execute(toolName, input)
  })
}
