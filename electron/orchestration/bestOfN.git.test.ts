/**
 * Real-git integration test for the audit-H1 fix: `resolveMainRepoRoot` must
 * return the MAIN working-tree root even when called from inside a linked
 * worktree (where `--show-toplevel` would wrongly return the worktree dir).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGitBestOfNOps } from './bestOfN'

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
}

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: ['pipe', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}

const real = (p: string): string => fs.realpathSync(p)

describe('createGitBestOfNOps.resolveMainRepoRoot (audit H1)', () => {
  let repo: string
  let worktree: string

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bon-git-'))
    git(['init'], repo)
    git(['config', 'user.email', 'test@example.com'], repo)
    git(['config', 'user.name', 'Test'], repo)
    git(['config', 'commit.gpgsign', 'false'], repo)
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n')
    git(['add', '-A'], repo)
    git(['commit', '-m', 'init', '--no-verify'], repo)
    worktree = path.join(repo, '.wt', 'attempt-0')
    fs.mkdirSync(path.join(repo, '.wt'), { recursive: true })
    git(['worktree', 'add', '-b', 'attempt-0', worktree, 'HEAD'], repo)
  })

  afterEach(() => {
    try {
      fs.rmSync(repo, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  it('returns the main repo root from inside a linked worktree', async () => {
    if (!gitAvailable()) return
    const ops = createGitBestOfNOps()
    const resolved = await ops.resolveMainRepoRoot(worktree)
    expect(resolved).not.toBeNull()
    expect(real(resolved!)).toBe(real(repo))
  })

  it('cherry-picks a worktree commit into the main tree', async () => {
    if (!gitAvailable()) return
    const ops = createGitBestOfNOps()
    // Make a change in the worktree and commit it via the production path.
    fs.writeFileSync(path.join(worktree, 'b.txt'), 'from attempt\n')
    const { sha, diff } = await ops.commitAndStat({ worktreePath: worktree, message: 'attempt change' })
    expect(sha).toBeTruthy()
    expect(diff.filesChanged).toBeGreaterThan(0)

    const mainRoot = await ops.resolveMainRepoRoot(worktree)
    await ops.integrate({ mainRepoRoot: mainRoot!, winningSha: sha! })

    // The file the attempt created now exists in the MAIN working tree.
    expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(true)
  })
})
