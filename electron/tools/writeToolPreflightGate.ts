/**
 * Single source of truth for the "should this Write call be rejected up-front?"
 * decision.
 *
 * The Write tool is reserved for **creating NEW files**. Any attempt to use
 * Write on a path that already exists on disk — whether the file has 0 bytes,
 * 1 byte, or many MB — must route through Edit instead, so the change is
 * expressed as a precise `old_string` / `new_string` and the full-file diff
 * is reviewable. A model authoring a full-file replacement is one
 * truncated-stream or hallucinated-line away from silently dropping content
 * the user never saw.
 *
 * Historically this rule lived inline in {@link toolWriteFile} only — meaning
 * the rejection only fired AFTER:
 *   1. The model had finished streaming the (often very large) `content`
 *      parameter,
 *   2. The streaming tool executor registered the tool and ran the full
 *      orchestration / permissions / hooks pipeline,
 *   3. A file lock had been acquired and the file re-read inside the lock.
 *
 * Centralising the decision here lets the **streaming tool executor** invoke
 * the same gate the instant a `Write` tool_use block completes (before any
 * UI permission flow, before {@link runAgenticToolUse}). The model sees the
 * "use Edit instead" instruction almost immediately, instead of waiting for
 * the entire pipeline to run only to be rejected at disk-write time.
 *
 * The in-tool defensive check in {@link toolWriteFile} stays in place and
 * delegates to {@link preflightWriteToolWithDisk}, so any non-streaming path
 * (sub-agent direct calls, batch executor, tests) still gets the same
 * verdict with the same wording.
 */

import fs from 'node:fs'
import { resolvePathForTool } from './workspaceState'
import { buildToolFailure, type ToolFailureFields } from './toolErrorFormat'

export interface WritePreflightInput {
  /** Raw `filePath` from the model's tool input — may be relative, absolute, with leading `/` typos, etc. */
  filePath: unknown
}

export interface WritePreflightAllow {
  ok: true
  /** Resolved absolute path, when the gate could resolve it. May be `null` for unresolvable / non-string inputs. */
  resolvedPath: string | null
  /** Size on disk in bytes if a file was found at the resolved path, else `null`. */
  existingFileSize: number | null
}

export interface WritePreflightReject extends ToolFailureFields {
  ok: false
  /** Resolved absolute path (always defined when we reject — the gate had to read disk to decide). */
  resolvedPath: string
  /** Size on disk that triggered the rejection. */
  existingFileSize: number
}

export type WritePreflightResult = WritePreflightAllow | WritePreflightReject

function buildUseEditError(displayPath: string, sizeBytes: number): ToolFailureFields {
  return buildToolFailure(
    {
      what: `write_file refused: "${displayPath}" already exists on disk (${sizeBytes} bytes).`,
      tried: ['write_file on an existing file'],
      next:
        `write_file is ONLY for creating NEW files. To modify ANY file that already ` +
        `exists on disk — including a zero-byte empty file — use edit_file with ` +
        `oldString / newString. For an empty existing file, call edit_file with an ` +
        `empty oldString and your content as newString to insert content.`,
    },
    'validation',
  )
}

/**
 * Pre-baked error message for the "content streamed before filePath" early
 * abort. Fires from the C-grade stream watcher when the model has emitted
 * the bulky `content` key but no `filePath` key — typical of providers
 * (notably DeepSeek V4 Pro via Anthropic-compat) whose tool-call JSON
 * key order does not honour the schema's property order.
 *
 * The message has TWO branches because, at the moment we abort, the host
 * does not yet know whether the target is an existing file (→ should be
 * edit_file) or a brand-new file (→ should retry with filePath first):
 *
 *   - If existing → switch to edit_file (write_file is rejected on any
 *     existing file by design).
 *   - If new     → retry write_file with filePath as the FIRST JSON
 *     property so the host can verify it does not exist before streaming
 *     wastes the entire `content` payload.
 */
export function buildContentBeforeFilePathError(): ToolFailureFields {
  return buildToolFailure(
    {
      what:
        `write_file aborted at stream time: \`content\` was emitted before \`filePath\` in the JSON. ` +
        `The host stopped the stream to save tokens — none of the \`content\` body reached disk.`,
      tried: ['write_file with `content` streaming before `filePath`'],
      next:
        `Two cases, pick the one that matches your intent:\n` +
        `  1. If the target file ALREADY EXISTS — switch to \`edit_file\` ` +
        `(write_file is rejected on any existing file by design; the ` +
        `\`content\`-first ordering would have hit that rejection anyway).\n` +
        `  2. If you really are CREATING A NEW FILE — retry \`write_file\` ` +
        `with \`filePath\` as the FIRST property of the JSON input, e.g. ` +
        `\`{"filePath":"<path>","content":"…"}\`. The host must learn the target ` +
        `path BEFORE the bulky \`content\` blob streams, otherwise it cannot ` +
        `verify the path is new and has to abort.`,
    },
    'validation',
  )
}

/**
 * Cheap up-front check used **before** the model's full tool input has been
 * pipelined. Only does a `statSync` (no full file read), so it is safe to
 * call from hot streaming paths.
 *
 * Returns `{ ok: true, … }` for any of:
 *   - missing / non-string / empty `filePath` (tool itself will surface a
 *     clearer "filePath is missing" error later),
 *   - workspace path resolution failure (same reasoning),
 *   - no file at the resolved path (brand-new file creation — the only
 *     legitimate Write target),
 *   - resolved path is a directory (tool itself rejects with a clearer message).
 *
 * Returns `{ ok: false, … }` when ANY existing regular file is found at the
 * resolved path — even a 0-byte file. Such writes MUST route through Edit.
 */
export function preflightWriteTool(input: WritePreflightInput): WritePreflightResult {
  const raw = input.filePath
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: true, resolvedPath: null, existingFileSize: null }
  }

  const resolveResult = resolvePathForTool(raw)
  if (!resolveResult.ok) {
    return { ok: true, resolvedPath: null, existingFileSize: null }
  }
  const resolvedPath = resolveResult.resolved

  let size: number
  try {
    const st = fs.statSync(resolvedPath)
    if (!st.isFile()) {
      return { ok: true, resolvedPath, existingFileSize: null }
    }
    size = st.size
  } catch {
    return { ok: true, resolvedPath, existingFileSize: null }
  }

  return {
    ok: false,
    resolvedPath,
    existingFileSize: size,
    ...buildUseEditError(raw, size),
  }
}

/**
 * Authoritative variant used **inside** {@link toolWriteFile}, where the disk
 * contents have already been read for line-ending detection. Avoids a second
 * stat / read by accepting the in-hand string. Same verdict + same wording
 * as {@link preflightWriteTool}.
 *
 * Callers MUST only invoke this when they have already confirmed the file
 * exists on disk — the function unconditionally rejects, mirroring the
 * "any existing file → use edit_file" contract of {@link preflightWriteTool}.
 *
 * `displayPath` is the model-supplied path (used in the error message); the
 * caller is expected to have already resolved + read the file.
 */
export function preflightWriteToolWithDisk(input: {
  displayPath: string
  diskContent: string
}): WritePreflightResult {
  const size = Buffer.byteLength(input.diskContent, 'utf8')
  return {
    ok: false,
    ...buildUseEditError(input.displayPath, size),
    // The disk-aware caller doesn't need the resolved path for routing —
    // it already has it. Surface an empty string rather than fabricate one.
    resolvedPath: '',
    existingFileSize: size,
  }
}
