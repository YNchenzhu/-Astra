import { describe, expect, it } from 'vitest'
import { resolveHookLlmWorkerPath } from './hookLlmSubprocess'

describe('hookLlm worker bundle path', () => {
  it('resolves to hookLlmWorkerEntry.js next to compiled hook helpers', () => {
    const p = resolveHookLlmWorkerPath()
    expect(p).toMatch(/hookLlmWorkerEntry\.js$/)
  })
})
