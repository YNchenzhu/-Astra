import { describe, it, expect } from 'vitest'
import { emitHookLifecycle, onHookLifecycle } from './hookLifecycleEvents'

describe('hookLifecycleEvents', () => {
  it('notifies subscribers without throwing on subscriber errors', () => {
    const seen: string[] = []
    const off1 = onHookLifecycle((p) => {
      seen.push(`${p.phase}:${p.event}:${p.source}`)
    })
    const off2 = onHookLifecycle(() => {
      throw new Error('subscriber boom')
    })

    emitHookLifecycle({
      phase: 'before',
      event: 'Setup',
      toolName: 'app',
      source: 'config',
    })

    off1()
    off2()

    expect(seen).toEqual(['before:Setup:config'])
  })
})
