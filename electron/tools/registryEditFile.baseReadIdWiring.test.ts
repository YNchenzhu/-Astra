/**
 * Regression: edit_file's registry-level wiring must forward baseReadId /
 * base_read_id to toolEditFile. Prior to this fix the destructure dropped
 * the field on the floor — the agent's hash-anchored read receipt was
 * advertised in the tool description but silently ignored at execution
 * time, falling back to the looser mtime/window gate.
 *
 * The tests here go through `toolRegistry.execute('edit_file', ...)` (the
 * exact path runAgenticToolUseBody uses), not the lower `toolEditFile`
 * helper directly — that's the only way to catch a registry-level wiring
 * regression.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toolRegistry } from './registry'
import { toolReadFile } from '../ai/tools'
import { setWorkspacePath } from './workspaceState'
import { clearAllReadFileState } from './readFileState'

function extractReadId(output: string): string {
  // The recordSuccessfulRead helper emits ids like `read-<hex>`; the banner
  // is `[readId: read-...] — REQUIRED: ...`. Match liberally so a future
  // schema change in the prefix doesn't silently invalidate this regression.
  const match = output.match(/\[readId: ([a-zA-Z][\w-]+)\]/)
  if (!match) throw new Error(`Could not find readId in output:\n${output}`)
  return match[1]!
}

describe('edit_file registry execute — baseReadId wiring', () => {
  let dir: string
  beforeEach(() => {
    clearAllReadFileState()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-read-id-'))
    setWorkspacePath(dir)
  })
  afterEach(() => {
    setWorkspacePath(null)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('forwards camelCase `baseReadId` to the hash-anchored gate', async () => {
    const fp = path.join(dir, 'a.ts')
    fs.writeFileSync(fp, 'export const x = 1\n', 'utf-8')
    const read = await toolReadFile(fp)
    expect(read.success).toBe(true)
    const readId = extractReadId(read.output ?? '')

    // A correctly-wired baseReadId should make the edit succeed via the
    // hash-anchored gate; nothing else changed since the read above.
    const r = await toolRegistry.execute('edit_file', {
      filePath: fp,
      oldString: 'export const x = 1',
      newString: 'export const x = 2',
      baseReadId: readId,
    })
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toContain('export const x = 2')
  })

  it('forwards snake_case `base_read_id` alias too', async () => {
    const fp = path.join(dir, 'b.ts')
    fs.writeFileSync(fp, 'const y = 1\n', 'utf-8')
    const read = await toolReadFile(fp)
    const readId = extractReadId(read.output ?? '')

    const r = await toolRegistry.execute('edit_file', {
      filePath: fp,
      oldString: 'const y = 1',
      newString: 'const y = 99',
      base_read_id: readId,
    })
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toContain('const y = 99')
  })

  it('hard-rejects a bogus baseReadId and surfaces the current valid readId (audit 2026-07)', async () => {
    const fp = path.join(dir, 'c.ts')
    fs.writeFileSync(fp, 'const z = 1\n', 'utf-8')
    const read = await toolReadFile(fp)
    const realReadId = extractReadId(read.output ?? '')

    // Intentionally fake readId. The former behaviour softly fell back to the
    // legacy mtime gate; the audit fix hard-rejects so an edit can never run
    // anchored to a receipt the agent never actually obtained. The error must
    // be actionable: it names the CURRENT valid readId for the path.
    const r = await toolRegistry.execute('edit_file', {
      filePath: fp,
      oldString: 'const z = 1',
      newString: 'const z = 2',
      baseReadId: 'r-not-a-real-receipt',
    })
    expect(r.success).toBe(false)
    expect(r.error).toContain('r-not-a-real-receipt')
    expect(r.error).toContain(realReadId)
    // File untouched.
    expect(fs.readFileSync(fp, 'utf-8')).toContain('const z = 1')
  })

  it('treats whitespace-only baseReadId as "no anchor provided" (legacy gate kicks in)', async () => {
    const fp = path.join(dir, 'd.ts')
    fs.writeFileSync(fp, 'const w = 1\n', 'utf-8')
    await toolReadFile(fp)

    // Whitespace must NOT activate the hash gate. The empty-string-collapse
    // mirrors editFileInputZod's transform — without it, a stray "   " from
    // a forgetful agent would surface as a confusing "unknown readId" error.
    const r = await toolRegistry.execute('edit_file', {
      filePath: fp,
      oldString: 'const w = 1',
      newString: 'const w = 2',
      baseReadId: '   ',
    })
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toContain('const w = 2')
  })

  it('camelCase wins when both aliases are provided (matches editFileInputZod transform)', async () => {
    const fp = path.join(dir, 'e.ts')
    fs.writeFileSync(fp, 'const e = 1\n', 'utf-8')
    const read = await toolReadFile(fp)
    const readId = extractReadId(read.output ?? '')

    // baseReadId is the real one; base_read_id is bogus. The destructure
    // resolves `baseReadId ?? base_read_id`, so the real one should win
    // and the edit should succeed.
    const r = await toolRegistry.execute('edit_file', {
      filePath: fp,
      oldString: 'const e = 1',
      newString: 'const e = 9',
      baseReadId: readId,
      base_read_id: 'r-bogus',
    })
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toContain('const e = 9')
  })
})
