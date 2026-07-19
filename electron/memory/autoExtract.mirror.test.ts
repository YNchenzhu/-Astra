import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mirrorExtractedToDirectory } from './autoExtract'
import type { ExtractedMemory } from './types'

const tmpDirs: string[] = []

function freshDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'))
  tmpDirs.push(d)
  return d
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function mdFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
}

describe('mirrorExtractedToDirectory collision handling (audit M4)', () => {
  it('writes two files for distinct names that sanitise to the same filename', () => {
    const dir = freshDir()
    const entries: ExtractedMemory[] = [
      { name: 'Foo Bar', type: 'project', description: 'd1', content: 'content one' },
      { name: 'Foo  Bar', type: 'project', description: 'd2', content: 'content two' }, // different name, same sanitised base
    ]
    mirrorExtractedToDirectory(dir, entries)

    const files = mdFiles(dir)
    expect(files.length).toBe(2)

    const blob = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
    expect(blob).toContain('content one')
    expect(blob).toContain('content two')
  })

  it('overwrites in place when the SAME memory is re-mirrored (no duplicate)', () => {
    const dir = freshDir()
    const entry: ExtractedMemory = {
      name: 'Stable Name',
      type: 'project',
      description: 'd',
      content: 'v1',
    }
    mirrorExtractedToDirectory(dir, [entry])
    expect(mdFiles(dir).length).toBe(1)

    mirrorExtractedToDirectory(dir, [{ ...entry, content: 'v2' }])
    const files = mdFiles(dir)
    expect(files.length).toBe(1)
    expect(fs.readFileSync(path.join(dir, files[0]), 'utf8')).toContain('v2')
  })

  it('refuses to mirror into a credential directory (e.g. .ssh)', () => {
    const dir = freshDir()
    // Survives path.resolve (no `..`), shape-valid, but contains a sensitive
    // credential segment — isUserSuppliedMirrorPathSafe must refuse it.
    const bad = path.join(dir, '.ssh', 'keys')
    mirrorExtractedToDirectory(bad, [
      { name: 'x', type: 'project', description: 'd', content: 'c' },
    ])
    expect(fs.existsSync(bad)).toBe(false)
  })
})
