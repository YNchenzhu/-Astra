import { describe, expect, it } from 'vitest'
import { RECALL_FINAL_TOP_K } from './recallPipeline'
import {
  MAX_PER_MEMORY_CHARS,
  MAX_RECALL_PROMPT_CHARS,
  buildRecalledMemoryPrompt,
} from './memoryPrompt'

function fakeMemory(
  name: string,
  content: string,
  ageDays = 0,
  isStale = false,
): { name: string; type: string; content: string; ageDays: number; isStale: boolean } {
  return { name, type: 'project', content, ageDays, isStale }
}

describe('memory injection budget guards', () => {
  it('caps the final recalled-memory count to a small fixed K', () => {
    // The exact value lives in recallPipeline.ts so this stays a single-
    // source-of-truth check. The lock is "small" (≤ 5) — anyone bumping
    // it past that must touch this test on purpose.
    expect(RECALL_FINAL_TOP_K).toBeGreaterThan(0)
    expect(RECALL_FINAL_TOP_K).toBeLessThanOrEqual(5)
  })

  it('truncates over-long individual memories to MAX_PER_MEMORY_CHARS', () => {
    const oversize = 'x'.repeat(MAX_PER_MEMORY_CHARS * 3)
    const prompt = buildRecalledMemoryPrompt([fakeMemory('huge', oversize)])

    expect(prompt).toContain('truncated to keep prompt within budget')
    expect(prompt.length).toBeLessThan(oversize.length / 2)
  })

  it('drops later memories once MAX_RECALL_PROMPT_CHARS budget is hit', () => {
    const chunk = 'a'.repeat(MAX_PER_MEMORY_CHARS - 100)
    const memories = Array.from({ length: 12 }, (_, i) => fakeMemory(`m${i}`, chunk))
    const prompt = buildRecalledMemoryPrompt(memories)

    expect(prompt.length).toBeLessThanOrEqual(MAX_RECALL_PROMPT_CHARS + 600)
    expect(prompt).toMatch(/additional memory record\(s\) were omitted/u)
  })

  it('keeps the production budgets within Claude Code-aligned ranges', () => {
    // Sanity ceiling — these are reference-grade context blocks, not
    // primary chat content. If we ever default them above ~10k chars we
    // are back to the pre-Stage 11 behaviour the audit flagged.
    expect(MAX_RECALL_PROMPT_CHARS).toBeLessThanOrEqual(10_000)
    expect(MAX_PER_MEMORY_CHARS).toBeLessThanOrEqual(2_000)
  })
})
