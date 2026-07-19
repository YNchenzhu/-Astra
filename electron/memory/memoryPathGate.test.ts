import { describe, expect, it, vi, beforeEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'

const getWs = vi.fn((): string | null => null)
const getBundle = vi.fn((): string => '')

vi.mock('../tools/workspaceState', () => ({
  getWorkspacePath: () => getWs(),
}))

vi.mock('./service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./service')>()
  return {
    ...actual,
    getMemoryBundleDataRoot: () => getBundle(),
  }
})

import { isResolvedPathInKnownMemoryWritableTree } from './memoryPathGate'

describe('memoryPathGate', () => {
  beforeEach(() => {
    getWs.mockReturnValue(null)
    getBundle.mockReturnValue('')
  })

  it('allows project memory under workspace .claude/memory', () => {
    const ws = path.join(os.tmpdir(), 'pole-ws-test')
    getWs.mockReturnValue(ws)
    const mem = path.join(ws, '.claude', 'memory', 'note.md')
    expect(isResolvedPathInKnownMemoryWritableTree(mem)).toBe(true)
  })

  it('allows team-memory under workspace', () => {
    const ws = path.join(os.tmpdir(), 'pole-ws-team')
    getWs.mockReturnValue(ws)
    const f = path.join(ws, '.claude', 'team-memory', 'shared.md')
    expect(isResolvedPathInKnownMemoryWritableTree(f)).toBe(true)
  })

  it('allows user memory dir when bundle root is set', () => {
    const bundle = path.join(os.tmpdir(), 'pole-bundle')
    getBundle.mockReturnValue(bundle)
    const f = path.join(bundle, 'memory', 'user', 'u.md')
    expect(isResolvedPathInKnownMemoryWritableTree(f)).toBe(true)
  })

  it('allows agent-memory under workspace', () => {
    const ws = path.join(os.tmpdir(), 'pole-ws-agent')
    getWs.mockReturnValue(ws)
    const f = path.join(ws, '.claude', 'agent-memory', 'Explore', 'x.md')
    expect(isResolvedPathInKnownMemoryWritableTree(f)).toBe(true)
  })

  it('rejects arbitrary path under .claude that is not memory', () => {
    const ws = path.join(os.tmpdir(), 'pole-ws-bad')
    getWs.mockReturnValue(ws)
    const f = path.join(ws, '.claude', 'settings.json')
    expect(isResolvedPathInKnownMemoryWritableTree(f)).toBe(false)
  })
})
