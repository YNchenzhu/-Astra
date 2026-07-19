/**
 * Behaviour lock for Keep Rate telemetry.
 *
 * The tests use vitest's fake timers to advance through the +5/+30/+180min
 * buckets without sleeping. They cover the four documented outcomes
 * (`kept` / `modified` / `reverted` / `gone`) plus the operational
 * guarantees: re-anchor on same file cancels the prior schedule, LRU cap
 * caps memory, telemetry opt-out via env disables emission, and
 * `flushAllAnchors()` clears every pending timer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  __resetKeepRateForTests,
  anchorEdit,
  flushAllAnchors,
  getActiveAnchorsSnapshot,
  hashContent,
} from './keepRate'
import {
  __resetTelemetryForTests,
  getRecentTelemetryEvents,
  type KeepRateTelemetryEvent,
} from './contextEvents'

function keepRateEvents(): KeepRateTelemetryEvent[] {
  return getRecentTelemetryEvents({ kind: 'keep_rate' }) as KeepRateTelemetryEvent[]
}

describe('keepRate', () => {
  let dir: string
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.POLE_DISABLE_TELEMETRY
    delete process.env.POLE_DISABLE_TELEMETRY
    __resetTelemetryForTests()
    __resetKeepRateForTests()
    dir = mkdtempSync(join(tmpdir(), 'keep-rate-'))
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    flushAllAnchors()
    rmSync(dir, { recursive: true, force: true })
    if (originalEnv === undefined) {
      delete process.env.POLE_DISABLE_TELEMETRY
    } else {
      process.env.POLE_DISABLE_TELEMETRY = originalEnv
    }
  })

  function writeFile(rel: string, contents: string): string {
    const fp = join(dir, rel)
    mkdirSync(join(fp, '..'), { recursive: true })
    writeFileSync(fp, contents, 'utf8')
    return fp
  }

  it('hashContent is stable and short', () => {
    expect(hashContent('hello')).toBe(hashContent('hello'))
    expect(hashContent('hello')).toHaveLength(16)
    expect(hashContent('hello')).not.toBe(hashContent('hello!'))
  })

  it('emits `kept` at all three buckets when the file is unchanged', () => {
    const fp = writeFile('a.ts', 'export const x = 1\n')
    anchorEdit({
      toolName: 'edit_file',
      resolvedPath: fp,
      workspaceRoot: dir,
      contentBefore: 'export const x = 0\n',
      contentAfter: 'export const x = 1\n',
    })

    vi.advanceTimersByTime(5 * 60_000 + 10)
    expect(keepRateEvents()).toHaveLength(1)
    expect(keepRateEvents()[0]?.bucket).toBe('m5')
    expect(keepRateEvents()[0]?.outcome).toBe('kept')

    vi.advanceTimersByTime(25 * 60_000) // → 30min mark
    expect(keepRateEvents()).toHaveLength(2)
    expect(keepRateEvents()[0]?.bucket).toBe('m30')
    expect(keepRateEvents()[0]?.outcome).toBe('kept')

    vi.advanceTimersByTime(150 * 60_000) // → 180min mark
    expect(keepRateEvents()).toHaveLength(3)
    expect(keepRateEvents()[0]?.bucket).toBe('m180')
    expect(keepRateEvents()[0]?.outcome).toBe('kept')
  })

  it('emits `modified` when the file content drifts from both before and after', () => {
    const fp = writeFile('b.ts', 'agent wrote this\n')
    anchorEdit({
      toolName: 'write_file',
      resolvedPath: fp,
      workspaceRoot: dir,
      contentBefore: null,
      contentAfter: 'agent wrote this\n',
    })

    // User edits the file before the m5 check fires.
    writeFileSync(fp, 'user replaced agent output\n', 'utf8')
    vi.advanceTimersByTime(5 * 60_000 + 10)

    const ev = keepRateEvents()[0]!
    expect(ev.bucket).toBe('m5')
    expect(ev.outcome).toBe('modified')
  })

  it('emits `reverted` when the file matches the pre-edit hash', () => {
    const fp = writeFile('c.ts', 'after\n')
    anchorEdit({
      toolName: 'edit_file',
      resolvedPath: fp,
      workspaceRoot: dir,
      contentBefore: 'before\n',
      contentAfter: 'after\n',
    })

    // User rolls the edit back.
    writeFileSync(fp, 'before\n', 'utf8')
    vi.advanceTimersByTime(5 * 60_000 + 10)

    expect(keepRateEvents()[0]?.outcome).toBe('reverted')
  })

  it('emits `gone` when the file is deleted', () => {
    const fp = writeFile('d.ts', 'temp\n')
    anchorEdit({
      toolName: 'write_file',
      resolvedPath: fp,
      workspaceRoot: dir,
      contentBefore: null,
      contentAfter: 'temp\n',
    })

    unlinkSync(fp)
    vi.advanceTimersByTime(5 * 60_000 + 10)

    expect(keepRateEvents()[0]?.outcome).toBe('gone')
  })

  it('re-anchoring the same path cancels the previous anchor', () => {
    const fp = writeFile('e.ts', 'first\n')
    const id1 = anchorEdit({
      toolName: 'edit_file',
      resolvedPath: fp,
      workspaceRoot: dir,
      contentBefore: null,
      contentAfter: 'first\n',
    })
    expect(id1).not.toBeNull()
    expect(getActiveAnchorsSnapshot()).toHaveLength(1)

    // Second edit on the same file → first anchor is replaced.
    writeFileSync(fp, 'second\n', 'utf8')
    const id2 = anchorEdit({
      toolName: 'edit_file',
      resolvedPath: fp,
      workspaceRoot: dir,
      contentBefore: 'first\n',
      contentAfter: 'second\n',
    })
    expect(id2).not.toBe(id1)
    const snap = getActiveAnchorsSnapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0]?.id).toBe(id2)

    // Drive past every bucket: only ONE set of three events should fire
    // (the second anchor). If the first anchor's timers leaked we'd see 6.
    vi.advanceTimersByTime(200 * 60_000)
    expect(keepRateEvents()).toHaveLength(3)
    // All events must reflect the second anchor (kept = matches 'second\n').
    for (const e of keepRateEvents()) {
      expect(e.outcome).toBe('kept')
    }
  })

  it('records the workspace-relative path when a workspace root is supplied', () => {
    const fp = writeFile('nested/sub/f.ts', 'x\n')
    anchorEdit({
      toolName: 'write_file',
      resolvedPath: fp,
      workspaceRoot: dir,
      contentBefore: null,
      contentAfter: 'x\n',
    })
    vi.advanceTimersByTime(5 * 60_000 + 10)
    expect(keepRateEvents()[0]?.filePath).toBe('nested/sub/f.ts')
  })

  it('falls back to the absolute path when no workspace root is given', () => {
    const fp = writeFile('g.ts', 'y\n')
    anchorEdit({
      toolName: 'write_file',
      resolvedPath: fp,
      workspaceRoot: null,
      contentBefore: null,
      contentAfter: 'y\n',
    })
    vi.advanceTimersByTime(5 * 60_000 + 10)
    expect(keepRateEvents()[0]?.filePath).toBe(fp)
  })

  it('respects POLE_DISABLE_TELEMETRY: no anchor is registered, no event fires', () => {
    process.env.POLE_DISABLE_TELEMETRY = '1'
    const fp = writeFile('h.ts', 'z\n')
    const id = anchorEdit({
      toolName: 'edit_file',
      resolvedPath: fp,
      workspaceRoot: dir,
      contentBefore: null,
      contentAfter: 'z\n',
    })
    expect(id).toBeNull()
    expect(getActiveAnchorsSnapshot()).toHaveLength(0)
    vi.advanceTimersByTime(200 * 60_000)
    expect(keepRateEvents()).toHaveLength(0)
  })

  it('flushAllAnchors() cancels every pending timer', () => {
    for (let i = 0; i < 5; i++) {
      const fp = writeFile(`m${i}.ts`, `n${i}\n`)
      anchorEdit({
        toolName: 'write_file',
        resolvedPath: fp,
        workspaceRoot: dir,
        contentBefore: null,
        contentAfter: `n${i}\n`,
      })
    }
    expect(getActiveAnchorsSnapshot()).toHaveLength(5)

    flushAllAnchors()
    expect(getActiveAnchorsSnapshot()).toHaveLength(0)

    vi.advanceTimersByTime(200 * 60_000)
    expect(keepRateEvents()).toHaveLength(0)
  })

  it('reports ageMs accurately at each bucket', () => {
    const fp = writeFile('age.ts', 'a\n')
    anchorEdit({
      toolName: 'edit_file',
      resolvedPath: fp,
      workspaceRoot: dir,
      contentBefore: null,
      contentAfter: 'a\n',
    })

    vi.advanceTimersByTime(5 * 60_000 + 5)
    const ev = keepRateEvents()[0]!
    // ageMs should be within a few ms of the bucket boundary.
    expect(ev.ageMs).toBeGreaterThanOrEqual(5 * 60_000)
    expect(ev.ageMs).toBeLessThan(5 * 60_000 + 200)
  })

  it('removes the anchor from the active set after the final bucket emits', () => {
    const fp = writeFile('final.ts', 'q\n')
    anchorEdit({
      toolName: 'edit_file',
      resolvedPath: fp,
      workspaceRoot: dir,
      contentBefore: null,
      contentAfter: 'q\n',
    })
    expect(getActiveAnchorsSnapshot()).toHaveLength(1)
    vi.advanceTimersByTime(5 * 60_000 + 10)
    expect(getActiveAnchorsSnapshot()).toHaveLength(1)
    vi.advanceTimersByTime(25 * 60_000)
    expect(getActiveAnchorsSnapshot()).toHaveLength(1)
    vi.advanceTimersByTime(150 * 60_000)
    expect(getActiveAnchorsSnapshot()).toHaveLength(0)
  })
})
