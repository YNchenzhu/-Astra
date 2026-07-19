/**
 * Tests for Plan B (smart widening) + Content-Hash anchored edit_file.
 *
 * These tests verify:
 *   1. read_file auto-widens to full for small files, even when offset/limit is given.
 *   2. The tool output contains a `readId` trailer.
 *   3. edit_file with a matching `baseReadId` succeeds.
 *   4. edit_file safely rebinds expired production ids but rejects live cross-file ids.
 *   5. edit_file detects external modification via contentHash (not just mtime).
 *   6. edit_file detects `old_string` that was never visible to the agent.
 *   7. After a successful edit, the tool output surfaces a fresh readId for chaining.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toolReadFile, toolEditFile, toolMultiEditFile } from './tools'
import { setWorkspacePath } from '../tools/workspaceState'
import { clearAllReadFileState } from '../tools/readFileState'

function extractReadId(output: string): string | undefined {
  const m = output.match(/readId:\s*(read-[0-9a-f]+)/)
  return m?.[1]
}

function extractNextReadId(output: string): string | undefined {
  const m = output.match(/readId for next edit:\s*(read-[0-9a-f]+)/)
  return m?.[1]
}

describe('Plan B — smart widening on read_file', () => {
  let tmp: string

  beforeEach(() => {
    clearAllReadFileState()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-hashedit-'))
    setWorkspacePath(tmp)
  })

  afterEach(() => {
    setWorkspacePath(null)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('auto-widens to full read when the caller asked for a sub-window of a small file', async () => {
    const f = path.join(tmp, 'small.txt')
    const body = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')
    fs.writeFileSync(f, body, 'utf-8')

    // Caller asks for only lines 10..15 (offset 10, limit 5) — 50 lines is well under the
    // small-file threshold so we should get the whole file back instead.
    const r = await toolReadFile(f, { offset: 10, limit: 5 })
    expect(r.success).toBe(true)
    const out = r.output ?? ''
    expect(out).toMatch(/^1:[0-9a-f]{2}\tline 1$/m)
    expect(out).toMatch(/^50:[0-9a-f]{2}\tline 50$/m)
    expect(out).toMatch(/showing full file: 50 lines/)
  })

  it('returns a readId trailer suitable for baseReadId', async () => {
    const f = path.join(tmp, 'read-id-demo.txt')
    fs.writeFileSync(f, 'alpha\nbeta\n', 'utf-8')
    const r = await toolReadFile(f)
    expect(r.success).toBe(true)
    const id = extractReadId(r.output ?? '')
    expect(id).toBeDefined()
    expect(id!.startsWith('read-')).toBe(true)
  })
})

describe('Content-Hash anchored edit_file', () => {
  let tmp: string

  beforeEach(() => {
    clearAllReadFileState()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-hashedit-'))
    setWorkspacePath(tmp)
  })

  afterEach(() => {
    setWorkspacePath(null)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('accepts an edit with a matching baseReadId and mutates the file', async () => {
    const f = path.join(tmp, 'a.ts')
    fs.writeFileSync(f, 'export const x = 1\n', 'utf-8')
    const r = await toolReadFile(f)
    const id = extractReadId(r.output ?? '')!
    const edit = await toolEditFile(f, 'export const x = 1', 'export const x = 2', {
      baseReadId: id,
    })
    expect(edit.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('export const x = 2\n')
  })

  it('recovers redundant JSON quote escapes through the full readId-gated tool path', async () => {
    const f = path.join(tmp, 'quoted-table.md')
    const content = '| 世界 | "不在天道之内"的真正含义 | 3 | 28 |\n'
    fs.writeFileSync(f, content, 'utf-8')
    const read = await toolReadFile(f)
    const readId = extractReadId(read.output ?? '')!

    const edit = await toolEditFile(
      f,
      '| 世界 | \\"不在天道之内\\"的真正含义 | 3 | 28 |',
      '| 世界 | \\"不在天道之外\\"的真正含义 | 3 | 28 |',
      { baseReadId: readId },
    )

    expect(edit.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('| 世界 | "不在天道之外"的真正含义 | 3 | 28 |\n')
    expect(edit.output).toMatch(/JSON string escapes/i)
  })

  it('safely rebinds a well-formed expired baseReadId to the current receipt on the same path', async () => {
    // This is not the former weak mtime fallback: the current path-bound
    // receipt still has to pass the exact disk-hash + old_string checks.
    const f = path.join(tmp, 'b.ts')
    fs.writeFileSync(f, 'hello\n', 'utf-8')
    await toolReadFile(f)
    const edit = await toolEditFile(f, 'hello', 'world', {
      baseReadId: 'read-deadbeefdeadbeef',
    })
    expect(edit.success).toBe(true)
    expect(edit.output).toMatch(/safely rebound/i)
    expect(edit.output).toMatch(/NEW readId/i)
    expect(fs.readFileSync(f, 'utf-8')).toBe('world\n')
  })

  it('hard-rejects a baseReadId that belongs to a different file (audit 2026-07)', async () => {
    const a = path.join(tmp, 'aa.ts')
    const b = path.join(tmp, 'bb.ts')
    fs.writeFileSync(a, 'AAA\n', 'utf-8')
    fs.writeFileSync(b, 'BBB\n', 'utf-8')
    const ra = await toolReadFile(a)
    const idA = extractReadId(ra.output ?? '')!
    const edit = await toolEditFile(b, 'BBB', 'ccc', { baseReadId: idA })
    expect(edit.success).toBe(false)
    expect(edit.error).toMatch(/different file/)
    expect(fs.readFileSync(b, 'utf-8')).toBe('BBB\n')
  })

  it('repairs the observed A-then-B mix-up after editing A expires the id mistakenly sent for B', async () => {
    const a = path.join(tmp, 'chapter.md')
    const b = path.join(tmp, 'review.md')
    fs.writeFileSync(a, 'chapter old\n', 'utf-8')
    fs.writeFileSync(b, 'review old\n', 'utf-8')

    const readA = await toolReadFile(a)
    const staleIdFromA = extractReadId(readA.output ?? '')!
    const readB = await toolReadFile(b)
    const currentIdForB = extractReadId(readB.output ?? '')!

    const editA = await toolMultiEditFile(
      a,
      [{ oldString: 'chapter old', newString: 'chapter new' }],
      { baseReadId: staleIdFromA },
    )
    expect(editA.success).toBe(true)

    // Model bug reproduced: it sends A's now-expired id while targeting B.
    const editB = await toolEditFile(b, 'review old', 'review new', {
      baseReadId: staleIdFromA,
    })
    expect(editB.success).toBe(true)
    expect(editB.output).toContain(staleIdFromA)
    expect(editB.output).toContain(currentIdForB)
    expect(editB.output).toMatch(/safely rebound/i)
    expect(fs.readFileSync(b, 'utf-8')).toBe('review new\n')
  })

  it('mtime-attempted-preserve tampering is caught by the content hash (audit 2026-07)', async () => {
    // The attacker rewrites the bytes and restores the original mtime via
    // `fs.utimesSync`. The hash-anchored gate catches this class regardless
    // of filesystem mtime precision — the receipt's contentHash no longer
    // matches the on-disk bytes.
    const f = path.join(tmp, 'c.ts')
    fs.writeFileSync(f, 'v1\n', 'utf-8')
    const r = await toolReadFile(f)
    const id = extractReadId(r.output ?? '')!

    const originalStat = fs.statSync(f)
    fs.writeFileSync(f, 'v1 tampered\n', 'utf-8')
    fs.utimesSync(f, originalStat.atime, originalStat.mtime)

    const edit = await toolEditFile(f, 'v1', 'v2', { baseReadId: id })
    expect(edit.success).toBe(false)
    expect(edit.error).toMatch(/content hash mismatch/)
  })

  it('does not let expired-id rebinding bypass an external disk change', async () => {
    const f = path.join(tmp, 'rebind-tamper.ts')
    fs.writeFileSync(f, 'safe old\n', 'utf-8')
    await toolReadFile(f)
    fs.writeFileSync(f, 'externally changed\n', 'utf-8')

    const edit = await toolEditFile(f, 'safe old', 'unsafe write', {
      baseReadId: 'read-feedfacefeedface',
    })

    expect(edit.success).toBe(false)
    expect(edit.error).toMatch(/hash mismatch|changed on disk/i)
    expect(fs.readFileSync(f, 'utf-8')).toBe('externally changed\n')
  })

  it('rejects an edit whose old_string was never visible in the partial view (audit 2026-07)', async () => {
    // The readId gate's own OLD_STRING_NOT_IN_READ error is authoritative
    // again — the agent is told the string was not in what it read, not a
    // generic partial-view message.
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`)
    lines[2500] = 'TARGET_AT_LINE_2501'
    const f = path.join(tmp, 'd.ts')
    fs.writeFileSync(f, lines.join('\n') + '\n', 'utf-8')

    const r = await toolReadFile(f, { offset: 0, limit: 100 })
    expect(r.success).toBe(true)
    const id = extractReadId(r.output ?? '')!
    expect(id).toBeDefined()

    const edit = await toolEditFile(f, 'TARGET_AT_LINE_2501', 'NEW_TARGET', {
      baseReadId: id,
    })
    expect(edit.success).toBe(false)
    expect(edit.error).toMatch(/does not appear in the content you read/)
  })

  it('rejects replace_all against a partial read with the specific gate error (audit 2026-07)', async () => {
    const lines = Array.from({ length: 3000 }, () => 'needle')
    const f = path.join(tmp, 'e.ts')
    fs.writeFileSync(f, lines.join('\n') + '\n', 'utf-8')

    const r = await toolReadFile(f, { offset: 0, limit: 100 })
    const id = extractReadId(r.output ?? '')!
    const edit = await toolEditFile(f, 'needle', 'thread', {
      replaceAll: true,
      baseReadId: id,
    })
    expect(edit.success).toBe(false)
    expect(edit.error).toMatch(/replace_all requires a full-file read/)
  })

  it('surfaces a fresh readId after a successful edit for chaining', async () => {
    const f = path.join(tmp, 'f.ts')
    fs.writeFileSync(f, 'alpha\nbeta\n', 'utf-8')
    const r1 = await toolReadFile(f)
    const id1 = extractReadId(r1.output ?? '')!

    const edit1 = await toolEditFile(f, 'alpha', 'ALPHA', { baseReadId: id1 })
    expect(edit1.success).toBe(true)
    const id2 = extractNextReadId(edit1.output ?? '')
    expect(id2).toBeDefined()
    expect(id2).not.toBe(id1)

    // Chain a second edit using the new readId — must succeed without a fresh read_file.
    const edit2 = await toolEditFile(f, 'beta', 'BETA', { baseReadId: id2! })
    expect(edit2.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('ALPHA\nBETA\n')
  })

  it('allows a stale expectedLineRange after a prior edit shifts a unique strongly anchored match', async () => {
    const f = path.join(tmp, 'shifted-range.ts')
    fs.writeFileSync(f, ['alpha', 'beta', 'gamma', 'target', 'omega'].join('\n') + '\n', 'utf-8')

    const r1 = await toolReadFile(f)
    const id1 = extractReadId(r1.output ?? '')!
    const edit1 = await toolEditFile(f, 'alpha', 'intro 1\nintro 2\nalpha', {
      baseReadId: id1,
      expectedLineRange: [1, 1],
    })
    expect(edit1.success).toBe(true)
    const id2 = extractNextReadId(edit1.output ?? '')!

    // `target` was line 4 in the original read, but the first edit shifted it
    // to line 6. The unique old_string plus fresh content-hash read anchor is
    // precise enough; the old expectedLineRange is treated as stale metadata.
    const edit2 = await toolEditFile(f, 'target', 'TARGET', {
      baseReadId: id2,
      expectedLineRange: [4, 4],
    })
    expect(edit2.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('intro 1\nintro 2\nalpha\nbeta\ngamma\nTARGET\nomega\n')
  })

  it('ignores normalized expectedLineRange failures when baseReadId hash gate and unique edit succeed', async () => {
    const f = path.join(tmp, 'crlf.ts')
    fs.writeFileSync(f, 'line1\r\nline2\r\nline3\r\n', 'utf-8')
    const r1 = await toolReadFile(f)
    const id1 = extractReadId(r1.output ?? '')!
    const edit = await toolEditFile(f, 'line1\nline2', 'LINE1\nLINE2', {
      baseReadId: id1,
      expectedLineRange: [1, 2],
    })
    expect(edit.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('LINE1\r\nLINE2\r\nline3\r\n')
  })

  it('uses hashAnchor to disambiguate repeated old_string inside a verified line range', async () => {
    const f = path.join(tmp, 'hash-anchor.ts')
    fs.writeFileSync(f, 'target\nkeep\nmarker\nkeep\n', 'utf-8')
    const r1 = await toolReadFile(f)
    const id1 = extractReadId(r1.output ?? '')!
    const line4 = (r1.output ?? '').match(/^4:([0-9a-f]{2})\tkeep$/m)
    expect(line4).not.toBeNull()

    const edit = await toolEditFile(f, 'keep', 'KEEP', {
      baseReadId: id1,
      hashAnchor: { startLine: 4, startHash: line4![1] },
    })
    expect(edit.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('target\nkeep\nmarker\nKEEP\n')
  })

  it('stale hashAnchor falls back to unanchored match; legacy mtime gate then rejects (cc-haha alignment Part 3)', async () => {
    // upstream alignment Part 3: hashAnchor stale no longer hard-rejects.
    // BUT the legacy mtime gate still catches a real on-disk content change
    // (the second writeFileSync changed mtime), so the edit still fails —
    // just with the mtime-gate error, not the hashAnchor error.
    const f = path.join(tmp, 'stale-hash-anchor.ts')
    fs.writeFileSync(f, 'alpha\nbeta\n', 'utf-8')
    const r1 = await toolReadFile(f)
    const id1 = extractReadId(r1.output ?? '')!
    const line2 = (r1.output ?? '').match(/^2:([0-9a-f]{2})\tbeta$/m)
    expect(line2).not.toBeNull()
    fs.writeFileSync(f, 'alpha\nchanged\n', 'utf-8')

    const edit = await toolEditFile(f, 'changed', 'CHANGED', {
      baseReadId: id1,
      hashAnchor: { startLine: 2, startHash: line2![1] },
    })
    expect(edit.success).toBe(false)
    expect(edit.error).toMatch(/modified on disk|mtime|read_file/i)
  })

  it('expectedLineRange shape violation now soft-warns and succeeds (cc-haha alignment Part 3)', async () => {
    // upstream alignment Part 3: `expectedLineRange` violations no longer
    // hard-reject — they soft-warn and the edit proceeds. upstream has no
    // expectedLineRange concept; a unique byte-exact match is authoritative.
    const f = path.join(tmp, 'boundary.ts')
    fs.writeFileSync(
      f,
      [
        'function one() {',
        '  return 1',
        '}',
        '',
        'function two() {',
        '  return 2',
        '}',
      ].join('\n') + '\n',
      'utf-8',
    )

    const r1 = await toolReadFile(f)
    const id1 = extractReadId(r1.output ?? '')!
    const edit = await toolEditFile(
      f,
      '}\n\nfunction two() {',
      '}\n\nfunction twoRenamed() {',
      {
        baseReadId: id1,
        expectedLineRange: [1, 3],
      },
    )
    expect(edit.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toContain('function twoRenamed()')
  })

  it('reusing the original read_file readId AFTER an edit rejects with the current readId named (audit 2026-07)', async () => {
    // Repro for the production complaint: the AI reads a file, edits it
    // successfully, then echoes the ORIGINAL read_file readId on the next
    // edit. The stale, well-formed id is safely rebound to the current
    // path-bound receipt, eliminating the failure/retry turn without
    // weakening the hash + snapshot checks.
    const f = path.join(tmp, 'rot.ts')
    fs.writeFileSync(f, 'first\nsecond\n', 'utf-8')
    const r1 = await toolReadFile(f)
    const id1 = extractReadId(r1.output ?? '')!

    const edit1 = await toolEditFile(f, 'first', 'FIRST', { baseReadId: id1 })
    expect(edit1.success).toBe(true)
    const id2 = extractNextReadId(edit1.output ?? '')!
    expect(id2).not.toBe(id1)

    // Second edit accidentally reuses id1 (the now-stale read_file id).
    const edit2 = await toolEditFile(f, 'second', 'SECOND', { baseReadId: id1 })
    expect(edit2.success).toBe(true)
    expect(edit2.output).toContain(id1)
    expect(edit2.output).toContain(id2)
    expect(edit2.output).toMatch(/safely rebound/i)
    expect(fs.readFileSync(f, 'utf-8')).toBe('FIRST\nSECOND\n')
  })

  it('READ_ID_NOT_FOUND on a never-read path instructs a fresh read_file (audit 2026-07)', async () => {
    // The path was never read, so there is no live readId to surface. The
    // hard-rejected error must steer the agent to a fresh read_file rather
    // than another fabricated-baseReadId retry.
    const f = path.join(tmp, 'never-read.ts')
    fs.writeFileSync(f, 'untouched\n', 'utf-8')
    const edit = await toolEditFile(f, 'untouched', 'edited', {
      baseReadId: 'read-feedfacefeedface',
    })
    expect(edit.success).toBe(false)
    expect(edit.error).toMatch(/unknown or expired/)
    expect(edit.error).toMatch(/Call read_file/)
    expect(fs.readFileSync(f, 'utf-8')).toBe('untouched\n')
  })

  it('falls back to legacy gate (and succeeds) when no baseReadId is provided', async () => {
    // Backward compat: unchanged callers still work.
    const f = path.join(tmp, 'g.ts')
    fs.writeFileSync(f, 'legacy\n', 'utf-8')
    await toolReadFile(f)
    const edit = await toolEditFile(f, 'legacy', 'modern')
    expect(edit.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('modern\n')
  })
})
