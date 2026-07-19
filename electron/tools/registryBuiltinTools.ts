/**
 * Built-in tool definitions for the unified Tool Registry.
 */

import {
  toolReadFile,
  toolWriteFile,
  toolEditFile,
  toolMultiEditFile,
  toolListFiles,
} from '../ai/tools'
import { toolGlob } from '../ai/toolGlob'
import { toolGrep } from '../ai/toolGrep'
import { toolWebFetch } from '../ai/toolWebFetch'
import { toolWebSearch, WEB_SEARCH_MAX_RESULT_CHARS } from '../ai/toolWebSearch'
import { toolRecallAttachment } from '../ai/toolRecallAttachment'
import {
  validateEditToolPayload,
  validateMultiEditToolPayload,
} from '../utils/settings/validateEditTool'
import {
  bashInputZod,
  editFileInputZod,
  globInputZod,
  grepInputZod,
  listFilesInputZod,
  multiEditFileInputZod,
  powerShellInputZod,
  readFileInputZod,
  webFetchInputZod,
  webSearchInputZod,
  writeFileInputZod,
} from './toolInputZod'
import { validateBashCommand, isCommandReadOnly } from './bashSecurity'
import { validatePowerShellCommand, isPowerShellCommandReadOnly } from './powershell/validatePowerShellCommand'
import { runPowerShellCommand } from './shellRunner'
import { appendPreExecutionWarnings } from './shellErrorFormat'
import type { ToolErrorClass } from '../ai/classifyToolError'
import { runSandboxedCommand } from '../utils/sandbox/sandbox-command'
import { getWorkspacePath } from './workspaceState'
import { excelTools } from './office/excelTool'
import { wordTools } from './office/wordTool'
import type { Tool } from './types'
import { buildTool } from './buildTool'
import { awaitTool } from './AwaitTool'
import { bestOfNTool } from './BestOfNTool'

