/**
 * Web Search Tool
 *
 * Searches the web using Brave, Baidu AI Search, or DuckDuckGo.
 * Delegates to the main process via `window.electronAPI.tools.webSearch()`
 * which routes through the configured search engine with API key resolution.
 */

import type { ITool, ToolInputSchema } from '../types/tool'

export class WebSearchTool implements ITool {
  name = 'web_search'
  description = 'Search the web for information using Brave, Baidu, or DuckDuckGo'

  inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query',
      },
      limit: {
        type: 'number',
        description: 'Number of results to return (default: 10, max: 20)',
      },
      engine: {
        type: 'string',
        description: 'Search engine: "auto" (default), "brave", "baidu", or "ddg"',
        enum: ['auto', 'brave', 'baidu', 'ddg'],
      },
    },
    required: ['query'],
  }

  async execute(input: Record<string, unknown>): Promise<string> {
    const query = (input.query as string)?.trim()
    if (!query) {
      throw new Error('Query is required')
    }

    const limit = Math.min(20, Math.max(1, (input.limit as number) || 10))
    const engine = (input.engine as string) || undefined

    const api = typeof window !== 'undefined' ? window.electronAPI : null
    if (!api?.tools?.webSearch) {
      return (
        `Web search is not available in this environment.\n\n` +
        `To enable web search, configure a search API key in Settings → Tools:\n` +
        `- Brave Search: https://brave.com/search/api/\n` +
        `- Baidu AI Search: https://cloud.baidu.com/\n` +
        `- DuckDuckGo: available without an API key (best-effort, no key required)`
      )
    }

    try {
      const result = await api.tools.webSearch(query, {
        maxResults: limit,
        engine: engine as 'auto' | 'brave' | 'baidu' | 'ddg' | undefined,
      })

      if (result.success && result.output) {
        return result.output
      }

      if (!result.success && result.error) {
        return `Web search error: ${result.error}`
      }

      return `No results found for "${query}".`
    } catch (error) {
      if (error instanceof Error) {
        return `Web search failed: ${error.message}`
      }
      return `Web search failed: ${String(error)}`
    }
  }
}

export function createWebSearchTool(): WebSearchTool {
  return new WebSearchTool()
}
