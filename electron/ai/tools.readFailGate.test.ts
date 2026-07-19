/**
 * Regression tests for the consecutive-read-failure gate in `toolReadFile`.
 *
 * Background:
 *   The gate counts back-to-back path-not-found read failures and blocks
 *   further reads after 2 in a row, forcing the model to discover via
 *   glob/list_files. The counter is intentionally module-global to match
 *   the rest of the tool execution context (workspace path, hooks, etc.).
 *
 * The bug these tests pin:
 *   `resetReadFailCounter` was exported but never called — meaning a
 *   failed-read streak in conversation A would carry over and falsely
 *   block conversation B's very first read. The fix wires the reset into
 *   `handleSendMessage` at every user-turn boundary; this file pins the
 *   pure-function semantics that hookup relies on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  toolReadFile,
  resetReadFailCounter,
  noteSuccessfulDiscovery,
} from './toolReadFile'
import { setWorkspacePath } from '../tools/workspaceState'
import { clearAllReadFileState } from '../tools/readFileState'

describe('toolReadFile: consecutive-read-failure gate', () => {
  let tmp: string

  beforeEach(() => {
    clearAllReadFileState()
    resetReadFailCounter()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-readfail-'))
    setWorkspacePath(tmp)
  })

  afterEach(() => {
    setWorkspacePath(null)
    resetReadFailCounter()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('blocks the third consecutive missing-path read', async () => {
    const r1 = await toolReadFile(path.join(tmp, 'ghost-a.ts'))
    expect(r1.success).toBe(false)
    expect(r1.error).not.toMatch(/BLOCKED/)

    const r2 = await toolReadFile(path.join(tmp, 'ghost-b.ts'))
    expect(r2.success).toBe(false)
    expect(r2.error).toMatch(/BLOCKED/)

    const r3 = await toolReadFile(path.join(tmp, 'ghost-c.ts'))
    expect(r3.success).toBe(false)
    expect(r3.error).toMatch(/BLOCKED/)
  })

  it('resetReadFailCounter clears the streak — the next missing read is no longer BLOCKED', async () => {
    await toolReadFile(path.join(tmp, 'ghost-a.ts'))
    await toolReadFile(path.join(tmp, 'ghost-b.ts')) // gate now armed

    resetReadFailCounter()

    const r = await toolReadFile(path.join(tmp, 'ghost-c.ts'))
    expect(r.success).toBe(false)
    expect(r.error).not.toMatch(/BLOCKED/)
  })

  it('noteSuccessfulDiscovery clears the streak (mirrors glob/list_files success path)', async () => {
    await toolReadFile(path.join(tmp, 'ghost-a.ts'))
    await toolReadFile(path.join(tmp, 'ghost-b.ts'))

    noteSuccessfulDiscovery()

    const r = await toolReadFile(path.join(tmp, 'ghost-c.ts'))
    expect(r.success).toBe(false)
    expect(r.error).not.toMatch(/BLOCKED/)
  })

  it('a successful read auto-clears the streak', async () => {
    await toolReadFile(path.join(tmp, 'ghost-a.ts')) // failure 1

    const real = path.join(tmp, 'real.txt')
    fs.writeFileSync(real, 'hello\n', 'utf-8')
    const ok = await toolReadFile(real)
    expect(ok.success).toBe(true)

    // After the success, two more failures should be allowed before the
    // gate trips again — proving the success reset to 0, not just to 1.
    const r1 = await toolReadFile(path.join(tmp, 'ghost-b.ts'))
    expect(r1.error).not.toMatch(/BLOCKED/)
    const r2 = await toolReadFile(path.join(tmp, 'ghost-c.ts'))
    expect(r2.error).toMatch(/BLOCKED/)
  })
})
