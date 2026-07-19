import type { ChildProcess } from 'node:child_process'
import { describe, it, expect, vi } from 'vitest'

import { killProcessTree } from './killProcessTree'

describe('killProcessTree', () => {
  it('is a no-op when the child has no pid', () => {
    const kill = vi.fn()
    const child = { pid: undefined, kill } as unknown as ChildProcess
    expect(() => killProcessTree(child)).not.toThrow()
    expect(kill).not.toHaveBeenCalled()
  })

  it('terminates the child when a pid is present', () => {
    const kill = vi.fn()
    // A pid that almost certainly does not exist — on Windows `taskkill`
    // fails fast, on POSIX `child.kill('SIGTERM')` is still invoked.
    const child = {
      pid: 2147483646,
      kill,
      exitCode: null,
      signalCode: null,
    } as unknown as ChildProcess
    killProcessTree(child)
    expect(kill).toHaveBeenCalled()
  })
})
