import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('behavior settings budget guards', () => {
  // 2026-07 quality uplift: default is 'medium' (balanced). 'high' stays
  // guarded against as an accidental global default (cost/latency spike);
  // 'low' is guarded against because it measurably degrades task quality
  // (shallow plan/implement/verify passes).
  it('defaults main chat reasoning effort to medium (not high, not low)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'behaviorSlice.ts'), 'utf-8')
    expect(src).toContain("effortLevel: 'medium'")
    expect(src).not.toContain("effortLevel: 'high'")
    expect(src).not.toContain("effortLevel: 'low'")
  })

  it('defaults extended thinking ON', () => {
    const src = fs.readFileSync(path.join(__dirname, 'behaviorSlice.ts'), 'utf-8')
    expect(src).toContain('alwaysThinking: true')
  })
})
