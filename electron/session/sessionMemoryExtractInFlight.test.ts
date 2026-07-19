import { describe, expect, it, beforeEach } from 'vitest'
import {
  endSessionMemoryExtract,
  resetSessionMemoryExtractInFlightForTests,
  tryBeginSessionMemoryExtract,
} from './sessionMemoryExtractInFlight'

beforeEach(() => {
  resetSessionMemoryExtractInFlightForTests()
})

describe('sessionMemoryExtractInFlight', () => {
  it('tryBegin returns false when already in flight', () => {
    expect(tryBeginSessionMemoryExtract('c1')).toBe(true)
    expect(tryBeginSessionMemoryExtract('c1')).toBe(false)
    endSessionMemoryExtract('c1')
    expect(tryBeginSessionMemoryExtract('c1')).toBe(true)
  })

  it('trims conversation id', () => {
    expect(tryBeginSessionMemoryExtract('  x  ')).toBe(true)
    expect(tryBeginSessionMemoryExtract('x')).toBe(false)
  })
})
