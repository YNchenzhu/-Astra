import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  bashInputZod,
  editFileInputZod,
  formatZodToolInputError,
  globInputZod,
  grepInputZod,
  lspToolInputZod,
  multiEditFileInputZod,
  readFileInputZod,
  skillToolInputZod,
  taskStopInputZod,
  taskUpdateInputZod,
  todoWriteInputZod,
  validateToolZodInput,
  webFetchInputZod,
  writeFileInputZod,
} from './toolInputZod'
import type { Tool } from './types'

describe('toolInputZod', () => {
  it('read_file lenient mode: unknown keys are kept passing validation (model-forgiveness)', () => {
    // Plan §P1: `.strict()` → `.passthrough()` on high-traffic tools so
    // benign extra fields (common OpenAI/Gemini model output) don't block
    // the whole tool call.
    const r = readFileInputZod.safeParse({
      filePath: 'x',
      extra: 1,
    })
    expect(r.success).toBe(true)
  })

  it('validateToolZodInput passes coerced shape', () => {
    const tool = { name: 'read_file', zInputSchema: readFileInputZod } as Tool
    const v = validateToolZodInput(tool, { filePath: 'README.md' })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.data.filePath).toBe('README.md')
  })

  it('accepts OpenClaude file_path alias and normalizes to filePath', () => {
    const tool = { name: 'read_file', zInputSchema: readFileInputZod } as Tool
    const v = validateToolZodInput(tool, { file_path: '/tmp/x.txt', offset: 1 })
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.data.filePath).toBe('/tmp/x.txt')
      expect(v.data.offset).toBe(1)
    }
  })

  it('web_fetch normalizes domain: to https URL', () => {
    const tool = { name: 'web_fetch', zInputSchema: webFetchInputZod } as Tool
    const v = validateToolZodInput(tool, { url: 'domain:docs.example.com/path' })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.data.url).toBe('https://docs.example.com/path')
  })

  it('read_file coerces string offset/limit to numbers', () => {
    const tool = { name: 'read_file', zInputSchema: readFileInputZod } as Tool
    const v = validateToolZodInput(tool, { filePath: 'a.txt', offset: '2', limit: '10' })
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.data.offset).toBe(2)
      expect(v.data.limit).toBe(10)
    }
  })

  it('bash accepts snake_case run_in_background and timeout_ms', () => {
    const tool = { name: 'bash', zInputSchema: bashInputZod } as Tool
    const v = validateToolZodInput(tool, {
      command: '  echo hi  ',
      run_in_background: true,
      timeout_ms: 5000,
    })
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.data.command).toBe('echo hi')
      expect(v.data.runInBackground).toBe(true)
      expect(v.data.timeoutMs).toBe(5000)
    }
  })

  it('bash rejects empty command', () => {
    expect(bashInputZod.safeParse({ command: '   ' }).success).toBe(false)
  })

  it('bash coerces string timeout_ms', () => {
    const v = bashInputZod.safeParse({ command: 'true', timeout_ms: '30000' })
    expect(v.success).toBe(true)
    if (v.success) expect(v.data.timeoutMs).toBe(30000)
  })

  it('Skill strict rejects unknown keys', () => {
    expect(skillToolInputZod.safeParse({ skill: 'x', extra: 1 }).success).toBe(false)
  })

  it('Skill requires skill unless end_inline_skill_session', () => {
    expect(skillToolInputZod.safeParse({}).success).toBe(false)
    const end = skillToolInputZod.safeParse({ end_inline_skill_session: true })
    expect(end.success).toBe(true)
  })

  it('edit_file accepts old_string / new_string aliases', () => {
    const tool = { name: 'edit_file', zInputSchema: editFileInputZod } as Tool
    const v = validateToolZodInput(tool, {
      file_path: 'f.ts',
      old_string: 'a',
      new_string: 'b',
      replace_all: true,
    })
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.data.filePath).toBe('f.ts')
      expect(v.data.oldString).toBe('a')
      expect(v.data.newString).toBe('b')
      expect(v.data.replaceAll).toBe(true)
    }
  })

  it('TodoWrite accepts native todos array', () => {
    const tool = { name: 'TodoWrite', zInputSchema: todoWriteInputZod } as Tool
    const v = validateToolZodInput(tool, {
      todos: [{ content: 'a', status: 'pending', activeForm: 'Doing a' }],
    })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.data.todos).toHaveLength(1)
  })

  it('TodoWrite coerces stringified JSON todos array', () => {
    const tool = { name: 'TodoWrite', zInputSchema: todoWriteInputZod } as Tool
    const v = validateToolZodInput(tool, {
      todos:
        '[{"content":"x","status":"in_progress","activeForm":"Working on x"},{"content":"y","status":"pending","activeForm":"Doing y"}]',
    })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.data.todos).toHaveLength(2)
  })

  it('grep maps path to cwd', () => {
    const tool = { name: 'grep', zInputSchema: grepInputZod } as Tool
    const v = validateToolZodInput(tool, { pattern: 'foo', path: '/tmp/proj' })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.data.cwd).toBe('/tmp/proj')
  })

  it('grep prefers cwd over path when both set', () => {
    const v = grepInputZod.safeParse({ pattern: 'x', cwd: '/a', path: '/b' })
    expect(v.success).toBe(true)
    if (v.success) expect(v.data.cwd).toBe('/a')
  })

  it('TaskStop accepts task_id alias', () => {
    const tool = { name: 'TaskStop', zInputSchema: taskStopInputZod } as Tool
    const v = validateToolZodInput(tool, { task_id: 'task-1' })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.data.taskId).toBe('task-1')
  })

  it('LSP workspaceSymbol passes without filePath when query is provided', () => {
    // Regression: workspaceSymbol is workspace-wide and must not require a
    // file path. Requiring filePath here forced a paradox on the AI
    // ("you must tell me what file to look in if you want to find symbol X
    // anywhere"), which is why the operation was effectively unused.
    const v = lspToolInputZod.safeParse({
      operation: 'workspaceSymbol',
      query: 'ToolUseCardProps',
    })
    expect(v.success).toBe(true)
  })

  it('LSP workspaceSymbol fails when query is missing', () => {
    const v = lspToolInputZod.safeParse({
      operation: 'workspaceSymbol',
    })
    expect(v.success).toBe(false)
    if (!v.success) {
      expect(JSON.stringify(v.error.issues)).toMatch(/workspaceSymbol requires.*query/)
    }
  })

  it('LSP non-workspaceSymbol operations still require filePath', () => {
    const v = lspToolInputZod.safeParse({
      operation: 'goToDefinition',
      line: 10,
      character: 5,
    })
    expect(v.success).toBe(false)
    if (!v.success) {
      expect(JSON.stringify(v.error.issues)).toMatch(/filePath/)
    }
  })

  it('TaskUpdate normalizes snake_case and title; metadata object to string', () => {
    const tool = { name: 'TaskUpdate', zInputSchema: taskUpdateInputZod } as Tool
    const v = validateToolZodInput(tool, {
      task_id: 't-1',
      title: 'Do thing',
      active_form: 'Doing thing',
      add_blocked_by: 'a, b',
      metadata: { priority: 1 },
      status: 'in_progress',
    })
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.data.taskId).toBe('t-1')
      expect(v.data.subject).toBe('Do thing')
      expect(v.data.activeForm).toBe('Doing thing')
      expect(v.data.addBlockedBy).toBe('a, b')
      expect(v.data.metadata).toBe('{"priority":1}')
    }
  })
})

