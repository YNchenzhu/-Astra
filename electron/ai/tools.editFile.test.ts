import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  computeFileEditResult,
  toolEditFile,
  toolReadFile,
  MAX_EDIT_FILE_BYTES,
  normalizeFileEditInput,
} from './tools'
import { toolRegistry } from '../tools/registry'
import { setWorkspacePath } from '../tools/workspaceState'
import { clearAllReadFileState } from '../tools/readFileState'

describe('normalizeFileEditInput (OpenClaude)', () => {
  it('strips trailing whitespace from new_string per line when path is not .md/.mdx', () => {
    const r = normalizeFileEditInput({
      file_path: 'C:\\proj\\src\\a.ts',
      fileContent: 'hello\n',
      edits: [{ old_string: 'hello', new_string: 'world  \n' }],
    })
    expect(r.edits[0]!.new_string).toBe('world\n')
  })

  it('preserves new_string for .md/.mdx (Markdown hard line breaks use two trailing spaces)', () => {
    const r = normalizeFileEditInput({
      file_path: '/proj/readme.md',
      fileContent: 'x\n',
      edits: [{ old_string: 'x', new_string: 'y  \n' }],
    })
    expect(r.edits[0]!.new_string).toBe('y  \n')
  })

  it('desanitizes old_string when the file contains the real token', () => {
    const fileContent = 'before <function_results> after'
    const r = normalizeFileEditInput({
      file_path: '/x.ts',
      fileContent,
      edits: [{ old_string: 'before <fnr> after', new_string: 'ok <fnr> ok' }],
    })
    expect(r.edits[0]!.old_string).toBe('before <function_results> after')
    expect(r.edits[0]!.new_string).toBe('ok <function_results> ok')
  })

  it('returns edits unchanged when fileContent is undefined (OpenClaude ENOENT path)', () => {
    const r = normalizeFileEditInput({
      file_path: '/missing.ts',
      fileContent: undefined,
      edits: [{ old_string: 'a', new_string: 'b  \n' }],
    })
    expect(r.edits[0]!.new_string).toBe('b  \n')
    expect(r.edits[0]!.old_string).toBe('a')
  })
})

