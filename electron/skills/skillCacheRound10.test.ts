/**
 * Round-10 skill-cache integrity test (skill-subsystem integration).
 *
 * Question under test (operator report 2026-06): "after the AI edits files
 * and goes to VERIFY around round 10, when it re-reads the conversation
 * cache, is the COMPLETE skill content still there?"
 *
 * What actually happens at round 10:
 *   - The inline skill body is injected ONCE (round 1) as a `tool_result`
 *     produced by `formatInlineSkillInstructionsOutput` (the real Skill
 *     tool formatter).
 *   - Every subsequent model call runs the WHOLE message history through
 *     `clampToolResultsInMessages` (see `queryLoopPreModel.ts` →
 *     `phases.push('tool_result_budget')`). So what the model "reads from
 *     cache" at round 10 is the CLAMPED view, not the raw injected body.
 *
 * The clamp has two passes:
 *   - Pass 1 (per-block cap = DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000):
 *     runs UNCONDITIONALLY. Skill blocks are kept as a HEAD slice (not a
 *     bare placeholder), but anything past 50k chars is dropped.
 *   - Pass 2 (global budget, oldest-first): skill blocks are EXEMPT.
 *
 * Conclusions this test pins:
 *   A. Real bundled skills (largest today ≈ 21 KB) survive round-10 cache
 *      reads INTACT — Pass 1 never bites (< 50k) and Pass 2 exempts them.
 *      => For normal skills the cache is NOT losing content.
 *   B. Large skills (50k–120k) now also survive intact at round 10: the
 *      per-round clamp's skill-block cap is aligned to the Skill tool's own
 *      inline cap (120k, shared via SKILL_INSTRUCTIONS_BLOCK_CAP_CHARS), so
 *      a body that rode WHOLE at injection is no longer head-truncated on
 *      later rounds. (Before the 2026-06 fix it was cut to 50k from round 2
 *      on, deleting the tail workflow steps the model verifies against.)
 *   C. The cap still exists — a pathological >120k skill body is still
 *      head-truncated, just at the higher 120k boundary.
 */

import { describe, expect, it, beforeAll } from 'vitest'
import { formatInlineSkillInstructionsOutput } from './skillTool'
import {
  applyToolResultSizeBudget,
  clampToolResultsInMessages,
  isSkillInstructionsBlock,
} from '../ai/toolResultBudget'
import {
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
  SKILL_INSTRUCTIONS_BLOCK_CAP_CHARS,
} from '../constants/toolLimits'

type ApiMessage = Record<string, unknown>
type Block = Record<string, unknown>

/** The Skill tool's own inline cap (skillTool.ts `maxResultChars`), now shared. */
const SKILL_TOOL_INLINE_CAP = SKILL_INSTRUCTIONS_BLOCK_CAP_CHARS

function toolResultMsg(blocks: Array<{ id: string; content: string }>): ApiMessage {
  return {
    role: 'user',
    content: blocks.map((b) => ({
      type: 'tool_result',
      tool_use_id: b.id,
      content: b.content,
    })),
  }
}

function assistantToolUseMsg(id: string, name: string): ApiMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input: {} }],
  }
}

/** A realistic large read_file result (carries the load-bearing [readId:] prefix). */
function readFileResult(n: number, bytes: number): { id: string; content: string } {
  const id = `tu_read_${n}`
  const body = `[readId: read-r${n}] — file body follows\n` + 'X'.repeat(bytes)
  return { id, content: body }
}

/**
 * Build a faithful round-10 conversation:
 *   round 1  : Skill tool_result (the injected skill body)
 *   rounds 2-10: 9 edit/read iterations whose read results create budget pressure.
 * Returns the FULL apiMessages array as it would exist when the model is
 * about to make its 10th call (the "verify my edits" turn).
 */
function buildRound10History(skillBlock: string, fillerBytesEach: number): ApiMessage[] {
  const msgs: ApiMessage[] = []
  // Round 1 — invoke the skill.
  msgs.push(assistantToolUseMsg('tu_skill', 'Skill'))
  msgs.push(toolResultMsg([{ id: 'tu_skill', content: skillBlock }]))
  // Rounds 2-10 — file edits + reads (the read results are the budget hogs).
  for (let r = 2; r <= 10; r++) {
    msgs.push(assistantToolUseMsg(`tu_read_${r}`, 'read_file'))
    msgs.push(toolResultMsg([readFileResult(r, fillerBytesEach)]))
  }
  return msgs
}

/** Pull the (single) skill tool_result block back out of a clamped history. */
function extractSkillBlock(messages: ApiMessage[]): Block | undefined {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content as Block[]) {
      if (b.type === 'tool_result' && b.tool_use_id === 'tu_skill') return b
    }
  }
  return undefined
}

