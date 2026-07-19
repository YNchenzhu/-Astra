/**
 * Error-message shape lock for tool failure paths.
 *
 * We invested heavily in structured `What / Tried / Context / Next` error
 * messages (see `toolErrorFormat.ts` + `TOOL_DESIGN_PRINCIPLES.md` §5).
 * If a refactor accidentally drops the `Next:` line or reformats `Tried:`,
 * the model loses the signal that lets it self-correct on the next turn.
 *
 * These tests pin the STRUCTURE (not exact wording) of representative error
 * paths. They stay stable under cosmetic edits (regex-based) and fire
 * loudly when a load-bearing section goes missing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setWorkspacePath } from './workspaceState'
import { clearAllReadFileState } from './readFileState'
import { toolReadFile, toolWriteFile, toolEditFile, toolListFiles } from '../ai/tools'
import { toolGrep } from '../ai/advancedTools'
import { formatToolError, formatUnexpectedToolError } from './toolErrorFormat'
import * as workspaceStateMod from './workspaceState'

/** Assert the message has our 4 structural sections, in order. */
function assertStructuredError(msg: string, mustContain: RegExp[] = []): void {
  // Headline is always the first line, short.
  const firstLine = msg.split('\n')[0]!
  expect(firstLine, 'headline (line 1) must exist').toBeTruthy()
  expect(firstLine.length, 'headline should be <= 200 chars').toBeLessThanOrEqual(200)
  for (const re of mustContain) {
    expect(msg).toMatch(re)
  }
}

describe('formatToolError shape lock', () => {
  it('includes the What / Tried / Context / Next sections when all are supplied', () => {
    const msg = formatToolError({
      what: 'read_file: file not found: src/foo.py',
      tried: ['/ws/src/foo.py', '/cwd/src/foo.py'],
      context: { workspace: '/ws', platform: 'win32' },
      next: ['Use workspace-relative path', 'Or absolute path'],
    })
    assertStructuredError(msg, [
      /read_file: file not found/,
      /^Tried:/m,
      /^Context:/m,
      /^Next:/m,
      /- Use workspace-relative path/,
      /- Or absolute path/,
    ])
  })

  it('keeps the headline alone when no other sections are supplied', () => {
    expect(formatToolError({ what: 'X' })).toBe('X')
  })

  it('single-line `next` renders inline; multi-line renders bulleted', () => {
    expect(formatToolError({ what: 'X', next: 'one' })).toBe('X\nNext: one')
    expect(formatToolError({ what: 'X', next: ['one', 'two'] })).toBe(
      'X\nNext:\n  - one\n  - two',
    )
  })
})

describe('formatUnexpectedToolError shape lock', () => {
  it('wraps raw errors with a consistent Next: tail', () => {
    const msg = formatUnexpectedToolError('read_file', new Error('boom'))
    expect(msg).toContain('read_file hit an unexpected error: boom')
    expect(msg).toMatch(/^Next:/m)
  })
})

