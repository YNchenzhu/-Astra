import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { enforceSessionMemorySizeCap } from './sessionMemoryExtract'

const tmpFiles: string[] = []

async function writeTmp(name: string, content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-sizecap-'))
  const p = path.join(dir, name)
  await fs.writeFile(p, content, 'utf8')
  tmpFiles.push(p)
  return p
}

afterEach(async () => {
  await Promise.all(
    tmpFiles.splice(0).map((p) => fs.rm(path.dirname(p), { recursive: true, force: true })),
  )
})

describe('enforceSessionMemorySizeCap (audit S1)', () => {
  it('leaves a small file untouched', async () => {
    const original = '# Session\n\nshort notes\n'
    const p = await writeTmp('small.md', original)
    await enforceSessionMemorySizeCap(p)
    expect(await fs.readFile(p, 'utf8')).toBe(original)
  })

  it('truncates an oversized file and appends the marker', async () => {
    const huge = 'x'.repeat(60_000) // > the byte budget (48k)
    const p = await writeTmp('huge.md', huge)
    await enforceSessionMemorySizeCap(p)
    const out = await fs.readFile(p, 'utf8')
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(60_000)
    expect(out).toContain('session memory was truncated to stay within the size budget')
  })

  it('never leaves a stray replacement char when cutting mid multi-byte run', async () => {
    // 1 ASCII byte + many 3-byte CJK chars forces the byte budget to land
    // INSIDE a multi-byte sequence. StringDecoder must drop the partial char
    // rather than emit U+FFFD.
    const oversized = 'x' + '中'.repeat(20_000) // 1 + 60000 bytes
    const p = await writeTmp('cjk.md', oversized)
    await enforceSessionMemorySizeCap(p)
    const out = await fs.readFile(p, 'utf8')
    expect(out).not.toContain('\uFFFD')
    expect(out).toContain('session memory was truncated to stay within the size budget')
  })

  it('is a no-op when the file does not exist', async () => {
    await expect(
      enforceSessionMemorySizeCap(path.join(os.tmpdir(), 'sm-sizecap-missing', 'nope.md')),
    ).resolves.toBeUndefined()
  })
})
