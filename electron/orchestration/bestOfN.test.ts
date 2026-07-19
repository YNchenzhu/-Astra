import { describe, expect, it, vi } from 'vitest'
import { runBestOfN, parseShortstat, type BestOfNGitOps } from './bestOfN'
import type { WorktreeAllocator } from './multiAgent'

function fakeAllocator(): WorktreeAllocator & { released: string[] } {
  const released: string[] = []
  return {
    released,
    allocate: (p) => `/wt/${p.childKernelId}`,
    release: (path: string) => {
      released.push(path)
    },
  }
}

function fakeGitOps(over?: Partial<BestOfNGitOps>): BestOfNGitOps {
  return {
    resolveMainRepoRoot: async () => '/repo',
    commitAndStat: async ({ worktreePath }) => ({
      sha: `sha-${worktreePath}`,
      diff: { filesChanged: 1, insertions: 10, deletions: 1 },
    }),
    integrate: async () => {},
    ...over,
  }
}

describe('parseShortstat', () => {
  it('parses files/insertions/deletions', () => {
    expect(parseShortstat(' 3 files changed, 12 insertions(+), 4 deletions(-)')).toEqual({
      filesChanged: 3,
      insertions: 12,
      deletions: 4,
    })
  })
  it('tolerates missing fields', () => {
    expect(parseShortstat(' 1 file changed, 2 insertions(+)')).toEqual({
      filesChanged: 1,
      insertions: 2,
      deletions: 0,
    })
    expect(parseShortstat('')).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 })
  })
})

describe('runBestOfN', () => {
  it('fans out N attempts, picks the PASS winner, and integrates its commit', async () => {
    const allocator = fakeAllocator()
    const integrate = vi.fn(async () => {})
    const gitOps = fakeGitOps({ integrate })

    const res = await runBestOfN({
      task: 'do the thing',
      n: 3,
      worktreeAllocator: allocator,
      gitOps,
      runAttempt: async ({ attemptIndex }) => ({
        finalText: `attempt ${attemptIndex}`,
        verification: { verdict: attemptIndex === 1 ? 'PASS' : 'FAIL' },
      }),
    })

    expect(res.attempts).toHaveLength(3)
    expect(res.winner?.attempt.attemptIndex).toBe(1)
    expect(res.integrated).toBe(true)
    expect(integrate).toHaveBeenCalledTimes(1)
    // Losers released; winner released too because integration succeeded.
    expect(allocator.released).toHaveLength(3)
  })

  it('isolates a thrown attempt as an errored artifact (does not fail the batch)', async () => {
    const allocator = fakeAllocator()
    const res = await runBestOfN({
      task: 't',
      n: 2,
      worktreeAllocator: allocator,
      gitOps: fakeGitOps(),
      runAttempt: async ({ attemptIndex }) => {
        if (attemptIndex === 0) throw new Error('kaboom')
        return { verification: { verdict: 'PASS' } }
      },
    })
    const errored = res.attempts.find((a) => a.attemptIndex === 0)!
    expect(errored.error).toContain('kaboom')
    expect(res.winner?.attempt.attemptIndex).toBe(1)
  })

  it('keeps the winner worktree when integration fails, and reports it', async () => {
    const allocator = fakeAllocator()
    const gitOps = fakeGitOps({
      integrate: async () => {
        throw new Error('cherry-pick conflict')
      },
    })
    const res = await runBestOfN({
      task: 't',
      n: 2,
      worktreeAllocator: allocator,
      gitOps,
      runAttempt: async ({ attemptIndex }) => ({
        verification: { verdict: attemptIndex === 0 ? 'PASS' : 'FAIL' },
      }),
    })
    expect(res.integrated).toBe(false)
    // Winner is attempt 0 at /wt/...-0; its worktree should NOT be released.
    const winnerPath = res.winner?.attempt.worktreePath
    expect(winnerPath).toBeTruthy()
    expect(allocator.released).not.toContain(winnerPath)
    expect(res.notes.some((n) => n.includes('integration failed'))).toBe(true)
  })

  it('clamps n and notes the clamp', async () => {
    const res = await runBestOfN({
      task: 't',
      n: 999,
      worktreeAllocator: fakeAllocator(),
      gitOps: fakeGitOps(),
      runAttempt: async () => ({ verification: { verdict: 'PASS' } }),
    })
    expect(res.attempts.length).toBeLessThanOrEqual(6)
    expect(res.notes.some((n) => n.startsWith('n clamped'))).toBe(true)
  })

  it('reports no winner when every attempt errors', async () => {
    const res = await runBestOfN({
      task: 't',
      n: 2,
      worktreeAllocator: fakeAllocator(),
      gitOps: fakeGitOps(),
      runAttempt: async () => ({ error: 'failed to do anything' }),
    })
    expect(res.winner).toBeUndefined()
    expect(res.integrated).toBe(false)
    expect(res.notes.some((n) => n.includes('no eligible winner'))).toBe(true)
  })
})
