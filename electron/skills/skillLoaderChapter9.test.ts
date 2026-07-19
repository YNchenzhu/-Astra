import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  clearDynamicSkills,
  createSkillLoader,
  getDynamicSkills,
} from './loader'

function skillMd(name: string, desc: string, paths?: string): string {
  const pathsBlock =
    paths !== undefined
      ? `paths:
  - "${paths}"
`
      : ''
  return `---
name: ${name}
description: ${desc}
${pathsBlock}---
Body for ${name}.`
}

describe('skill loader chapter 9 (AC-9.4)', () => {
  afterEach(() => {
    clearDynamicSkills()
  })

  it('loads all seven origin slots (1–7) with distinct skills', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-sk7-home-'))
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-sk7-ws-'))
    const tmpUd = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-sk7-ud-'))

    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome)

    const mk = (base: string, slotName: string, desc: string) => {
      fs.mkdirSync(path.join(base, slotName), { recursive: true })
      fs.writeFileSync(path.join(base, slotName, 'SKILL.md'), skillMd(slotName, desc))
    }

    try {
      mk(path.join(tmpHome, '.cursor', 'skills'), 'slot1-skill', 'slot-1')
      mk(path.join(tmpHome, '.claude', 'skills'), 'slot2-skill', 'slot-2')
      mk(path.join(tmpUd, 'skills'), 'slot3-skill', 'slot-3')
      mk(path.join(tmpWs, '.cursor', 'skills'), 'slot4-skill', 'slot-4')
      mk(path.join(tmpWs, '.agents', 'skills'), 'slot5-skill', 'slot-5')
      mk(path.join(tmpWs, '.claude', 'skills'), 'slot6-skill', 'slot-6')
      mk(path.join(tmpWs, '.claude', 'commands'), 'slot7-skill', 'slot-7')

      const loader = createSkillLoader()
      const skills = loader.loadAll(tmpWs, tmpUd)
      const byName = new Map(skills.map((s) => [s.name, s]))

      for (let i = 1; i <= 7; i++) {
        const s = byName.get(`slot${i}-skill`)
        expect(s, `missing slot${i}-skill`).toBeTruthy()
        expect(s!.description).toBe(`slot-${i}`)
        expect(s!.originSlot).toBe(i)
      }
    } finally {
      homedirSpy.mockRestore()
    }
  })

  it('project slot 4 overrides user slot 1 for same skill id', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-sk-home-'))
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-sk-ws-'))

    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome)

    try {
      fs.mkdirSync(path.join(tmpHome, '.cursor', 'skills', 'dup-skill'), { recursive: true })
      fs.writeFileSync(
        path.join(tmpHome, '.cursor', 'skills', 'dup-skill', 'SKILL.md'),
        skillMd('dup-skill', 'from-user-slot'),
      )

      fs.mkdirSync(path.join(tmpWs, '.cursor', 'skills', 'dup-skill'), { recursive: true })
      fs.writeFileSync(
        path.join(tmpWs, '.cursor', 'skills', 'dup-skill', 'SKILL.md'),
        skillMd('dup-skill', 'from-project-slot'),
      )

      const loader = createSkillLoader()
      const skills = loader.loadAll(tmpWs, undefined)
      const dup = skills.find((s) => s.name === 'dup-skill')
      expect(dup?.description).toBe('from-project-slot')
      expect(dup?.originSlot).toBe(4)
    } finally {
      homedirSpy.mockRestore()
    }
  })

  it('activates conditional skill when path matches (activateConditionalSkillsForPaths)', () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-sk-cond-'))

    fs.mkdirSync(path.join(tmpWs, '.claude', 'skills', 'cond-skill'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpWs, '.claude', 'skills', 'cond-skill', 'SKILL.md'),
      skillMd('cond-skill', 'Conditional', 'src/**'),
    )

    addSkillDirectories([path.join(tmpWs, '.claude', 'skills')])

    const rel = path.join('src', 'foo.ts').split(path.sep).join('/')
    const activated = activateConditionalSkillsForPaths([rel], tmpWs)
    expect(activated).toContain('cond-skill')

    const dyn = getDynamicSkills().find((s) => s.name === 'cond-skill')
    expect(dyn?.name).toBe('cond-skill')
  })
})
