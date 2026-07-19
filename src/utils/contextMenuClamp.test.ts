import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clampFixedContextMenuPosition } from './contextMenuClamp'

describe('clampFixedContextMenuPosition', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps a comfortably-placed menu where it is', () => {
    expect(clampFixedContextMenuPosition(100, 100, 200, 150)).toEqual({ x: 100, y: 100 })
  })

  it('clamps to the right/bottom edge when the box would overflow', () => {
    // maxX = 1000 - 200 - 8 = 792 ; maxY = 800 - 150 - 8 = 642
    expect(clampFixedContextMenuPosition(990, 790, 200, 150)).toEqual({ x: 792, y: 642 })
  })

  it('clamps to the left/top margin when click is negative', () => {
    expect(clampFixedContextMenuPosition(-50, -50, 200, 150)).toEqual({ x: 8, y: 8 })
  })

  it('falls back to margin when box is larger than viewport', () => {
    // maxX = max(8, 1000 - 2000 - 8) = 8
    expect(clampFixedContextMenuPosition(500, 500, 2000, 2000)).toEqual({ x: 8, y: 8 })
  })

  it('respects a custom margin', () => {
    expect(clampFixedContextMenuPosition(0, 0, 100, 100, 20)).toEqual({ x: 20, y: 20 })
  })
})
