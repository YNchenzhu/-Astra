/**
 * Regression: models trained on the upstream BashTool convention pass
 * `description` (and sometimes `timeout` / `dangerouslyDisableSandbox`)
 * alongside `command`. Previously our `bashInputZod` was `.strict()` and
 * rejected these with:
 *
 *   InputValidationError (bash): (root): Unrecognized key: "description"
 *
 * The schema now accepts them as optional ignored fields.
 */

import { describe, expect, it } from 'vitest'
import { bashInputZod, powerShellInputZod } from './toolInputZod'

describe('bashInputZod — Claude Code description convention', () => {
  it('accepts `description` alongside `command`', () => {
    const r = bashInputZod.safeParse({
      command: 'ls -la',
      description: 'List files in current directory',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.command).toBe('ls -la')
      expect(r.data.description).toBe('List files in current directory')
    }
  })

  it('accepts `timeout` (ms) as an alias for `timeoutMs`', () => {
    const r = bashInputZod.safeParse({ command: 'sleep 1', timeout: 30_000 })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.timeoutMs).toBe(30_000)
    }
  })

  it('accepts `dangerouslyDisableSandbox` (ignored)', () => {
    const r = bashInputZod.safeParse({
      command: 'echo hi',
      dangerouslyDisableSandbox: true,
    })
    expect(r.success).toBe(true)
  })

  it('still rejects truly unknown keys (strict mode preserved)', () => {
    const r = bashInputZod.safeParse({ command: 'echo hi', wat: 1 })
    expect(r.success).toBe(false)
  })
})

describe('powerShellInputZod — same compat', () => {
  it('accepts `description`', () => {
    const r = powerShellInputZod.safeParse({
      command: 'Get-Process',
      description: 'List running processes',
    })
    expect(r.success).toBe(true)
  })

  it('still rejects truly unknown keys', () => {
    const r = powerShellInputZod.safeParse({ command: 'Get-Process', wat: 1 })
    expect(r.success).toBe(false)
  })
})
