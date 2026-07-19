/**
 * Per-edit `expectedLineRange` positional cross-check in multi_edit_file
 * (2026-07). Guards the weak-model failure where a batch edit's oldString
 * uniquely matches a location DIFFERENT from the intended one ("content
 * meant for line 8 landed at line 10"). The check runs against the
 * ORIGINAL pre-batch buffer — the coordinate system of the model's
 * read_file output — before any edit applies.
 */

import { describe, it, expect } from 'vitest'
import { computeFileEditResultMulti } from './fileEditSemantics'
import { multiEditFileInputZod } from '../tools/toolInputZod'
import { validateMultiEditToolPayload } from '../utils/settings/validateEditTool'

const FILE = [
  'line 1 header', //           1
  'alpha section start', //     2
  'target paragraph A', //      3
  'alpha section end', //       4
  'beta section start', //      5
  'target paragraph B', //      6
  'beta section end', //        7
].join('\n')

describe('computeFileEditResultMulti — per-edit expectedLineRange pre-pass', () => {
  it('applies normally when every declared range covers its actual match', () => {
    const r = computeFileEditResultMulti(FILE, [
      { oldString: 'target paragraph A', newString: 'TARGET A', expectedLineRange: [2, 4] },
      { oldString: 'target paragraph B', newString: 'TARGET B', expectedLineRange: [5, 7] },
    ])
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.newContent).toContain('TARGET A')
    expect(r.newContent).toContain('TARGET B')
  })

  it('rejects the WHOLE batch when an oldString uniquely matches outside its declared range', () => {
    // Model thinks paragraph B lives in the alpha section (lines 2-4) —
    // the exact "meant for line 8, landed at line 10" shape.
    const r = computeFileEditResultMulti(FILE, [
      { oldString: 'line 1 header', newString: 'HEADER' },
      { oldString: 'target paragraph B', newString: 'TARGET B', expectedLineRange: [2, 4] },
    ])
    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.failedEditIndex).toBe(1)
    expect(r.error).toMatch(/Edit #2/)
    expect(r.error).toMatch(/expectedLineRange \[2, 4\]/)
    expect(r.error).toMatch(/No edit from this batch was applied/i)
  })

  it('skips the check for an edit targeting text authored by an earlier edit in the batch', () => {
    const r = computeFileEditResultMulti(FILE, [
      { oldString: 'target paragraph A', newString: 'FRESH CONTENT X' },
      // 'FRESH CONTENT X' does not exist in the original buffer — the
      // pre-pass must skip (NOT_FOUND) and let the sequential applier judge.
      { oldString: 'FRESH CONTENT X', newString: 'FRESH CONTENT X REFINED', expectedLineRange: [1, 3] },
    ])
    // The clobber guard may still reject this shape — what matters here is
    // that the failure (if any) is NOT an expectedLineRange violation.
    if (!r.success) {
      expect(r.error).not.toMatch(/expectedLineRange/)
    }
  })

  it('replaceAll: rejects when one of several matches falls outside the declared range', () => {
    const content = 'keep\ntoken here\nmiddle\ntoken there\n'
    const r = computeFileEditResultMulti(content, [
      { oldString: 'token', newString: 'TOKEN', replaceAll: true, expectedLineRange: [1, 2] },
    ])
    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.error).toMatch(/outside expectedLineRange/i)
  })

  it('edits without expectedLineRange are unaffected (backward compatible)', () => {
    const r = computeFileEditResultMulti(FILE, [
      { oldString: 'target paragraph B', newString: 'TARGET B' },
    ])
    expect(r.success).toBe(true)
  })
})

describe('multiEditFileInputZod — per-edit expectedLineRange plumbing', () => {
  it('passes camelCase expectedLineRange through the transform', () => {
    const parsed = multiEditFileInputZod.parse({
      filePath: 'a.txt',
      edits: [{ oldString: 'x', newString: 'y', expectedLineRange: [3, 5] }],
    })
    expect(parsed.edits[0]!.expectedLineRange).toEqual([3, 5])
  })

  it('maps snake_case expected_line_range to camelCase', () => {
    const parsed = multiEditFileInputZod.parse({
      file_path: 'a.txt',
      edits: [{ old_string: 'x', new_string: 'y', expected_line_range: [8, 8] }],
    })
    expect(parsed.edits[0]!.expectedLineRange).toEqual([8, 8])
  })

  it('leaves the field undefined when omitted', () => {
    const parsed = multiEditFileInputZod.parse({
      filePath: 'a.txt',
      edits: [{ oldString: 'x', newString: 'y' }],
    })
    expect(parsed.edits[0]!.expectedLineRange).toBeUndefined()
  })
})

describe('validateMultiEditToolPayload — per-edit range shape validation', () => {
  it('rejects a malformed per-edit range with the edit index in the message', () => {
    const r = validateMultiEditToolPayload({
      filePath: 'a.txt',
      edits: [
        { oldString: 'a', newString: 'b' },
        { oldString: 'c', newString: 'd', expectedLineRange: [5] },
      ],
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toMatch(/edits\[1\]/)
    expect(r.message).toMatch(/2-element array/)
  })

  it('rejects start > end per edit', () => {
    const r = validateMultiEditToolPayload({
      filePath: 'a.txt',
      edits: [{ oldString: 'a', newString: 'b', expected_line_range: [9, 3] }],
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toMatch(/start <= end/)
  })

  it('accepts a well-formed per-edit range', () => {
    const r = validateMultiEditToolPayload({
      filePath: 'a.txt',
      edits: [{ oldString: 'a', newString: 'b', expectedLineRange: [3, 9] }],
    })
    expect(r.ok).toBe(true)
  })
})
