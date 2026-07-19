import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as service from './service'
import {
  tryAcquireFileLock,
  releaseFileLock,
  resetExtractionStateForTests,
} from './extractionState'

const tmpDirs: string[] = []

function freshWorkspace(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-svc-'))
  tmpDirs.push(d)
  return d
}

afterEach(() => {
  resetExtractionStateForTests()
  service.setActiveWorkspace(null)
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('service.updateMemory lock contract (audit M8)', () => {
  it('THROWS a distinct error on lock contention (not a null no-op)', () => {
    const ws = freshWorkspace()
    service.setActiveWorkspace(ws)
    service.createMemory({
      name: 'lockme',
      description: 'd',
      type: 'project',
      content: 'original',
    })

    // Simulate a concurrent writer holding the file lock. `updateMemory` calls
    // tryAcquireFileLock(loc.diskName) with the bare disk filename.
    const diskName = 'lockme.md'
    expect(tryAcquireFileLock(diskName, 'other-writer')).toBe(true)

    try {
      expect(() =>
        service.updateMemory({ filename: diskName, content: 'changed' }),
      ).toThrow(/locked/i)
    } finally {
      releaseFileLock(diskName)
    }
  })

  it('still returns null (not throw) when the memory does not exist', () => {
    const ws = freshWorkspace()
    service.setActiveWorkspace(ws)
    expect(service.updateMemory({ filename: 'no-such.md', content: 'x' })).toBeNull()
  })

  it('succeeds normally when the lock is free', () => {
    const ws = freshWorkspace()
    service.setActiveWorkspace(ws)
    service.createMemory({
      name: 'editme',
      description: 'd',
      type: 'project',
      content: 'v1',
    })
    const updated = service.updateMemory({ filename: 'editme.md', content: 'v2' })
    expect(updated).not.toBeNull()
    expect(updated!.content).toBe('v2')
  })
})
