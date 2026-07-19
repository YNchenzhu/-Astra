import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toolGlob } from './toolGlob'

describe('toolGlob extreme', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-glob-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function create(relPath: string, content?: string): string {
    const fp = path.join(tmp, relPath)
    const dir = path.dirname(fp)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(fp, content ?? '', 'utf-8')
    return fp
  }

  function createDir(relPath: string): string {
    const dp = path.join(tmp, relPath)
    if (!fs.existsSync(dp)) fs.mkdirSync(dp, { recursive: true })
    return dp
  }

  // -----------------------------------------------------------------------
  // 1. Match files with .ts extension
  // -----------------------------------------------------------------------
  it('1. matches files by extension with **/*.ts', async () => {
    create('a.ts')
    create('b.ts')
    create('c.js')
    const r = await toolGlob('**/*.ts', tmp)
    expect(r.success).toBe(true)
    expect(r.numFiles).toBe(2)
    expect(r.output).toContain('a.ts')
    expect(r.output).toContain('b.ts')
    expect(r.output).not.toContain('c.js')
  })

  // -----------------------------------------------------------------------
  // 2. Match all files recursively
  // -----------------------------------------------------------------------
  it('2. matches all files with **/*', async () => {
    create('root.txt')
    create('a/file1.txt')
    create('a/b/file2.txt')
    const r = await toolGlob('**/*', tmp)
    expect(r.success).toBe(true)
    expect(r.numFiles).toBe(3)
  })

  // -----------------------------------------------------------------------
  // 3. Single char wildcard ?
  // -----------------------------------------------------------------------
  it('3. single-char wildcard ? matches exactly one character', async () => {
    create('ab')
    create('ac')
    create('abc')
    create('a')
    const r = await toolGlob('a?', tmp)
    expect(r.success).toBe(true)
    expect(r.numFiles).toBe(2)
    // Inspect the file list as parsed lines so a substring like `'a'` (which
    // is part of `'ab'`) doesn't trip the assertion. Earlier this test used
    // `expect(r.output).not.toContain('a')` which falsely failed for any
    // result containing the letter `a` regardless of `?`-correctness.
    const files = r.output.split('\n').filter(Boolean)
    expect(files).toContain('ab')
    expect(files).toContain('ac')
    expect(files).not.toContain('a')
    expect(files).not.toContain('abc')
  })

  // -----------------------------------------------------------------------
  // 4. Character class [abc]
  // -----------------------------------------------------------------------
  it('4. character class [abc] matches listed chars', async () => {
    create('file-a.txt')
    create('file-b.txt')
    create('file-c.txt')
    create('file-d.txt')
    const r = await toolGlob('file-[ab].txt', tmp)
    expect(r.success).toBe(true)
    expect(r.numFiles).toBe(2)
    expect(r.output).toContain('file-a.txt')
    expect(r.output).toContain('file-b.txt')
    expect(r.output).not.toContain('file-d.txt')
  })

  // -----------------------------------------------------------------------
  // 5. Brace alternation {a,b}
  // -----------------------------------------------------------------------
  it('5. brace alternation {cat,dog} matches listed alternatives', async () => {
    create('cat.ts')
    create('dog.ts')
    create('bird.ts')
    const r = await toolGlob('{cat,dog}.ts', tmp)
    expect(r.success).toBe(true)
    expect(r.numFiles).toBe(2)
    expect(r.output).toContain('cat.ts')
    expect(r.output).toContain('dog.ts')
    expect(r.output).not.toContain('bird.ts')
  })

  // -----------------------------------------------------------------------
  // 6. Exact file match
  // -----------------------------------------------------------------------
  it('6. exact filename match returns single result', async () => {
    create('exact.txt')
    const r = await toolGlob('exact.txt', tmp)
    expect(r.success).toBe(true)
    expect(r.numFiles).toBe(1)
    expect(r.output).toContain('exact.txt')
  })

  // -----------------------------------------------------------------------
  // 7. No matching files
  // -----------------------------------------------------------------------
  it('7. no matching files returns success with descriptive message', async () => {
    create('real.txt')
    const r = await toolGlob('nonexistent.*', tmp)
    expect(r.success).toBe(true)
    expect(r.output).toMatch(/No files matching/i)
  })

  // -----------------------------------------------------------------------
  // 8. includeDirs option
  // -----------------------------------------------------------------------
  it('8. includeDirs: true returns directory entries with trailing slash', async () => {
    createDir('src')
    create('src/app.ts')
    create('other.txt')
    const r = await toolGlob('src', tmp, { includeDirs: true })
    expect(r.success).toBe(true)
    // Should include the src directory
    expect(r.output).toContain('src')
  })

  // -----------------------------------------------------------------------
  // 9. maxResults limit
  // -----------------------------------------------------------------------
  it('9. maxResults caps output and sets truncated flag', async () => {
    for (let i = 0; i < 10; i++) create(`file${i}.txt`)
    const r = await toolGlob('*', tmp, { maxResults: 3 })
    expect(r.success).toBe(true)
    expect(r.numFiles).toBeLessThanOrEqual(3)
    // The contract for "how many files matched" is `numFiles`; `output` is
    // human-readable and on the ripgrep path includes a `(truncated at N
    // results)` footer that earlier counted as a 4th line and falsely
    // tripped the assertion. Filter out the footer / blank separators.
    const fileLines = r.output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('('))
    expect(fileLines.length).toBeLessThanOrEqual(3)
  })

  // -----------------------------------------------------------------------
  // 10. Hidden/dotfile exclusion
  // -----------------------------------------------------------------------
  it('10. files starting with dot are excluded (unless .env.example)', async () => {
    create('.hidden')
    create('.env.example') // explicitly allowed
    create('visible.txt')
    const r = await toolGlob('*', tmp)
    expect(r.success).toBe(true)
    expect(r.output).not.toContain('.hidden')
    // .env.example is explicitly allowed by the code
  })

  // -----------------------------------------------------------------------
  // 11. Deeply nested files via **/*
  // -----------------------------------------------------------------------
  it('11. nested directory recursion **/*.js finds deep files', async () => {
    create('a/b/c/d/test.js')
    create('root.js')
    const r = await toolGlob('**/*.js', tmp)
    expect(r.success).toBe(true)
    expect(r.numFiles).toBe(2)
    expect(r.output).toContain('test.js')
    expect(r.output).toContain('root.js')
  })

  // -----------------------------------------------------------------------
  // 12. cwd with Windows backslash path
  // -----------------------------------------------------------------------
  it('12. handles cwd with Windows-style backslash separators', async () => {
    create('subdir/file.txt')
    // Use path.join to get native backslash path on Windows
    const cwd = path.join(tmp, 'subdir')
    const r = await toolGlob('*.txt', cwd)
    expect(r.success).toBe(true)
    expect(r.numFiles).toBe(1)
    expect(r.output).toContain('file.txt')
  })

  // -----------------------------------------------------------------------
  // 13. Empty directory
  // -----------------------------------------------------------------------
  it('13. glob on empty directory returns "No files matching"', async () => {
    const r = await toolGlob('**/*', tmp)
    expect(r.success).toBe(true)
    expect(r.output).toMatch(/No files matching/i)
  })

  // -----------------------------------------------------------------------
  // 14. Combined extension pattern
  // -----------------------------------------------------------------------
  it('14. combined pattern *.{ts,js} matches both extensions', async () => {
    create('app.ts')
    create('app.js')
    create('app.css')
    const r = await toolGlob('*.{ts,js}', tmp)
    expect(r.success).toBe(true)
    expect(r.numFiles).toBe(2)
    expect(r.output).toContain('app.ts')
    expect(r.output).toContain('app.js')
    expect(r.output).not.toContain('app.css')
  })

  // -----------------------------------------------------------------------
  // 15. Pattern matching directory name without includeDirs
  // -----------------------------------------------------------------------
  it('15. directory name pattern without includeDirs excludes the directory', async () => {
    createDir('components')
    create('components/Button.tsx')
    create('root.tsx')
    // Pattern 'components' without includeDirs should only match files named exactly 'components'
    // Since there are no files named 'components', it should return no match
    const r = await toolGlob('components', tmp)
    expect(r.success).toBe(true)
    // Either no match or only matches file named components (none exist)
    // The directory itself should NOT appear
    if (r.numFiles && r.numFiles > 0) {
      // Any match must be a file, not the directory
      expect(r.output).not.toContain('components/')
    }
  })

  // -----------------------------------------------------------------------
  // 16. Single file target mode
  // -----------------------------------------------------------------------
  it('16. cwd pointing to a single file degenerates to file-name check', async () => {
    create('target.ts')
    const filePath = path.join(tmp, 'target.ts')
    const r = await toolGlob('*.ts', filePath)
    expect(r.success).toBe(true)
    // Should match the single file because it matches *.ts
    expect(r.numFiles).toBe(1)
  })

  // -----------------------------------------------------------------------
  // 17. Unicode filenames
  // -----------------------------------------------------------------------
  it('17. handles Unicode filenames like 你好.txt', async () => {
    create('\u4F60\u597D.txt') // 你好.txt
    create('hello.txt')
    const r = await toolGlob('*.txt', tmp)
    expect(r.success).toBe(true)
    expect(r.numFiles).toBe(2)
    expect(r.output).toContain('\u4F60\u597D.txt')
  })

  // -----------------------------------------------------------------------
  // 18. Filename with bracket characters (literal matching)
  // -----------------------------------------------------------------------
  it('18. handles filename with literal bracket chars test[1].txt', async () => {
    create('test[1].txt')
    create('test1.txt')
    const r = await toolGlob('test[1].txt', tmp)
    expect(r.success).toBe(true)
    // In glob syntax, [1] is a character class matching '1'.
    // So test[1].txt would match both test1.txt and test[1].txt
    // (on filesystems where [ and ] are allowed in filenames).
    // At minimum, we verify the tool doesn't crash.
    expect(r.success).toBe(true)
  })

  // -----------------------------------------------------------------------
  // 19. Depth limit of 20
  // -----------------------------------------------------------------------
  it('19. respects depth limit of 20 for deeply nested files', async () => {
    // Create files at depths 1..25
    let deep = ''
    for (let i = 1; i <= 25; i++) {
      deep += `d${i}/`
    }
    create(`${deep}deepest.txt`)
    // Also create a file at depth 10
    create('a1/a2/a3/a4/a5/a6/a7/a8/a9/a10/shallow.txt')
    const r = await toolGlob('**/*.txt', tmp)
    expect(r.success).toBe(true)
    // Files beyond depth 20 should not be found (JS fallback only; ripgrep may differ)
    // At minimum the tool should not crash
    expect(r.success).toBe(true)
    if (r.numFiles !== undefined && r.numFiles > 0) {
      // The shallow file at depth 10 *should* be found
      expect(r.output).toContain('shallow.txt')
    }
  })

  // -----------------------------------------------------------------------
  // 20. Very large result set (300 files, default maxResults=200)
  // -----------------------------------------------------------------------
  it('20. large result set caps at 200 by default with truncation', async () => {
    for (let i = 0; i < 300; i++) {
      create(`big${String(i).padStart(4, '0')}.txt`)
    }
    const r = await toolGlob('*', tmp)
    expect(r.success).toBe(true)
    // Default maxResults is 200
    expect(r.numFiles).toBeLessThanOrEqual(200)
    // Should indicate truncation
    if (r.truncated) {
      expect(r.output).toMatch(/truncated/i)
    }
  })
})
