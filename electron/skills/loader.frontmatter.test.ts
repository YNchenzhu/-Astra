/**
 * Self-audit fix B3 (2026-05) — covers the YAML library swap (S1+G2),
 * the `quoteProblematicValues` retry path, and the `coerceFrontmatterString`
 * pinning (B1). Without these tests:
 *   - a glob pattern in `paths: src/*.{ts,tsx}` could silently break parsing;
 *   - `version: 1.5` could flow through as a number and trip downstream
 *     `.split('.')` callers (`SkillDefinition.version` is declared as
 *     `string | undefined`).
 *
 * We hit the real loader via on-disk fixtures so the parse path and
 * the `coerceFrontmatterString` glue both get covered.
 */

import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadSkillsFromDir, clearDynamicSkills } from './loader'

function mkSkillDir(): { skillsDir: string; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-fm-'))
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

function writeSkill(skillsDir: string, name: string, body: string): void {
  const dir = path.join(skillsDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body)
}

describe('parseFrontmatter via loadSkillsFromDir — quote-retry fallback (S1+G2)', () => {
  let env: ReturnType<typeof mkSkillDir>
  afterEach(() => {
    env?.cleanup()
    clearDynamicSkills()
  })

  it('parses simple key/value frontmatter', () => {
    env = mkSkillDir()
    writeSkill(
      env.skillsDir,
      'simple',
      `---
name: simple
description: A normal skill
---
Body`,
    )
    const skills = loadSkillsFromDir(env.skillsDir, 'project')
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('simple')
    expect(skills[0].description).toBe('A normal skill')
  })

  it('parses frontmatter with unquoted glob (`: ` mid-value)', () => {
    // `description: src/*.{ts,tsx}` is invalid in strict YAML (the
    // unquoted brace-block is a flow mapping). Before the retry path
    // this would silently fail and the loader would synthesize a
    // description from the body. After the fix, the retry quotes the
    // value and the skill loads with the literal description.
    env = mkSkillDir()
    writeSkill(
      env.skillsDir,
      'glob-skill',
      `---
name: glob-skill
description: Activates on src/*.{ts,tsx}
---
Body`,
    )
    const skills = loadSkillsFromDir(env.skillsDir, 'project')
    expect(skills).toHaveLength(1)
    expect(skills[0].description).toBe('Activates on src/*.{ts,tsx}')
  })

  it('parses a paths array containing brace-glob patterns', () => {
    env = mkSkillDir()
    writeSkill(
      env.skillsDir,
      'paths-skill',
      `---
name: paths-skill
description: Pattern-activated
paths:
  - "src/**/*.{ts,tsx}"
  - "lib/**"
---
Body`,
    )
    const skills = loadSkillsFromDir(env.skillsDir, 'project')
    expect(skills).toHaveLength(1)
    expect(skills[0].paths).toEqual(
      // splitPathInFrontmatter strips trailing /** and filters bare **,
      // so we expect the lib pattern to come through as "lib".
      expect.arrayContaining(['src/**/*.{ts,tsx}', 'lib']),
    )
  })

  it('falls back to body-extracted description on completely malformed frontmatter', () => {
    env = mkSkillDir()
    writeSkill(
      env.skillsDir,
      'broken',
      `---
name: broken
description: :::: this is intentionally malformed: ::::
extra
  weird:
    "{}["
---
This skill explains how to recover from bad frontmatter.`,
    )
    // Whether the second-pass quoting succeeds or both passes fail and
    // we fall back to the body description, the loader must NOT throw
    // and the skill must surface a non-empty description.
    const skills = loadSkillsFromDir(env.skillsDir, 'project')
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('broken')
    expect(skills[0].description.length).toBeGreaterThan(0)
  })
})

describe('coerceFrontmatterString via loadSkillsFromDir (B1)', () => {
  let env: ReturnType<typeof mkSkillDir>
  afterEach(() => {
    env?.cleanup()
    clearDynamicSkills()
  })

  it('coerces numeric `version` into a string', () => {
    env = mkSkillDir()
    writeSkill(
      env.skillsDir,
      'numeric-version',
      `---
name: numeric-version
description: Numeric version test
version: 1.5
---
Body`,
    )
    const skills = loadSkillsFromDir(env.skillsDir, 'project')
    expect(skills).toHaveLength(1)
    // Before B1 this was the runtime type lie: `version` claimed string
    // but ran as number 1.5. Now it must be a real string.
    expect(typeof skills[0].version).toBe('string')
    expect(skills[0].version).toBe('1.5')
  })

  it('coerces boolean-shaped values like `model: true` into a string', () => {
    env = mkSkillDir()
    writeSkill(
      env.skillsDir,
      'bool-model',
      `---
name: bool-model
description: Boolean model
model: true
---
Body`,
    )
    const skills = loadSkillsFromDir(env.skillsDir, 'project')
    expect(typeof skills[0].model).toBe('string')
    expect(skills[0].model).toBe('true')
  })

  it('strips empty-string scalars to undefined (no zombie "")', () => {
    env = mkSkillDir()
    writeSkill(
      env.skillsDir,
      'empty-fields',
      `---
name: empty-fields
description: Empty fields
model: ""
version: ""
---
Body`,
    )
    const skills = loadSkillsFromDir(env.skillsDir, 'project')
    expect(skills[0].model).toBeUndefined()
    expect(skills[0].version).toBeUndefined()
  })

  it('rejects non-scalar values with a warn and falls back to undefined', () => {
    // `description: { foo: bar }` is technically valid YAML but
    // semantically wrong for our schema. We expect the coerce to log
    // and treat it as missing → loader falls back to body.
    env = mkSkillDir()
    writeSkill(
      env.skillsDir,
      'obj-desc',
      `---
name: obj-desc
description:
  foo: bar
---
A real body description ought to be used here.`,
    )
    const skills = loadSkillsFromDir(env.skillsDir, 'project')
    expect(skills).toHaveLength(1)
    // The body fallback path produces a description from the markdown.
    expect(skills[0].description).toMatch(/real body description/i)
  })

  it('coerces context only to "inline" or "fork", never raw input', () => {
    env = mkSkillDir()
    writeSkill(
      env.skillsDir,
      'fork-skill',
      `---
name: fork-skill
description: Fork
context: fork
---
Body`,
    )
    writeSkill(
      env.skillsDir,
      'weird-skill',
      `---
name: weird-skill
description: Weird context value
context: weird
---
Body`,
    )
    const skills = loadSkillsFromDir(env.skillsDir, 'project')
    const forkSkill = skills.find((s) => s.name === 'fork-skill')
    const weirdSkill = skills.find((s) => s.name === 'weird-skill')
    expect(forkSkill?.context).toBe('fork')
    expect(weirdSkill?.context).toBe('inline')
  })
})
