/**
 * Tolerant best-effort extraction of in-progress string values from a
 * `tool_use` arguments JSON buffer that is still streaming. Used by the
 * Write/Edit progress card to render the model's running `content` /
 * `newString` / `oldString` *while the closing quote has not yet arrived*
 * — that's the key behavioural difference from the main-process
 * `electron/ai/partialJsonExtract.ts`, which only returns fully-closed
 * strings (it's used to decide stream-time preflight reject and so must
 * not false-positive on a half-streamed value).
 *
 * For the UI side we **want** half-streamed values — that's the point of
 * the "the IDE typewriter" feel. We accept that the last few chars may
 * be invalid escape sequences mid-stream; we render them as best-effort
 * and they'll be replaced by the canonical full value once `tool_start`
 * lands and the card switches over to `toolUse.input`.
 *
 * Why we hand-roll instead of `JSON.parse(buf + '"}')`-style closer
 * tricks: those produce false matches when the buffer ends inside another
 * key's value (key-ordering varies across models / gateways). A tiny
 * JSON-aware scanner that walks depth correctly is ~50 lines and handles
 * every observed real case.
 *
 * Scope: top-level string fields plus the flat string pairs inside
 * `multi_edit_file.edits[]`. Nested values remain opaque to the scanner.
 */

/**
 * Find the index of the un-escaped closing `"` for a JSON string body
 * starting at `start`, or `-1` if the string is still open.
 */
function findStringClose(buf: string, start: number): number {
  let i = start
  const n = buf.length
  while (i < n) {
    const ch = buf.charCodeAt(i)
    if (ch === 0x5c /* \ */) {
      i += 2
      continue
    }
    if (ch === 0x22 /* " */) return i
    i += 1
  }
  return -1
}

/**
 * Decode a JSON string body in-place. Falls back to the raw slice for
 * malformed input — happens legitimately when the buffer ends mid-escape
 * (`\u00…`). The caller already accepts approximate values during the
 * streaming window.
 */
function decodeBody(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    // Mid-stream we can land on `…\` (lone trailing backslash) which is
    // invalid JSON. Strip the dangling backslash and try again before
    // dropping to raw — preserves rendering quality on the common case.
    if (raw.endsWith('\\')) {
      try {
        return JSON.parse(`"${raw.slice(0, -1)}"`) as string
      } catch {
        return raw.slice(0, -1)
      }
    }
    return raw
  }
}

function skipWhitespace(buf: string, i: number): number {
  const n = buf.length
  while (i < n) {
    const ch = buf.charCodeAt(i)
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
      i += 1
      continue
    }
    return i
  }
  return i
}

/**
 * Extract a single top-level string value from `buf`. Returns:
 *   - `null` when the key is absent / not yet streamed
 *   - `{ value, complete }` once the value's opening `"` is found —
 *     `complete: true` means the closing `"` has been seen (the value is
 *     final); `complete: false` means the value is still in-flight and
 *     the returned `value` is whatever's been streamed so far.
 *
 * Linear scan, no regex, no allocations besides the eventual decoded
 * result.
 */
export function extractStreamingString(
  buf: string,
  keys: ReadonlyArray<string>,
): { value: string; complete: boolean } | null {
  if (typeof buf !== 'string' || buf.length === 0) return null
  const n = buf.length
  let i = 0
  let depth = 0
  let sawOpenBrace = false

  while (i < n) {
    const ch = buf.charCodeAt(i)
    if (ch === 0x7b) {
      depth += 1
      sawOpenBrace = true
      i += 1
      continue
    }
    if (ch === 0x7d || ch === 0x5d) {
      depth -= 1
      i += 1
      continue
    }
    if (ch === 0x5b) {
      depth += 1
      i += 1
      continue
    }
    if (ch === 0x22) {
      const stringStart = i + 1
      const stringEnd = findStringClose(buf, stringStart)
      if (stringEnd < 0) return null
      if (depth === 1 && sawOpenBrace) {
        const decodedKey = decodeBody(buf.slice(stringStart, stringEnd))
        let j = skipWhitespace(buf, stringEnd + 1)
        if (j < n && buf.charCodeAt(j) === 0x3a /* : */) {
          j = skipWhitespace(buf, j + 1)
          if (keys.includes(decodedKey)) {
            if (j >= n) return null
            if (buf.charCodeAt(j) !== 0x22) return null
            const valStart = j + 1
            const valEnd = findStringClose(buf, valStart)
            if (valEnd < 0) {
              return { value: decodeBody(buf.slice(valStart)), complete: false }
            }
            return { value: decodeBody(buf.slice(valStart, valEnd)), complete: true }
          }
        }
      }
      i = stringEnd + 1
      continue
    }
    i += 1
  }
  return null
}

