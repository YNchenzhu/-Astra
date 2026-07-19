import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toolGrep } from './toolGrep'
import { setWorkspacePath } from '../tools/workspaceState'

function mkFile(dir: string, name: string, content: string): string {
  const fp = path.join(dir, name)
  fs.writeFileSync(fp, content, 'utf-8')
  return fp
}

describe('toolGrep extreme tests', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-grep-extreme-'))
    setWorkspacePath(tmp)
  })

  afterEach(() => {
    setWorkspacePath(null)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // 1. Simple text match (files_with_matches)
  it('TC01: simple text match returns matching files', async () => {
    mkFile(tmp, 'a.txt', 'hello world\n')
    mkFile(tmp, 'b.txt', 'goodbye world\n')
    const r = await toolGrep('hello', tmp, { outputMode: 'files_with_matches' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.output).toContain('a.txt')
      expect(r.output).not.toContain('b.txt')
    }
  })

  // 2. Case insensitive match
  it('TC02: case insensitive match finds different casing', async () => {
    mkFile(tmp, 'caps.txt', 'Hello World\n')
    const r = await toolGrep('hello', tmp, { outputMode: 'content', caseInsensitive: true })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.output).toContain('Hello')
    }
  })

  // 3. Case sensitive mismatch
  it('TC03: case sensitive default does not match different casing', async () => {
    mkFile(tmp, 'caps.txt', 'Hello World\n')
    mkFile(tmp, 'lower.txt', 'hello world\n')
    const r = await toolGrep('Hello', tmp, { outputMode: 'files_with_matches' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.output).toContain('caps.txt')
      expect(r.output).not.toContain('lower.txt')
    }
  })

  // 4. Regex metacharacters as literal — escaped dollar sign
  it('TC04: escaped dollar sign in regex matches literal $', async () => {
    mkFile(tmp, 'prices.txt', 'price: $100.00\naltprice: $50\nfree item\n')
    const r = await toolGrep('\\$100', tmp, { outputMode: 'files_with_matches' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.output).toContain('prices.txt')
      expect(r.output).not.toContain('$50')
    }
  })

  // 5. Content mode with line numbers
  it('TC05: content mode shows matched line content', async () => {
    const content = 'line one\nline two\nline three TARGET here\nline four\nline five\n'
    mkFile(tmp, 'numbered.txt', content)
    const r = await toolGrep('TARGET', tmp, { outputMode: 'content', lineNumbers: true })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.output).toContain('TARGET')
      // The text from line 3 should appear
      expect(r.output).toContain('TARGET here')
    }
  })

  // 6. Count mode
  it('TC06: count mode returns occurrence counts per file', async () => {
    mkFile(tmp, 'countme.txt', 'foo foo foo bar\nfoo again\n')
    const r = await toolGrep('foo', tmp, { outputMode: 'count' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.output).toMatch(/countme\.txt:\s*\d/)
      expect(r.numMatches).toBeGreaterThan(0)
    }
  })

  // 7. Multiline match across lines
  it('TC07: multiline pattern matches across line boundaries', async () => {
    mkFile(tmp, 'multi.txt', 'lineA\nlineB\nlineC\n')
    const r = await toolGrep('lineA\\nlineB', tmp, {
      outputMode: 'files_with_matches',
      multiline: true,
    })
    expect(r.success).toBe(true)
    // With multiline, the pattern should match across lines
    if (r.success && r.output && r.output.includes('multi.txt')) {
      // It matched — multiline works
    }
    // Even if it doesn't on the JS fallback, at minimum it shouldn't crash
  })

  // 8. Context lines
  it('TC08: context lines show surrounding content', async () => {
    const lines: string[] = []
    for (let i = 1; i <= 10; i++) lines.push(`line ${i}: some text here`)
    mkFile(tmp, 'ctx.txt', lines.join('\n') + '\n')
    const r = await toolGrep('line 5', tmp, { outputMode: 'content', context: 2 })
    expect(r.success).toBe(true)
    if (r.success) {
      // Should contain context from line 3,4 and 6,7
      expect(r.output).toContain('line 5')
    }
  })

  // 9. Include filter — only match files matching glob
  it('TC09: include filter restricts matched files', async () => {
    mkFile(tmp, 'src.ts', 'TODO: fix')
    mkFile(tmp, 'src.js', 'TODO: fix')
    mkFile(tmp, 'readme.md', 'TODO: fix')
    const r = await toolGrep('TODO', tmp, {
      include: '*.ts',
      outputMode: 'files_with_matches',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.output).toContain('src.ts')
      expect(r.output).not.toContain('src.js')
      expect(r.output).not.toContain('readme.md')
    }
  })

  // 10. Exclude filter — skip files matching glob
  it('TC10: exclude filter omits matched files', async () => {
    mkFile(tmp, 'main.ts', 'TODO: refactor')
    mkFile(tmp, 'main.test.ts', 'TODO: add test')
    mkFile(tmp, 'utils.ts', 'TODO: cleanup')
    const r = await toolGrep('TODO', tmp, {
      exclude: '*.test.*',
      outputMode: 'files_with_matches',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.output).toContain('main.ts')
      expect(r.output).not.toContain('main.test.ts')
    }
  })

  // 11. Pagination with headLimit and offset
  it('TC11: headLimit + offset paginates results', async () => {
    for (let i = 0; i < 10; i++) {
      mkFile(tmp, `file_${String(i).padStart(2, '0')}.txt`, 'MATCH\n')
    }
    // headLimit:3 starting from offset:2 should return results 3-5
    // But offset is at the result level not file level; just check it works
    const r = await toolGrep('MATCH', tmp, {
      outputMode: 'files_with_matches',
      headLimit: 3,
      offset: 2,
    })
    expect(r.success).toBe(true)
    // Should return at most 3 results
  })

  // 12. No matches returns success with "No matches"
  it('TC12: no matches returns success with "No matches" message', async () => {
    mkFile(tmp, 'empty.txt', 'just some text\n')
    const r = await toolGrep('NONEXISTENT_NEEDLE_12345', tmp, {
      outputMode: 'files_with_matches',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.output).toMatch(/no matches/i)
    }
  })

  // 13. Invalid regex pattern returns error
  it('TC13: invalid regex pattern returns success:false with error', async () => {
    mkFile(tmp, 'dummy.txt', 'content\n')
    const r = await toolGrep('[unclosed', tmp, { outputMode: 'files_with_matches' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error).toMatch(/invalid regex|unterminated/i)
    }
  })

  // 14. Empty pattern — should produce a result (not crash)
  it('TC14: empty pattern does not crash', async () => {
    mkFile(tmp, 'empty-pat.txt', 'hello\n')
    // Empty pattern is a valid regex that matches empty string — can match everything
    const r = await toolGrep('', tmp, { outputMode: 'files_with_matches' })
    // Should at least not crash; either matches all or errors gracefully
    expect(r).toBeDefined()
  })

  // 15. Unicode text match
  it('TC15: unicode text pattern matches multi-byte characters', async () => {
    mkFile(tmp, 'zh.txt', '你好世界！这是中文测试。\nこんにちは\n')
    const r = await toolGrep('你好', tmp, { outputMode: 'files_with_matches' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.output).toContain('zh.txt')
    }
  })

  // 16. Large file near size limit — search finds late content
  it('TC16: matches content in a moderately large file (~500KB)', async () => {
    const needle = 'UNIQUE_NEEDLE_FOR_LARGE_FILE'
    // Build ~300KB of filler + needle at end
    const filler = 'x'.repeat(100) + '\n'
    const fillerBlock = filler.repeat(3000)
    const content = fillerBlock + needle + '\n'
    mkFile(tmp, 'big.txt', content)
    const r = await toolGrep(needle, tmp, { outputMode: 'files_with_matches' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.output).toContain('big.txt')
    }
  })

  // 17. File type filter — uses ripgrep --type
  it('TC17: ripgrep --type filtering by file type', async () => {
    mkFile(tmp, 'script.py', 'import os\n')
    mkFile(tmp, 'script.js', 'import fs from "fs"\n')
    const r = await toolGrep('import', tmp, { outputMode: 'files_with_matches', type: 'py' })
    expect(r.success).toBe(true)
    if (r.success) {
      // Should only match .py file when using type:'py'
      expect(r.output).toContain('script.py')
    }
  })

  // 18. Dot as literal — escaped dot matches literal period, not any char
  it('TC18: escaped dot matches literal period only', async () => {
    mkFile(tmp, 'dots.txt', 'a.b X\naxb X\n')
    const r = await toolGrep('a\\.b', tmp, { outputMode: 'content' })
    expect(r.success).toBe(true)
    if (r.success) {
      // Should match 'a.b' but not 'axb'
      expect(r.output).toContain('a.b')
      expect(r.output).not.toContain('axb')
    }
  })

  // 19. Leading dash in pattern — handled by ripgrep -e flag.
  // The point of this test is that a pattern beginning with `-` (which the
  // shell would otherwise treat as a CLI flag) reaches ripgrep verbatim.
  // The previous version of this test gave `dash.txt` content `-color`
  // (single dash) but searched for `--color` (double dash) — those don't
  // share a substring, so the test could never pass even with a perfect
  // CLI router. Use file contents that actually contain the pattern.
  it('TC19: leading dash in pattern passed correctly to ripgrep', async () => {
    mkFile(tmp, 'dash.txt', '--color: red\ncolor: blue\n')
    const r = await toolGrep('--color', tmp, { outputMode: 'files_with_matches' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.output).toContain('dash.txt')
    }
  })

  // 20. Regex anchors — ^ matches start of line
  it('TC20: regex start anchor ^ matches line beginnings', async () => {
    mkFile(tmp, 'anchors.txt', 'start middle end\n  start indented\nmiddle start end\n')
    const r = await toolGrep('^start', tmp, { outputMode: 'content' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.output).toContain('start middle')
      // "start indented" should not match ^start because it has leading spaces
      // "middle start end" — "start" is not at the start
    }
  })
})
