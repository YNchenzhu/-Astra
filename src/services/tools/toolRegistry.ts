/**
 * Tool Registry
 *
 * Central registry for all available tools.
 */

import type { ITool, ToolRegistry } from '../../types/tool'

class ToolRegistryImpl {
  private tools: Map<string, ITool> = new Map()
  private definitions: ToolRegistry = {}

  register(tool: ITool): void {
    this.tools.set(tool.name, tool)
    this.definitions[tool.name] = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }
  }

  unregister(toolName: string): void {
    this.tools.delete(toolName)
    delete this.definitions[toolName]
  }

  get(toolName: string): ITool | undefined {
    return this.tools.get(toolName)
  }

  getAll(): ITool[] {
    return Array.from(this.tools.values())
  }

  getDefinitions(): ToolRegistry {
    return { ...this.definitions }
  }

  has(toolName: string): boolean {
    return this.tools.has(toolName)
  }
}

export const toolRegistry = new ToolRegistryImpl()
