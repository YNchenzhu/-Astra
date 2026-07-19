/**
 * Crash-survivable inbox persistence — round-trip + invalidation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  saveInboxToDisk,
  loadInboxFromDisk,
  deleteInboxFromDisk,
} from './inboxPersistence'
import type { KernelInboxItem } from './kernelTypes'

describe('inboxPersistence', () => {
  let baseDir: string
  beforeEach(() => {
    baseDir = path.join(os.tmpdir(), `inbox-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(baseDir, { recursive: true })
  })
  afterEach(() => {
    try { fs.rmSync(baseDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('round-trips inbox items', () => {
    const items: KernelInboxItem[] = [
      { kind: 'synthetic_user_text', text: 'hello' },
      { kind: 'slash_command', name: 'memory', args: 'list' },
      { kind: 'inter_agent_mailbox_draft', lines: ['line a', 'line b'] },
    ]
    saveInboxToDisk('conv-1', items, baseDir)
    const loaded = loadInboxFromDisk('conv-1', baseDir)
    expect(loaded).toEqual(items)
  })

  it('returns undefined when no file exists', () => {
    expect(loadInboxFromDisk('nope', baseDir)).toBeUndefined()
  })

  it('deletes the file when the inbox becomes empty (auto-cleanup on save)', () => {
    saveInboxToDisk('conv-2', [{ kind: 'synthetic_user_text', text: 'x' }], baseDir)
    expect(loadInboxFromDisk('conv-2', baseDir)).not.toBeUndefined()
    saveInboxToDisk('conv-2', [], baseDir)
    expect(loadInboxFromDisk('conv-2', baseDir)).toBeUndefined()
  })

  it('explicit delete removes the file', () => {
    saveInboxToDisk('conv-3', [{ kind: 'synthetic_user_text', text: 'y' }], baseDir)
    expect(loadInboxFromDisk('conv-3', baseDir)).not.toBeUndefined()
    deleteInboxFromDisk('conv-3', baseDir)
    expect(loadInboxFromDisk('conv-3', baseDir)).toBeUndefined()
  })

  it('rejects blobs whose stored conversationId does not match', () => {
    saveInboxToDisk('conv-A', [{ kind: 'synthetic_user_text', text: 'x' }], baseDir)
    // Manually rename the file to simulate a moved conversation
    const dir = path.join(baseDir, 'orchestration-inbox')
    const files = fs.readdirSync(dir)
    expect(files.length).toBe(1)
    const renamed = path.join(dir, 'conv-B.json')
    fs.renameSync(path.join(dir, files[0]), renamed)
    expect(loadInboxFromDisk('conv-B', baseDir)).toBeUndefined()
  })
})
