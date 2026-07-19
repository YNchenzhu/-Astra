/**
 * Codex-parity post-compact prefix rebuild (2026-07) — registry side.
 *
 * Covers:
 *   - `takeInvokedSkillsPromptFragmentForAgent` with `keepSkillNames`
 *     (active skill listed but NOT consumed)
 *   - `peekInvokedSkillRecordForAgent`
 *   - `renderActiveSkillRebuildBlock` (verbatim body + truncation notice)
 *   - `generatePostCompactAttachments` end-to-end: `activeSkillName`
 *     produces a verbatim `<skill-instructions>` rebuild that survives
 *     REPEATED compacts.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  peekInvokedSkillRecordForAgent,
  peekInvokedSkillsPromptFragmentForAgent,
  recordInvokedSkill,
  renderActiveSkillRebuildBlock,
  resetInvokedSkillsRegistryForTests,
  takeInvokedSkillsPromptFragmentForAgent,
} from './invokedSkillsRegistry'
import { INVOKED_SKILL_CONTENT_MAX_CHARS } from './discoveryBudget'
import { asAgentId } from '../tools/ids'
import {
  buildActiveSkillRebuildAttachment,
  generatePostCompactAttachments,
} from '../context/postCompactAttachments'

const MAIN = asAgentId('main')

function record(name: string, content: string): void {
  recordInvokedSkill({
    agentId: MAIN,
    skillName: name,
    skillPath: `C:/skills/${name}`,
    content,
  })
}

beforeEach(() => {
  resetInvokedSkillsRegistryForTests()
})

describe('takeInvokedSkillsPromptFragmentForAgent — keepSkillNames', () => {
  it('lists kept skills but does not consume them', () => {
    record('doc-format', '正文+空行+标题+正文')
    record('other-skill', 'other body')

    const frag = takeInvokedSkillsPromptFragmentForAgent(MAIN, {
      keepSkillNames: ['doc-format'],
    })
    expect(frag).toContain('doc-format')
    expect(frag).toContain('other-skill')

    // Kept entry survives; the other was consumed.
    expect(peekInvokedSkillRecordForAgent(MAIN, 'doc-format')).toBeDefined()
    expect(peekInvokedSkillRecordForAgent(MAIN, 'other-skill')).toBeUndefined()
    const secondPeek = peekInvokedSkillsPromptFragmentForAgent(MAIN)
    expect(secondPeek).toContain('doc-format')
    expect(secondPeek).not.toContain('other-skill')
  })

  it('behaves exactly like the legacy consume-all when opts are omitted', () => {
    record('doc-format', 'body')
    const first = takeInvokedSkillsPromptFragmentForAgent(MAIN)
    expect(first).toContain('doc-format')
    expect(takeInvokedSkillsPromptFragmentForAgent(MAIN)).toBe('')
  })
})

describe('renderActiveSkillRebuildBlock', () => {
  it('re-emits the recorded body verbatim inside <skill-instructions>', () => {
    record('doc-format', '## 格式\n\n正文+空行+标题+正文')
    const rec = peekInvokedSkillRecordForAgent(MAIN, 'doc-format')!
    const block = renderActiveSkillRebuildBlock(rec)
    expect(block).toContain('<skill-instructions skill="doc-format"')
    expect(block).toContain('source="C:/skills/doc-format/SKILL.md"')
    expect(block).toContain('## 格式\n\n正文+空行+标题+正文')
    expect(block).toContain('</skill-instructions>')
    expect(block).toContain('ACTIVE workflow directive')
    expect(block).not.toContain('[NOTE: the text above is a truncated HEAD')
  })

  it('labels a cap-truncated body explicitly with the re-read path', () => {
    record('big-skill', 'x'.repeat(INVOKED_SKILL_CONTENT_MAX_CHARS + 500))
    const rec = peekInvokedSkillRecordForAgent(MAIN, 'big-skill')!
    expect(rec.content.length).toBe(INVOKED_SKILL_CONTENT_MAX_CHARS)
    const block = renderActiveSkillRebuildBlock(rec)
    expect(block).toContain('[NOTE: the text above is a truncated HEAD')
    expect(block).toContain('C:/skills/big-skill/SKILL.md')
  })

  it('returns empty string for a blank body', () => {
    const block = renderActiveSkillRebuildBlock({
      skillName: 's',
      skillPath: '',
      content: '   ',
      invokedAt: Date.now(),
      agentId: MAIN,
    })
    expect(block).toBe('')
  })
})

describe('generatePostCompactAttachments — active-skill verbatim rebuild', () => {
  it('includes the verbatim body when activeSkillName is set', async () => {
    record('doc-format', '正文+空行+标题+正文（无标题后空行）')
    const atts = await generatePostCompactAttachments({
      messages: [],
      agentId: 'main',
      activeSkillName: 'doc-format',
    })
    const skillAtt = atts.find((a) => a._attachmentKind === 'skills')
    expect(skillAtt).toBeDefined()
    expect(skillAtt!.content).toContain('<skill-instructions skill="doc-format"')
    expect(skillAtt!.content).toContain('正文+空行+标题+正文（无标题后空行）')
    // Metadata listing still present alongside the rebuild block.
    expect(skillAtt!.content).toContain('<invoked-skills>')
  })

  it('survives repeated compacts: the active entry is not consumed', async () => {
    record('doc-format', 'rules body')
    const first = await generatePostCompactAttachments({
      messages: [],
      agentId: 'main',
      activeSkillName: 'doc-format',
    })
    expect(first.find((a) => a._attachmentKind === 'skills')!.content).toContain(
      'rules body',
    )

    // Second compact in the same session — must still rebuild.
    const second = await generatePostCompactAttachments({
      messages: [],
      agentId: 'main',
      activeSkillName: 'doc-format',
    })
    const att = second.find((a) => a._attachmentKind === 'skills')
    expect(att).toBeDefined()
    expect(att!.content).toContain('rules body')
  })

  it('buildActiveSkillRebuildAttachment (SM-compact path) is peek-only', () => {
    record('doc-format', 'rules body')
    const att = buildActiveSkillRebuildAttachment('main', 'doc-format')
    expect(att).toBeDefined()
    expect(att!._attachmentKind).toBe('skills')
    expect(att!.content).toContain('<skill-instructions skill="doc-format"')
    expect(att!.content).toContain('rules body')

    // Nothing consumed: record and metadata listing both intact.
    expect(peekInvokedSkillRecordForAgent(MAIN, 'doc-format')).toBeDefined()
    expect(peekInvokedSkillsPromptFragmentForAgent(MAIN)).toContain('doc-format')

    // Null cases: no active name / unknown skill.
    expect(buildActiveSkillRebuildAttachment('main', undefined)).toBeNull()
    expect(buildActiveSkillRebuildAttachment('main', 'nope')).toBeNull()
  })

  it('falls back to metadata-only when no session is active (legacy shape + consume)', async () => {
    record('doc-format', 'rules body')
    const first = await generatePostCompactAttachments({
      messages: [],
      agentId: 'main',
    })
    const att = first.find((a) => a._attachmentKind === 'skills')
    expect(att).toBeDefined()
    expect(att!.content).toContain('<invoked-skills>')
    expect(att!.content).not.toContain('rules body')

    // Legacy consume semantics preserved: nothing left for a second pass.
    const second = await generatePostCompactAttachments({
      messages: [],
      agentId: 'main',
    })
    expect(second.find((a) => a._attachmentKind === 'skills')).toBeUndefined()
  })
})
