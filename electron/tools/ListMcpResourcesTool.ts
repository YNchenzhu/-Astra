/**
 * ListMcpResourcesTool — Lists resources exposed by connected MCP servers.
 *
 * Uses MCPClientManager.listResources() which checks server capabilities
 * and sends the "resources/list" request only to servers that support it.
 */

import type { Tool } from './types'
import type { MCPClientManager } from '../mcp/client'
import { buildTool } from './buildTool'
import { listMcpResourcesInputZod } from './toolInputZod'
import { validateNoOp } from './toolValidateCommon'
import { sanitizeUntrustedText } from '../security/sanitizeUntrustedText'

export function createListMcpResourcesTool(clientManager: MCPClientManager): Tool {
  return buildTool({
    name: 'ListMcpResourcesTool',
    zInputSchema: listMcpResourcesInputZod,
    description:
      'List resources from connected MCP servers. Resources are data sources ' +
      'exposed by MCP servers (files, database records, API responses, etc.). ' +
      'Use the "server" parameter to filter by a specific server.',
    inputSchema: [
      {
        name: 'server',
        type: 'string',
        description: 'Optional server name to filter resources by',
        required: false,
      },
    ],
    isReadOnly: true,
    isConcurrencySafe: true,
    searchHint: 'mcp resources list servers',
    validateInput: validateNoOp,
    async call({ server }) {
      try {
        const connected = clientManager
          .listServers()
          .filter((s) => s.connected)
          .map((s) => s.name)
        const targets =
          typeof server === 'string' && server.trim().length > 0
            ? [server.trim()]
            : connected

        if (targets.length === 0) {
          return {
            success: true,
            output:
              'No connected MCP servers. Connect a server first, or pass "server" to target one by name.',
          }
        }

        type Row = {
          uri: string
          name: string
          description?: string
          mimeType?: string
          server: string
        }
        const resources: Row[] = []
        for (const srv of targets) {
          try {
            const batch = await clientManager.listResourcesForServer(srv)
            for (const r of batch) {
              resources.push({ ...r, server: srv })
            }
          } catch {
            // Skip servers that error (e.g. filter typo); still return others
          }
        }

        if (resources.length === 0) {
          return {
            success: true,
            output:
              'No resources found. MCP servers may still provide tools even if they have no resources.',
          }
        }

        // Server-supplied `name` / `uri` / `description` fields are untrusted
        // text that becomes part of the LLM-visible output. Strip invisible
        // Unicode prompt-injection payloads before rendering each row.
        // See `electron/security/sanitizeUntrustedText.ts` for threat model.
        const sanitize = (s: string | undefined): string =>
          typeof s === 'string' && s.length > 0 ? sanitizeUntrustedText(s).cleaned : (s ?? '')
        const formatted = resources
          .map(
            (r) =>
              `- ${sanitize(r.name) || sanitize(r.uri)}${r.uri ? ` <${sanitize(r.uri)}>` : ''}` +
              (r.mimeType ? ` [${sanitize(r.mimeType)}]` : '') +
              (r.description ? ` — ${sanitize(r.description)}` : '') +
              ` (server: ${r.server})`,
          )
          .join('\n')

        return {
          success: true,
          output: `Found ${resources.length} resource(s):\n${formatted}`,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, error: `Failed to list MCP resources: ${message}` }
      }
    },
  })
}
