/**
 * ReadMcpResourceTool — Reads a specific MCP resource by URI.
 *
 * Uses MCPClientManager.readResourceForServer (resources/read). Text inline;
 * binary saved under {@link getTempDir} and path returned.
 */

import path from 'node:path'
import { app } from 'electron'
import type { Tool } from './types'
import type { MCPClientManager } from '../mcp/client'
import { buildTool } from './buildTool'
import { readMcpResourceInputZod } from './toolInputZod'
import { validateRequiredStringFields } from './toolValidateCommon'
import { sanitizeUntrustedText, summarizeFindings } from '../security/sanitizeUntrustedText'

export type ReadMcpResourceToolOptions = {
  /** Directory for binary blobs (must be writable). Default: app temp + astra-mcp-resources */
  getTempDir?: () => string
}

export function createReadMcpResourceTool(
  clientManager: MCPClientManager,
  options?: ReadMcpResourceToolOptions,
): Tool {
  const getTempDir =
    options?.getTempDir ??
    (() => path.join(app.getPath('temp'), 'astra-mcp-resources'))

  return buildTool({
    name: 'ReadMcpResourceTool',
    zInputSchema: readMcpResourceInputZod,
    description:
      'Read a specific MCP resource by URI from a CONNECTED MCP server. ' +
      'Use this ONLY for resources exposed by an MCP server (listed via ' +
      'ListMcpResourcesTool). **Do NOT use this to read local files** — ' +
      'for `file://` paths or workspace files use the Read tool instead. ' +
      'Required params: `server` (MCP server name, e.g. the name shown in ' +
      'ListMcpResourcesTool output) AND `uri` (the exact resource URI). ' +
      'Returns text inline, binary to a temp file whose path is returned.',
    inputSchema: [
      {
        name: 'server',
        type: 'string',
        description: 'The MCP server name to read the resource from',
        required: true,
      },
      {
        name: 'uri',
        type: 'string',
        description: 'The URI of the resource to read',
        required: true,
      },
    ],
    isReadOnly: true,
    isConcurrencySafe: true,
    searchHint: 'mcp resource uri read fetch',
    validateInput: validateRequiredStringFields('server', 'uri'),
    async call({ server, uri }) {
      if (!server) {
        return {
          success: false,
          error:
            'Parameter "server" is required. ReadMcpResourceTool reads from a CONNECTED MCP server, ' +
            'not arbitrary URIs. If you meant to read a local file, use the Read tool instead. ' +
            'Use ListMcpResourcesTool to see which MCP servers have resources.',
        }
      }
      if (!uri) {
        return { success: false, error: 'Parameter "uri" is required.' }
      }

      // Defense-in-depth: a `file://` URI or a Windows drive path almost
      // certainly means the model confused this tool with the file Read tool.
      // Surface the right tool instead of silently failing inside the MCP client.
      //
      // Audit Bug A10: the previous check also rejected anything starting
      // with `/`, which blocks legitimate non-file schemes like
      // `custom:/path` AND bare path-like resource URIs some MCP servers
      // expose (e.g. `/workspace/abc`). Narrow the guard to forms that are
      // unambiguously local filesystem references.
      const looksLikeLocalFile =
        /^file:\/\//i.test(uri) ||
        /^[A-Za-z]:[\\/]/.test(uri) ||
        // POSIX-absolute AND no scheme — only reject when there's no `:`
        // suggesting a URI scheme earlier in the string.
        (uri.startsWith('/') && !uri.includes(':'))
      if (looksLikeLocalFile) {
        return {
          success: false,
          error:
            `ReadMcpResourceTool does not read local files. The URI "${uri}" looks like a local path — use the Read tool with filePath="${
              uri.replace(/^file:\/\//i, '')
            }" instead.`,
        }
      }

      try {
        const rows = await clientManager.readResourceForServer(server, uri, getTempDir())

        if (!rows.length) {
          return { success: true, output: 'Resource returned no content.' }
        }

        const parts = rows.map((c: { uri?: string; mimeType?: string; text?: string; blobSavedTo?: string }) => {
          let text = `Resource: ${c.uri}`
          if (c.mimeType) text += ` (${c.mimeType})`
          text += '\n'
          if (c.text) text += c.text
          if (c.blobSavedTo) text += `[Binary content saved to: ${c.blobSavedTo}]`
          return text
        })

        // Same defense-in-depth as `mcp/registry.ts:execute` —
        // MCP resource content is untrusted server output that goes
        // straight into the LLM's tool_result stream. Strip invisible
        // Unicode prompt-injection payloads (Tag chars, Bidi, ZW, BOM)
        // before passing along. See `electron/security/sanitizeUntrustedText.ts`.
        const flattenedRaw = parts.join('\n---\n')
        const sanitized = sanitizeUntrustedText(flattenedRaw)
        if (sanitized.findings.length > 0) {
          console.warn(
            `[mcp] Stripped ${sanitized.totalStripped} invisible Unicode char(s) from "${server}" resource "${uri}": ${summarizeFindings(sanitized.findings)}`,
          )
        }
        return { success: true, output: sanitized.cleaned }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, error: `Failed to read MCP resource: ${message}` }
      }
    },
  })
}
