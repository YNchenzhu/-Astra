import { describe, expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import {
  getSessionMemoryMarkdownPath,
  getSessionMemoryProjectRoot,
  getSessionMemoryRootDir,
  sanitizeConversationIdForFilename,
} from './sessionMemoryPaths'

describe('sessionMemoryPaths', () => {
  it('root is ~/.claude/session-memory', () => {
    expect(getSessionMemoryRootDir()).toBe(path.join(os.homedir(), '.claude', 'session-memory'))
  })

  it('sanitizeConversationIdForFilename strips unsafe chars', () => {
    expect(sanitizeConversationIdForFilename('a/b:c\\d')).toMatch(/^a_b_c_d/)
    expect(sanitizeConversationIdForFilename('   ')).toBe('conversation')
  })

  it('sanitizeConversationIdForFilename stays injective past the 200-char cap (audit S3)', () => {
    // Short ids are returned verbatim (no behaviour drift).
    expect(sanitizeConversationIdForFilename('conv-1234')).toBe('conv-1234')

    // Two ids sharing a >200-char prefix must NOT collide onto one file.
    const longA = 'a'.repeat(300)
    const longB = 'a'.repeat(250) + 'b'.repeat(50) // identical first 250 chars
    const ra = sanitizeConversationIdForFilename(longA)
    const rb = sanitizeConversationIdForFilename(longB)

    expect(ra.length).toBeLessThanOrEqual(200)
    expect(rb.length).toBeLessThanOrEqual(200)
    expect(ra).not.toBe(rb)
  })

  it('getSessionMemoryMarkdownPath uses sanitized basename (legacy flat)', () => {
    const p = getSessionMemoryMarkdownPath('chat::001')
    expect(p.endsWith('chat_001.md')).toBe(true)
    expect(path.dirname(p)).toBe(getSessionMemoryRootDir())
  })

  it('getSessionMemoryMarkdownPath uses project dir when workspace set', () => {
    const ws = 'C:\\proj\\demo'
    const p = getSessionMemoryMarkdownPath('c1', ws)
    expect(p.endsWith('c1.md')).toBe(true)
    expect(path.dirname(p)).toBe(getSessionMemoryProjectRoot(ws))
  })
})
