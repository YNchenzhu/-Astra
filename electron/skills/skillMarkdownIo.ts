/**
 * Hardened read of SKILL.md — avoid following symlinks when opening the file (POSIX).
 * upstream §9.5-style extraction safety subset for workspace skills.
 */

import fs from 'node:fs'

export function readSkillMarkdownFileSync(filePath: string): string {
  const nofollow = fs.constants.O_NOFOLLOW as number | undefined
  const flags = fs.constants.O_RDONLY | (nofollow ?? 0)
  let fd: number
  try {
    fd = fs.openSync(filePath, flags)
  } catch {
    return fs.readFileSync(filePath, 'utf-8')
  }
  try {
    return fs.readFileSync(fd, 'utf-8')
  } finally {
    fs.closeSync(fd)
  }
}
