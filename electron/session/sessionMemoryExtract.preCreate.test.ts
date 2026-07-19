/**
 * Unit tests for {@link ensureSessionMemoryTargetFile} — the pre-create
 * helper that guarantees the session-memory scribe always has a file to
 * `Edit` (so the directive's "do not Write" rule has a stable anchor).
 *
 * Covers:
 *   - Creates an empty template when the file is missing.
 *   - Does NOT clobber an existing file (real or template).
 *   - Survives concurrent invocations without throwing (wx EEXIST race).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ensureSessionMemoryTargetFile,
  generateEmptySessionMemoryTemplate,
} from './sessionMemoryExtract'

describe('ensureSessionMemoryTargetFile', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pole-sm-precreate-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('creates an empty template when the file does not yet exist', async () => {
    const memPath = path.join(tmpDir, 'conv-fresh.md')
    await ensureSessionMemoryTargetFile(memPath)

    const content = await fs.readFile(memPath, 'utf8')
    expect(content).toBe(generateEmptySessionMemoryTemplate('Session Title'))
    // The title placeholder must match the directive's example template,
    // otherwise the scribe's first `Edit("# Session Title", ...)` fails.
    expect(content.startsWith('# Session Title')).toBe(true)
  })

  it('does NOT clobber an existing file with real content', async () => {
    const memPath = path.join(tmpDir, 'conv-already-has-notes.md')
    const realNotes = '# 真实标题\n\n## Current State\n\n用户在调试 scribe 问题。\n'
    await fs.writeFile(memPath, realNotes, 'utf8')

    await ensureSessionMemoryTargetFile(memPath)

    const content = await fs.readFile(memPath, 'utf8')
    expect(content).toBe(realNotes)
  })

  it('survives concurrent pre-create races (wx EEXIST swallowed)', async () => {
    const memPath = path.join(tmpDir, 'conv-race.md')
    // Fire 8 invocations in parallel. Without `flag: 'wx'` + EEXIST handling,
    // at least one would either crash or clobber a sibling's freshly-written
    // template.
    await expect(
      Promise.all(
        Array.from({ length: 8 }, () => ensureSessionMemoryTargetFile(memPath)),
      ),
    ).resolves.toBeDefined()

    const content = await fs.readFile(memPath, 'utf8')
    expect(content).toBe(generateEmptySessionMemoryTemplate('Session Title'))
  })

  it('re-throws non-ENOENT access errors instead of overwriting silently', async () => {
    // Simulate a non-ENOENT access path by pointing at a directory: `fs.access`
    // succeeds for a directory, so the helper would early-return without
    // trying to write. To exercise the non-ENOENT branch we instead point at
    // a path whose parent does not exist — `fs.access` raises ENOENT (still
    // the create branch), then `fs.writeFile` raises a non-EEXIST error
    // (ENOENT on the missing dir), which the helper must propagate so the
    // outer scribe fork-runner logs it.
    const memPath = path.join(tmpDir, 'no-such-dir', 'conv.md')
    await expect(ensureSessionMemoryTargetFile(memPath)).rejects.toThrow()
  })
})