describe('round-10 skill cache integrity (skill subsystem integration)', () => {
  let realSkillBody: string

  beforeAll(() => {
    // Use the largest real-shaped skill body we ship (~21 KB, proactive-agent)
    // as a stand-in. We construct it through the REAL formatter so the framing
    // (Skill: header + <skill-instructions> envelope + trailer) is identical
    // to production — that framing is exactly what the clamp keys on.
    const body = [
      '# proactive-agent workflow',
      '',
      ...Array.from({ length: 400 }, (_, i) => `Step ${i + 1}: do the thing number ${i + 1} carefully and verify it.`),
    ].join('\n')
    realSkillBody = body
  })

  it('A — a normal-sized skill (~21 KB) survives the round-10 cache read INTACT', () => {
    const skillBlock = formatInlineSkillInstructionsOutput('proactive-agent', undefined, realSkillBody)
    expect(isSkillInstructionsBlock(skillBlock)).toBe(true)
    expect(skillBlock.length).toBeLessThan(DEFAULT_MAX_RESULT_SIZE_CHARS)

    // 9 reads × 30 KB = 270 KB > 200 KB default total budget → Pass 2 fires
    // on the filler, but the skill block must be untouched.
    const history = buildRound10History(skillBlock, 30_000)
    const totalBefore = history
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as Block[]) : []))
      .filter((b) => b.type === 'tool_result')
      .reduce((n, b) => n + String(b.content).length, 0)
    expect(totalBefore).toBeGreaterThan(MAX_TOOL_RESULTS_PER_MESSAGE_CHARS)

    // This is EXACTLY what queryLoopPreModel runs before the round-10 call.
    const clamped = clampToolResultsInMessages(history)
    const skillAfter = extractSkillBlock(clamped)
    expect(skillAfter).toBeDefined()

    // The complete, byte-identical skill body is still in the cache.
    expect(String(skillAfter!.content)).toBe(skillBlock)
    expect(String(skillAfter!.content)).toContain(realSkillBody)
    // No truncation markers leaked into the skill block.
    expect(String(skillAfter!.content)).not.toMatch(/truncated/)
  })

  it('B — a LARGE skill (50k–120k) now survives the round-10 cache read INTACT (the fix)', () => {
    // A doc-heavy SKILL.md whose body is 80 KB. The Skill tool deliberately
    // allows this (maxResultChars = 120k), so it reaches history WHOLE.
    const bigBody =
      'HEAD-MARKER-step-1\n' +
      'm'.repeat(80_000) +
      '\nTAIL-MARKER-final-verification-step'
    const skillBlock = formatInlineSkillInstructionsOutput('superdesign', undefined, bigBody)
    expect(skillBlock.length).toBeGreaterThan(DEFAULT_MAX_RESULT_SIZE_CHARS)
    expect(skillBlock.length).toBeLessThan(SKILL_TOOL_INLINE_CAP)

    // 1) At tool-execution time the Skill tool keeps it WHOLE (no disk spill),
    //    because its inline cap is 120k.
    const atInjection = applyToolResultSizeBudget(
      'Skill',
      { success: true, output: skillBlock },
      { maxChars: SKILL_TOOL_INLINE_CAP, toolUseId: 'tu_skill' },
    )
    expect(atInjection.persistedResultPath).toBeUndefined()
    expect(atInjection.output).toContain('TAIL-MARKER-final-verification-step')

    // 2) By round 10 the per-round history clamp now uses the SAME 120k skill
    //    cap, so the tail — the final verification step — is STILL THERE.
    const history = buildRound10History(skillBlock, 30_000) // 9×30k → Pass 2 fires on filler
    const totalBefore = history
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as Block[]) : []))
      .filter((b) => b.type === 'tool_result')
      .reduce((n, b) => n + String(b.content).length, 0)
    expect(totalBefore).toBeGreaterThan(MAX_TOOL_RESULTS_PER_MESSAGE_CHARS)

    const clamped = clampToolResultsInMessages(history)
    const skillAfter = extractSkillBlock(clamped)
    expect(skillAfter).toBeDefined()
    const cached = String(skillAfter!.content)

    // Byte-identical: head AND tail both present, no truncation marker.
    expect(cached).toBe(skillBlock)
    expect(cached).toContain('HEAD-MARKER-step-1')
    expect(cached).toContain('TAIL-MARKER-final-verification-step')
    expect(cached).not.toMatch(/truncated/)
  })

  it('C — the cap still bites a PATHOLOGICAL >120k skill (head-sliced at the 120k boundary)', () => {
    const hugeBody = 'HEAD-MARKER\n' + 'm'.repeat(SKILL_TOOL_INLINE_CAP + 20_000) + '\nTAIL-MARKER'
    const skillBlock = formatInlineSkillInstructionsOutput('huge', undefined, hugeBody)
    expect(skillBlock.length).toBeGreaterThan(SKILL_TOOL_INLINE_CAP)

    const history = buildRound10History(skillBlock, 1_000)
    const clamped = clampToolResultsInMessages(history)
    const cached = String(extractSkillBlock(clamped)!.content)

    expect(cached.startsWith('Skill: huge')).toBe(true)
    expect(cached).toContain('HEAD-MARKER')
    expect(cached).toMatch(/skill instructions truncated at per-block cap 120000/)
    expect(cached).not.toContain('TAIL-MARKER')
    // Head kept up to the 120k boundary (+ the appended recovery note).
    expect(cached.length).toBeLessThanOrEqual(SKILL_TOOL_INLINE_CAP + 400)
  })

  it('cap-alignment — the clamp skill cap equals the Skill tool inline cap (no drift)', () => {
    expect(SKILL_INSTRUCTIONS_BLOCK_CAP_CHARS).toBe(120_000)
    expect(SKILL_TOOL_INLINE_CAP).toBe(SKILL_INSTRUCTIONS_BLOCK_CAP_CHARS)
  })
})
