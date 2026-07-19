/**
 * Regression: the `validateInput` pre-check (validateEditToolPayload /
 * validateMultiEditToolPayload) must align with the loosened Zod gate and the
 * executors' baseReadId fallback. When the model drops `filePath` but supplies
 * a `baseReadId`, the request must be allowed through to the executor (which
 * recovers the path from the read receipt) instead of failing here with a
 * spurious "filePath is required." — the ~30% chained-edit failure mode.
 */

import { describe, it, expect } from 'vitest'
import {
  validateEditToolPayload,
  validateMultiEditToolPayload,
} from './validateEditTool'

describe('validateEditToolPayload — baseReadId tolerance for missing filePath', () => {
  it('allows a missing filePath when baseReadId is present (camelCase)', () => {
    const r = validateEditToolPayload({
      baseReadId: 'read-abc123',
      oldString: 'a',
      newString: 'b',
    })
    expect(r).toEqual({ ok: true })
  })

  it('allows a missing filePath when base_read_id is present (snake_case)', () => {
    const r = validateEditToolPayload({
      base_read_id: 'read-abc123',
      old_string: 'a',
      new_string: 'b',
    })
    expect(r).toEqual({ ok: true })
  })

  it('still rejects when BOTH filePath and baseReadId are missing', () => {
    const r = validateEditToolPayload({ oldString: 'a', newString: 'b' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/filePath is required/)
  })
})

describe('validateMultiEditToolPayload — baseReadId tolerance for missing filePath', () => {
  it('allows a missing filePath when baseReadId is present', () => {
    const r = validateMultiEditToolPayload({
      baseReadId: 'read-abc123',
      edits: [{ oldString: 'a', newString: 'b' }],
    })
    expect(r).toEqual({ ok: true })
  })

  it('still rejects when BOTH filePath and baseReadId are missing', () => {
    const r = validateMultiEditToolPayload({
      edits: [{ oldString: 'a', newString: 'b' }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/filePath is required/)
  })
})
