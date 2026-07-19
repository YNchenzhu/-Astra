/**
 * Unit tests for the tolerant `filePath` extractor used by the C-grade
 * stream-time Write preflight. The extractor must:
 *
 *   - Decline gracefully when the field isn't extractable yet (null).
 *   - Honour JSON string escape rules (escaped quotes, backslashes,
 *     unicode, CRLF inside `content`) so it never mistakenly truncates a
 *     filePath value.
 *   - Work on input that the upstream gateway has fed us in random-sized
 *     SSE chunks (incremental concatenation).
 *   - Accept both `filePath` (Anthropic / canonical) and `file_path`
 *     (snake_case alias used by some gateways and tests).
 */
import { describe, it, expect } from 'vitest'
import {
  detectContentBeforeFilePath,
  extractFilePathFromPartialJson,
} from './partialJsonExtract'

describe('extractFilePathFromPartialJson — null cases (still streaming)', () => {
  it('returns null for empty / non-string input', () => {
    expect(extractFilePathFromPartialJson('')).toBeNull()
    expect(extractFilePathFromPartialJson(null as unknown as string)).toBeNull()
    expect(extractFilePathFromPartialJson(undefined as unknown as string)).toBeNull()
    expect(extractFilePathFromPartialJson(42 as unknown as string)).toBeNull()
  })

  it('returns null when the field name has not yet streamed', () => {
    expect(extractFilePathFromPartialJson('{')).toBeNull()
    expect(extractFilePathFromPartialJson('{"fil')).toBeNull()
    expect(extractFilePathFromPartialJson('{"filePat')).toBeNull()
    expect(extractFilePathFromPartialJson('{"filePath"')).toBeNull()
    expect(extractFilePathFromPartialJson('{"filePath":')).toBeNull()
  })

  it('returns null when the string value has opened but not closed yet', () => {
    expect(extractFilePathFromPartialJson('{"filePath":"')).toBeNull()
    expect(extractFilePathFromPartialJson('{"filePath":"src')).toBeNull()
    expect(extractFilePathFromPartialJson('{"filePath":"src/foo')).toBeNull()
  })

  it('returns null when only an unrelated field is present', () => {
    expect(extractFilePathFromPartialJson('{"content":"hello"')).toBeNull()
    expect(extractFilePathFromPartialJson('{"content":"hello","other":42')).toBeNull()
  })
})

describe('extractFilePathFromPartialJson — successful extractions', () => {
  it('extracts from a complete object', () => {
    expect(extractFilePathFromPartialJson('{"filePath":"src/foo.ts"}')).toBe('src/foo.ts')
  })

  it('extracts from a buffer that ends right at the closing quote (still missing `}`)', () => {
    expect(extractFilePathFromPartialJson('{"filePath":"src/foo.ts"')).toBe('src/foo.ts')
  })

  it('extracts as soon as filePath terminates, ignoring partial `content` after it', () => {
    const buf = '{"filePath":"src/foo.ts","content":"export const x = 1\\nconsole.log'
    expect(extractFilePathFromPartialJson(buf)).toBe('src/foo.ts')
  })

  it('extracts snake_case `file_path` (legacy alias)', () => {
    expect(extractFilePathFromPartialJson('{"file_path":"src/bar.ts"')).toBe('src/bar.ts')
    const buf = '{"file_path":"src/bar.ts","content":"…still streaming…'
    expect(extractFilePathFromPartialJson(buf)).toBe('src/bar.ts')
  })

  it('extracts the natural-language `path` alias (many non-Claude models emit this)', () => {
    // Alias set must stay aligned with Zod's writeFileInputZod — before
    // this case existed, a fully valid `{"path":…,"content":…}` call was
    // mis-classified as content-before-filePath and aborted with an empty
    // synthetic input ("missing/empty required argument" symptom).
    expect(extractFilePathFromPartialJson('{"path":"src/baz.ts"')).toBe('src/baz.ts')
    const buf = '{"path":"src/baz.ts","content":"…still streaming…'
    expect(extractFilePathFromPartialJson(buf)).toBe('src/baz.ts')
  })

  it('decodes a Windows-style backslash path with escape sequences', () => {
    const buf = String.raw`{"filePath":"C:\\Users\\me\\foo.ts","content":"`
    expect(extractFilePathFromPartialJson(buf)).toBe('C:\\Users\\me\\foo.ts')
  })

  it('decodes an escaped quote inside the path (rare but legal)', () => {
    const buf = String.raw`{"filePath":"weird\"name.ts","content":"…`
    expect(extractFilePathFromPartialJson(buf)).toBe('weird"name.ts')
  })

  it('decodes a unicode escape inside the path', () => {
    // \u4f60\u597d → 你好
    expect(extractFilePathFromPartialJson('{"filePath":"\\u4f60\\u597d.txt"')).toBe('你好.txt')
  })

  it('extracts when filePath is not the first field', () => {
    const buf = '{"thoughtSignature":"abc","filePath":"src/x.ts"'
    expect(extractFilePathFromPartialJson(buf)).toBe('src/x.ts')
  })
})