// ─── multi_edit_file / edit_file — baseReadId fallback (no filePath) ────
//
// Loosened gate: schema accepts `{ edits, baseReadId }` (without filePath)
// because the tool surface recovers the path from `findReadReceiptByReadId`.
// Without the loosening, models that drop filePath on long multi-edit
// batches see `InputValidationError (multi_edit_file): filePath: filePath
// or file_path is required | received keys: [edits, baseReadId]` and have
// no way to recover other than guessing the path.

describe('writeFileInputZod — baseReadId fallback', () => {
  it('accepts {content, baseReadId} payloads without filePath (loosened gate)', () => {
    const r = writeFileInputZod.safeParse({
      content: 'new content\n',
      baseReadId: 'read-abc',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.baseReadId).toBe('read-abc')
      expect(r.data.filePath).toBe('')
      expect(r.data.content).toBe('new content\n')
    }
  })

  it('still rejects when BOTH filePath AND baseReadId are missing', () => {
    const r = writeFileInputZod.safeParse({ content: 'x' })
    expect(r.success).toBe(false)
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join(' | ')
      expect(msg).toMatch(/filePath or file_path is required/)
      expect(msg).toMatch(/baseReadId/)
    }
  })

  it('accepts snake_case base_read_id alias', () => {
    const r = writeFileInputZod.safeParse({
      content: 'x',
      base_read_id: 'read-xyz',
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.baseReadId).toBe('read-xyz')
  })
})

