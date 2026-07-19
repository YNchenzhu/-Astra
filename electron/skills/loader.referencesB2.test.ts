/**
 * Self-audit fix B2 (2026-05) — pins the references/scripts memory
 * contract: bodies must STAY ON DISK, only filename lists end up in
 * `SkillDefinition.references` / `.scripts`.
 *
 * Coverage:
 *   - structural shape (string[], not Record<string, string>)
 *   - filename allowlist (extension filter still applied)
 *   - body content NOT loaded (no GB-sized RAM bloat from a
 *     hypothetical large reference)
 *   - empty subdir → undefined (rather than [])
 *   - `executeSkill` surfaces the filename list as a single inline
 *     line, not per-file headings with body content
 */

import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  clearDynamicSkills,
  loadSkillsFromDir,
} from './loader'
import { executeSkill, initSkills } from './skillTool'

interface TmpEnv {
  skillsDir: string
  cleanup: () => void
}

function mkSkillsRoot(): TmpEnv {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-b2-'))
  return {
    skillsDir: tmp,
    cleanup: () => {
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    },
  }
}

function writeSkill(
  skillsDir: string,
  name: string,
  opts: {
    body?: string
    references?: Record<string, string>
    scripts?: Record<string, string>
  } = {},
): string {
  const dir = path.join(skillsDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    opts.body ??
      `---
name: ${name}
description: ${name} skill
---
Skill body here.`,
  )
  if (opts.references) {
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true })
    for (const [fname, content] of Object.entries(opts.references)) {
      fs.writeFileSync(path.join(dir, 'references', fname), content)
    }
  }
  if (opts.scripts) {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    for (const [fname, content] of Object.entries(opts.scripts)) {
      fs.writeFileSync(path.join(dir, 'scripts', fname), content)
    }
  }
  return dir
}

describe('B2 — references / scripts stored as filename lists (no body content)', () => {
  let env: TmpEnv | null = null
  afterEach(() => {
    env?.cleanup()
    env = null
    clearDynamicSkills()
  })

  it('surfaces filename list as string[] (not Record<string, string>)', () => {
    env = mkSkillsRoot()
    writeSkill(env.skillsDir, 'demo', {
      references: { 'a.md': 'aaa', 'b.txt': 'bbb' },
      scripts: { 'do.sh': 'echo ok' },
    })
    const [skill] = loadSkillsFromDir(env.skillsDir, 'project')
    expect(Array.isArray(skill.references)).toBe(true)
    expect(Array.isArray(skill.scripts)).toBe(true)
    expect(skill.references).toEqual(expect.arrayContaining(['a.md', 'b.txt']))
    expect(skill.scripts).toEqual(['do.sh'])
  })

  it('does NOT carry body content in the loaded SkillDefinition (RAM regression guard)', () => {
    env = mkSkillsRoot()
    const giantPayload = 'X'.repeat(500_000)
    writeSkill(env.skillsDir, 'big-refs', {
      references: { 'giant.md': giantPayload },
    })
    const [skill] = loadSkillsFromDir(env.skillsDir, 'project')

    // Filename surfaces.
    expect(skill.references).toEqual(['giant.md'])

    // The 500KB body must not be in the in-memory representation.
    const serialized = JSON.stringify(skill)
    expect(serialized).not.toContain(giantPayload)
    expect(serialized.length).toBeLessThan(50_000)
  })

  it('returns undefined when the subdir is empty / nonexistent (no zombie [])', () => {
    env = mkSkillsRoot()
    writeSkill(env.skillsDir, 'no-refs', {})
    const [skill] = loadSkillsFromDir(env.skillsDir, 'project')
    expect(skill.references).toBeUndefined()
    expect(skill.scripts).toBeUndefined()
  })

  it('respects the extension allowlist (stray .bin not surfaced)', () => {
    env = mkSkillsRoot()
    const dir = writeSkill(env.skillsDir, 'mixed', {
      references: { 'doc.md': 'ok' },
    })
    fs.writeFileSync(path.join(dir, 'references', 'stray.bin'), 'BINARY')

    const [skill] = loadSkillsFromDir(env.skillsDir, 'project')
    expect(skill.references).toEqual(['doc.md'])
  })

  it('executeSkill output surfaces references via the <skill-resources> manifest (no body content)', async () => {
    env = mkSkillsRoot()
    writeSkill(env.skillsDir, 'inline-ref', {
      references: {
        'guide.md': '# Guide to widget wiring\n\nBODY TEXT SHOULD NOT APPEAR IN PROMPT',
      },
    })

    // Drive `executeSkill` through `initSkills` so the in-memory registry
    // picks up our temp skill. We pass `userDataPath` separately so user
    // skills from any real `~/.cursor` are not pulled in.
    initSkills(env.skillsDir.replace(/\.cursor.*$/, ''), undefined)
    // Direct disk path scan (slot 5 / .agents/skills) — easier to use
    // the dynamic-add API since our temp dir doesn't follow the seven-
    // slot layout. We re-use loadSkillsFromDir + addSkillDirectories.
    const skills = loadSkillsFromDir(env.skillsDir, 'project')
    // Manually push into the registry by re-initializing via a
    // virtual workspace whose `.claude/skills` IS our temp dir.
    const fakeWs = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-b2-ws-'))
    const realSkillsDir = path.join(fakeWs, '.claude', 'skills')
    fs.mkdirSync(realSkillsDir, { recursive: true })
    for (const s of skills) {
      const srcName = path.basename(s.resolvedPath || '')
      const dst = path.join(realSkillsDir, srcName)
      fs.cpSync(path.join(env.skillsDir, srcName), dst, { recursive: true })
    }
    initSkills(fakeWs, undefined)
    try {
      const result = await executeSkill('inline-ref', undefined, { invoker: 'user' })
      expect(result.success).toBe(true)
      expect(result.expandedPrompt).toBeDefined()
      const prompt = result.expandedPrompt!
      // Filename mentioned, with FULL on-disk path inside the manifest
      // (skill-resource attention uplift, 2026-07 — replaced the old
      // bare "Available references (read on demand): …" line).
      expect(prompt).toContain('<skill-resources')
      expect(prompt).toMatch(/references\/guide\.md/)
      // The bounded hint (first heading) rides along…
      expect(prompt).toContain('Guide to widget wiring')
      // …but the body itself stays on disk (B2 contract unchanged).
      expect(prompt).not.toContain('BODY TEXT SHOULD NOT APPEAR IN PROMPT')
    } finally {
      fs.rmSync(fakeWs, { recursive: true, force: true })
    }
  })
})
