/** 临时枚举工具清单，决策延迟加载分级。用后删除。 */
import fs from 'node:fs'
import { describe, it } from 'vitest'

describe('audit: 工具清单', () => {
  it('枚举', async () => {
    const { toolRegistry } = await import('../tools/registry')
    const rows = toolRegistry.getAll().map((t) => ({
      name: t.name,
      size: JSON.stringify({ d: t.description, s: t.inputSchema }).length,
      defer: t.shouldDefer === true,
      always: t.alwaysLoad === true,
      hint: (t.searchHint ?? '').slice(0, 40),
    }))
    rows.sort((a, b) => b.size - a.size)
    const lines = rows.map(
      (r) => `${r.name}\t${r.size}\t${r.defer ? 'DEFER' : ''}\t${r.always ? 'ALWAYS' : ''}\t${r.hint}`,
    )
    fs.writeFileSync('tools-out.txt', lines.join('\n'), 'utf8')
  })
})