/**
 * Convenience: returns only the value (or null) — drops the `complete`
 * flag for callers that don't care.
 */
export function getStreamingString(
  buf: string,
  keys: ReadonlyArray<string>,
): string | null {
  const r = extractStreamingString(buf, keys)
  return r ? r.value : null
}

const FILE_PATH_KEYS = ['filePath', 'file_path', 'path'] as const
const CONTENT_KEYS = ['content', 'fileContents', 'file_contents', 'text'] as const
const OLD_STRING_KEYS = ['oldString', 'old_string'] as const
const NEW_STRING_KEYS = ['newString', 'new_string'] as const
const EDITS_ARRAY_KEY = 'edits'

export interface PartialWriteInput {
  filePath: string | null
  content: string | null
  contentComplete: boolean
}

export interface PartialEditInput {
  filePath: string | null
  oldString: string | null
  newString: string | null
  oldComplete: boolean
  newComplete: boolean
}

export interface PartialMultiEditInput {
  filePath: string | null
  /** Every edit object that has started streaming, in source order. */
  edits: PartialMultiEditEntry[]
  /** Index of the edit whose value is still streaming, or -1. */
  streamingEditIndex: number
}

export interface PartialMultiEditEntry {
  oldString: string | null
  newString: string | null
  oldComplete: boolean
  newComplete: boolean
}

export function parsePartialWriteInput(buf: string): PartialWriteInput {
  const filePath = getStreamingString(buf, FILE_PATH_KEYS)
  const c = extractStreamingString(buf, CONTENT_KEYS)
  return {
    filePath,
    content: c?.value ?? null,
    contentComplete: c?.complete ?? false,
  }
}

export function parsePartialEditInput(buf: string): PartialEditInput {
  const filePath = getStreamingString(buf, FILE_PATH_KEYS)
  const oldR = extractStreamingString(buf, OLD_STRING_KEYS)
  const newR = extractStreamingString(buf, NEW_STRING_KEYS)
  return {
    filePath,
    oldString: oldR?.value ?? null,
    newString: newR?.value ?? null,
    oldComplete: oldR?.complete ?? false,
    newComplete: newR?.complete ?? false,
  }
}

/**
 * Locate the top-level `"edits":[` array start in `buf`. Returns the
 * index of the first character INSIDE the `[` (i.e., where edit
 * objects begin), or `-1` when the key has not yet streamed.
 *
 * Depth-aware — only matches `"edits"` at the outermost object's key
 * position. Without this we'd false-match a literal `"edits":[` inside
 * a string value (rare in practice, but easy to defend against).
 */
function findTopLevelArrayStart(buf: string, targetKey: string): number {
  const n = buf.length
  let i = 0
  let depth = 0
  let sawOpenBrace = false

  while (i < n) {
    const ch = buf.charCodeAt(i)
    if (ch === 0x7b) {
      depth += 1
      sawOpenBrace = true
      i += 1
      continue
    }
    if (ch === 0x7d || ch === 0x5d) {
      depth -= 1
      i += 1
      continue
    }
    if (ch === 0x5b) {
      depth += 1
      i += 1
      continue
    }
    if (ch === 0x22) {
      const stringStart = i + 1
      const stringEnd = findStringClose(buf, stringStart)
      if (stringEnd < 0) return -1
      if (depth === 1 && sawOpenBrace) {
        const decodedKey = decodeBody(buf.slice(stringStart, stringEnd))
        let j = skipWhitespace(buf, stringEnd + 1)
        if (j < n && buf.charCodeAt(j) === 0x3a) {
          j = skipWhitespace(buf, j + 1)
          if (decodedKey === targetKey) {
            if (j < n && buf.charCodeAt(j) === 0x5b) {
              return j + 1
            }
            return -1
          }
        }
      }
      i = stringEnd + 1
      continue
    }
    i += 1
  }
  return -1
}

