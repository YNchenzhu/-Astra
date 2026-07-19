import { scanMemdir } from '../memory/service'
import { buildTool } from './buildTool'
import { validateNoOp } from './toolValidateCommon'
import { memdirScanInputZod } from './toolInputZod'

export const memdirScanTool = buildTool({
  name: 'MemdirScan',
  description:
    'Scan extra workspace memory dirs (memory/, .claude/memories/, .cursor/memory/) and return entries; in-app project memories are kept in .claude/memory. User-scoped memories are stored in the install bundle (see settings).',
  inputSchema: [
    { name: 'maxResults', type: 'number', description: 'Maximum entries to return (default 20)' },
  ],
  isReadOnly: true,
  isConcurrencySafe: true,
  // 2026-05 — was `shouldDefer: true` under upstream's "defer non-core read
  // tools" rule. The token savings (~50) didn't justify the UX cost: AI
  // test scenarios and any "list / try all tools" workflow hit the
  // ToolSearch gate. Schema is a single optional `maxResults` parameter,
  // so we expose it in the default tool list instead. MCP tools and the
  // heavyweight LSP tool keep deferred discovery (real schema-size wins).
  searchHint: 'memory MEMORY.md scan workspace memories',
  zInputSchema: memdirScanInputZod,
  validateInput: validateNoOp,
  async call({ maxResults }) {
    const limit = typeof maxResults === 'number' ? Math.max(1, Math.min(200, maxResults)) : 20

    const entries = scanMemdir().slice(0, limit)
    if (entries.length === 0) {
      return {
        success: true,
        output: 'No memdir entries found in current workspace.',
      }
    }

    const lines = entries.map((m) => {
      const source = m.sourcePath ? ` (${m.sourcePath})` : ''
      return `- ${m.name} [${m.type}] — ${m.description}${source}`
    })

    return {
      success: true,
      output: `Memdir scan results (${entries.length}):\n${lines.join('\n')}`,
    }
  },
})
