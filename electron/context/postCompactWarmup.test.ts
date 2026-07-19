import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { generatePostCompactAttachments } from './postCompactAttachments'
import {
  clearReadFileStateForCurrentScope,
  hashFileContent,
  recordSuccessfulRead,
} from '../tools/readFileState'

/**
 * Exercise the post-compact warmup logic end-to-end: a file is recorded in
 * the read-file state, the disk content remains unchanged, so the generated
 * attachment should include a full `<restored-file>` block.
 */
describe('post-compact <restored-file> warmup (feature)', () => {
  let tmpDir: string
  let filePath: string
  const body = `line 1\nline 2\nline 3\n`

  beforeEach(() => {
    clearReadFileStateForCurrentScope()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-postcompact-'))
    filePath = path.join(tmpDir, 'example.ts')
    fs.writeFileSync(filePath, body, 'utf8')
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    clearReadFileStateForCurrentScope()
  })

  it('emits <restored-file> for full-view unchanged files', async () => {
    const stat = fs.statSync(filePath)
    recordSuccessfulRead(filePath, {
      mtimeMs: stat.mtimeMs,
      isPartialView: false,
      fullFileContent: body,
    })

    const atts = await generatePostCompactAttachments({
      messages: [{ role: 'user', content: `read the file \`${filePath}\`` }],
    })

    const fileAtt = atts.find((a) => a._attachmentKind === 'file_hints')
    expect(fileAtt).toBeDefined()
    if (!fileAtt) return
    expect(fileAtt.content).toContain('<restored-file')
    expect(fileAtt.content).toContain(filePath)
    expect(fileAtt.content).toContain('line 1')
    expect(fileAtt.content).toContain('line 3')
    const hash = hashFileContent(body)
    expect(fileAtt.content).toContain(`hash="${hash}"`)
  })

  it('does NOT emit <restored-file> for partial views', async () => {
    const stat = fs.statSync(filePath)
    recordSuccessfulRead(filePath, {
      mtimeMs: stat.mtimeMs,
      isPartialView: true,
      viewedContent: 'line 2\n',
      // No fullFileContent — partial view can't produce a hash either.
    })

    const atts = await generatePostCompactAttachments({
      messages: [{ role: 'user', content: `read \`${filePath}\`` }],
    })
    const fileAtt = atts.find((a) => a._attachmentKind === 'file_hints')
    expect(fileAtt).toBeDefined()
    if (!fileAtt) return
    // Descriptor still present (status line) but no restored body block.
    expect(fileAtt.content).toContain('unchanged:')
    expect(fileAtt.content).not.toContain('<restored-file')
  })

  it('flags stale when content changes', async () => {
    const stat = fs.statSync(filePath)
    recordSuccessfulRead(filePath, {
      mtimeMs: stat.mtimeMs,
      isPartialView: false,
      fullFileContent: body,
    })
    // Mutate on disk with a fresh mtime.
    fs.writeFileSync(filePath, `${body}new line\n`, 'utf8')
    // Bump mtime to guarantee it's outside the fast-path tolerance.
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(filePath, future, future)

    const atts = await generatePostCompactAttachments({
      messages: [{ role: 'user', content: `${filePath}` }],
    })
    const fileAtt = atts.find((a) => a._attachmentKind === 'file_hints')
    expect(fileAtt).toBeDefined()
    if (!fileAtt) return
    expect(fileAtt.content).toContain('stale:')
    expect(fileAtt.content).not.toContain('<restored-file')
  })

  it('flags missing when file deleted', async () => {
    const stat = fs.statSync(filePath)
    recordSuccessfulRead(filePath, {
      mtimeMs: stat.mtimeMs,
      isPartialView: false,
      fullFileContent: body,
    })
    fs.rmSync(filePath)

    const atts = await generatePostCompactAttachments({
      messages: [{ role: 'user', content: `${filePath}` }],
    })
    const fileAtt = atts.find((a) => a._attachmentKind === 'file_hints')
    expect(fileAtt).toBeDefined()
    if (!fileAtt) return
    expect(fileAtt.content).toContain('missing:')
    expect(fileAtt.content).not.toContain('<restored-file')
  })

  it('respects per-file char cap (large files skip warmup)', async () => {
    const hugeBody = 'x'.repeat(50_000)
    fs.writeFileSync(filePath, hugeBody, 'utf8')
    const stat = fs.statSync(filePath)
    recordSuccessfulRead(filePath, {
      mtimeMs: stat.mtimeMs,
      isPartialView: false,
      fullFileContent: hugeBody,
    })

    const atts = await generatePostCompactAttachments({
      messages: [{ role: 'user', content: filePath }],
    })
    const fileAtt = atts.find((a) => a._attachmentKind === 'file_hints')
    expect(fileAtt).toBeDefined()
    if (!fileAtt) return
    // Over the per-file cap — status still shown but body NOT restored.
    expect(fileAtt.content).toContain('unchanged:')
    expect(fileAtt.content).not.toContain('<restored-file')
  })
})
