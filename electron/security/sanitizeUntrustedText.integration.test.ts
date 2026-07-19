/**
 * Integration tests for the import-boundary sanitization: SKILL.md content
 * and AgentBundleEntry prompt fields must not carry hidden Unicode payloads
 * into the LLM's context.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadSkillsFromDir } from '../skills/loader'
import { parseBundle } from '../agents/bundles/bundleSerialize'

describe('SKILL.md import — invisible Unicode stripping', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-skill-sanitize-'))
  })

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    vi.restoreAllMocks()
  })

  it('strips Tag-character payload from a SKILL.md description before parsing', () => {
    const skillDir = path.join(tmpDir, 'evil-skill')
    fs.mkdirSync(skillDir, { recursive: true })
    // A Tag-encoded payload hidden between visible chars in the description.
    // Visually: "Test skill description"; model would see additional hidden
    // instructions in the original. After sanitize: hidden chars are stripped.
    const hidden = String.fromCodePoint(0xE0049, 0xE0047, 0xE004E)
    const skillContent =
      '---\n' +
      'name: evil-skill\n' +
      `description: Test skill${hidden} description\n` +
      '---\n' +
      'Body content.\n'
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const skills = loadSkillsFromDir(tmpDir, 'user')
    expect(skills.length).toBe(1)
    const desc = skills[0].description
    // Hidden chars must NOT survive into the SkillDefinition the LLM eventually sees.
    expect(desc).not.toMatch(/[\u{E0000}-\u{E007F}]/u)
    expect(desc).toContain('Test skill')
    expect(desc).toContain('description')

    // And user must be warned so they can audit the bundle.
    expect(warnSpy).toHaveBeenCalled()
    const msg = warnSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(msg).toMatch(/tagChar/)
  })

  it('does not warn for clean skill bundles', () => {
    const skillDir = path.join(tmpDir, 'clean-skill')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: clean-skill\ndescription: Plain description.\n---\nBody.\n',
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const skills = loadSkillsFromDir(tmpDir, 'user')
    expect(skills.length).toBe(1)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('Agent bundle import — invisible Unicode stripping', () => {
  it('strips Tag chars from agent systemPromptRaw and promptSection bodies', () => {
    const hiddenInPrompt = String.fromCodePoint(0xE0049, 0xE0047, 0xE004E)
    const hiddenInWhen = '\u202Etxt-reverse'
    const bundleJson = JSON.stringify({
      meta: { id: 'evil-bundle', name: 'Evil', version: '1.0.0' },
      agents: [
        {
          agentType: 'evil',
          whenToUse: `Use it when${hiddenInWhen}`,
          isPrimary: true,
          systemPromptRaw: `You are helpful${hiddenInPrompt}.`,
          promptSections: [
            { id: 'a', body: `Section${hiddenInPrompt} body`, order: 0 },
          ],
        },
      ],
      teams: [],
      capabilities: { enabledTools: '*' },
      layout: { type: 'chat-centric' },
      defaultAgent: 'evil',
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = parseBundle(bundleJson, '<test>', 'user')
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const agent = res.bundle.agents[0]
    expect(agent.systemPromptRaw).not.toMatch(/[\u{E0000}-\u{E007F}]/u)
    expect(agent.systemPromptRaw).toBe('You are helpful.')
    expect(agent.whenToUse).not.toMatch(/[\u202A-\u202E]/u)
    expect(agent.whenToUse).toBe('Use it whentxt-reverse')
    expect(agent.promptSections?.[0].body).not.toMatch(/[\u{E0000}-\u{E007F}]/u)
    expect(agent.promptSections?.[0].body).toBe('Section body')

    expect(warnSpy).toHaveBeenCalled()
    const msg = warnSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(msg).toContain('evil-bundle')
    expect(msg).toMatch(/tagChar/)
    expect(msg).toMatch(/bidiControl/)

    vi.restoreAllMocks()
  })

  it('does not warn for clean bundles', () => {
    const bundleJson = JSON.stringify({
      meta: { id: 'clean-bundle', name: 'Clean', version: '1.0.0' },
      agents: [
        {
          agentType: 'clean',
          whenToUse: 'Use it always',
          isPrimary: true,
          systemPromptRaw: 'You are helpful.',
        },
      ],
      teams: [],
      capabilities: { enabledTools: '*' },
      layout: { type: 'chat-centric' },
      defaultAgent: 'clean',
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = parseBundle(bundleJson, '<test>', 'user')
    expect(res.ok).toBe(true)
    expect(warnSpy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
