import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyToolResultSizeBudget,
  clampToolResultsInMessages,
  isSkillInstructionsBlock,
  spillPreviewSplitForTool,
} from './toolResultBudget'

describe('toolResultBudget', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('relevance-weighted eviction (2026-07 uplift #10)', () => {
    const toolResultMsg = (
      blocks: Array<{ id: string; content: string }>,
    ): Record<string, unknown> => ({
      role: 'user',
      content: blocks.map((b) => ({
        type: 'tool_result',
        tool_use_id: b.id,
        content: b.content,
      })),
    })

    const blockContent = (out: Record<string, unknown>, msgIdx: number): string =>
      String((out[msgIdx] as { content: Array<Record<string, unknown>> }).content[0]!.content)

    it('evicts irrelevant blocks first; task-relevant blocks survive the sweep', () => {
      // Oldest block IS task-relevant (mentions src/core.ts); newer filler is
      // not. Legacy oldest-first would clamp the relevant one — the
      // relevance partition must clamp the filler instead.
      const relevant = `[readId: r1] src/core.ts contents\n${'c'.repeat(900)}`
      const filler = `unrelated grep noise\n${'f'.repeat(900)}`
      const messages = [
        toolResultMsg([{ id: 'tu_core', content: relevant }]),
        toolResultMsg([{ id: 'tu_noise', content: filler }]),
      ]
      const out = clampToolResultsInMessages(messages, {
        // Budget forces exactly one eviction.
        maxTotalChars: relevant.length + 100,
        perBlockCapChars: 10_000,
        relevanceTerms: ['src/core.ts'],
      })
      expect(blockContent(out, 0)).toBe(relevant)
      expect(blockContent(out, 1)).toContain('tool_result truncated')
    })

    it('matches terms case-insensitively against the block head', () => {
      const relevant = `Read SRC/Core.TS ok\n${'c'.repeat(900)}`
      const filler = `noise\n${'f'.repeat(900)}`
      const messages = [
        toolResultMsg([{ id: 'a', content: relevant }]),
        toolResultMsg([{ id: 'b', content: filler }]),
      ]
      const out = clampToolResultsInMessages(messages, {
        maxTotalChars: relevant.length + 100,
        perBlockCapChars: 10_000,
        relevanceTerms: ['src/core.ts'],
      })
      expect(blockContent(out, 0)).toBe(relevant)
      expect(blockContent(out, 1)).toContain('tool_result truncated')
    })

    it('no relevance terms ⇒ legacy oldest-first order unchanged', () => {
      const oldest = `[readId: r1] src/core.ts contents\n${'c'.repeat(900)}`
      const newest = `noise\n${'f'.repeat(900)}`
      const messages = [
        toolResultMsg([{ id: 'a', content: oldest }]),
        toolResultMsg([{ id: 'b', content: newest }]),
      ]
      const out = clampToolResultsInMessages(messages, {
        maxTotalChars: newest.length + 100,
        perBlockCapChars: 10_000,
      })
      expect(blockContent(out, 0)).toContain('tool_result truncated')
      expect(blockContent(out, 1)).toBe(newest)
    })

    it('relevant blocks are still evicted (oldest-first) once irrelevant ones are exhausted', () => {
      const rel1 = `src/core.ts pass one\n${'a'.repeat(900)}`
      const rel2 = `src/core.ts pass two\n${'b'.repeat(900)}`
      const messages = [
        toolResultMsg([{ id: 'a', content: rel1 }]),
        toolResultMsg([{ id: 'b', content: rel2 }]),
      ]
      const out = clampToolResultsInMessages(messages, {
        maxTotalChars: rel2.length + 100,
        perBlockCapChars: 10_000,
        relevanceTerms: ['src/core.ts'],
      })
      // Both relevant → falls back to oldest-first within the group.
      expect(blockContent(out, 0)).toContain('tool_result truncated')
      expect(blockContent(out, 1)).toBe(rel2)
    })

    it('honours the POLE_CLAMP_RELEVANCE=0 kill-switch', () => {
      vi.stubEnv('POLE_CLAMP_RELEVANCE', '0')
      const relevant = `src/core.ts contents\n${'c'.repeat(900)}`
      const filler = `noise\n${'f'.repeat(900)}`
      const messages = [
        toolResultMsg([{ id: 'a', content: relevant }]),
        toolResultMsg([{ id: 'b', content: filler }]),
      ]
      const out = clampToolResultsInMessages(messages, {
        maxTotalChars: filler.length + 100,
        perBlockCapChars: 10_000,
        relevanceTerms: ['src/core.ts'],
      })
      // Kill-switch ⇒ legacy oldest-first: the (relevant) oldest is clamped.
      expect(blockContent(out, 0)).toContain('tool_result truncated')
      expect(blockContent(out, 1)).toBe(filler)
    })
  })

  describe('tool-aware spill preview split (2026-07 uplift #13)', () => {
    it('shell tools get the tail-weighted split; others keep head-weighted', () => {
      expect(spillPreviewSplitForTool('bash')).toEqual({ head: 0.3, tail: 0.7 })
      expect(spillPreviewSplitForTool('PowerShell')).toEqual({ head: 0.3, tail: 0.7 })
      expect(spillPreviewSplitForTool('read_file')).toEqual({ head: 0.6, tail: 0.4 })
      expect(spillPreviewSplitForTool('Grep')).toEqual({ head: 0.6, tail: 0.4 })
    })

    it('bash spill preview keeps the trailing verdict visible', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-tr-split-'))
      vi.stubEnv('ASTRA_TOOL_RESULTS_DIR', dir)
      // Preview window is TOOL_RESULT_SPILL_PREVIEW_CHARS; build an output
      // much larger, with the verdict in the last line.
      const body = `${'log line\n'.repeat(20_000)}Tests: 3 failed, 97 passed\nVERDICT-LINE-AT-END`
      const out = applyToolResultSizeBudget(
        'bash',
        { success: true, output: body },
        { maxChars: 1_000, toolUseId: 'split-bash' },
      )
      expect(out.output).toContain('VERDICT-LINE-AT-END')
      fs.rmSync(dir, { recursive: true, force: true })
    })
  })

  it('spills oversized success output under ASTRA_TOOL_RESULTS_DIR', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-tr-'))
    vi.stubEnv('ASTRA_TOOL_RESULTS_DIR', dir)
    const body = 'x'.repeat(120)
    const out = applyToolResultSizeBudget(
      'read_file',
      { success: true, output: body },
      { maxChars: 20, toolUseId: 'spill-case' },
    )
    expect(out.persistedResultPath).toBeTruthy()
    const fp = out.persistedResultPath!
    expect(fp.startsWith(dir)).toBe(true)
    expect(fs.readFileSync(fp, 'utf8')).toBe(body)
    expect(out.output).toMatch(/too large/i)
    expect(out.output).toMatch(/Preview:/)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  describe('skill-instructions clamp protection (skill-adherence audit)', () => {
    const skillBlockContent = (bodyLen: number): string =>
      `Skill: my-flow\n\n<skill-instructions skill="my-flow">\n${'s'.repeat(bodyLen)}\n</skill-instructions>`

    const toolResultMsg = (
      blocks: Array<{ id: string; content: string }>,
    ): Record<string, unknown> => ({
      role: 'user',
      content: blocks.map((b) => ({
        type: 'tool_result',
        tool_use_id: b.id,
        content: b.content,
      })),
    })

    it('isSkillInstructionsBlock matches the framed Skill output only', () => {
      expect(isSkillInstructionsBlock(skillBlockContent(10))).toBe(true)
      expect(isSkillInstructionsBlock('Skill: x\n\nplain body, no envelope')).toBe(false)
      expect(isSkillInstructionsBlock('[readId: r1] file contents')).toBe(false)
    })

    it('pass 2 (global budget) skips skill blocks; siblings absorb the clamp', () => {
      const skill = skillBlockContent(500)
      const filler = 'f'.repeat(1_000)
      const messages = [
        // Oldest message holds the skill block — previously the first victim.
        toolResultMsg([{ id: 'tu_skill', content: skill }]),
        toolResultMsg([{ id: 'tu_fill', content: filler }]),
      ]
      const out = clampToolResultsInMessages(messages, {
        maxTotalChars: 800,
        perBlockCapChars: 10_000,
      })
      const skillBlock = (out[0].content as Array<Record<string, unknown>>)[0]
      const fillerBlock = (out[1].content as Array<Record<string, unknown>>)[0]
      expect(String(skillBlock.content)).toBe(skill)
      expect(String(fillerBlock.content)).toMatch(/truncated for context budget/)
    })

    it('pass 1 keeps the skill head + re-read hint instead of a bare placeholder (at the SKILL cap)', () => {
      // Skill blocks now clamp at `skillBlockCapChars`, NOT `perBlockCapChars`
      // (aligned to the Skill tool's 120k inline cap). Drive the truncation
      // path by lowering the skill cap explicitly.
      const skill = skillBlockContent(2_000)
      const messages = [toolResultMsg([{ id: 'tu_skill', content: skill }])]
      const out = clampToolResultsInMessages(messages, {
        maxTotalChars: 1_000_000,
        perBlockCapChars: 600,
        skillBlockCapChars: 600,
      })
      const block = (out[0].content as Array<Record<string, unknown>>)[0]
      const content = String(block.content)
      // Head survives (includes the Skill: header + envelope opening).
      expect(content.startsWith('Skill: my-flow')).toBe(true)
      expect(content).toContain('<skill-instructions')
      // Tail carries the recovery hint, not the generic placeholder.
      expect(content).toMatch(/skill instructions truncated at per-block cap/)
      expect(content).toMatch(/re-read SKILL\.md/)
      expect(content).not.toMatch(/^\[tool_result truncated/)
    })

    it('pass 1 leaves a skill block UNDER the skill cap untouched even when it exceeds perBlockCapChars', () => {
      // Regression guard for the 2026-06 fix: a 2k skill body with the generic
      // 600-char per-block cap must NOT be truncated — only the higher skill
      // cap (default 120k) governs skill blocks.
      const skill = skillBlockContent(2_000)
      const messages = [toolResultMsg([{ id: 'tu_skill', content: skill }])]
      const out = clampToolResultsInMessages(messages, {
        maxTotalChars: 1_000_000,
        perBlockCapChars: 600,
      })
      const block = (out[0].content as Array<Record<string, unknown>>)[0]
      expect(String(block.content)).toBe(skill)
    })
  })
})
