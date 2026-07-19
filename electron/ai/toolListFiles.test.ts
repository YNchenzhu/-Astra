/**
 * list_files — anti-guessing behaviour: did-you-mean, parent-dir auto-listing, and
 * consecutive-failure hard block. Mirrors the regression report where the AI called
 * `list_files <project>/src/agent` and got "directory not found" without enough info to
 * self-correct (the real path was `<project>/src/agents`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toolListFiles } from './toolListFiles'
import { setWorkspacePath } from '../tools/workspaceState'
import { resetReadFailCounter } from './toolReadFile'

describe('toolListFiles — anti-guessing', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-list-'))
    setWorkspacePath(dir)
    resetReadFailCounter()
  })
  afterEach(() => {
    setWorkspacePath(null)
    fs.rmSync(dir, { recursive: true, force: true })
    resetReadFailCounter()
  })

  it('suggests the closest existing sibling on a typo (the "agent vs agents" regression)', () => {
    fs.mkdirSync(path.join(dir, 'src', 'agents', 'sub'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'src', 'tools'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'src', 'utils'), { recursive: true })

    const r = toolListFiles('src/agent')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/directory not found/)
    expect(r.error).toMatch(/Did you mean "src\/agents\/"/)
    // And the parent's full subdir listing is included so the AI sees the alternatives.
    expect(r.error).toMatch(/Subdirectories that DO exist under "src\/"/)
    expect(r.error).toContain('src/agents/')
    expect(r.error).toContain('src/tools/')
    expect(r.error).toContain('src/utils/')
  })

  it('lists the parent directory contents when no close match exists', () => {
    fs.mkdirSync(path.join(dir, 'pkg', 'foo'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'pkg', 'bar'), { recursive: true })

    const r = toolListFiles('pkg/totally-unrelated-name')
    expect(r.success).toBe(false)
    // No "Did you mean" — nothing close enough.
    expect(r.error).not.toMatch(/Did you mean/)
    // But the AI still sees what's actually there.
    expect(r.error).toMatch(/Subdirectories that DO exist under "pkg\/"/)
    expect(r.error).toContain('pkg/foo/')
    expect(r.error).toContain('pkg/bar/')
  })

  it('walks up multiple levels to find the deepest existing parent', () => {
    fs.mkdirSync(path.join(dir, 'a', 'b', 'c', 'leaf'), { recursive: true })

    const r = toolListFiles('a/b/c/d/e/f')
    expect(r.success).toBe(false)
    // The deepest existing ancestor is `a/b/c/`, and it has `leaf/` inside.
    expect(r.error).toMatch(/under "a\/b\/c\/"/)
    expect(r.error).toContain('a/b/c/leaf/')
  })

  it('reports "no subdirectories" when the deepest existing parent is empty', () => {
    fs.mkdirSync(path.join(dir, 'empty-leaf'), { recursive: true })

    const r = toolListFiles('empty-leaf/missing/deep')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/deepest existing ancestor "empty-leaf\/" has no subdirectories/)
  })

  it('hard-blocks after 2 consecutive failed list_files calls', () => {
    fs.mkdirSync(path.join(dir, 'real-dir'), { recursive: true })

    const r1 = toolListFiles('ghost-1')
    expect(r1.success).toBe(false)
    expect(r1.error).not.toMatch(/BLOCKED/)

    const r2 = toolListFiles('ghost-2')
    expect(r2.success).toBe(false)
    expect(r2.error).toMatch(/list_files BLOCKED/)
    expect(r2.error).toMatch(/STOP guessing/)
    expect(r2.error).toMatch(/Use glob/)
  })

  it('a successful list_files call resets the consecutive-failure counter', () => {
    fs.mkdirSync(path.join(dir, 'real-dir'), { recursive: true })

    const r1 = toolListFiles('ghost-1')
    expect(r1.success).toBe(false)
    // Successful call resets the counter (cross-tool tracker).
    const r2 = toolListFiles('real-dir')
    expect(r2.success).toBe(true)
    // Now another miss should NOT be hard-blocked yet.
    const r3 = toolListFiles('ghost-2')
    expect(r3.success).toBe(false)
    expect(r3.error).not.toMatch(/BLOCKED/)
  })

  // Case-insensitive directory name matching is filesystem-dependent: Windows / macOS
  // case-insensitive volumes will resolve `src/Agents` directly to `src/agents` so
  // `list_files` succeeds before our did-you-mean logic runs. Linux / case-sensitive
  // mounts trip the fuzzy path. We don't test the success branch; the next test below
  // covers the typo case which is what the user actually hits.

  it('matches edit-distance ≤ 2 (e.g. "agetns" → "agents")', () => {
    fs.mkdirSync(path.join(dir, 'src', 'agents'), { recursive: true })
    const r = toolListFiles('src/agetns')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Did you mean "src\/agents\/"/)
  })
})
