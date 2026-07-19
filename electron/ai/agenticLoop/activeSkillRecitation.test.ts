/**
 * Active-skill recitation (Codex parity, 2026-07) — ephemeral tail
 * re-surfacing of the active inline skill's workflow text.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  ACTIVE_SKILL_RECITATION_MARKER,
  RECITATION_MIN_TURNS_SINCE_SKILL_LOAD,
  RECITED_SKILL_BODY_MAX_CHARS,
  appendEphemeralActiveSkillRecitation,
  buildActiveSkillRecitationText,
  withEphemeralActiveSkillRecitation,
} from './activeSkillRecitation'
import {
  recordInvokedSkill,
  resetInvokedSkillsRegistryForTests,
} from '../../skills/invokedSkillsRegistry'
import { asAgentId } from '../../tools/ids'

type Msg = Record<string, unknown>

const MAIN = asAgentId('main')

function assistantTextTurn(text: string): Msg {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

function skillLoadTurn(): Msg {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu_skill', name: 'Skill', input: {} }],
  }
}

/** Transcript with the Skill load `turns` assistant turns in the past. */
function transcriptWithSkillLoad(turnsSince: number): Msg[] {
  const msgs: Msg[] = [
    { role: 'user', content: '用 doc-format 排版' },
    skillLoadTurn(),
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_skill', content: 'Skill: doc-format' }] },
  ]
  for (let i = 0; i < turnsSince; i++) {
    msgs.push(assistantTextTurn(`turn ${i}`))
    msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] })
  }
  return msgs
}

beforeEach(() => {
  resetInvokedSkillsRegistryForTests()
  recordInvokedSkill({
    agentId: MAIN,
    skillName: 'doc-format',
    skillPath: 'C:/skills/doc-format',
    content: '## 格式规则\n正文+空行+标题+正文',
  })
})

afterEach(() => {
  delete process.env.POLE_ACTIVE_SKILL_RECITATION
  resetInvokedSkillsRegistryForTests()
})

describe('buildActiveSkillRecitationText', () => {
  it('renders marker, envelope, verbatim body, and no truncation note when it fits', () => {
    const text = buildActiveSkillRecitationText({
      skillName: 'doc-format',
      skillPath: 'C:/skills/doc-format',
      content: '## 格式规则\n正文+空行+标题+正文',
    })!
    expect(text).toContain(ACTIVE_SKILL_RECITATION_MARKER)
    expect(text).toContain('<skill-instructions skill="doc-format"')
    expect(text).toContain('## 格式规则\n正文+空行+标题+正文')
    expect(text).not.toContain('[NOTE: truncated for recitation')
  })

  it('cuts oversized bodies at a newline and appends an explicit truncation note', () => {
    const body = Array.from({ length: 500 }, (_, i) => `rule line ${i}`).join('\n')
    expect(body.length).toBeGreaterThan(RECITED_SKILL_BODY_MAX_CHARS)
    const text = buildActiveSkillRecitationText({
      skillName: 'big',
      skillPath: 'C:/skills/big',
      content: body,
    })!
    expect(text).toContain('[NOTE: truncated for recitation')
    expect(text).toContain('C:/skills/big/SKILL.md')
    // Cut lands on a line boundary — no half-line rules.
    const recited = text.slice(text.indexOf('>') + 1, text.indexOf('</skill-instructions>'))
    for (const line of recited.trim().split('\n')) {
      expect(line).toMatch(/^rule line \d+$/)
    }
  })

  it('returns null for an empty body', () => {
    expect(
      buildActiveSkillRecitationText({ skillName: 's', skillPath: '', content: ' ' }),
    ).toBeNull()
  })
})

describe('appendEphemeralActiveSkillRecitation', () => {
  it('appends to a trailing user message without mutating the input', () => {
    const messages: Msg[] = [{ role: 'user', content: 'hello' }]
    const out = appendEphemeralActiveSkillRecitation(messages, 'RECITE')
    expect(out).not.toBe(messages)
    expect(messages[0].content).toBe('hello')
    expect(out[0].content).toContain('hello')
    expect(out[0].content).toContain('RECITE')
    expect(out[0].content).toContain('<system-reminder>')
  })

  it('pushes a standalone user message when the tail is an assistant turn', () => {
    const messages: Msg[] = [assistantTextTurn('done')]
    const out = appendEphemeralActiveSkillRecitation(messages, 'RECITE')
    expect(out).toHaveLength(2)
    expect(out[1].role).toBe('user')
    expect(String(out[1].content)).toContain('RECITE')
  })
})

describe('withEphemeralActiveSkillRecitation — gates', () => {
  it('recites once the skill load is old enough', () => {
    const messages = transcriptWithSkillLoad(RECITATION_MIN_TURNS_SINCE_SKILL_LOAD)
    const out = withEphemeralActiveSkillRecitation(messages, {
      activeSkillName: 'doc-format',
    })
    expect(out).not.toBe(messages)
    const tail = JSON.stringify(out[out.length - 1])
    expect(tail).toContain('doc-format')
    expect(tail).toContain('正文+空行+标题+正文')
  })

  it('no-ops right after the skill was loaded (full tool_result still recent)', () => {
    const messages = transcriptWithSkillLoad(RECITATION_MIN_TURNS_SINCE_SKILL_LOAD - 1)
    const out = withEphemeralActiveSkillRecitation(messages, {
      activeSkillName: 'doc-format',
    })
    expect(out).toBe(messages)
  })

  it('no-ops without an active skill session', () => {
    const messages = transcriptWithSkillLoad(5)
    expect(withEphemeralActiveSkillRecitation(messages, {})).toBe(messages)
    expect(
      withEphemeralActiveSkillRecitation(messages, { activeSkillName: '  ' }),
    ).toBe(messages)
  })

  it('no-ops when the registry has no record for the skill', () => {
    const messages = transcriptWithSkillLoad(5)
    const out = withEphemeralActiveSkillRecitation(messages, {
      activeSkillName: 'unknown-skill',
    })
    expect(out).toBe(messages)
  })

  it('POLE_ACTIVE_SKILL_RECITATION=0 disables the recitation', () => {
    process.env.POLE_ACTIVE_SKILL_RECITATION = '0'
    const messages = transcriptWithSkillLoad(5)
    const out = withEphemeralActiveSkillRecitation(messages, {
      activeSkillName: 'doc-format',
    })
    expect(out).toBe(messages)
  })

  it('is ephemeral: repeated calls never accumulate in the source array', () => {
    const messages = transcriptWithSkillLoad(5)
    const lenBefore = messages.length
    withEphemeralActiveSkillRecitation(messages, { activeSkillName: 'doc-format' })
    withEphemeralActiveSkillRecitation(messages, { activeSkillName: 'doc-format' })
    expect(messages.length).toBe(lenBefore)
    expect(JSON.stringify(messages)).not.toContain(ACTIVE_SKILL_RECITATION_MARKER)
  })
})