describe('computeFileEditResult newline tolerance', () => {
  it('matches LF old_string in CRLF file (single replace)', () => {
    const content = 'export const x = 1\r\nexport const y = 2\r\n'
    const r = computeFileEditResult(
      content,
      'export const x = 1\nexport const y = 2',
      'export const x = 9\r\nexport const y = 2',
    )
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('export const x = 9\r\nexport const y = 2\r\n')
    }
  })

  it('replace_all: LF multiline old_string in CRLF file', () => {
    const content = 'start\r\nfoo\r\nbar\r\nend\r\n'
    const r = computeFileEditResult(content, 'foo\nbar\n', 'z\n', { replaceAll: true })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('start\r\nz\r\nend\r\n')
    }
  })

  it('exact match still preferred when old_string matches bytes', () => {
    const content = 'foo\nbar'
    const r = computeFileEditResult(content, 'foo', 'baz')
    expect(r.success).toBe(true)
    if (r.success) expect(r.newContent).toBe('baz\nbar')
  })

  it('strips UTF-8 BOM for matching and preserves BOM in output', () => {
    const content = '\uFEFFexport const x = 1\r\n'
    const r = computeFileEditResult(content, 'export const x = 1', 'export const x = 2')
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('\uFEFFexport const x = 2\r\n')
    }
  })

  it('matches old_string pasted from Read tool (line number + tab per line)', () => {
    const content = 'export const x = 1\nexport const y = 2\n'
    const fromRead = '1\texport const x = 1\n2\texport const y = 2'
    const r = computeFileEditResult(
      content,
      fromRead,
      'export const x = 9\nexport const y = 2\n',
    )
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('export const x = 9\nexport const y = 2\n')
    }
  })

  it('matches old_string pasted from hashline read_file output (line:hash + tab per line)', () => {
    const content = 'export const x = 1\nexport const y = 2\n'
    const fromRead = '1:aa\texport const x = 1\n2:bb\texport const y = 2'
    const r = computeFileEditResult(
      content,
      fromRead,
      'export const x = 9\nexport const y = 2\n',
    )
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('export const x = 9\nexport const y = 2\n')
    }
  })

  it('reports candidate line locations when old_string is not unique', () => {
    const content = 'const x = 1\nconst keep = 0\nconst x = 1\n'
    const r = computeFileEditResult(content, 'const x = 1', 'const x = 2')
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error).toContain('Candidate locations')
      expect(r.error).toContain('line 1')
      expect(r.error).toContain('line 3')
    }
  })

  it('centers the candidate snippet on the match inside a very long line', () => {
    // A short, non-unique needle buried deep inside a long prose line. The
    // snippet must show the bytes AROUND the match (so "expand old_string"
    // is actionable), not just the start of the line.
    const longLineHead = 'A'.repeat(300)
    const longLineTail = 'B'.repeat(300)
    const content =
      `${longLineHead}NEEDLE${longLineTail}\n` + // line 1 — match deep inside
      `short NEEDLE here\n` // line 2 — short, shown whole
    const r = computeFileEditResult(content, 'NEEDLE', 'X')
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error).toContain('Candidate locations')
      // The long-line snippet must include the needle (centered window),
      // with an ellipsis showing the line head was trimmed away.
      expect(r.error).toContain('NEEDLE')
      expect(r.error).toContain('…')
      // It must NOT degrade to showing only the 300-char head of A's.
      expect(r.error).not.toContain('A'.repeat(118))
    }
  })

  it('strips Read trailing "(showing lines …)" from old_string', () => {
    const content = 'hello\nworld\n'
    const oldPasted = '1\thello\n2\tworld\n\n(showing lines 1-2 of 99)'
    const r = computeFileEditResult(content, oldPasted, 'hi\nworld\n')
    expect(r.success).toBe(true)
    if (r.success) expect(r.newContent).toBe('hi\nworld\n')
  })

  it('matches when file has curly quotes and model sent ASCII quotes; preserves curly typography in new_string (OpenClaude preserveQuoteStyle)', () => {
    const content = 'const msg = \u201chello\u201d\n'
    const r = computeFileEditResult(content, 'const msg = "hello"', 'const msg = "hi"')
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe(`const msg = \u201chi\u201d\n`)
    }
  })

  it('matches when file has fullwidth CJK punctuation and model drifted to halfwidth ASCII (claude-code #52482)', () => {
    // Disk uses fullwidth `（`/`）`/`，`/`。` (typical Chinese doc/spec format).
    // Model drifted to ASCII `(`/`)`/`,`/`.` in old_string.
    const content = '注意（参考第\uFF13条），详见说明\u3002\n'
    const r = computeFileEditResult(
      content,
      '注意(参考第\uFF13条),详见说明.',
      '注意（参考第3条），详见说明。',
    )
    expect(r.success).toBe(true)
    if (r.success) {
      // The replacement uses the model's new_string verbatim; the surrounding
      // file body keeps its original chars.
      expect(r.newContent).toBe('注意（参考第3条），详见说明。\n')
    }
  })

  it('matches Chinese brackets / colons drift in a longer paragraph and restores fullwidth style in new_string', () => {
    // 全角【】《》：；in disk → 半角 []<>:; in drifted old_string.
    // Every aligned [ ] occurrence drifted, so new_string's halfwidth
    // brackets are restored to the file's 【】 typography
    // (preserveFullwidthPunctuationStyle).
    const content = '【目标】《SPEC v1》：完成全部测试；不漏一项！\n'
    const r = computeFileEditResult(
      content,
      '[目标]<SPEC v1>:完成全部测试;不漏一项!',
      '[done]',
    )
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('【done】\n')
    }
  })

  it('restores fullwidth punctuation AND Chinese quotes in new_string after a drift match', () => {
    // Disk: fullwidth ：，。 and Chinese quotes “”. Model drifted everything
    // to halfwidth ASCII in old_string and writes new_string the same way.
    const content = '他说：“你好，世界。”\n'
    const r = computeFileEditResult(
      content,
      '他说:"你好,世界."',
      '他说:"再见,朋友."',
    )
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('他说：“再见，朋友。”\n')
    }
  })

  it('leaves a punctuation char untouched when the matched region shows it is genuinely halfwidth somewhere (ambiguous)', () => {
    // Disk mixes halfwidth `,` inside the call with fullwidth `，` in prose.
    // `,` is ambiguous → stays halfwidth in new_string; `.` drifted at its
    // only aligned position → restored to 。
    const content = '调用 f(a,b)，然后结束。\n'
    const r = computeFileEditResult(
      content,
      '调用 f(a,b),然后结束.',
      '调用 g(x,y),完成.',
    )
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('调用 g(x,y),完成。\n')
    }
  })

  it('does not touch new_string when old_string matched the file verbatim (no drift)', () => {
    const content = '原文，保持。\n'
    const r = computeFileEditResult(content, '原文，保持。', '改后,混排.')
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('改后,混排.\n')
    }
  })

  it('rejects empty old_string when file already has content (OpenClaude FileEditTool)', () => {
    const r = computeFileEditResult('not empty', '', 'x')
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error).toMatch(/empty old_string/i)
    }
  })

  it('empty new_string: extends old_string to include following newline when deleting a line (OpenClaude applyEditToFile)', () => {
    const content = 'keep\nremove\nend\n'
    const r = computeFileEditResult(content, 'remove', '', {})
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('keep\nend\n')
    }
  })
})

