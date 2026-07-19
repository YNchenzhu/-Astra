/**
 * Regression test for the worktree isolation defect: EnterWorktree must
 * redirect the GLOBAL workspace path into the worktree (so file tools land
 * there), and ExitWorktree must restore it. Before the fix the tool created a
 * worktree but never called setWorkspacePath, so all edits leaked into the main
 * workspace — the isolation was a no-op.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { enterWorktreeTool, getCurrentWorktreeSession } from './EnterWorktreeTool'
import { exitWorktreeTool } from './ExitWorktreeTool'
import { getWorkspacePath, setWorkspacePath } from './workspaceState'

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: ['pipe', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}

const gitAvailable = hasGit()

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
}

describe.skipIf(!gitAvailable)('worktree workspace isolation', () => {
  let repoDir: string
  let priorWorkspace: string | null

  beforeEach(() => {
    priorWorkspace = getWorkspacePath()
    repoDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pole-wt-test-')),
    )
    git(['init'], repoDir)
    git(['config', 'user.email', 'test@example.com'], repoDir)
    git(['config', 'user.name', 'Test'], repoDir)
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed\n')
    git(['add', '.'], repoDir)
    git(['commit', '-m', 'init'], repoDir)
    setWorkspacePath(repoDir)
  })

  afterEach(() => {
    // Each test exits its own worktree; just restore the global state + clean.
    setWorkspacePath(priorWorkspace)
    try {
      fs.rmSync(repoDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('redirects the workspace path into the worktree on enter', async () => {
    const res = await enterWorktreeTool.execute({ name: 'iso' }, undefined)
    expect(res.success).toBe(true)

    const ws = getWorkspacePath()
    expect(ws).toBeTruthy()
    const expectedDir = path.join(repoDir, '.claude', 'worktrees', 'iso')
    expect(fs.realpathSync(ws as string)).toBe(fs.realpathSync(expectedDir))
    expect(fs.existsSync(expectedDir)).toBe(true)

    // cleanup
    await exitWorktreeTool.execute({ action: 'remove', discard_changes: true }, undefined)
  })

  it('restores the original workspace path on exit (remove)', async () => {
    await enterWorktreeTool.execute({ name: 'iso2' }, undefined)
    const worktreeDir = getWorkspacePath() as string

    const res = await exitWorktreeTool.execute(
      { action: 'remove', discard_changes: true },
      undefined,
    )
    expect(res.success).toBe(true)
    expect(getWorkspacePath()).toBe(repoDir)
    expect(getCurrentWorktreeSession()).toBeNull()
    expect(fs.existsSync(worktreeDir)).toBe(false)
  })

  it('blocks a second concurrent EnterWorktree (single-workspace semantics)', async () => {
    const first = await enterWorktreeTool.execute({ name: 'one' }, undefined)
    expect(first.success).toBe(true)

    const second = await enterWorktreeTool.execute({ name: 'two' }, undefined)
    expect(second.success).toBe(false)

    await exitWorktreeTool.execute({ action: 'remove', discard_changes: true }, undefined)
  })

  it('rejects path-traversal worktree names', async () => {
    const res = await enterWorktreeTool.execute({ name: '../../evil' }, undefined)
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('Invalid worktree name')
    // No session should have been created.
    expect(getCurrentWorktreeSession()).toBeNull()
    expect(getWorkspacePath()).toBe(repoDir)
  })

  it('keeps the worktree on disk and restores workspace with action=keep', async () => {
    await enterWorktreeTool.execute({ name: 'kept' }, undefined)
    const worktreeDir = getWorkspacePath() as string

    const res = await exitWorktreeTool.execute({ action: 'keep' }, undefined)
    expect(res.success).toBe(true)
    expect(getWorkspacePath()).toBe(repoDir)
    expect(getCurrentWorktreeSession()).toBeNull()
    expect(fs.existsSync(worktreeDir)).toBe(true)

    // cleanup the kept worktree so afterEach rm doesn't fight git metadata
    git(['worktree', 'remove', worktreeDir, '--force'], repoDir)
  })
})