describe('integrated shape lock — live tool error paths', () => {
  let dir: string
  let wsSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    clearAllReadFileState()
    dir = mkdtempSync(join(tmpdir(), 'tool-error-shape-'))
    mkdirSync(join(dir, 'subdir'), { recursive: true })
    writeFileSync(join(dir, 'real.ts'), 'export const x = 1\n', 'utf-8')
    setWorkspacePath(dir)
    wsSpy = vi.spyOn(workspaceStateMod, 'getWorkspacePath').mockReturnValue(dir)
    process.env.DISABLE_RG_GREP = '1'
  })

  afterEach(() => {
    wsSpy.mockRestore()
    delete process.env.DISABLE_RG_GREP
    setWorkspacePath(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('read_file on missing path → What / Tried / Context / Next', async () => {
    const r = await toolReadFile('does/not/exist.ts')
    expect(r.success).toBe(false)
    assertStructuredError(r.error ?? '', [
      /read_file: file not found/,
      /^Tried:/m,
      /^Context:/m,
      /workspace=/,
      /^Next:/m,
    ])
  })

  it('read_file on missing path → Next: names `glob` and `list_files` as discovery tools (anti-guessing)', async () => {
    // Regression target: the model used to respond to a missing-path error
    // by guessing ANOTHER path from the same conventional layout instead
    // of pivoting to discovery. We now call out `glob` + `list_files` by
    // name in the Next: bullets.
    const r = await toolReadFile('does/not/exist.ts')
    expect(r.success).toBe(false)
    const msg = r.error ?? ''
    expect(msg).toMatch(/\bglob\b/)
    expect(msg).toMatch(/\blist_files\b/)
    // Also check the hint uses the actual missing filename in its
    // suggested glob pattern — this is what makes it land (a generic
    // "use glob" is easy to ignore; a concrete `**/exist.ts` is not).
    expect(msg).toContain('**/exist.ts')
    // And warns explicitly against re-guessing.
    expect(msg).toMatch(/Do NOT retry with another guessed path/i)
  })

  it('read_file on a directory → points at list_files in Next:', async () => {
    const r = await toolReadFile('subdir')
    expect(r.success).toBe(false)
    assertStructuredError(r.error ?? '', [
      /is a directory, not a file/,
      /^Tried:/m,
      /list_files/,
      /^Next:/m,
    ])
  })

  it('read_file on a NON-EMPTY directory → inlines the listing so no list_files round-trip is needed', async () => {
    // Regression target: the model passes a directory to read_file ~30% of
    // the time in exploration flows. The old error only said "use
    // list_files", costing a full extra turn. Now the directory contents are
    // inlined in the Next: section so the very next call can hit a real file.
    mkdirSync(join(dir, 'filled'), { recursive: true })
    writeFileSync(join(dir, 'filled', 'auth.ts'), 'export {}\n', 'utf-8')
    writeFileSync(join(dir, 'filled', 'logger.ts'), 'export {}\n', 'utf-8')
    mkdirSync(join(dir, 'filled', 'nested'), { recursive: true })

    const r = await toolReadFile('filled')
    expect(r.success).toBe(false)
    const msg = r.error ?? ''
    assertStructuredError(msg, [
      /is a directory, not a file/,
      /^Tried:/m,
      /^Next:/m,
    ])
    // The actual entries must be present (dirs get a trailing slash).
    expect(msg).toContain('auth.ts')
    expect(msg).toContain('logger.ts')
    expect(msg).toContain('nested/')
    // And the model is told NOT to waste a turn re-listing the same path.
    expect(msg).toMatch(/Do NOT call `list_files` on this same path/)
  })

  it('read_file with empty filePath → missing-arg structured error', async () => {
    const r = await toolReadFile('   ')
    expect(r.success).toBe(false)
    assertStructuredError(r.error ?? '', [
      /missing or empty/,
      /^Next:/m,
    ])
  })

  it('list_files on a file → points at read_file in Next:', async () => {
    const r = toolListFiles('real.ts')
    expect(r.success).toBe(false)
    assertStructuredError(r.error ?? '', [
      /is a file, not a directory/,
      /^Tried:/m,
      /read_file/,
      /^Next:/m,
    ])
  })

  it('list_files on missing path → Tried + workspace Context + Next', () => {
    const r = toolListFiles('ghost-dir-xyz')
    expect(r.success).toBe(false)
    assertStructuredError(r.error ?? '', [
      /directory not found/i,
      /^Tried:/m,
      /^Context:/m,
      /workspace=/,
      /^Next:/m,
    ])
  })

  it('write_file with empty filePath → structured error', async () => {
    const r = await toolWriteFile('   ', 'x')
    expect(r.success).toBe(false)
    assertStructuredError(r.error ?? '', [/missing or empty/, /^Next:/m])
  })

  it('write_file onto an existing directory → directory rejection with Next:', async () => {
    const r = await toolWriteFile('subdir', 'hi')
    expect(r.success).toBe(false)
    assertStructuredError(r.error ?? '', [
      /existing directory, not a file/,
      /^Tried:/m,
      /^Next:/m,
    ])
  })

  it('edit_file with empty filePath → structured error', async () => {
    const r = await toolEditFile('   ', 'a', 'b')
    expect(r.success).toBe(false)
    assertStructuredError(r.error ?? '', [/missing or empty/, /^Next:/m])
  })

  it('edit_file with "..." in old_string falls through to exact-byte match (cc-haha alignment)', async () => {
    // upstream alignment Part 1: the placeholder-ellipsis gate is gone, so
    // `...` in old_string is no longer specially flagged. The edit now
    // takes the exact-match path and fails with the standard "not found"
    // structured error — same code path the model already knows how to
    // recover from (re-read + retry with literal bytes).
    const fp = join(dir, 'real.ts')
    await toolReadFile(fp)
    const r = await toolEditFile(
      fp,
      'export const x = 1\n...\nend',
      'export const x = 2',
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/not found|exact match|did not match|closest match/i)
    expect(r.error).not.toMatch(/does NOT expand placeholders/)
  })

  it('grep on missing path → What / Tried / Context / Next with workspace root', async () => {
    const r = await toolGrep('x', 'does/not/exist.py')
    expect(r.success).toBe(false)
    assertStructuredError(r.error ?? '', [
      /Path not found/i,
      /^Tried:/m,
      new RegExp(dir.replace(/[/\\]/g, '[/\\\\]')),
      /^Next:/m,
    ])
  })
})