describe('toolEditFile', () => {
  let dir: string
  beforeEach(() => {
    clearAllReadFileState()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-edit-'))
    setWorkspacePath(dir)
  })
  afterEach(() => {
    setWorkspacePath(null)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('empty oldString on non-empty file is rejected (OpenClaude: use write_file or non-empty old_string)', async () => {
    const fp = path.join(dir, 'a.md')
    fs.writeFileSync(fp, 'old', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(fp, '', '# new\n')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/empty old_string/i)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('old')
  })

  it('empty oldString on empty file replaces content', async () => {
    const fp = path.join(dir, 'a-empty.md')
    fs.writeFileSync(fp, '', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(fp, '', '# new\n')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('# new\n')
  })

  it('whitespace-only oldString on empty file replaces entire file', async () => {
    const fp = path.join(dir, 'b.md')
    fs.writeFileSync(fp, '', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(fp, '\n  \n', '# doc')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('# doc')
  })

  it('whitespace-only oldString on non-empty file is not a full replace (not found)', async () => {
    const fp = path.join(dir, 'c.md')
    fs.writeFileSync(fp, 'hello', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(fp, '\n', 'x')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/not found/i)
  })

  it('normal single replace still works', async () => {
    const fp = path.join(dir, 'd.md')
    fs.writeFileSync(fp, 'a old b', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(fp, 'old', 'new')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('a new b')
  })

  it('toolEditFile: trims trailing spaces on newString for non-.md (normalizeFileEditInput)', async () => {
    const fp = path.join(dir, 'trim.ts')
    fs.writeFileSync(fp, 'ab', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(fp, 'b', 'x  ')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('ax')
  })

  it('rejects edit that would clear a non-empty file (full replace with empty newString)', async () => {
    const fp = path.join(dir, 'clear-full.md')
    fs.writeFileSync(fp, 'keep me', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(fp, '', '')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/identical|empty|clear/i)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('keep me')
  })

  it('rejects edit that would clear a non-empty file (replace snippet with empty)', async () => {
    const fp = path.join(dir, 'clear-snippet.md')
    fs.writeFileSync(fp, 'ab', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(fp, 'ab', '')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/empty|clear/i)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('ab')
  })

  it('rejects edit that reduces a non-empty file to a BOM-only remnant', async () => {
    // Post-normalisation destructive-clear guard: even if the literal new
    // content is '\uFEFF' (not strictly ''), the semantic body after BOM
    // stripping is empty and would erase everything the user had.
    const fp = path.join(dir, 'bom-remnant.md')
    fs.writeFileSync(fp, '\uFEFFreal body', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(fp, 'real body', '')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/empty|clear/i)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('\uFEFFreal body')
  })

  it('rejects empty oldString and empty newString (OpenClaude: identical no-op)', async () => {
    const fp = path.join(dir, 'already-empty.md')
    fs.writeFileSync(fp, '', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(fp, '', '')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/no-op|empty/i)
  })

  it('edit_file tool: empty content with oldString/newString does not treat as full-file write', async () => {
    const fp = path.join(dir, 'e.md')
    fs.writeFileSync(fp, 'hello world', 'utf-8')
    await toolReadFile(fp)
    const r = await toolRegistry.execute('edit_file', {
      filePath: fp,
      oldString: 'world',
      newString: 'there',
    })
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('hello there')
  })

  it('creates a new file when path missing and oldString is empty (OpenClaude create)', async () => {
    const fp = path.join(dir, 'new-created.ts')
    const r = await toolEditFile(fp, '', 'export const x = 1\n')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('export const x = 1\n')
    expect(r.output).toMatch(/Created/)
  })

  it('rejects edit_file on .ipynb (use NotebookEdit)', async () => {
    const fp = path.join(dir, 'n.ipynb')
    fs.writeFileSync(fp, '{"cells":[]}', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(fp, '"cells":[]', '"cells":[{}]')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/NotebookEdit|notebook/i)
  })

  // ---------------------------------------------------------------------
  // First-try-correct guards: catch common AI failure modes BEFORE the
  // lower-layer "old_string not found" path, with a message that tells the
  // model exactly what it did wrong. Saves a full round-trip each time.
  // ---------------------------------------------------------------------

  it('rejects a literal "..." in old_string with an explanation', async () => {
    // Regression: AI frequently abbreviates long code blocks with `...`
    // expecting partial-match semantics. Edit does exact bytes only.
    const fp = path.join(dir, 'ellipsis.py')
    fs.writeFileSync(
      fp,
      [
        'def start_reskin_single(self):',
        '    """docstring"""',
        '    if not self.project:',
        '        return',
        '    print("done")',
      ].join('\n'),
      'utf-8',
    )
    await toolReadFile(fp)
    const r = await toolEditFile(
      fp,
      'def start_reskin_single(self):\n    """docstring"""\n...',
      'def start_reskin_single(self):\n    """docstring"""\n    print("new")',
    )
    // upstream alignment Part 1: placeholder-ellipsis gate removed. Edits
    // containing `...` now fall through to exact-byte matching. Disk bytes
    // do NOT contain `def start_reskin_single(self):\n    """docstring"""\n...`
    // verbatim, so the edit fails with a standard "not found" error.
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/not found|exact match|did not match/i)
    expect(r.error).not.toMatch(/does NOT expand placeholders/)
  })

  it('Unicode ellipsis "…" is no longer rejected by a placeholder gate (cc-haha alignment)', async () => {
    const fp = path.join(dir, 'unicode-ellipsis.py')
    fs.writeFileSync(fp, 'def foo():\n    x = 1\n    return x\n', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(
      fp,
      'def foo():\n    x = 1\n    …',
      'def foo():\n    x = 2\n    return x',
    )
    // Disk does not contain a literal `…` line, so the edit fails on
    // byte-exact match — not on the historical placeholder gate.
    expect(r.success).toBe(false)
    expect(r.error).not.toMatch(/"…"/)
    expect(r.error).not.toMatch(/does NOT expand placeholders/)
  })

  // Regression: the previous regex `/(?:^|[^.])\.{3}(?:[^.]|$)/` triggered on
  // legitimate JS/TS spread/rest (`(...args)`, `[...arr]`, `{ ...obj }`)
  // because the parens / brackets count as `[^.]` flankers. We tightened the
  // detector to require whitespace or comment-marker boundaries — these
  // patterns must now pass through to the actual edit logic.
  it('does NOT reject JS spread/rest patterns in old_string (regression)', async () => {
    const fp = path.join(dir, 'spread.ts')
    fs.writeFileSync(
      fp,
      [
        'export function pick(...args: unknown[]) {',
        '  const merged = { ...args[0] }',
        '  return [...args, merged]',
        '}',
      ].join('\n'),
      'utf-8',
    )
    await toolReadFile(fp)
    // `...args` is a placeholder-looking pattern that is in fact legit syntax.
    const r = await toolEditFile(
      fp,
      'export function pick(...args: unknown[]) {',
      'export function pick(...args: readonly unknown[]) {',
    )
    // Either the edit succeeds, or it fails for a *real* reason (e.g. read
    // gate). What it must NOT do is reject because the regex thought
    // `...args` was a placeholder.
    if (!r.success) {
      expect(r.error).not.toMatch(/does NOT expand placeholders/)
    }
  })

  it('does NOT reject array / object spread in old_string', async () => {
    const fp = path.join(dir, 'array-spread.ts')
    fs.writeFileSync(fp, 'const a = [...src]\nconst b = { ...src }\n', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(fp, 'const a = [...src]', 'const a = [...src.slice()]')
    if (!r.success) {
      expect(r.error).not.toMatch(/does NOT expand placeholders/)
    }
  })

  it('placeholder ellipsis no longer triggers expansion suggestion (cc-haha alignment)', async () => {
    const fp = path.join(dir, 'expand.ts')
    fs.writeFileSync(
      fp,
      [
        'function bigBlock() {',
        '  const a = 1',
        '  const b = 2',
        '  const c = 3',
        '  return a + b + c',
        '}',
      ].join('\n'),
      'utf-8',
    )
    await toolReadFile(fp)
    // upstream alignment Part 1: the historical auto-expansion path is now
    // unreachable. `...` inside old_string falls through to exact-byte
    // matching, which here cannot match a literal `  ...` line.
    const r = await toolEditFile(
      fp,
      ['function bigBlock() {', '  ...', '  return a + b + c', '}'].join('\n'),
      ['function bigBlock() {', '  return 6', '}'].join('\n'),
    )
    expect(r.success).toBe(false)
    expect(r.error).not.toMatch(/does NOT expand placeholders/)
    expect(r.error).not.toMatch(/BEGIN SUGGESTED old_string/)
    expect(r.error).toMatch(/not found|exact match|did not match/i)
  })

  it('ambiguous placeholder context falls through to exact-byte match (cc-haha alignment)', async () => {
    const fp = path.join(dir, 'ambiguous.ts')
    fs.writeFileSync(
      fp,
      [
        'if (x) {',
        '  doA()',
        '}',
        'if (x) {',
        '  doB()',
        '}',
      ].join('\n'),
      'utf-8',
    )
    await toolReadFile(fp)
    const r = await toolEditFile(
      fp,
      'if (x) {\n  ...\n}',
      'if (x) {\n  doNothing()\n}',
    )
    expect(r.success).toBe(false)
    expect(r.error).not.toMatch(/does NOT expand placeholders/)
    expect(r.error).not.toMatch(/BEGIN SUGGESTED old_string/)
  })

  it('placeholder ellipsis with replaceAll falls through to exact-byte match (cc-haha alignment)', async () => {
    const fp = path.join(dir, 'replace-all.ts')
    fs.writeFileSync(fp, 'function bigBlock() {\n  const a = 1\n  return a\n}\n', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(
      fp,
      'function bigBlock() {\n  ...\n  return a\n}',
      'function bigBlock() {\n  return 0\n}',
      { replaceAll: true },
    )
    expect(r.success).toBe(false)
    expect(r.error).not.toMatch(/does NOT expand placeholders/)
  })

  it('accepts legitimate "..." inside source when old_string === real bytes (cc-haha alignment)', async () => {
    // upstream alignment Part 1: the placeholder-ellipsis gate is gone, so an
    // edit whose `old_string` happens to contain `...` (Python Ellipsis
    // literal, JS spread, prose ellipsis) succeeds iff the bytes match
    // exactly on disk. This fixes the prior false rejection on `x = ...`.
    const fp = path.join(dir, 'real-ellipsis.py')
    fs.writeFileSync(fp, 'x = ...\n', 'utf-8')
    await toolReadFile(fp)
    const r = await toolEditFile(fp, 'x = ...', 'x = 42')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('x = 42\n')
  })

  it('appends a "wrong file / wrong buffer" warning when the best fuzzy match is weak', async () => {
    // A fuzzy hit is emitted (score ≥ 0.35 threshold) but remains below
    // the 0.55 strong-match line — the agent most likely has the wrong
    // file open or is paraphrasing old code from memory.
    const fp = path.join(dir, 'weak-match.ts')
    fs.writeFileSync(
      fp,
      ['const handleSubmit = async (input) => {', '  return persist(input)', '}'].join('\n'),
      'utf-8',
    )
    await toolReadFile(fp)
    // Extra tokens in old_string (`opts`, `extras`, `more`, `return`, `true`)
    // dilute the anchor so coverage falls into 0.35–0.55 weak-match band.
    const r = await toolEditFile(
      fp,
      'const handleSubmit = async (input, opts, extras, more) => { return true }',
      'const handleSubmit = async (input) => { return true }',
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/closest match/i)
    expect(r.error).toMatch(/(WRONG file|WRONG version|read_file)/i)
  })

  it('rejects files over MAX_EDIT_FILE_BYTES (stat)', async () => {
    const fp = path.join(dir, 'huge.txt')
    fs.writeFileSync(fp, 'tiny', 'utf-8')
    await toolReadFile(fp)
    const spy = vi.spyOn(fs, 'statSync').mockImplementation((p: fs.PathLike) => {
      const s = String(p)
      if (s.replace(/\\/g, '/') === fp.replace(/\\/g, '/')) {
        return { size: MAX_EDIT_FILE_BYTES + 1, isFile: () => true } as fs.Stats
      }
      return fs.statSync(p)
    })
    const r = await toolEditFile(fp, 'tiny', 'TINY')
    spy.mockRestore()
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/too large|Maximum editable/i)
  })
})