describe('multiEditFileInputZod — baseReadId fallback', () => {
  it('accepts {edits, baseReadId} payloads without filePath (loosened gate)', () => {
    const r = multiEditFileInputZod.safeParse({
      edits: [{ oldString: 'a', newString: 'b' }],
      baseReadId: 'read-abc',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.baseReadId).toBe('read-abc')
      expect(r.data.filePath).toBe('') // empty until tool resolves from baseReadId
      expect(r.data.edits).toHaveLength(1)
    }
  })

  it('still rejects when BOTH filePath AND baseReadId are missing', () => {
    const r = multiEditFileInputZod.safeParse({
      edits: [{ oldString: 'a', newString: 'b' }],
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join(' | ')
      expect(msg).toMatch(/filePath or file_path is required/)
      expect(msg).toMatch(/baseReadId/)
    }
  })

  it('accepts snake_case base_read_id alias', () => {
    const r = multiEditFileInputZod.safeParse({
      edits: [{ old_string: 'a', new_string: 'b' }],
      base_read_id: 'read-xyz',
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.baseReadId).toBe('read-xyz')
  })
})

describe('formatZodToolInputError — __rawArguments hint heuristic', () => {
  function probe(rawJson: string): string {
    const input = { __rawArguments: rawJson }
    const r = multiEditFileInputZod.safeParse(input)
    if (r.success) throw new Error('expected schema to reject __rawArguments-only input')
    return formatZodToolInputError('multi_edit_file', r.error, input, multiEditFileInputZod)
  }

  it('switches to escape-focused hint when raw payload has unescaped " inside a string value', () => {
    // Real-world repro shape: oldString contains a literal " that the model
    // forgot to escape. JSON.parse fails at the stray ", and parseToolArguments
    // falls back to __rawArguments — we want the model to be told the right
    // root cause on retry, not the misleading "truncation" default.
    const raw =
      '{"filePath":"a.txt","edits":[{"oldString":"深植"民族性"的办学基因","newString":"x"}]}'
    const msg = probe(raw)
    expect(msg).toMatch(/unescaped/i)
    expect(msg).toMatch(/semantic string value/i)
    expect(msg).toMatch(/do not add a literal backslash/i)
    expect(msg).not.toMatch(/Truncation is likely|shorten the payload/i)
  })

  it('refuses a write/edit payload that was only parseable via lenient JSON repair', () => {
    // The streaming layer tags lenient-repaired write/edit calls with the
    // marker key; the schema must refuse so a mis-guessed newString/content
    // boundary is never persisted. Read-class tools have no such gate.
    const r = multiEditFileInputZod.safeParse({
      filePath: 'a.txt',
      edits: [{ oldString: 'a', newString: 'b' }],
      __argsLenientlyRepaired: true,
    })
    if (r.success) throw new Error('expected lenient-repaired multi_edit to be rejected')
    const msg = formatZodToolInputError('multi_edit_file', r.error, {}, multiEditFileInputZod)
    expect(msg).toMatch(/lenient JSON repair/i)
    expect(msg).toMatch(/\\"/)
  })

  it('surfaces a tailored headline from the marker even when received carries it (strict-tool path)', () => {
    // A .strict() tool (e.g. notebook_edit) rejects a marker-carrying input with
    // a generic "unrecognized key" issue and NO tailored superRefine message.
    // formatZodToolInputError must read the marker off `received` and still give
    // the actionable lenient/truncation headline (plus the cross-agent marker).
    const strictNotebookLike = z.object({ filePath: z.string() }).strict()
    const input = { filePath: 'a.ipynb', __argsLenientlyRepaired: true }
    const r = strictNotebookLike.safeParse(input)
    if (r.success) throw new Error('expected strict schema to reject the unknown marker key')
    const msg = formatZodToolInputError('notebook_edit', r.error, input)
    expect(msg).toMatch(/lenient JSON repair/i)
    expect(msg).toMatch(/FIX FIRST/)
  })

  it('surfaces the truncation headline from the marker on a strict-tool reject', () => {
    const strictNotebookLike = z.object({ filePath: z.string() }).strict()
    const input = { filePath: 'a.ipynb', __argsTruncatedByMaxTokens: true }
    const r = strictNotebookLike.safeParse(input)
    if (r.success) throw new Error('expected strict schema to reject the unknown marker key')
    const msg = formatZodToolInputError('notebook_edit', r.error, input)
    expect(msg).toMatch(/truncated at the model output token limit/i)
  })

  it('pin-points the offending " with a marked excerpt deep inside a long payload', () => {
    // The default preview is sliced from char 0, so a stray quote buried in a
    // long Chinese newString would never be visible. The pinpoint excerpt must
    // surface the offending region with the →»"«← marker regardless of depth.
    const filler = '一'.repeat(800)
    const raw =
      `{"filePath":"a.txt","edits":[{"oldString":"x","newString":"${filler}深植"民族性"基因"}]}`
    const msg = probe(raw)
    expect(msg).toMatch(/unescaped/i)
    // The marker and surrounding context must appear (proves we located the
    // interior quote and showed it, not just the start of the payload).
    expect(msg).toContain('→»"«←')
    expect(msg).toMatch(/offending `"` is near char \d+/)
    expect(msg).toContain('深植')
  })

  it('keeps truncation-focused hint when raw payload is cut off mid-string', () => {
    // Stream truncated inside an open string: inString stays true to EOF, so
    // the heuristic must NOT misfire — the default truncation hint is correct.
    const raw = '{"filePath":"a.txt","edits":[{"oldString":"hello wor'
    const msg = probe(raw)
    expect(msg).toMatch(/shorten the payload|truncated/i)
    expect(msg).not.toMatch(/unescaped/i)
  })

  it('does not false-fire on other malformations with no string-context anomaly', () => {
    // Bare-token JSON (unquoted key). Our scanner sees no `"` closes at all,
    // so it falls back to the default hint instead of inventing an escape
    // explanation that does not apply.
    const raw = '{a:1}'
    const msg = probe(raw)
    expect(msg).not.toMatch(/unescaped/i)
  })
})

describe('formatZodToolInputError — empty / dropped-argument headline', () => {
  it('surfaces an actionable "missing/empty arguments" headline when write_file is called with {}', () => {
    // DeepSeek-on-Anthropic-compat symptom: the model emits a tool_use block
    // whose argument stream is empty, so write_file reaches Zod as `{}` and
    // fails with the cryptic `content: ... received undefined`. Without the
    // headline the model just repeats the same empty call and trips the
    // cross-agent block.
    const r = writeFileInputZod.safeParse({})
    expect(r.success).toBe(false)
    if (r.success) return
    const msg = formatZodToolInputError('write_file', r.error, {}, writeFileInputZod)
    expect(msg).toMatch(/FIX FIRST: this tool call arrived with missing\/empty/i)
    expect(msg).toMatch(/dropped or truncated/i)
    expect(msg).toMatch(/Do NOT repeat the same empty call/i)
    // Canonical prefix preserved for UI / telemetry consumers.
    expect(msg).toMatch(/InputValidationError \(write_file\)/)
  })

  it('fires for a partial write_file (filePath present, content never generated)', () => {
    const input = { filePath: '/tmp/x.py' }
    const r = writeFileInputZod.safeParse(input)
    expect(r.success).toBe(false)
    if (r.success) return
    const msg = formatZodToolInputError('write_file', r.error, input, writeFileInputZod)
    expect(msg).toMatch(/FIX FIRST: this tool call arrived with missing\/empty/i)
    // Partial-but-valid JSON must NOT be blamed on streaming truncation — a
    // real truncation is caught by the __rawArguments / max_tokens-marker
    // paths. The old wording taught models to conclude "content too long →
    // write via bash heredoc instead".
    expect(msg).not.toMatch(/dropped or truncated while streaming/i)
    expect(msg).toMatch(/complete, valid object/i)
    expect(msg).toMatch(/never generated/i)
    expect(msg).toMatch(/do NOT conclude the content was "too long"/i)
    expect(msg).toMatch(/Do NOT repeat the same incomplete call/i)
    // Fix-3: the bash/PowerShell escape hatch is explicitly forbidden.
    expect(msg).toMatch(/Do NOT fall back to bash \/ PowerShell/i)
  })

  it('keeps the streaming-truncation wording ONLY for the fully-empty {} case', () => {
    const r = writeFileInputZod.safeParse({})
    expect(r.success).toBe(false)
    if (r.success) return
    const msg = formatZodToolInputError('write_file', r.error, {}, writeFileInputZod)
    expect(msg).toMatch(/dropped or truncated while streaming/i)
    // Empty write_file also gets the no-shell-bypass tail; non-write tools don't.
    expect(msg).toMatch(/Do NOT fall back to bash \/ PowerShell/i)
    const rg = globInputZod.safeParse({})
    expect(rg.success).toBe(false)
    if (rg.success) return
    const globMsg = formatZodToolInputError('glob', rg.error, {}, globInputZod)
    expect(globMsg).not.toMatch(/Do NOT fall back to bash \/ PowerShell/i)
  })

  it('fires for empty edit_file and multi_edit_file (whole edit suite covered by one path)', () => {
    const re = editFileInputZod.safeParse({})
    expect(re.success).toBe(false)
    if (!re.success) {
      const msg = formatZodToolInputError('edit_file', re.error, {}, editFileInputZod)
      expect(msg).toMatch(/FIX FIRST: this tool call arrived with missing\/empty/i)
    }
    const rm = multiEditFileInputZod.safeParse({})
    expect(rm.success).toBe(false)
    if (!rm.success) {
      const msg = formatZodToolInputError('multi_edit_file', rm.error, {}, multiEditFileInputZod)
      expect(msg).toMatch(/FIX FIRST: this tool call arrived with missing\/empty/i)
    }
  })

  it('does NOT fire the dropped-args headline for a present-but-wrong-type value', () => {
    // A number where a string is expected is a genuine model mistake, not a
    // transport drop — it must fall through to the standard message.
    const input = { filePath: '/tmp/x.py', content: 123 as unknown as string }
    const r = writeFileInputZod.safeParse(input)
    expect(r.success).toBe(false)
    if (r.success) return
    const msg = formatZodToolInputError('write_file', r.error, input, writeFileInputZod)
    expect(msg).not.toMatch(/dropped or truncated/i)
  })

  it('appends the content/edit_file advice ONLY for write/edit tools', () => {
    const rw = writeFileInputZod.safeParse({})
    const rg = globInputZod.safeParse({})
    expect(rw.success).toBe(false)
    expect(rg.success).toBe(false)
    if (rw.success || rg.success) return
    const writeMsg = formatZodToolInputError('write_file', rw.error, {}, writeFileInputZod)
    const globMsg = formatZodToolInputError('glob', rg.error, {}, globInputZod)
    // Both get the generic dropped-args headline + "do not repeat" guidance.
    expect(writeMsg).toMatch(/arrived with missing\/empty required argument/i)
    expect(globMsg).toMatch(/arrived with missing\/empty required argument/i)
    expect(writeMsg).toMatch(/Do NOT repeat the same empty call/i)
    expect(globMsg).toMatch(/Do NOT repeat the same empty call/i)
    // Only write/edit tools get the content/newString chunking advice.
    expect(writeMsg).toMatch(/write in smaller chunks or use `edit_file`/i)
    expect(globMsg).not.toMatch(/write in smaller chunks or use `edit_file`/i)
    expect(globMsg).not.toMatch(/oversized `write_file`/i)
  })

  it('write/edit truncation marker → distinct max_tokens-truncation headline (not the generic dropped-args one)', () => {
    const input = { filePath: '/tmp/x.ts', content: 'partial...', __argsTruncatedByMaxTokens: true }
    const r = writeFileInputZod.safeParse(input)
    expect(r.success).toBe(false)
    if (r.success) return
    const msg = formatZodToolInputError('write_file', r.error, input, writeFileInputZod)
    expect(msg).toMatch(/truncated at the model output token limit/i)
    expect(msg).toMatch(/file was NOT written/i)
    expect(msg).toMatch(/append the remaining parts with `edit_file`/i)
    // It must NOT be misclassified as the empty/dropped-args case.
    expect(msg).not.toMatch(/arrived with missing\/empty required argument/i)
  })

  it('does NOT fire the dropped-args headline when __rawArguments is present (parse-failure path owns that)', () => {
    const input = { __rawArguments: '{"filePath":"a.txt","content":"hello wor' }
    const r = writeFileInputZod.safeParse(input)
    expect(r.success).toBe(false)
    if (r.success) return
    const msg = formatZodToolInputError('write_file', r.error, input, writeFileInputZod)
    expect(msg).not.toMatch(/missing\/empty required argument/i)
  })
})
