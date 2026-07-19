import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  findSubAgentDiskSnapshot,
  persistSubAgentSidechainSnapshot,
  loadSubAgentDiskSnapshotByAgentId,
} from './subAgentSidechainDisk'

describe('subAgentSidechainDisk', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-sidechain-'))
  })
  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('persists and loads by agent id', () => {
    persistSubAgentSidechainSnapshot(root, {
      agentId: 'worker-9',
      agentType: 'Explore',
      name: 'scout',
      teamName: 'T1',
      endedAt: 42,
      entries: [
        { ts: 1, kind: 'start', summary: 'go' },
        { ts: 2, kind: 'complete', summary: 'success=true' },
      ],
    })
    const snap = loadSubAgentDiskSnapshotByAgentId(root, 'worker-9')
    expect(snap?.agentType).toBe('Explore')
    expect(snap?.name).toBe('scout')
    expect(snap?.entries).toHaveLength(2)
  })

  it('findSubAgentDiskSnapshot resolves by name', () => {
    persistSubAgentSidechainSnapshot(root, {
      agentId: 'opaque-id',
      agentType: 'Plan',
      name: 'planner',
      endedAt: 9,
      entries: [{ ts: 1, kind: 'start', summary: 'x' }],
    })
    const byName = findSubAgentDiskSnapshot(root, 'planner')
    expect(byName?.agentId).toBe('opaque-id')
  })
})