/**
 * Walk the contents of an `edits[]` array starting at `arrayStart`
 * (first char inside `[`). Tracks object boundaries and preserves every
 * edit encountered so the renderer can append cards progressively
 * instead of replacing the current card and mounting the full array at
 * tool completion.
 *
 * Stops at the matching `]`, end-of-buffer, or any truncated string
 * value (which is itself surfaced as a partial result — caret keeps
 * blinking until the closing `"` lands).
 */
function scanEditsArray(buf: string, arrayStart: number): {
  edits: PartialMultiEditEntry[]
  streamingEditIndex: number
} {
  const n = buf.length
  let i = arrayStart
  let depth = 0 // 0 = inside array; >=1 = inside an edit object
  let currentEdit: PartialMultiEditEntry | null = null
  const edits: PartialMultiEditEntry[] = []

  const result = () => ({
    edits,
    streamingEditIndex:
      currentEdit !== null && !currentEdit.newComplete
        ? edits.length - 1
        : -1,
  })

  while (i < n) {
    const ch = buf.charCodeAt(i)
    if (ch === 0x7b) {
      if (depth === 0) {
        currentEdit = {
          oldString: null,
          newString: null,
          oldComplete: false,
          newComplete: false,
        }
        edits.push(currentEdit)
      }
      depth += 1
      i += 1
      continue
    }
    if (ch === 0x7d) {
      depth -= 1
      if (depth === 0) currentEdit = null
      i += 1
      continue
    }
    if (ch === 0x5d && depth === 0) {
      // End of edits[] array.
      return result()
    }
    if (ch === 0x5b) {
      depth += 1
      i += 1
      continue
    }
    if (ch === 0x22) {
      const stringStart = i + 1
      const stringEnd = findStringClose(buf, stringStart)
      if (stringEnd < 0) {
        // Truncated string. Could be either a key (no useful info) or
        // an in-progress value. We can't tell without context, so we
        // bail and the caller renders whatever was captured before.
        return result()
      }
      // Inside an edit object at depth 1, check if this string is a
      // top-level key followed by `:`. Anything deeper (nested objects
      // inside a value) is opaque to us — we skip past.
      if (depth === 1) {
        const decodedKey = decodeBody(buf.slice(stringStart, stringEnd))
        let j = skipWhitespace(buf, stringEnd + 1)
        if (j < n && buf.charCodeAt(j) === 0x3a) {
          j = skipWhitespace(buf, j + 1)
          if (j < n && buf.charCodeAt(j) === 0x22) {
            const valStart = j + 1
            const valEnd = findStringClose(buf, valStart)
            const value =
              valEnd >= 0
                ? decodeBody(buf.slice(valStart, valEnd))
                : decodeBody(buf.slice(valStart))
            const complete = valEnd >= 0
            if (currentEdit !== null) {
              if (
                decodedKey === 'oldString' ||
                decodedKey === 'old_string'
              ) {
                currentEdit.oldString = value
                currentEdit.oldComplete = complete
              } else if (
                decodedKey === 'newString' ||
                decodedKey === 'new_string'
              ) {
                currentEdit.newString = value
                currentEdit.newComplete = complete
              }
            }
            if (!complete) {
              // Value still streaming — caller wants the partial.
              return result()
            }
            i = valEnd + 1
            continue
          }
        }
      }
      i = stringEnd + 1
      continue
    }
    i += 1
  }
  return result()
}

export function parsePartialMultiEditInput(buf: string): PartialMultiEditInput {
  const filePath = getStreamingString(buf, FILE_PATH_KEYS)
  const arrayStart = findTopLevelArrayStart(buf, EDITS_ARRAY_KEY)
  if (arrayStart < 0) {
    return {
      filePath,
      edits: [],
      streamingEditIndex: -1,
    }
  }
  const r = scanEditsArray(buf, arrayStart)
  return { filePath, ...r }
}
