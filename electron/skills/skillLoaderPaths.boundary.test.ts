/**
 * Destructive boundary tests for skill loader path handling
 * (`activateConditionalSkillsForPaths` + the cwd-relativization that runs
 * before `ignore.ignores()`).
 *
 * The happy-path is already covered in skillLoaderChapter9.test.ts. This
 * file pins down what happens when:
 *  - file paths escape the cwd
 *  - file paths are on a different Windows drive
 *  - file paths use mixed separators
 *  - the conditional pattern is `**` or empty
 */

import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  clearDynamicSkills,
  getDynamicSkills,
} from './loader'

const isWin = process.platform === 'win32'

function skillMd(name: string, desc: string, paths?: string): string {
  const pathsBlock = paths !== undefined ? `paths:\n  - "${paths}"\n` : ''
  return `---\nname: ${name}\ndescription: ${desc}\n${pathsBlock}---\nBody for ${name}.`
}

function setupCondSkill(name: string, pattern: string): string {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-cond-'))
  const dir = path.join(tmpWs, '.claude', 'skills', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd(name, 'Conditional', pattern))
  addSkillDirectories([path.join(tmpWs, '.claude', 'skills')])
  return tmpWs
}

describe('activateConditionalSkillsForPaths — boundary', () => {
  afterEach(() => {
    clearDynamicSkills()
  })

  it('SKIPS file paths that escape cwd via `..` (path.relative returns `../...`)', () => {
    const tmpWs = setupCondSkill('escape-test', 'src/**')
    // Construct an absolute path that lives in a sibling of tmpWs.
    const sibling = path.join(path.dirname(tmpWs), 'unrelated', 'src', 'foo.ts')
    const activated = activateConditionalSkillsForPaths([sibling], tmpWs)
    // Skill remains loaded (in dynamicSkills) but is NOT activated.
    // The activation registry tracks it separately and would emit it on the
    // first matching path; here that signal must be empty.
    expect(activated).toEqual([])
  })

  it('SKIPS Windows different-drive absolute paths', () => {
    if (!isWin) return
    const tmpWs = setupCondSkill('drive-test', 'src/**')
    // Force a path on a different drive letter than tmpWs (which is on the
    // tmp drive, usually C:). path.relative across drives returns the abs
    // form, so the loader's `path.isAbsolute(relativePath)` guard kicks in.
    const otherDrive = tmpWs.startsWith('C:') ? 'D:\\src\\foo.ts' : 'C:\\src\\foo.ts'
    const activated = activateConditionalSkillsForPaths([otherDrive], tmpWs)
    expect(activated).toEqual([])
  })

  it('returns [] when filePaths is empty', () => {
    setupCondSkill('empty-files', 'src/**')
    expect(activateConditionalSkillsForPaths([], path.dirname(__filename))).toEqual([])
  })

  it('returns [] when there are no conditional skills registered', () => {
    // No setupCondSkill — registry is empty.
    const result = activateConditionalSkillsForPaths(['src/foo.ts'], process.cwd())
    expect(result).toEqual([])
  })

  it('matches an absolute file inside cwd by relativizing', () => {
    const tmpWs = setupCondSkill('inside-test', 'src/**')
    const inside = path.join(tmpWs, 'src', 'index.ts')
    const activated = activateConditionalSkillsForPaths([inside], tmpWs)
    expect(activated).toContain('inside-test')
  })

  it('matches a relative path passed through verbatim', () => {
    setupCondSkill('rel-test', 'src/**')
    const activated = activateConditionalSkillsForPaths(
      [path.join('src', 'foo.ts').split(path.sep).join('/')],
      path.dirname(__filename),
    )
    expect(activated).toContain('rel-test')
  })

  it('once activated, a skill stays activated and is not re-emitted on subsequent calls', () => {
    const tmpWs = setupCondSkill('idempotent', 'src/**')
    const inside = path.join(tmpWs, 'src', 'a.ts')

    const first = activateConditionalSkillsForPaths([inside], tmpWs)
    expect(first).toContain('idempotent')

    // Second activation must NOT re-emit (it's already in dynamicSkills).
    const second = activateConditionalSkillsForPaths([inside], tmpWs)
    expect(second).not.toContain('idempotent')

    // But it stays available for retrieval.
    expect(getDynamicSkills().find((s) => s.name === 'idempotent')).toBeTruthy()
  })

  it('does NOT match a sibling directory that shares the pattern prefix', () => {
    // Pattern is "src" (after splitPathInFrontmatter strips /**), so a file
    // under "src2/" must not be considered inside "src/". Pin path-segment
    // semantics rather than raw string-prefix.
    const tmpWs = setupCondSkill('prefix-sibling', 'src/**')
    const sibling = path.join(tmpWs, 'src2', 'foo.ts')
    const activated = activateConditionalSkillsForPaths([sibling], tmpWs)
    expect(activated).toEqual([])
  })

  it('matches when the file is exactly at the workspace root and pattern is `*.ts`', () => {
    const tmpWs = setupCondSkill('root-glob', '*.ts')
    const root = path.join(tmpWs, 'foo.ts')
    const activated = activateConditionalSkillsForPaths([root], tmpWs)
    expect(activated).toContain('root-glob')
  })

  it('does not crash on a SKILL.md whose paths array reduces to nothing (`**` filtered)', () => {
    // splitPathInFrontmatter strips bare `**` entries entirely, so this skill
    // ends up with paths=undefined → unconditional. The caller never registers
    // it as a conditional skill, so activate-by-path should not return it.
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'astras-'))
    const dir = path.join(tmpWs, '.claude', 'skills', 'starstar')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: starstar\ndescription: starstar\npaths:\n  - "**"\n---\nBody.`,
    )
    addSkillDirectories([path.join(tmpWs, '.claude', 'skills')])

    const activated = activateConditionalSkillsForPaths([path.join(tmpWs, 'whatever.ts')], tmpWs)
    expect(activated).not.toContain('starstar')
  })
})
