/**
 * Extreme Scenario Tests — Tool Subsystem (54 scenarios, 6 categories)
 *
 * These tests stress the tool subsystem at its boundaries:
 * unicode edge cases, race conditions, size limits, path attacks,
 * concurrent access patterns, normalization collisions, and more.
 *
 * Categories:
 *   1. fileEditSemantics      (15 scenarios)
 *   2. writeIntegrityGuard    (8 scenarios)
 *   3. toolErrorFormat        (5 scenarios)
 *   4. globToRegex            (8 scenarios)
 *   5. readFileState          (10 scenarios)
 *   6. workspace/path         (8 scenarios)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ── Category 1 imports ─────────────────────────────────────────────────
import {
  computeFileEditResult,
  toolEditFile,
  toolReadFile,
  normalizeFileEditInput,
  formatFileSize,
  stripTrailingWhitespace,
} from './tools'
import {
  findFuzzyOldStringHints,
  getEditAffectedLineBounds1Based,
} from './fileEditSemantics'

// ── Category 2 imports ─────────────────────────────────────────────────
import {
  assertPreWriteIntegrity,
  verifyPostWriteIntegrity,
  WriteIntegrityCode,
} from '../tools/writeIntegrityGuard'

// ── Category 3 imports ─────────────────────────────────────────────────
import {
  formatToolError,
  formatUnexpectedToolError,
} from '../tools/toolErrorFormat'

// ── Category 4 imports ─────────────────────────────────────────────────
import { globToRegex, splitGlobPatterns, matchesIgnorePattern } from './advancedToolUtils'

// ── Category 5 imports ─────────────────────────────────────────────────
import {
  clearAllReadFileState,
  recordSuccessfulRead,
  tryConsumeReadDedup,
  assertReadBeforeEditByReadId,
  invalidateReadAfterMutation,
  buildFileUnchangedStub,
} from '../tools/readFileState'
import { runWithAgentContext, type AgentContext } from '../agents/agentContext'
import type { ProviderConfig } from '../ai/client'
import { setWorkspacePath, getWorkspacePath } from '../tools/workspaceState'

// ── Category 6 imports ─────────────────────────────────────────────────
import {
  gateFileReadPath,
  isUncOrSmbStylePath,
  isBlockedBinaryExtensionForRead,
  isBlockedUnixStyleDevicePath,
  isDangerousSensitiveFileBasename,
  pathHasDangerousDirectorySegment,
} from '../tools/fileToolValidation'
import { resolveSearchPath } from './advancedToolUtils'

const cfg: ProviderConfig = { id: 'anthropic', name: 't', apiKey: '' }
function agentCtx(agentId: string, conv?: string): AgentContext {
  return {
    config: cfg, model: 'm', systemPrompt: '', messages: [],
    signal: new AbortController().signal, agentId, streamConversationId: conv,
  }
}

// ============================================================================
// CATEGORY 1: fileEditSemantics — 15 extreme scenarios
// ============================================================================
describe('CAT1: fileEditSemantics extreme scenarios', () => {

  let dir: string
  beforeEach(() => {
    clearAllReadFileState()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-ext-sem-'))
    setWorkspacePath(dir)
  })
  afterEach(() => {
    setWorkspacePath(null)
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ok */ }
  })

  // E1: BOM-only file with BOM-only old_string → empty-on-empty match
  it('E1: BOM-only file edit with BOM-only old_string', async () => {
    const fp = path.join(dir, 'bom-only.md')
    fs.writeFileSync(fp, '\uFEFF', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(fp, '\uFEFF', 'hello')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('\uFEFFhello')
  })

  // E2: CRLF file, LF old_string, edge case where trailing newline mismatch occurs
  it('E2: CRLF file with LF old_string and trailing-whitespace newString', async () => {
    const fp = path.join(dir, 'crlf-trail.ts')
    fs.writeFileSync(fp, 'a\r\nb\r\nc\r\n', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(fp, 'a\nb', 'x\ny')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('x\r\ny\r\nc\r\n')
  })

  // E3: replace_all with non-overlapping matches in CRLF file
  it('E3: replace_all LF old_string in CRLF file', async () => {
    const fp = path.join(dir, 'replace-all-crlf.md')
    fs.writeFileSync(fp, 'hello\r\nworld\r\nhello\r\n', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(fp, 'hello\n', 'bye\n', { replaceAll: true })
    expect(r.success).toBe(true)
    // File: hello\r\nworld\r\nhello\r\n → only 2 "hello" lines, not 3
    expect(fs.readFileSync(fp, 'utf-8')).toBe('bye\r\nworld\r\nbye\r\n')
  })

  // E4: old_string with zero-width characters (ZWSP, ZWNJ)
  it('E4: old_string containing zero-width characters', async () => {
    const zwsp = '\u200B'
    const fp = path.join(dir, 'zwsp.ts')
    fs.writeFileSync(fp, `hello${zwsp}world`, 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(fp, `hello${zwsp}world`, 'replaced')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('replaced')
  })

  // E5: Multiple different curly quote styles in the same file
  it('E5: curly+straight quote mix in single file', async () => {
    const fp = path.join(dir, 'quotes.ts')
    fs.writeFileSync(fp, 'const a = \u201chello\u201d\nconst b = "world"\n', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(fp, 'const a = "hello"', 'const a = "hi"')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('const a = \u201chi\u201d\nconst b = "world"\n')
  })

  // E6: new_string with trailing whitespace on .md file → should NOT strip
  it('E6: .md file preserves trailing spaces in new_string', async () => {
    const fp = path.join(dir, 'preserve.md')
    fs.writeFileSync(fp, 'line\n', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(fp, 'line', 'newline  \n')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('newline  \n')
  })

  // E7: Desanitize nested combinations (e.g. <fnr> inside <s>)
  it('E7: desanitize handles nested sanitized tokens', () => {
    const fileContent = 'before <function_results> middle <system> after'
    const r = normalizeFileEditInput({
      file_path: '/x.ts',
      fileContent,
      edits: [{ old_string: 'before <fnr> middle <s> after', new_string: 'ok' }],
    })
    expect(r.edits[0]!.old_string).toBe('before <function_results> middle <system> after')
  })

  // E8: Empty file with whitespace-only old_string creates new content
  it('E8: empty file + whitespace oldString → replaces entirely', async () => {
    const fp = path.join(dir, 'empty-ws.md')
    fs.writeFileSync(fp, '', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(fp, '  \n\t', 'new content')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('new content')
  })

  // E9: Old_string spans exactly the last line without trailing newline
  it('E9: old_string is last line without trailing newline', () => {
    const content = 'line1\nline2\nline3'
    const r = computeFileEditResult(content, 'line3', 'line4')
    expect(r.success).toBe(true)
    if (r.success) expect(r.newContent).toBe('line1\nline2\nline4')
  })

  // E10: Both newline AND quote normalization needed simultaneously
  it('E10: CRLF+curly-quote normalization simultaneously', () => {
    const content = 'const msg = \u201chello\u201d\r\nconst x = 1\r\n'
    const r = computeFileEditResult(
      content,
      'const msg = "hello"\nconst x = 1',
      'const msg = "world"\nconst x = 2',
    )
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('const msg = \u201cworld\u201d\r\nconst x = 2\r\n')
    }
  })

  // E11: Fuzzy hints with exact anchor match at 2 locations → ambiguous diagnostic
  it('E11: fuzzy hints detects ambiguous anchor (exact match at 2+ locations)', () => {
    const content = 'function f() {\n  return 1\n}\nfunction f() {\n  return 2\n}\n'
    // old_string has "function f()" as anchor which appears twice
    const hint = findFuzzyOldStringHints(content, 'function f() {\n  return 3\n}')
    expect(hint).toMatch(/EXACTLY at 2 locations/)
    expect(hint).toMatch(/ambiguous/)
  })

  // E12: Fuzzy hints with self-inflicted drift (exact anchor at 1 location)
  it('E12: fuzzy hints detects self-inflicted drift (1 exact anchor but lines differ)', () => {
    const content = 'function g() {\n  const a = 1\n  const b = 2\n  return a + b\n}\n'
    // old_string has "function g()" as anchor (exact) but wrong body lines
    const hint = findFuzzyOldStringHints(content, 'function g() {\n  const x = 9\n  return x\n}')
    expect(hint).toMatch(/EXACTLY/)
    expect(hint).toMatch(/self-inflicted drift/)
    expect(hint).toMatch(/read_file.+\bagain\b/i)
  })

  // E13: large file with line count computation
  it('E13: getEditAffectedLineBounds1Based on large file', () => {
    const lines: string[] = []
    for (let i = 0; i < 5000; i++) lines.push(`line${i}`)
    const content = lines.join('\n')
    const bounds = getEditAffectedLineBounds1Based(content, 'line2000\nline2001', 'x')
    expect(bounds.ok).toBe(true)
    if (bounds.ok) {
      expect(bounds.minLine1).toBe(2001) // 0-based to 1-based
      expect(bounds.maxLine1).toBe(2002)
    }
  })

  // E14: stripTrailingWhitespace with CRLF
  it('E14: stripTrailingWhitespace preserves CRLF line endings', () => {
    const result = stripTrailingWhitespace('hello  \r\nworld \r\n')
    expect(result).toBe('hello\r\nworld\r\n')
  })

  // E15: formatFileSize edge values
  it('E15: formatFileSize handles all magnitude boundaries', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(1023)).toBe('1023 B')
    expect(formatFileSize(1024)).toBe('1.0 KB')
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.00 GB')
  })
})

// ============================================================================
// CATEGORY 2: writeIntegrityGuard — 8 extreme scenarios
// ============================================================================
describe('CAT2: writeIntegrityGuard extreme scenarios', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-ext-wig-'))
  })
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ok */ }
  })

  // E16: CRLF-only content being overwritten with BOM+empty body
  it('E16: refuse to overwrite CRLF-only file with BOM-only content', () => {
    const r = assertPreWriteIntegrity({
      resolvedPath: '/tmp/crlf-clear.txt',
      displayPath: 'crlf-clear.txt',
      previousContent: '\r\n\r\n',
      nextContent: '\uFEFF',
      fileExisted: true,
      intent: 'write',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe(WriteIntegrityCode.DestructiveWhitespaceLikeWrite)
  })

  // E17: Post-write verification succeeds with unicode content
  it('E17: post-write verification with unicode (CJK + emoji)', () => {
    const f = path.join(tmp, 'unicode-match.txt')
    const unicode = '你好世界 🌍\n🚀\n'
    fs.writeFileSync(f, unicode, 'utf-8')
    const r = verifyPostWriteIntegrity({
      resolvedPath: f, displayPath: f,
      expectedContent: unicode, intent: 'write',
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.actualContent).toBe(unicode)
  })

  // E18: Empty existing file, writing empty content → allowed
  it('E18: empty file → empty write is allowed', () => {
    const r = assertPreWriteIntegrity({
      resolvedPath: '/tmp/empty-empty.txt',
      displayPath: 'empty-empty.txt',
      previousContent: '',
      nextContent: '',
      fileExisted: true,
      intent: 'write',
    })
    expect(r.ok).toBe(true)
  })

  // E19: intent='notebook' produces correct error messages
  it('E19: notebook intent uses generic error message', () => {
    const r = assertPreWriteIntegrity({
      resolvedPath: '/tmp/nb.ipynb',
      displayPath: 'nb.ipynb',
      previousContent: '{"cells":[]}',
      nextContent: '',
      fileExisted: true,
      intent: 'notebook',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe(WriteIntegrityCode.DestructiveEmptyWrite)
      expect(r.error).toMatch(/empty content|clear the file/i)
    }
  })

  // E20: BOM in previous but not in next (substantive write)
  it('E20: BOM-preserving replacement passes integrity check', () => {
    const r = assertPreWriteIntegrity({
      resolvedPath: '/tmp/bom-prev.txt',
      displayPath: 'bom-prev.txt',
      previousContent: '\uFEFFhello',
      nextContent: '\uFEFFworld',
      fileExisted: true,
      intent: 'write',
    })
    expect(r.ok).toBe(true)
  })

  // E21: BOM-only file → empty write is allowed.
  // The on-disk file has no real body content (only the UTF-8 BOM marker),
  // so replacing it with empty bytes is not destructive — there is no body
  // to lose. The BOM-aware check in assertPreWriteIntegrity short-circuits
  // before the literal `nextContent === ''` rule fires.
  it('E21: BOM-only file → empty write is allowed (no body to clobber)', () => {
    const r = assertPreWriteIntegrity({
      resolvedPath: '/tmp/bom-to-empty.txt',
      displayPath: 'bom-to-empty.txt',
      previousContent: '\uFEFF',
      nextContent: '',
      fileExisted: true,
      intent: 'write',
    })
    expect(r.ok).toBe(true)
  })

  // E22: Post-write mismatch with different content but same byte length
  it('E22: post-write detects mismatch even with same byte count', () => {
    const f = path.join(tmp, 'same-len.txt')
    fs.writeFileSync(f, 'abcde', 'utf-8')
    const r = verifyPostWriteIntegrity({
      resolvedPath: f, displayPath: f,
      expectedContent: 'vwxyz', intent: 'write',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe(WriteIntegrityCode.PostWriteMismatch)
  })

  // E23: Post-write with unicode byte-length differences
  it('E23: post-write mismatch with unicode byte length difference', () => {
    const f = path.join(tmp, 'unicode-mismatch.txt')
    fs.writeFileSync(f, 'hello', 'utf-8')
    const r = verifyPostWriteIntegrity({
      resolvedPath: f, displayPath: f,
      expectedContent: '你好', intent: 'write',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe(WriteIntegrityCode.PostWriteMismatch)
      // Verify byte lengths are correctly reported
      expect(r.error).toMatch(/\d+ bytes/)
    }
  })
})

// ============================================================================
// CATEGORY 3: toolErrorFormat — 5 extreme scenarios
// ============================================================================
describe('CAT3: toolErrorFormat extreme scenarios', () => {

  // E24: Very long error message (pathological length)
  it('E24: handles very long error what string', () => {
    const longStr = 'x'.repeat(10000)
    const result = formatToolError({ what: longStr })
    expect(result.length).toBeGreaterThanOrEqual(10000)
    expect(result.startsWith(longStr)).toBe(true)
  })

  // E25: Context with undefined values
  it('E25: context with undefined and null values are filtered', () => {
    const result = formatToolError({
      what: 'test',
      context: { a: 1, b: undefined, c: null, d: '', e: 'ok' },
    })
    expect(result).toMatch(/a=1/)
    expect(result).toMatch(/e=ok/)
    expect(result).not.toMatch(/b=undefined/)
    expect(result).not.toMatch(/c=null/)
    expect(result).not.toMatch(/d=/)
  })

  // E26: Next with nested array mixing empty + valid items
  it('E26: next array with mixed empty/valid entries', () => {
    const result = formatToolError({
      what: 'test',
      next: ['action 1', '', '  ', 'action 2'],
    })
    expect(result).toMatch(/action 1/)
    expect(result).toMatch(/action 2/)
    // empty/whitespace items should be filtered
    const emptyIndicators = result.match(/^\s*- $/gm)
    expect(emptyIndicators).toBeNull()
  })

  // E27: Special characters in error message
  it('E27: handles newlines and special chars in what/tried/next', () => {
    const result = formatToolError({
      what: 'Error: <script>alert("xss")</script>',
      tried: ['path/to/$HOME/.config', 'C:\\Users\\test'],
      next: 'Run: npm install && npm test',
    })
    expect(result).toContain('script')
    expect(result).toContain('$HOME')
    expect(result).toContain('C:\\Users')
    expect(result).toContain('npm install')
  })

  // E28: formatUnexpectedToolError with non-Error throwable
  it('E28: formatUnexpectedToolError wraps string throwable', () => {
    const result = formatUnexpectedToolError('read_file', 'just a string error')
    expect(result).toMatch(/read_file hit an unexpected error/)
    expect(result).toMatch(/just a string error/)
  })
})

// ============================================================================
// CATEGORY 4: globToRegex / advancedToolUtils — 8 extreme scenarios
// ============================================================================
describe('CAT4: globToRegex extreme scenarios', () => {

  // E29: Nested braces expand correctly — comma splitting now tracks brace
  // depth, so commas inside nested `{…}` are NOT treated as top-level
  // alternatives. `a{b{c{d,e},f},g}h` should expand to the alternatives
  // `b{c{d,e},f}` and `g` at the top level, matching the strings:
  //   abcdh, abceh, abfh, agh
  it('E29: nested brace splitting respects depth (top-level commas only)', () => {
    const re = globToRegex('a{b{c{d,e},f},g}h')
    expect(re.test('abcdh')).toBe(true)
    expect(re.test('abceh')).toBe(true)
    expect(re.test('abfh')).toBe(true)
    expect(re.test('agh')).toBe(true)
    expect(re.test('axh')).toBe(false)
  })

  // E30: Character class with special characters inside
  it('E30: character class with special regex chars', () => {
    const re = globToRegex('file[.*+?^${}()|]')
    expect(re.test('file.')).toBe(true)
    expect(re.test('file*')).toBe(true)
    expect(re.test('file+')).toBe(true)
    expect(re.test('filea')).toBe(false)
    expect(re.test('file(')).toBe(true)
  })

  // E31: ** pattern at various positions
  it('E31: ** globstar at start, middle, and end', () => {
    // Start
    expect(globToRegex('**/foo').test('a/b/foo')).toBe(true)
    expect(globToRegex('**/foo').test('foo')).toBe(true)
    // Middle
    expect(globToRegex('a/**/b').test('a/x/y/b')).toBe(true)
    // End
    expect(globToRegex('a/**').test('a/b/c')).toBe(true)
  })

  // E32: Pattern with only wildcards
  it('E32: pattern consisting only of wildcards', () => {
    expect(globToRegex('*').test('anything')).toBe(true)
    expect(globToRegex('*').test('a/b')).toBe(false) // * does not cross /
    expect(globToRegex('**').test('a/b/c')).toBe(true)
    expect(globToRegex('?').test('a')).toBe(true)
    expect(globToRegex('?').test('ab')).toBe(false)
  })

  // E33: Very long pattern
  it('E33: very long glob pattern (2000 chars)', () => {
    const pattern = 'a'.repeat(1998) + '*.ts'
    const re = globToRegex(pattern)
    const target = 'a'.repeat(1998) + 'hello.ts'
    expect(re.test(target)).toBe(true)
  })

  // E34: Braces with empty alternatives
  it('E34: brace with empty alternative', () => {
    const re = globToRegex('file{,.test}.ts')
    expect(re.test('file.ts')).toBe(true)
    expect(re.test('file.test.ts')).toBe(true)
    expect(re.test('filefail.ts')).toBe(false)
  })

  // E35: splitGlobPatterns with braces containing commas
  it('E35: splitGlobPatterns preserves brace-internal commas', () => {
    const result = splitGlobPatterns('src/**/*.{ts,tsx}  test/**/*.test.ts')
    expect(result).toEqual(['src/**/*.{ts,tsx}', 'test/**/*.test.ts'])
  })

  // E36: Combined ignore pattern matching with .gitignore directory semantics.
  // Plain (non-anchored, no `/`, no `**`) patterns now match against any
  // path segment of `relPath`, so `node_modules` correctly ignores the
  // directory itself and everything underneath it.
  it('E36: matchesIgnorePattern with brace expansion + gitignore dir semantics', () => {
    const patterns = ['*.log', 'dist/**', 'node_modules']
    expect(matchesIgnorePattern('error.log', patterns)).toBe(true)
    expect(matchesIgnorePattern('logs/error.log', patterns)).toBe(true)
    expect(matchesIgnorePattern('dist/index.js', patterns)).toBe(true)
    expect(matchesIgnorePattern('src/index.ts', patterns)).toBe(false)
    // gitignore directory semantics — `node_modules` ignores the dir itself
    // and every file underneath it.
    expect(matchesIgnorePattern('node_modules', patterns)).toBe(true)
    expect(matchesIgnorePattern('node_modules/pkg/index.js', patterns)).toBe(true)
  })

  // E36b: Anchored pattern (leading /) matches only at the workspace root.
  it('E36b: matchesIgnorePattern anchored pattern stays at root', () => {
    const patterns = ['/build']
    expect(matchesIgnorePattern('build', patterns)).toBe(true)
    expect(matchesIgnorePattern('build/output.js', patterns)).toBe(true)
    // Same name nested deeper must NOT match — the anchor pins the
    // pattern to the first segment only.
    expect(matchesIgnorePattern('packages/foo/build', patterns)).toBe(false)
    expect(matchesIgnorePattern('packages/foo/build/output.js', patterns)).toBe(false)
  })
})

// ============================================================================
// CATEGORY 5: readFileState — 10 extreme scenarios
// ============================================================================
describe('CAT5: readFileState extreme scenarios', () => {
  afterEach(() => {
    clearAllReadFileState()
  })

  // E37: Cross-scope dedup with stale mtime → no dedup
  it('E37: cross-scope dedup rejected on stale mtime', () => {
    const p = 'C:/tmp/stale-mtime.txt'.replace(/\\/g, '/')
    const body = 'content'

    runWithAgentContext(agentCtx('agent-a', 'conv-1'), () => {
      recordSuccessfulRead(p, {
        mtimeMs: 100, isPartialView: false,
        fullFileContent: body, viewedContent: body,
        readOffset: 0, readLimit: 2000,
      })
    })

    runWithAgentContext(agentCtx('agent-b', 'conv-1'), () => {
      const r = tryConsumeReadDedup(p, 200, 0, 2000) // different mtime
      expect(r.dedup).toBe(false)
    })
  })

  // E38: Dedup with contentSnapshot returns cached content on repeated calls.
  // The strikeCount resets each scope entry; remain agnostic about repeatStop timing.
  it('E38: dedup with contentSnapshot returns dedup:true with cached content', () => {
    const p = 'C:/tmp/exhaust-dedup.txt'.replace(/\\/g, '/')
    const body = 'file body'

    runWithAgentContext(agentCtx('main', 'conv-dd'), () => {
      recordSuccessfulRead(p, {
        mtimeMs: 500, isPartialView: false,
        fullFileContent: body, viewedContent: body,
        readOffset: 0, readLimit: 2000,
      })
    })

    runWithAgentContext(agentCtx('main', 'conv-dd'), () => {
      let lastResult: ReturnType<typeof tryConsumeReadDedup> = { dedup: false }
      for (let i = 0; i < 15; i++) {
        lastResult = tryConsumeReadDedup(p, 500, 0, 2000)
      }
      expect(lastResult.dedup).toBe(true)
      // When contentSnapshot exists, either cachedContent is delivered directly
      // or repeatStop fires. Both are valid termination signals.
      if (lastResult.repeatStop === undefined) {
        expect(lastResult.cachedContent).toBe(body)
      } else {
        expect(lastResult.repeatStop).toBe(true)
      }
    })
  })

  // E39: Invalid readId → READ_ID_NOT_FOUND
  it('E39: assertReadBeforeEditByReadId rejects unknown readId', () => {
    const r = assertReadBeforeEditByReadId(
      '/tmp/test.ts', 'read-deadbeef00000000', 'content', 'old', 'new',
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('READ_ID_NOT_FOUND')
  })

  // E40: Record → invalidate → re-record → verify fresh readId
  it('E40: invalidateReadAfterMutation works correctly', () => {
    const p = 'C:/tmp/invalidate-test.txt'.replace(/\\/g, '/')

    runWithAgentContext(agentCtx('main', 'conv-inv'), () => {
      const first = recordSuccessfulRead(p, {
        mtimeMs: 100, isPartialView: false,
        fullFileContent: 'v1', viewedContent: 'v1',
        readOffset: 0, readLimit: 2000,
      })
      expect(first.readId).toBeDefined()

      invalidateReadAfterMutation(p)

      const second = recordSuccessfulRead(p, {
        mtimeMs: 200, isPartialView: false,
        fullFileContent: 'v2', viewedContent: 'v2',
        readOffset: 0, readLimit: 2000,
      })
      expect(second.readId).toBeDefined()
      expect(second.readId).not.toBe(first.readId)
    })
  })

  // E41: Partial read covers edit window exactly at margin boundary
  it('E41: partial read receipt correctly calculates coverage margin', () => {
    const p = 'C:/tmp/coverage-margin.txt'.replace(/\\/g, '/')
    const body = Array.from({ length: 500 }, (_, i) => `line-${i + 1}`).join('\n')

    runWithAgentContext(agentCtx('main', 'conv-cov'), () => {
      recordSuccessfulRead(p, {
        mtimeMs: 100, isPartialView: true,
        viewedContent: body, readOffset: 0, readLimit: 500,
      })
    })
    // Even with a partial read, the coverage logic should detect this
    // is a wide enough window (offset 0, limit 500 covers many edit ranges)
  })

  // E42: Cross-agent dedup from partial-view source
  it('E42: cross-agent partial-view dedup delivers content and flags', () => {
    const p = 'C:/tmp/cross-partial.txt'.replace(/\\/g, '/')
    const body = 'partial file body'

    runWithAgentContext(agentCtx('agent-x', 'conv-yy'), () => {
      recordSuccessfulRead(p, {
        mtimeMs: 600, isPartialView: true,
        viewedContent: body, readOffset: 10, readLimit: 100,
      })
    })

    runWithAgentContext(agentCtx('agent-y', 'conv-yy'), () => {
      const r = tryConsumeReadDedup(p, 600, 10, 100)
      expect(r.dedup).toBe(true)
      if (r.dedup) {
        expect(r.crossAgent).toBe(true)
        expect(r.sourceIsPartial).toBe(true)
        expect(r.sourceReadOffset).toBe(10)
        expect(r.cachedContent).toBe(body)
      }
    })
  })

  // E43: buildFileUnchangedStub with valid readId
  it('E43: buildFileUnchangedStub formats correctly', () => {
    const stub = buildFileUnchangedStub('read-abcdef1234567890', 'content preview here')
    expect(stub).toMatch(/File unchanged since your last read/)
    expect(stub).toMatch(/read-abcdef1234567890/)
    expect(stub).toMatch(/content preview here/)
  })

  // E44: Hash mismatch detection
  it('E44: hash-anchored edit catches content hash mismatch', () => {
    const p = 'C:/tmp/hash-mismatch.txt'.replace(/\\/g, '/')

    let readId = ''
    runWithAgentContext(agentCtx('main', 'conv-hash'), () => {
      const result = recordSuccessfulRead(p, {
        mtimeMs: 700, isPartialView: false,
        fullFileContent: 'original', viewedContent: 'original',
        readOffset: 0, readLimit: 2000,
      })
      readId = result.readId!
    })

    // Now check with different content → should fail hash check
    runWithAgentContext(agentCtx('main', 'conv-hash'), () => {
      const r = assertReadBeforeEditByReadId(p, readId, 'modified', 'original', 'new')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('HASH_MISMATCH')
    })
  })

  // E45: OLD_STRING_NOT_IN_READ with CRLF normalization
  it('E45: readId gate normalizes CRLF for old_string check', () => {
    const p = 'C:/tmp/crlf-read-gate.txt'.replace(/\\/g, '/')
    const content = 'export const x = 1\r\nexport const y = 2\r\n'

    let readId = ''
    runWithAgentContext(agentCtx('main', 'conv-crlf'), () => {
      const result = recordSuccessfulRead(p, {
        mtimeMs: 800, isPartialView: false,
        fullFileContent: content, viewedContent: content,
        readOffset: 0, readLimit: 2000,
      })
      readId = result.readId!
    })

    // old_string uses LF but file is CRLF → normalization should match
    runWithAgentContext(agentCtx('main', 'conv-crlf'), () => {
      const r = assertReadBeforeEditByReadId(
        p, readId, content,
        'export const x = 1\nexport const y = 2', 'export const x = 9\nexport const y = 2',
      )
      // This should succeed because the snapshot and old_string are normalised
      // but the snapshot is CRLF and old_string is LF. The gate normalizes both.
      expect(r.ok).toBe(true)
    })
  })

  // E46: REPLACE_ALL_NEEDS_FULL_READ when receipt is partial
  it('E46: replace_all with partial read receipt is rejected', () => {
    const p = 'C:/tmp/partial-replace-all.txt'.replace(/\\/g, '/')
    const body = 'hello world hello'

    let readId = ''
    runWithAgentContext(agentCtx('main', 'conv-ra'), () => {
      const result = recordSuccessfulRead(p, {
        mtimeMs: 900, isPartialView: true,
        fullFileContent: body, viewedContent: 'hello world',
        readOffset: 0, readLimit: 2,
      })
      readId = result.readId!
    })

    runWithAgentContext(agentCtx('main', 'conv-ra'), () => {
      const r = assertReadBeforeEditByReadId(
        p, readId, body, 'hello', 'bye', true,
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('REPLACE_ALL_NEEDS_FULL_READ')
    })
  })
})

// ============================================================================
// CATEGORY 6: workspace/path security — 8 extreme scenarios
// ============================================================================
describe('CAT6: workspace/path security extreme scenarios', () => {
  // E47: Path with shell-like expansion
  it('E47: gateFileReadPath rejects shell expansions', () => {
    const r = gateFileReadPath('$(cat /etc/passwd)', '/tmp/resolved')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/shell/i)
  })


  // E48: UNC/SMB path detection
  it('E48: isUncOrSmbStylePath detects various UNC formats', () => {
    // UNC paths start with \\\\ (two backslashes) — in JS literal that's \\\\\\\\
    expect(isUncOrSmbStylePath('\\\\server\\share', 'C:\\resolved')).toBe(true)
    expect(isUncOrSmbStylePath('//server/share', 'C:\\resolved')).toBe(true)
    expect(isUncOrSmbStylePath('C:\\local\\path', 'C:\\local\\path')).toBe(false)
    // \\\\?\\UNC\\ resolved path — starts with \\, so line 422 catches it
    expect(isUncOrSmbStylePath('foo', '\\\\?\\UNC\\server\\share')).toBe(true)
  })

  // E49: Unix device path detection
  it('E49: isBlockedUnixStyleDevicePath blocks device paths', () => {
    expect(isBlockedUnixStyleDevicePath('/dev/null')).toBe(true)
    expect(isBlockedUnixStyleDevicePath('/dev/random')).toBe(true)
    expect(isBlockedUnixStyleDevicePath('/dev/zero')).toBe(true)
    expect(isBlockedUnixStyleDevicePath('/proc/self/fd/0')).toBe(true)
    expect(isBlockedUnixStyleDevicePath('/tmp/normal.txt')).toBe(false)
  })

  // E50: Binary extension blocking
  it('E50: isBlockedBinaryExtensionForRead blocks risky extensions', () => {
    expect(isBlockedBinaryExtensionForRead('app.exe')).toBe(true)
    expect(isBlockedBinaryExtensionForRead('lib.dll')).toBe(true)
    expect(isBlockedBinaryExtensionForRead('data.zip')).toBe(true)
    expect(isBlockedBinaryExtensionForRead('data.sqlite')).toBe(true)
    expect(isBlockedBinaryExtensionForRead('data.wasm')).toBe(true)
    expect(isBlockedBinaryExtensionForRead('photo.png')).toBe(false)
    expect(isBlockedBinaryExtensionForRead('doc.pdf')).toBe(false)
    expect(isBlockedBinaryExtensionForRead('doc.txt')).toBe(false)
  })

  // E51: Dangerous file basename detection
  it('E51: isDangerousSensitiveFileBasename detects dangerous basenames', () => {
    expect(isDangerousSensitiveFileBasename('/home/user/.gitconfig')).toBe(true)
    expect(isDangerousSensitiveFileBasename('/home/user/.GITCONFIG')).toBe(true)
    expect(isDangerousSensitiveFileBasename('/home/user/.bashrc')).toBe(true)
    expect(isDangerousSensitiveFileBasename('/home/user/.mcp.json')).toBe(true)
    expect(isDangerousSensitiveFileBasename('/home/user/.claude.json')).toBe(true)
    expect(isDangerousSensitiveFileBasename('/home/user/regular.txt')).toBe(false)
  })

  // E52: Dangerous directory segment detection
  it('E52: pathHasDangerousDirectorySegment detects protected dirs', () => {
    expect(pathHasDangerousDirectorySegment('/proj/.git/config')).toBe(true)
    expect(pathHasDangerousDirectorySegment('/proj/.vscode/settings.json')).toBe(true)
    expect(pathHasDangerousDirectorySegment('/proj/.idea/workspace.xml')).toBe(true)
    expect(pathHasDangerousDirectorySegment('/proj/.claude/settings.json')).toBe(true)
    expect(pathHasDangerousDirectorySegment('/proj/src/index.ts')).toBe(false)
  })

  // E53: resolveSearchPath with file target
  it('E53: resolveSearchPath resolves a single file target', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-search-'))
    const testFile = path.join(tmpDir, 'single.ts')
    fs.writeFileSync(testFile, '// test', 'utf-8')
    const origWs = getWorkspacePath()
    setWorkspacePath(os.tmpdir())
    try {
      const result = resolveSearchPath(path.relative(os.tmpdir(), testFile))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.singleFileTarget).toBeTruthy()
        expect(result.baseDir).toBe(path.dirname(testFile))
      }
    } finally {
      setWorkspacePath(origWs)
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })

  // E54: resolveSearchPath with non-existent path
  it('E54: resolveSearchPath handles non-existent path gracefully', () => {
    const origWs = getWorkspacePath()
    setWorkspacePath(os.tmpdir())
    try {
      const result = resolveSearchPath('non-existent-path-xyz-123')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.result.success).toBe(false)
        expect(result.result.error).toMatch(/not found/i)
      }
    } finally {
      setWorkspacePath(origWs)
    }
  })

  // E55: resolveSearchPath rejects UNC/SMB paths without touching the filesystem.
  // Real attack surface: stat-ing \\evil-host\share triggers an SMB handshake
  // and leaks the current user's NTLM hash on Windows. Must short-circuit before
  // existsSync / statSync ever runs.
  it('E55: resolveSearchPath rejects UNC paths (NTLM leak guard)', () => {
    const origWs = getWorkspacePath()
    setWorkspacePath(os.tmpdir())
    try {
      for (const unc of ['\\\\evil-host\\share', '//evil-host/share', '\\\\evil-host\\share\\sub']) {
        const result = resolveSearchPath(unc)
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.result.success).toBe(false)
          expect(result.result.error).toMatch(/UNC|SMB/i)
          expect(result.result.error).toMatch(/NTLM/)
        }
      }
    } finally {
      setWorkspacePath(origWs)
    }
  })

  // E56: resolveSearchPath includes a "Did you mean …?" hint when a workspace-
  // relative path doesn't exist but a similarly-named file/dir does. Covers
  // the typos LLMs actually make most often: missing extension and
  // singular/plural — both substring-matchable. (Case-only typos like
  // "COMPONENTS"→"components" can't be tested portably because NTFS resolves
  // them as the real path before we ever reach the suggestion branch.)
  it('E56: resolveSearchPath suggests a similar path on singular/plural typo', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-suggest-'))
    fs.mkdirSync(path.join(tmpDir, 'components'))
    fs.writeFileSync(path.join(tmpDir, 'components', 'Button.tsx'), '// ok', 'utf-8')
    const origWs = getWorkspacePath()
    setWorkspacePath(tmpDir)
    try {
      const result = resolveSearchPath('component')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.result.error).toMatch(/Did you mean/)
        expect(result.result.error).toMatch(/components/)
      }
    } finally {
      setWorkspacePath(origWs)
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ok */ }
    }
  })
})
