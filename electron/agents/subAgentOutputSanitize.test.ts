import { describe, it, expect } from 'vitest'
import { stripLeadingSubAgentProcessNarration } from './subAgentOutputSanitize'

describe('stripLeadingSubAgentProcessNarration', () => {
  it('returns unchanged when text already starts with a heading', () => {
    const s = '## Summary\n\nBody'
    expect(stripLeadingSubAgentProcessNarration(s)).toBe(s)
  })

  it('strips Chinese process preamble before ### section', () => {
    const filler =
      '我将检查当前工作目录以了解项目状态，然后制定全面的开发计划。我先检查一下当前项目目录的状态，以了解已有的内容。我看到已经有一个 `novel_writer` 目录和一个 `main.py` 文件了。让我查看一下它们，以便了解现有状态。我来详细查看一下现有的 `novel_writer` 包结构。好的。项目处于非常早期的原型阶段——一个有效的 PyQt6 单文件演示，其中包含基本的窗口布局和一个骨架包结构。现在我已完全理解项目背景，可以交付全面的规划文档了。\n\n'
    const body = '### Implementation Plan\n\n1. Do the thing\n2. Done'
    const out = stripLeadingSubAgentProcessNarration(filler + body)
    expect(out.startsWith('### Implementation Plan')).toBe(true)
    expect(out).not.toContain('我将检查')
  })

  it('does not strip short intros', () => {
    const s = 'Brief note.\n\n## Plan\n\nSteps'
    expect(stripLeadingSubAgentProcessNarration(s)).toBe(s)
  })

  it('strips filler even when a heading appears on a later line (no false early exit)', () => {
    const filler = '我将简述。\n\n'
    const body = '### Plan\n\n- item one with enough length\n- item two also long enough here'
    const combined = filler + 'x'.repeat(90) + '\n\n' + body
    const out = stripLeadingSubAgentProcessNarration(combined)
    expect(out.startsWith('### Plan')).toBe(true)
    expect(out).not.toContain('我将简述')
  })
})