export const builtinTools: Tool[] = [
  buildTool({
    name: 'read_file',
    searchHint: 'read open view file contents lines source',
    description:
      'Read a single FILE from disk and return its content with line numbers. ' +
      'Returns lines as `<N>:<hash>\\t<text>` (1-based line number, 2-char line hash, ' +
      'a literal TAB, then the line) so the model can use `hashAnchor` for precise edits. ' +
      'When pasting into `edit_file`, the tool automatically strips the `<N>:<hash>\\t` prefix — so verbatim ' +
      'paste works — but prefer stripped lines when hand-editing the snippet. ' +
      'Relative paths resolve against the workspace root. ' +
      'For directory contents use `list_files`. For pattern matches use `grep`. ' +
      'Max 10 MB. On files larger than the limit, read a window with offset/limit ' +
      'instead of bumping maxSizeBytes. ' +
      '**Editing-prep rule: when planning to edit this file, prefer a FULL read (no offset/limit). ' +
      'A partial read is only valid if the window already covers every line you will touch plus ' +
      'about 100 lines of context on either side. If the file is under ~2000 lines, just read it whole — ' +
      'the edit gate rejects partial reads that miss the edit region and you will pay another turn.**',
    inputSchema: [
      {
        name: 'filePath',
        type: 'string',
        description:
          'Path to the FILE. Absolute OR relative-to-workspace. ' +
          'A directory path will be rejected with a pointer to `list_files`.',
        required: true,
      },
      {
        name: 'offset',
        type: 'number',
        description:
          'Line to start from, **0-indexed** (first line = 0; line 100 in a 1-indexed ' +
          'editor is offset 99). Combine with `limit` to read a window of a big file. ' +
          'Do NOT use to skip early "matter" you do not want — read the whole file and ignore. ' +
          'OMIT entirely when planning an edit unless the file is genuinely huge — a partial ' +
          'read that misses the edit region forces a re-read and wastes a turn.',
      },
      {
        name: 'limit',
        type: 'number',
        description:
          'Max lines to return (default 2000, max 2000). Use this when you need only ' +
          'a window; the returned block starts at `offset` and ends after `limit` lines. ' +
          'OMIT entirely when planning an edit unless the file is genuinely huge.',
      },
      {
        name: 'maxSizeBytes',
        type: 'number',
        description:
          'Override the 10 MB cap (e.g. for a large JSON you MUST load in full). ' +
          'Prefer offset/limit over raising this — enormous payloads blow the context window.',
      },
      {
        name: 'maxTokens',
        type: 'number',
        description: 'Soft cap on approximate line count (takes effect as a line window).',
      },
    ],
    isReadOnly: true,
    isConcurrencySafe: true,
    runIn: 'worker',
    maxResultChars: 2_000_000,
    zInputSchema: readFileInputZod,
    async call({ filePath, offset, limit, maxSizeBytes, maxTokens }, ctx) {
      if (ctx?.abortSignal.aborted) {
        return {
          success: false,
          error: 'read_file aborted before execution (signal already fired).',
          toolErrorClass: 'aborted',
        }
      }
      return toolReadFile(filePath, { offset, limit, maxSizeBytes, maxTokens })
    },
  }),

  buildTool({
    name: 'write_file',
    searchHint: 'create new file save full contents from scratch',
    description:
      'Create a NEW file. **REJECTED on ANY existing file — even a zero-byte empty file.** ' +
      'If `filePath` exists on disk at all, this call WILL fail; the only path to modify an ' +
      'existing file is `edit_file`. To insert content into an existing empty file, call ' +
      '`edit_file` with `oldString: ""` and your content as `newString`. ' +
      'Do NOT call `write_file` after `read_file` on a path that already exists — that ' +
      'wastes tokens, the result is always the same rejection. ' +
      'Creates parent directories automatically when the path is new. ' +
      'Always send BOTH `filePath` and `content` together in a single valid JSON ' +
      'argument object — never emit an empty or partial argument block. Empty / ' +
      'truncated arguments are rejected outright. ' +
      '**Large files MUST be written in chunks.** A single model response has an ' +
      'output-token ceiling (≈100KB of text), so any sizable target — roughly the ' +
      '20–150KB range or larger — will be truncated mid-`content` if you try to emit it ' +
      'all in one call, and a truncated write is rejected (no partial file is persisted). ' +
      'For such targets: create the file with the FIRST chunk via `write_file`, then ' +
      'append each remaining chunk with successive `edit_file` calls (anchor on the ' +
      'end of the file) until the full requested size is reached. Continue these append ' +
      'calls yourself — do NOT write one chunk and then stop to ask the user whether to ' +
      'keep going.',
    inputSchema: [
      {
        name: 'filePath',
        type: 'string',
        description:
          'Absolute OR relative-to-workspace path. A directory path will be rejected. ' +
          'Parent directories are created on demand.',
        required: true,
      },
      {
        name: 'content',
        type: 'string',
        description:
          'Full file contents to write, byte-for-byte. Include a trailing newline. ' +
          'Do NOT include line-number prefixes like "   1→" that `read_file` emits — ' +
          'strip them before writing back.',
        required: true,
      },
    ],
    isReadOnly: false,
    isConcurrencySafe: false,
    runIn: 'worker',
    maxResultChars: 100_000,
    zInputSchema: writeFileInputZod,
    async call({ filePath, content, baseReadId }, _ctx) {
      // baseReadId alias normalisation + trim done by writeFileInputZod.
      // Passed through to toolWriteFile so the missing-filePath fallback
      // can recover the path from a recent read_file receipt — same
      // pattern as edit_file / multi_edit_file.
      return toolWriteFile(filePath, content, { baseReadId })
    },
  }),

  buildTool({
    name: 'edit_file',
    searchHint: 'modify substring replace patch update existing file',
    description:
      'Edit a file in place by replacing `oldString` with `newString`. ' +
      'Performs **exact byte matching** — NOT fuzzy / regex / partial / template. ' +
      'Rules:\n' +
      '  - read_file the target file FIRST. The edit tool rejects edits when the file ' +
      '    was not read, or when the read window does not cover the edit region.\n' +
      '  - Pass the readId returned by read_file back as baseReadId in edit_file — ' +
      '    this is the strongest anchor and prevents range / mtime mismatch rejections.\n' +
      '  - **readIds are PATH-BOUND, not global.** If you read A and B together, keep two ' +
      '    separate mappings (`A -> A\'s readId`, `B -> B\'s readId`). Never send the most ' +
      '    recently mentioned id with a different path. When the host ledger prints ' +
      '    `[Current path-bound readIds]`, copy the id beside the exact target path; if the ' +
      '    target is absent, call read_file first.\n' +
      '  - **readId ROTATES on every successful edit.** The edit_file response contains ' +
      '    a fresh `[readId: read-…]` line — that is the ONLY readId valid for the NEXT ' +
      '    edit on the same path. The readId from your earlier read_file is invalidated ' +
      '    the moment your edit lands, and reusing it returns ' +
      '    `baseReadId "…" is unknown or expired`. Always echo the latest readId from ' +
      '    the most recent read_file OR edit_file result on this path.\n' +
      '  - If you do not have a recent readId (e.g. it was lost across a sub-agent ' +
      '    boundary or compacted out of context), call read_file again and use the ' +
      '    readId from that response. Do NOT invent a readId and do NOT just omit ' +
      '    `baseReadId` — omission silently drops to a weaker legacy mtime/window gate, ' +
      '    and memory-driven post-compact edits are exactly what the readId gate exists ' +
      '    to catch. Sole exception: when a `[Post-compact …]` reminder lists this file ' +
      '    as `unchanged` AND surfaces a readId, pass that readId directly.\n' +
      '  - Paste old_string VERBATIM from the read_file output. The edit layer ' +
      '    auto-strips both `<N>\\t` and `<N>:<hash>\\t` prefixes, so raw paste works. ' +
      '    Include enough surrounding lines to make the match unique.\n' +
      '  - Do NOT use "..." or "…" as placeholders — the tool will reject them with ' +
      '    a clear hint. If the block is too long, break into smaller edits.\n' +
      '  - **Edit in small chunks — never rewrite a large region in a single call.** ' +
      '    When you need to rewrite or replace a lot of content (e.g. a whole section, ' +
      "    chapter, or document), do NOT put the entire old body into `oldString` and the " +
      '    entire new body into `newString`. Instead apply a SEQUENCE of small edits, ' +
      '    changing only a few lines at a time (around 3 lines — at most a short paragraph — ' +
      '    per call). One giant replacement almost always fails: a single drifted character ' +
      '    anywhere in a long `oldString` aborts the whole match, and large payloads risk ' +
      '    output truncation. Small sequential edits each match reliably and waste no tokens ' +
      '    on retries. (Normal small code edits are unaffected — this only matters for big rewrites.)\n' +
      '  - To replace EVERY occurrence, set `replace_all: true`.\n' +
      '  - **STRONGLY RECOMMENDED**: pass `expectedLineRange: [startLine, endLine]` ' +
      '    (1-based, inclusive) declaring where the edit is meant to land. The tool ' +
      '    treats this as an advisory boundary guard: it rejects obvious overlapping ' +
      '    cross-boundary hits, but does not fail safe unique edits just because earlier ' +
      '    edits shifted line numbers or CRLF/LF normalization was needed.\n' +
      '  - When oldString may occur more than once, pass `hashAnchor` from read_file\'s ' +
      '    `<N>:<hash>` prefix. The hash must match current disk content, otherwise the ' +
      '    tool rejects and asks for a re-read.\n' +
      '  - `.ipynb` notebooks must go through the dedicated NotebookEdit tool.\n' +
      '  - Max editable file size: 1 GiB.',
    inputSchema: [
      {
        name: 'filePath',
        type: 'string',
        description:
          'Path to the file. Absolute OR relative-to-workspace. A directory path is rejected.',
        required: true,
      },
      {
        name: 'oldString',
        type: 'string',
        description:
          'Exact bytes to find. Must be present verbatim in the file — no fuzzy matching, ' +
          'no regex metacharacters. If the first occurrence is ambiguous, include more ' +
          'surrounding lines until it is unique.',
        required: true,
      },
      {
        name: 'newString',
        type: 'string',
        description:
          'Replacement. Must differ from `oldString` in some way when the edit is meant to ' +
          'change the file. An identical `oldString === newString` is accepted as an ' +
          'idempotent no-op.',
        required: true,
      },
      {
        name: 'replaceAll',
        type: 'boolean',
        description:
          'Replace EVERY occurrence instead of just the first. Use for renames that span ' +
          'many lines. Otherwise the edit fails if `oldString` appears more than once.',
      },
      { name: 'replace_all', type: 'boolean', description: 'Alias for replaceAll (OpenClaude-style).' },
      {
        name: 'baseReadId',
        type: 'string',
        description:
          'STRONGLY RECOMMENDED. The readId from the LATEST read_file OR edit_file ' +
          'response on this same path. readIds are path-bound, never global: do not reuse ' +
          'A\'s id when editing B. When provided, the edit is validated against the ' +
          'EXACT byte snapshot recorded at read time (content-hash anchored) instead of ' +
          'the looser mtime/window heuristic. ' +
          '**IMPORTANT — readId rotation**: every successful edit_file invalidates the ' +
          'previous readId and emits a fresh one in its `[readId: …]` response line. ' +
          'For chained edits, always pass the readId from the *previous* edit_file ' +
          'output, NOT the original read_file. Reusing an old readId returns ' +
          '"baseReadId is unknown or expired". If you do not have a fresh readId, ' +
          're-call read_file and use its readId — never invent one, and do not just ' +
          'omit this field (omission drops to the weaker mtime/window gate). Sole ' +
          'exception: a `[Post-compact …]` reminder listing this file as `unchanged` ' +
          'supplies a readId you may pass directly.',
      },
      {
        name: 'base_read_id',
        type: 'string',
        description: 'Alias for baseReadId (snake_case).',
      },
      {
        name: 'expectedLineRange',
        type: 'array',
        description:
          'Optional [startLine, endLine] (1-based, inclusive) declaring where the edit ' +
          'is expected to land. Advisory guard only: rejects obvious overlapping ' +
          'cross-boundary hits, while safe unique edits can continue when line numbers ' +
          'shift after chained edits or CRLF/LF normalization is needed.',
        items: { type: 'integer' },
      },
      {
        name: 'expected_line_range',
        type: 'array',
        description: 'Alias for expectedLineRange (snake_case).',
        items: { type: 'integer' },
      },
      {
        name: 'hashAnchor',
        type: 'object',
        description:
          'Optional hashline-lite anchor from read_file output. Use the `line:hash` prefix, e.g. ' +
          '`12:a3\\t...` becomes `{ startLine: 12, startHash: "a3" }`. For multi-line edits, ' +
          'also provide endLine/endHash. If the hash changed, the tool rejects and asks for a re-read.',
      },
      {
        name: 'hash_anchor',
        type: 'object',
        description: 'Snake_case alias for hashAnchor: { start_line, start_hash, end_line, end_hash }.',
      },
    ],
    isReadOnly: false,
    isConcurrencySafe: false,
    runIn: 'worker',
    maxResultChars: 100_000,
    zInputSchema: editFileInputZod,
    validateInput: async (input) => {
      const v = validateEditToolPayload(input)
      return v.ok ? { valid: true } : { valid: false, message: v.message }
    },
    async call(
      { filePath, oldString, newString, replaceAll, baseReadId, expectedLineRange, hashAnchor },
      ctx,
    ) {
      // upstream alignment stage 1: pre-fs abort check. If the user / loop
      // already cancelled this turn, avoid kicking off a write that the
      // file-lock then has to be released for. Mirrors upstream's pattern of
      // tools honoring `ctx.abortController.signal` at every fs boundary.
      if (ctx?.abortSignal.aborted) {
        return {
          success: false,
          error: 'edit_file aborted before execution (signal already fired).',
          toolErrorClass: 'aborted',
        }
      }
      // Alias normalisation (filePath / oldString / newString / baseReadId /
      // expectedLineRange / hashAnchor) is already done by the zod transform,
      // so we receive canonical camelCase fields. baseReadId trim + empty
      // collapse is also handled there.
      return toolEditFile(filePath, oldString, newString, {
        replaceAll: replaceAll === true,
        baseReadId,
        expectedLineRange,
        hashAnchor,
      })
    },
  }),

  buildTool({
    name: 'multi_edit_file',
    searchHint: 'batch atomic edits rename refactor multiple substitutions one file',
    description:
      'Apply an ordered batch of substring edits to a SINGLE existing file in one atomic transaction. ' +
      'Use this instead of chaining multiple edit_file calls when refactoring (renames, signature changes, ' +
      'multi-spot bug fixes): the whole batch lands together, the file is locked for the full duration, and ' +
      'only ONE readId rotation happens at the end. ' +
      'Performs **exact byte matching** for each entry — NOT fuzzy / regex / partial / template. ' +
      'Rules:\n' +
      '  - read_file the target file FIRST. The same read-before-write gate as edit_file applies.\n' +
      '  - Pass the readId from your most recent read_file (or previous edit_file / multi_edit_file response) ' +
      '    as `baseReadId`. The whole batch is anchored to the EXACT bytes that readId recorded.\n' +
      '  - **readIds are PATH-BOUND, not global.** When several files were read, use the id ' +
      '    listed beside this exact target path in `[Current path-bound readIds]`; if absent, ' +
      '    call read_file first instead of borrowing another file\'s id.\n' +
      '  - **readId ROTATES once per successful multi_edit_file** (regardless of how many edits the batch ' +
      '    contained). The response contains a fresh `[readId for next edit: read-…]` line — that is the ' +
      '    ONLY readId valid for the next edit on this path. Reusing the old readId returns ' +
      '    "baseReadId is unknown or expired".\n' +
      '  - **Edits are applied in order.** Edit #1 runs against the disk content; edit #2 runs against ' +
      '    the result of edit #1, and so on. Order matters when later edits depend on earlier ones.\n' +
      '  - **No rewriting text another edit in the batch just authored.** If edit #N\'s oldString overlaps ' +
      '    the newly-written portion of an earlier edit\'s newString, the whole batch is rejected — that ' +
      '    pattern is almost always a chained-clobber bug. Fix by MERGING (author the earlier edit\'s ' +
      '    newString in its final form and drop edit #N), or split into separate multi_edit_file calls. ' +
      '    Overlapping only the unchanged context lines an earlier edit carried is fine — adjacent edits ' +
      '    sharing context are applied normally.\n' +
      '  - **Per-edit no-op is rejected.** Each edit must actually change the file. If you find yourself ' +
      '    wanting to include an "intentional no-op", you don\'t — drop that entry from the batch.\n' +
      '  - **Final no-op is rejected.** After all edits run, the file must differ from the original. ' +
      '    A round-trip batch (edit #1 adds X, edit #2 removes X) is a model bug we want to surface.\n' +
      '  - Paste each oldString VERBATIM from read_file output. The edit layer auto-strips the ' +
      '    `<N>:<hash>\\t` prefix, so raw paste works. Include enough surrounding lines per entry to make ' +
      '    each match unique.\n' +
      '  - Supply the semantic oldString/newString values exactly as read. Structured tool calling ' +
      '    serializes quotes, backslashes, and newlines for transport automatically. Do NOT add literal ' +
      '    backslashes before quotes or replace real newlines with the two characters `\\n`; those bytes ' +
      '    would become part of the parsed value and fail exact matching.\n' +
      '  - Do NOT use "..." or "…" as placeholders in any oldString — the tool will reject the whole batch ' +
      '    with a clear hint. Unlike edit_file, multi_edit_file CANNOT offer a prefix/suffix auto-expand ' +
      '    suggestion because the disk content drifts between edits within the batch.\n' +
      '  - To replace EVERY occurrence inside a single entry, set that entry\'s `replaceAll: true`. ' +
      '    Different entries can have different replaceAll values.\n' +
      '  - **STRONGLY RECOMMENDED**: give each edit an `expectedLineRange: [startLine, endLine]` ' +
      '    (1-based, inclusive) using the line numbers from your read_file output. Before ANY edit ' +
      '    applies, each declared range is cross-checked against the ORIGINAL file: if an oldString ' +
      '    uniquely matches OUTSIDE its declared range (the classic "content meant for line 8 landed ' +
      '    at line 10" mistake), the whole batch is rejected before touching disk. Do NOT adjust the ' +
      '    numbers for earlier edits in the same batch — always use the pre-batch line numbers you read.\n' +
      '  - multi_edit_file does NOT support per-edit `hashAnchor` (line hashes shift mid-batch). ' +
      '    For a hash-anchored single edit, use edit_file instead.\n' +
      '  - multi_edit_file does NOT create files. To create, use write_file or single edit_file with ' +
      '    an empty oldString.\n' +
      '  - `.ipynb` notebooks must go through the dedicated NotebookEdit tool.\n' +
      '  - Max editable file size: 1 GiB.',
    inputSchema: [
      {
        name: 'filePath',
        type: 'string',
        description:
          'Path to the file. Absolute OR relative-to-workspace. A directory path is rejected.',
        required: true,
      },
      {
        name: 'edits',
        type: 'array',
        description:
          'Ordered list of edits to apply. Each item is `{oldString, newString, replaceAll?}`. ' +
          'Edits run sequentially: edit #1 runs against disk content, edit #N runs against the result ' +
          'of edits #1..N-1. Order matters when later edits depend on earlier ones.',
        required: true,
        items: {
          type: 'object',
          properties: {
            oldString: {
              type: 'string',
              description:
                'Exact bytes to find. Must be present verbatim in the (post-previous-edits) file content. ' +
                'No fuzzy matching, no regex metacharacters. If the first occurrence is ambiguous, include ' +
                'more surrounding lines until it is unique.',
            },
            newString: {
              type: 'string',
              description:
                'Replacement. Must differ from oldString for this entry. Note: oldString MUST NOT appear ' +
                'as a substring of any EARLIER entry\'s newString — that pattern is a chained-clobber bug ' +
                'and the whole batch is rejected.',
            },
            replaceAll: {
              type: 'boolean',
              description:
                'Replace every occurrence in this entry only (default false: just the first). ' +
                'Different entries in the same batch can have different replaceAll values.',
            },
            expectedLineRange: {
              type: 'array',
              description:
                'STRONGLY RECOMMENDED [startLine, endLine] (1-based, inclusive) declaring where this ' +
                'edit is meant to land, in PRE-BATCH file coordinates (the line numbers your read_file ' +
                'showed — do NOT adjust for earlier edits in this batch). If the oldString matches ' +
                'outside this window in the original file, the whole batch is rejected before any edit ' +
                'applies — catching edits that would land at the wrong location.',
              items: { type: 'integer' },
            },
          },
          required: ['oldString', 'newString'],
        },
      },
      {
        name: 'baseReadId',
        type: 'string',
        description:
          'STRONGLY RECOMMENDED. The readId from the LATEST read_file or edit_file / multi_edit_file ' +
          'response on this same path. readIds are path-bound, never global: do not reuse A\'s id when ' +
          'editing B. When provided, the WHOLE BATCH is validated against the exact byte ' +
          'snapshot recorded at read time (content-hash anchored). ' +
          '**IMPORTANT — readId rotation**: a successful multi_edit_file rotates the readId exactly once. ' +
          'For the next edit on this path, echo the readId from THIS response, not the original read_file ' +
          'response. Reusing the old readId returns "baseReadId is unknown or expired". If you do not have ' +
          'a fresh readId, re-call read_file and use its readId — never invent one, and do not just omit ' +
          'this field (omission drops to the weaker mtime/window gate). Sole exception: a `[Post-compact …]` ' +
          'reminder listing this file as `unchanged` supplies a readId you may pass directly.',
      },
      {
        name: 'base_read_id',
        type: 'string',
        description: 'Alias for baseReadId (snake_case).',
      },
    ],
    isReadOnly: false,
    isConcurrencySafe: false,
    runIn: 'worker',
    maxResultChars: 100_000,
    zInputSchema: multiEditFileInputZod,
    validateInput: async (input) => {
      const v = validateMultiEditToolPayload(input)
      return v.ok ? { valid: true } : { valid: false, message: v.message }
    },
    async call({ filePath, edits, baseReadId }, ctx) {
      if (ctx?.abortSignal.aborted) {
        return {
          success: false,
          error: 'multi_edit_file aborted before execution (signal already fired).',
          toolErrorClass: 'aborted',
        }
      }
      // baseReadId alias normalisation + trim is done by multiEditFileInputZod.
      return toolMultiEditFile(filePath, edits, { baseReadId })
    },
  }),

  buildTool({
    name: 'list_files',
    searchHint: 'directory listing folder contents ls dir tree',
    description:
      'List the direct children (files and sub-directories) of a directory. ' +
      'Filters hidden entries and skip-dirs (`node_modules`, `.git`, `dist`, …). ' +
      'For NAME-pattern matches across the tree use `glob` (e.g. `**/*.ts`). ' +
      'For CONTENT search use `grep`. For reading a single file use `read_file`. ' +
      'Relative paths resolve against the workspace root.',
    inputSchema: [
      {
        name: 'dirPath',
        type: 'string',
        description:
          'Directory to list. A FILE path will be rejected with a pointer to `read_file`. ' +
          'Use `"."` (or omit in future if made optional) to list the workspace root.',
        required: true,
      },
    ],
    isReadOnly: true,
    isConcurrencySafe: true,
    zInputSchema: listFilesInputZod,
    async call({ dirPath }, _ctx) {
      return toolListFiles(dirPath)
    },
  }),

  buildTool({
    name: 'glob',
    searchHint: 'find files name pattern wildcard globbing recursive',
    description:
      'Find files by NAME pattern (glob syntax, NOT regex). Supports `*` (anything except /), ' +
      '`**` (recursive), `?` (single char), `[abc]` (char class), `{a,b}` (alternation). ' +
      'Examples:\n' +
      '  - `**/*.ts` — all .ts files recursively\n' +
      '  - `src/**/*.{ts,tsx}` — TS + TSX under src\n' +
      '  - `tests/*/fixtures/*.json` — exactly two path segments under tests\n' +
      'For CONTENT matching use `grep`. For regex on file names convert to glob first ' +
      '(e.g. `.*\\.ts$` → `**/*.ts`). Relative `cwd` resolves against the workspace root.',
    inputSchema: [
      {
        name: 'pattern',
        type: 'string',
        description:
          'Glob pattern (NOT regex). `*` does not cross `/`; use `**` for recursive.',
        required: true,
      },
      {
        name: 'cwd',
        type: 'string',
        description:
          'Base directory. Relative → resolves against workspace root. ' +
          'A FILE path degenerates to "does this file match the pattern?" (returns 0 or 1 result).',
      },
      { name: 'maxResults', type: 'number', description: 'Cap on results (default 200).' },
      {
        name: 'includeDirs',
        type: 'boolean',
        description: 'Include directories in output (default false — files only).',
      },
    ],
    isReadOnly: true,
    isConcurrencySafe: true,
    runIn: 'worker',
    maxResultChars: 100_000,
    zInputSchema: globInputZod,
    async call({ pattern, cwd, maxResults, includeDirs }, _ctx) {
      return toolGlob(pattern, cwd, { maxResults, includeDirs })
    },
  }),

  buildTool({
    name: 'grep',
    searchHint: 'search content text regex inside files ripgrep',
    description:
      'Search file contents using ripgrep (Rust regex), not POSIX `grep`. ' +
      'Brace escaping: match Go `interface{}` with pattern `interface\\{\\}` (backslash-escape `{` and `}` for ripgrep). ' +
      'Some patterns differ from JavaScript `RegExp` (fallback only if ripgrep fails). ' +
      'Supports file filtering (include/exclude), context lines, case-insensitive matching, multiline mode, and pagination. ' +
      '`path` / `cwd` accepts EITHER a directory (recursive search) OR a single file ' +
      '(searches just that file — no include/exclude walk). Relative paths resolve ' +
      'against the current workspace root, then process cwd.',
    inputSchema: [
      { name: 'pattern', type: 'string', description: 'Regex pattern to search for', required: true },
      { name: 'query', type: 'string', description: 'Alias for pattern (search query string)' },
      { name: 'cwd', type: 'string', description: 'Working directory OR single file to search (relative paths resolve against workspace root)' },
      { name: 'path', type: 'string', description: 'Alias for cwd. Directory for recursive search, or a file path to search just that one file.' },
      { name: 'include', type: 'string', description: 'Glob pattern to filter files to search (e.g. "*.ts")' },
      { name: 'exclude', type: 'string', description: 'Glob pattern to exclude files (e.g. "*.test.ts")' },
      { name: 'maxResults', type: 'number', description: 'Maximum matches to return (default 100)' },
      { name: 'context', type: 'number', description: 'Number of context lines around each match' },
      { name: 'caseInsensitive', type: 'boolean', description: 'Case-insensitive search' },
      {
        name: 'outputMode',
        type: 'string',
        description: 'content | files_with_matches | count',
        enum: ['content', 'files_with_matches', 'count'],
      },
      {
        name: 'headLimit',
        type: 'number',
        description: 'Max matches (content) or max files/lines (other modes); 0 = internal safety cap only',
      },
      { name: 'offset', type: 'number', description: 'Skip first N results before applying headLimit (pagination)' },
      { name: 'multiline', type: 'boolean', description: 'Enable multiline mode where . matches newlines' },
      { name: 'type', type: 'string', description: 'File type to search (rg --type). e.g. js, py, rust, go, java' },
      { name: 'lineNumbers', type: 'boolean', description: 'Show line numbers in content mode (default true)' },
    ],
    isReadOnly: true,
    isConcurrencySafe: true,
    runIn: 'worker',
    maxResultChars: 20_000,
    zInputSchema: grepInputZod,
    async call(input, _ctx) {
      const {
        pattern,
        cwd,
        include,
        exclude,
        maxResults,
        context,
        beforeLines,
        afterLines,
        caseInsensitive,
        outputMode,
        headLimit,
        offset,
        multiline,
        type: typeFilter,
        lineNumbers,
      } = input
      return toolGrep(pattern, cwd, {
        include,
        exclude,
        maxResults,
        context,
        beforeLines,
        afterLines,
        caseInsensitive,
        outputMode,
        headLimit,
        offset,
        multiline,
        type: typeFilter,
        lineNumbers,
      })
    },
  }),

  buildTool({
    name: 'web_fetch',
    searchHint: 'download fetch HTTP URL webpage markdown article',
    description:
      'Fetch an http:// or https:// URL and return the body as text. ' +
      'HTML is stripped to plain text (scripts/styles removed). JSON is returned raw. ' +
      '15 s request timeout. Rejects non-http(s) schemes (`file://`, `ftp://`, …). ' +
      'For search engines use `WebSearch`; for workspace files use `read_file`.',
    inputSchema: [
      {
        name: 'url',
        type: 'string',
        description:
          'Full http/https URL. Also accepts OpenClaude-style `domain:hostname` shorthand ' +
          '(e.g. `domain:example.com`), which is normalised to https. ' +
          'No support for relative URLs or `file://`.',
        required: true,
      },
      {
        name: 'maxLength',
        type: 'number',
        description:
          'Hard character cap on the returned body (default 50 000). Larger pages are truncated.',
      },
    ],
    isReadOnly: true,
    isConcurrencySafe: true,
    networkBound: true,
    runIn: 'worker',
    maxResultChars: 50_000,
    zInputSchema: webFetchInputZod,
    async call({ url, maxLength }, ctx) {
      // upstream alignment stage 2: stream short status chunks while the
      // fetch is in-flight so the UI shows a live progress feed instead
      // of a frozen "running" pip. Each note becomes a `text`-typed
      // ToolProgressEvent that mainStreamRouter appends to `streamingProgress.text`.
      const onProgress = ctx?.emitToolProgress
        ? (note: string) =>
            ctx.emitToolProgress!({
              type: 'text',
              data: { text: note + '\n' },
            })
        : undefined
      return toolWebFetch(url, { maxLength, onProgress })
    },
  }),

  buildTool({
    name: 'WebSearch',
    aliases: ['web_search'],
    searchHint: 'search engine web internet google bing query',
    description:
      'Search the public web. Engines (picked automatically by default, keys configured at Settings → Tools):\n' +
      '  - Brave Search — English-biased queries when `webSearchBraveApiKey` is set.\n' +
      '  - Baidu AI Search — CJK (中文 / 日本語 / 한국어) queries when `webSearchBaiduApiKey` is set.\n' +
      '  - DuckDuckGo — no-key fallback when neither above is configured.\n' +
      'The router auto-detects CJK-biased queries (≥30% CJK chars) and prefers Baidu when available. ' +
      'Override with `engine: "brave" | "baidu" | "ddg" | "auto"`. ' +
      'Baidu supports `freshness` (`pd` / `pw` / `pm` / `py` or `YYYY-MM-DDtoYYYY-MM-DD`) for time-bounded results.',
    inputSchema: [
      { name: 'query', type: 'string', description: 'Search query', required: true },
      { name: 'maxResults', type: 'number', description: 'Max results to return (1–20, default 8)' },
      {
        name: 'engine',
        type: 'string',
        description:
          'Optional engine override. `auto` (default) routes by query language and key availability; ' +
          '`brave` / `baidu` forces a specific provider (falls back to `ddg` if the key is missing); ' +
          '`ddg` forces the DuckDuckGo fallback.',
        enum: ['auto', 'brave', 'baidu', 'ddg'],
      },
      {
        name: 'freshness',
        type: 'string',
        description:
          'Baidu-only time filter. Use `pd` / `pw` / `pm` / `py` for past day/week/month/year, ' +
          'or `YYYY-MM-DDtoYYYY-MM-DD` for an explicit range. Ignored on Brave / DuckDuckGo.',
      },
    ],
    isReadOnly: true,
    isConcurrencySafe: true,
    networkBound: true,
    runIn: 'worker',
    maxResultChars: WEB_SEARCH_MAX_RESULT_CHARS,
    zInputSchema: webSearchInputZod,
    async call({ query, maxResults, engine, freshness }, _ctx) {
      return toolWebSearch(query, {
        maxResults,
        ...(engine ? { engine } : {}),
        ...(freshness ? { freshness } : {}),
      })
    },
  }),

  buildTool({
    name: 'bash',
    searchHint: 'shell command execute terminal POSIX sh bash run',
    description:
      'Execute a shell command. Cross-platform: on macOS/Linux runs via bash; on Windows ' +
      'runs via the configured default shell (usually PowerShell), with automatic routing ' +
      'to Git Bash when the command uses POSIX idioms (`grep`, `awk`, `sed`, `&&`, `$()`, ' +
      '`[[ ]]`, `|head`, `|tail`, `/dev/null`, …). ' +
      'Prefer this over the `PowerShell` tool unless you need PS-specific cmdlets. ' +
      'Use `cwd` to change working directory — do NOT prefix with `cd foo && …` for simple ' +
      'directory changes (that syntax breaks on bundled PowerShell 5.1). ' +
      'For long-running jobs (dev server, build watch, test watcher) set `runInBackground: true` ' +
      'and poll via TaskOutput. `timeoutMs` is MILLISECONDS (default 120 000 = 2 min). ' +
      '**If your command modifies a file (scripts, sed, formatters, generators), you MUST ' +
      're-run read_file on that file before the next edit_file / write_file** — shell commands ' +
      'do not refresh the read receipt, so editing from your pre-script snapshot is rejected ' +
      'as "modified on disk".',
    inputSchema: [
      {
        name: 'command',
        type: 'string',
        description:
          'The shell command. Write it in POSIX/bash style — automatic routing will send it ' +
          'to Git Bash on Windows when POSIX idioms are detected. Example: ' +
          '`grep -n "TODO" src/**/*.ts | head -20`',
        required: true,
      },
      {
        name: 'cwd',
        type: 'string',
        description:
          'Working directory. Relative paths resolve against the current workspace root. ' +
          'Prefer this over `cd foo && …`.',
      },
      {
        name: 'runInBackground',
        type: 'boolean',
        description:
          'Run asynchronously and return a task ID immediately, without waiting for exit. ' +
          'Use for dev servers, watchers, or anything expected to run > ~30s. When true, ' +
          'read incremental output via the TaskOutput tool. (alias: run_in_background)',
      },
      {
        name: 'run_in_background',
        type: 'boolean',
        description: 'Alias for `runInBackground` (snake_case). Either form is accepted.',
      },
      {
        name: 'timeoutMs',
        type: 'number',
        description:
          'Hard timeout in MILLISECONDS (not seconds). Default 120 000 (2 min), max 600 000. ' +
          'If you need longer, prefer `runInBackground: true` instead of bumping the timeout. ' +
          '(aliases: timeout, timeout_ms — both are also milliseconds)',
      },
      {
        name: 'timeout',
        type: 'number',
        description:
          'Alias for `timeoutMs` (Claude Code BashTool convention). Value is MILLISECONDS, not seconds.',
      },
      {
        name: 'timeout_ms',
        type: 'number',
        description: 'Alias for `timeoutMs` (snake_case). Value is MILLISECONDS.',
      },
      {
        name: 'description',
        type: 'string',
        description:
          'Optional short label for this command (5-10 words, active voice). Used for UI / ' +
          'telemetry only — has NO effect on execution. Example: "Install npm dependencies". ' +
          'Provided for parity with Claude Code BashTool conventions; safe to omit.',
      },
    ],
    isReadOnly: false,
    isConcurrencySafe: (input) => {
      const cmd = typeof input.command === 'string' ? input.command : ''
      if (!cmd.trim()) return false
      return isCommandReadOnly(cmd)
    },
    // P0-2 — long-running bash commands (explicit `timeoutMs >= 60_000`, or
    // `runInBackground` which spawns a detached LocalShellTask) keep running
    // through a soft user interrupt. Mid-turn user intent (e.g. they typed a
    // new message while a 5-minute rsync is at 80%) should NOT waste in-flight
    // work. Hard abort (second Stop / process exit) still applies via the
    // kernel's hardAbortController.
    //
    // Short bash commands stay 'cancel' so quick lint/grep/echo iterations
    // remain instantly cancellable.
    interruptBehavior: (input: Record<string, unknown>) => {
      const runInBackground = input.runInBackground === true
      const t = typeof input.timeoutMs === 'number' ? input.timeoutMs : 0
      if (runInBackground || t >= 60_000) return 'block'
      return 'cancel'
    },
    zInputSchema: bashInputZod,
    async call({ command, cwd, runInBackground, timeoutMs }, _ctx) {
      // Inject workspace as default cwd so shell tools never use process.cwd()
      // (which is the Electron install dir in packaged builds).
      const effectiveCwd = cwd?.trim() || getWorkspacePath()?.trim() || undefined
      // Bash 工具按 POSIX/bash 语义执行（见 shellRunner + getToolShellSpawnSpec）；校验必须与执行一致。
      // 勿用 readDefaultShellId()：Windows 默认 PowerShell 会放宽反引号等规则，但命令仍可能经 Git Bash 运行。
      const analysis = validateBashCommand(command, { defaultShell: 'bash', cwd: effectiveCwd })
      if (analysis.verdict === 'deny') {
        return {
          success: false,
          error:
            analysis.reasons.join('; ') ||
            `Command denied (${analysis.codes.join(', ') || 'policy'})`,
        }
      }
      const sand = await runSandboxedCommand(command, {
        cwd: effectiveCwd,
        timeoutMs,
        label: 'bash',
        runInBackground,
      })
      const { sandboxed: _s, violations: _v, ...rest } = sand
      // When the validator emitted warn-level hints (e.g. `python3` on win32
      // is likely missing → exit 9009/49 + empty stderr), surface them
      // alongside the runtime error so the agent can adjust on retry. We
      // only do this on failure: a successful command must not spam the
      // model with hints it didn't need.
      if (
        rest.success === false &&
        typeof rest.error === 'string' &&
        analysis.verdict === 'warn' &&
        analysis.reasons.length > 0
      ) {
        // Audit D4: rest already carries structured `error*` from
        // formatShellFailure. Re-package into ToolFailureFields, append
        // the warnings (which lands them both in the `error` text AND
        // the `errorNext` bullet list), then spread back.
        const withWarnings = appendPreExecutionWarnings(
          {
            error: rest.error,
            errorWhat: rest.errorWhat ?? rest.error,
            errorTried: rest.errorTried,
            errorContext: rest.errorContext,
            errorNext: rest.errorNext,
            toolErrorClass: rest.toolErrorClass as ToolErrorClass | undefined,
          },
          analysis.reasons,
        )
        return { ...rest, ...withWarnings }
      }
      return rest
    },
  }),

  buildTool({
    name: 'PowerShell',
    searchHint: 'PowerShell command Windows pwsh execute terminal run',
    description:
      'Execute a PowerShell command (Windows only — hidden on macOS/Linux). ' +
      'Use this ONLY when you genuinely need PS-specific cmdlets (`Get-ChildItem`, ' +
      '`Select-String`, `ConvertTo-Json`, `Get-Process`, …). For POSIX tooling ' +
      '(`grep`, `awk`, `sed`, pipes, `&&`) prefer the `bash` tool — it auto-routes to ' +
      'Git Bash. ' +
      'NOTE: the bundled `powershell.exe` is PowerShell 5.1 which does NOT support `&&` / `||` ' +
      'chain operators (use `; ` or separate calls instead). ' +
      '`$_` / `$PSItem` inside `ForEach-Object { }` / `Where-Object { }` pipelines is ' +
      'preserved (via `-EncodedCommand`). `timeoutMs` is milliseconds (default 120 000). ' +
      '**If your command modifies a file, you MUST re-run read_file on it before the next ' +
      'edit_file / write_file** — shell commands do not refresh the read receipt.',
    inputSchema: [
      {
        name: 'command',
        type: 'string',
        description:
          'PowerShell script. Example: ' +
          '`Get-ChildItem -Recurse -Filter "*.ts" | Select-Object -First 10 | ForEach-Object { $_.FullName }`. ' +
          'Use `; ` to chain — NOT `&&` (unsupported in PS 5.1).',
        required: true,
      },
      {
        name: 'cwd',
        type: 'string',
        description:
          'Working directory. Relative paths resolve against the workspace root.',
      },
      {
        name: 'runInBackground',
        type: 'boolean',
        description:
          'Run asynchronously and return a task ID. Use for long-running jobs; ' +
          'poll via TaskOutput. (alias: run_in_background)',
      },
      {
        name: 'run_in_background',
        type: 'boolean',
        description: 'Alias for `runInBackground` (snake_case). Either form is accepted.',
      },
      {
        name: 'timeoutMs',
        type: 'number',
        description:
          'Hard timeout in MILLISECONDS (default 120 000 = 2 min). For longer jobs, ' +
          'prefer `runInBackground: true`. (aliases: timeout, timeout_ms — both are also milliseconds)',
      },
      {
        name: 'timeout',
        type: 'number',
        description:
          'Alias for `timeoutMs` (Claude Code convention). Value is MILLISECONDS, not seconds.',
      },
      {
        name: 'timeout_ms',
        type: 'number',
        description: 'Alias for `timeoutMs` (snake_case). Value is MILLISECONDS.',
      },
      {
        name: 'description',
        type: 'string',
        description:
          'Optional short label for this command (UI / telemetry only — has NO effect on execution). ' +
          'Provided for parity with Claude Code conventions; safe to omit.',
      },
    ],
    isReadOnly: false,
    isEnabled: () => process.platform === 'win32',
    isConcurrencySafe: (input) => {
      const cmd = typeof input.command === 'string' ? input.command : ''
      if (!cmd.trim()) return false
      return isPowerShellCommandReadOnly(cmd, {})
    },
    // P0-2 — same heuristic as bash: long-timeout / background PowerShell
    // commands keep running through a soft user interrupt.
    interruptBehavior: (input: Record<string, unknown>) => {
      const runInBackground = input.runInBackground === true
      const t = typeof input.timeoutMs === 'number' ? input.timeoutMs : 0
      if (runInBackground || t >= 60_000) return 'block'
      return 'cancel'
    },
    zInputSchema: powerShellInputZod,
    async call({ command, cwd, runInBackground, timeoutMs }, _ctx) {
      // Inject workspace as default cwd so shell tools never use process.cwd()
      // (which is the Electron install dir in packaged builds).
      const effectiveCwd = cwd?.trim() || getWorkspacePath()?.trim() || undefined
      const analysis = validatePowerShellCommand(command, { cwd: effectiveCwd })
      if (analysis.verdict === 'deny') {
        return {
          success: false,
          error:
            analysis.reasons.join('; ') ||
            `Command denied (${analysis.codes.join(', ') || 'policy'})`,
        }
      }
      const psResult = await runPowerShellCommand(command, effectiveCwd, {
        runInBackground,
        timeoutMs,
      })
      if (
        psResult.success === false &&
        typeof psResult.error === 'string' &&
        analysis.verdict === 'warn' &&
        analysis.reasons.length > 0
      ) {
        const withWarnings = appendPreExecutionWarnings(
          {
            error: psResult.error,
            errorWhat: psResult.errorWhat ?? psResult.error,
            errorTried: psResult.errorTried,
            errorContext: psResult.errorContext,
            errorNext: psResult.errorNext,
            toolErrorClass: psResult.toolErrorClass as ToolErrorClass | undefined,
          },
          analysis.reasons,
        )
        return { ...psResult, ...withWarnings }
      }
      return psResult
    },
  }),

  // Recall stripped attachment bytes (image / PDF / Office) from the on-disk
  // attachment cache. Companion to the P2 `<recall-pointer>` markers emitted
  // by `src/services/contextBuilder.ts` once historical attachments cross
  // POLE_STRIP_BINARIES_AFTER_TURNS user turns. See electron/ai/toolRecallAttachment.ts.
  toolRecallAttachment,

  // Excel tool suite — 26 atomic .xlsx tools (electron/tools/office/excelTool.ts).
  // Each tool is a self-contained "load → mutate → save" cycle backed by exceljs.
  // See excelHelpers.ts header for the design rationale.
  ...excelTools,

  // Word read-only tool suite — 5 .docx ingestion tools (electron/tools/office/wordTool.ts).
  // Backed by `mammoth`. Read-only by design (see scope decision in conv log).
  ...wordTools,

  // Await — block on background shell/sub-agent tasks until they finish or their
  // output matches a pattern (e.g. "Ready"/"Error"). Event-driven via
  // taskRuntimeStore.waitForChange. Also the fan-in primitive for best-of-N.
  awaitTool,

  // BestOfN — run one task N ways in parallel (isolated worktrees), score the
  // results, and cherry-pick the winner. Cursor 3 `/best-of-n` parity.
  bestOfNTool,
]
