import { describe, it, expect } from 'vitest'
import { decideAutoSave } from './autoSaveConflict'

describe('decideAutoSave', () => {
  it('returns in-sync when disk already matches the buffer', () => {
    expect(
      decideAutoSave({
        bufferContent: 'C1',
        diskContent: 'C1',
        baselineContent: 'C0',
      }),
    ).toBe('in-sync')
  })

  it('returns write when only the user buffer changed since the baseline', () => {
    // disk still equals the baseline → no external writer → safe to persist.
    expect(
      decideAutoSave({
        bufferContent: 'user-edits',
        diskContent: 'C0',
        baselineContent: 'C0',
      }),
    ).toBe('write')
  })

  it('returns conflict when an external writer changed disk since the baseline', () => {
    // The user-reported bug: buffer has stale user edits, an AI edit_file
    // wrote C1 to disk; baseline was C0. Writing the buffer would destroy C1.
    expect(
      decideAutoSave({
        bufferContent: 'stale-user-buffer',
        diskContent: 'C1-from-ai',
        baselineContent: 'C0',
      }),
    ).toBe('conflict')
  })

  it('falls back to write when the baseline is unknown (no regression for legacy tabs)', () => {
    expect(
      decideAutoSave({
        bufferContent: 'buf',
        diskContent: 'other',
        baselineContent: undefined,
      }),
    ).toBe('write')
  })

  it('prefers in-sync over conflict when disk equals the buffer even if baseline differs', () => {
    // AI wrote exactly what the user also ended up with → no clobber, just
    // clear dirty. in-sync must win so we still refresh the baseline.
    expect(
      decideAutoSave({
        bufferContent: 'same',
        diskContent: 'same',
        baselineContent: 'C0',
      }),
    ).toBe('in-sync')
  })
})