describe('extractFilePathFromPartialJson — incremental streaming simulation', () => {
  it('returns null on every prefix until the closing quote arrives, then returns the value', () => {
    const full = '{"filePath":"src/foo.ts","content":"hello"}'
    let buf = ''
    let seen: string | null = null
    for (const ch of full) {
      buf += ch
      seen = extractFilePathFromPartialJson(buf)
      if (seen) break
    }
    expect(seen).toBe('src/foo.ts')
    // The first prefix that should succeed is the one that includes the
    // closing quote of `filePath`. That's the 24-th character (0-indexed
    // through `…ts"`).
    const expectedFirstSuccess = '{"filePath":"src/foo.ts"'
    expect(buf.startsWith(expectedFirstSuccess)).toBe(true)
  })

  it('does NOT prematurely succeed on a backslash-escaped quote inside the value', () => {
    // The first `"` after `…weird` is escaped, so a naive scanner would
    // wrongly return `weird\` here. We assert we keep returning null
    // until the *real* closing quote arrives.
    expect(extractFilePathFromPartialJson('{"filePath":"weird\\"')).toBeNull()
    expect(extractFilePathFromPartialJson('{"filePath":"weird\\"name')).toBeNull()
    expect(extractFilePathFromPartialJson('{"filePath":"weird\\"name.ts"')).toBe('weird"name.ts')
  })

  it('ignores stray `filePath` text that appears INSIDE another string value', () => {
    // Model said `"content":"the filePath is unset"` — there is no real
    // `"filePath":"…"` field yet. We must not return "is unset".
    const buf = '{"content":"the filePath is unset"'
    expect(extractFilePathFromPartialJson(buf)).toBeNull()
  })
})

describe('detectContentBeforeFilePath — DeepSeek V4 Pro signature detector', () => {
  it('returns false for empty / non-string input', () => {
    expect(detectContentBeforeFilePath('')).toBe(false)
    expect(detectContentBeforeFilePath(null as unknown as string)).toBe(false)
    expect(detectContentBeforeFilePath(undefined as unknown as string)).toBe(false)
  })

  it('returns false when neither key has streamed yet', () => {
    expect(detectContentBeforeFilePath('{')).toBe(false)
    expect(detectContentBeforeFilePath('{"co')).toBe(false)
    expect(detectContentBeforeFilePath('{"some_other":"x"')).toBe(false)
  })

  it('returns true the moment `"content":` is on the wire and no filePath key has appeared', () => {
    // Earliest detectable moment — key just closed, value not even started.
    expect(detectContentBeforeFilePath('{"content":')).toBe(true)
    expect(detectContentBeforeFilePath('{"content":"')).toBe(true)
    expect(detectContentBeforeFilePath('{"content":"export const x = 1')).toBe(true)
    // Snake-case / camelCase keys with whitespace are tolerated.
    expect(detectContentBeforeFilePath('{ "content" : "abc')).toBe(true)
  })

  it('returns false when `"filePath":` has already streamed (normal happy path)', () => {
    // Standard order — extractor will succeed; detector must NOT fire.
    expect(detectContentBeforeFilePath('{"filePath":"foo.ts","content":"abc')).toBe(false)
    // Even with whitespace.
    expect(detectContentBeforeFilePath('{ "filePath" : "foo.ts" , "content" : "abc')).toBe(false)
  })

  it('returns false when only the snake_case `file_path` key has streamed (gateway alias)', () => {
    expect(detectContentBeforeFilePath('{"file_path":"foo.ts","content":"abc')).toBe(false)
  })

  it('returns false when only the natural-language `path` alias has streamed', () => {
    expect(detectContentBeforeFilePath('{"path":"foo.ts","content":"abc')).toBe(false)
  })

  it('accepts content-first ordering even with whitespace', () => {
    // Gateways occasionally pretty-print the JSON args. The detector
    // must still classify this as content-before-filePath.
    expect(detectContentBeforeFilePath('{\n  "content": "abc')).toBe(true)
  })
})
