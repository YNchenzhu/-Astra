/**
 * Tolerant best-effort extraction of a single string field from a JSON
 * document that is still being **streamed** to us delta-by-delta.
 *
 * The Write-tool stream-time preflight (C-grade) reads incomplete JSON like:
 *
 *   {"filePath":"src/foo
 *   {"filePath":"src/foo.ts","content":"
 *   {"filePath":"src/foo.ts","content":"export const x = 1\n
 *
 * …and needs to pull `filePath` out **the moment** its closing `"` arrives,
 * without waiting for `content` to stream in (which can be many KB).
 *
 * ── Why not `JSON.parse(buf + '"}')` or similar closer-pass tricks? ──
 *
 *   They false-positive on a buffer that ends *inside* a still-streaming
 *   string. Example: the buffer `{"filePath":"src` is appended with `"}`
 *   to produce `{"filePath":"src"}`, which is valid JSON and reports
 *   `filePath = "src"` — but the real value is still streaming! We'd
 *   commit to aborting the model based on a guessed substring.
 *
 *   The bug compounds with backslash escapes: `{"filePath":"weird\"`
 *   (model has typed an escaped quote and not yet closed the string) +
 *   `"}` parses to `{"filePath":"weird\""}` which JSON-decodes to
 *   `weird"`, again silently truncating the in-flight value.
 *
 *   So this module deliberately implements a tiny JSON-aware scanner that
 *   only succeeds when the **real** closing un-escaped `"` for the
 *   `filePath` value is already on the wire.
 *
 * Scope: deliberately one field, three aliases (`filePath` / `file_path` /
 * `path`). The alias set MUST stay aligned with the Zod input schema
 * (`toolInputZod.ts#writeFileInputZod`) and
 * `builtinToolAliases.ts#extractWorkspaceFilePathFromToolInput` — a key the
 * validator accepts but this scanner misses makes the C-grade watcher
 * mis-classify a perfectly valid call as "content streamed before filePath"
 * and abort it with an empty synthetic input (the "all providers fail
 * write_file with missing/empty required argument" symptom).
 * Robust general partial-JSON parsing is much harder and unneeded for
 * the Write-preflight hot path.
 */

const FILE_PATH_KEYS = ['filePath', 'file_path', 'path'] as const

/**
 * From `buf[start]` onward, find the position of the un-escaped closing
 * double-quote. Returns the index of the closing `"`, or `-1` if the
 * string is still open (truncated buffer).
 *
 * Handles backslash escapes by skipping the character following any `\`.
 * That's sufficient for JSON's escape grammar (`\\`, `\"`, `\n`, `\u…`):
 * the next char after `\` is always part of the escape and cannot be
 * mistaken for a closing quote.
 */
function findStringClose(buf: string, start: number): number {
  let i = start
  const n = buf.length
  while (i < n) {
    const ch = buf.charCodeAt(i)
    if (ch === 0x5c /* backslash */) {
      i += 2
      continue
    }
    if (ch === 0x22 /* double-quote */) return i
    i += 1
  }
  return -1
}

/**
 * Decode the JSON-escaped string body between the opening and closing
 * quotes. Falls back to the raw slice if the body is malformed (which can
 * legitimately happen if we're staring at a half-streamed escape — but
 * by construction we only call this when `findStringClose` returned a
 * real index, so the body should be well-formed).
 */
function decodeJsonStringBody(buf: string, start: number, end: number): string {
  const raw = buf.slice(start, end)
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return raw
  }
}

function skipJsonWhitespace(buf: string, i: number): number {
  const n = buf.length
  while (i < n) {
    const ch = buf.charCodeAt(i)
    if (ch === 0x20 /* space */ || ch === 0x09 /* tab */ || ch === 0x0a /* LF */ || ch === 0x0d /* CR */) {
      i += 1
      continue
    }
    return i
  }
  return i
}

/**
 * Walk `buf` as JSON, tracking nesting depth so we only consider strings
 * that appear as **top-level keys** of the outermost object. When we find
 * a top-level key whose decoded name matches `targetKey`, parse its value
 * — only succeed when the value is a fully-closed JSON string.
 *
 * Returns the decoded string value, or `null` when the field is absent /
 * still streaming / present but with a non-string value (the gateway
 * sometimes mis-types `filePath` as an object during recovery; treat as
 * "not yet" rather than falsely reject).
 *
 * Linear in `buf.length`; no regex backtracking, no temporary buffer
 * allocations besides the eventual decoded result.
 */
function scanTopLevelStringField(buf: string, targetKey: string): string | null {
  const n = buf.length
  let i = 0
  let depth = 0
  let sawOpenBrace = false

  while (i < n) {
    const ch = buf.charCodeAt(i)

    if (ch === 0x7b /* { */) {
      depth += 1
      sawOpenBrace = true
      i += 1
      continue
    }
    if (ch === 0x7d /* } */ || ch === 0x5d /* ] */) {
      depth -= 1
      i += 1
      continue
    }
    if (ch === 0x5b /* [ */) {
      depth += 1
      i += 1
      continue
    }
    if (ch === 0x22 /* " */) {
      const stringStart = i + 1
      const stringEnd = findStringClose(buf, stringStart)
      if (stringEnd < 0) return null

      // Only depth==1 strings followed by `:` are top-level keys.
      // Strings at other depths (nested objects, array elements, value
      // positions) are not candidates and we just skip past them.
      if (depth === 1 && sawOpenBrace) {
        const decodedKey = decodeJsonStringBody(buf, stringStart, stringEnd)
        let j = skipJsonWhitespace(buf, stringEnd + 1)
        if (j < n && buf.charCodeAt(j) === 0x3a /* : */) {
          j = skipJsonWhitespace(buf, j + 1)
          if (decodedKey === targetKey) {
            if (j >= n) return null
            if (buf.charCodeAt(j) !== 0x22 /* " */) return null
            const valStart = j + 1
            const valEnd = findStringClose(buf, valStart)
            if (valEnd < 0) return null
            return decodeJsonStringBody(buf, valStart, valEnd)
          }
          // Different key — let the natural walk continue past the value.
          // Setting `i` here is unnecessary; the outer loop will hit the
          // value's opening character on the next iteration.
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
 * Extract the `filePath` (or snake-case `file_path`) value from a partial
 * JSON document streamed from a model. Returns the resolved string, or
 * `null` when the value is not yet extractable.
 *
 * Called on every `input_json_delta` event during model streaming, so the
 * implementation avoids any allocation in the common no-match case.
 */
export function extractFilePathFromPartialJson(buf: string): string | null {
  if (typeof buf !== 'string' || buf.length === 0) return null
  for (const k of FILE_PATH_KEYS) {
    const v = scanTopLevelStringField(buf, k)
    if (v && v.length > 0) return v
  }
  return null
}

// Key-shape patterns used by {@link detectContentBeforeFilePath}. A "key"
// here is the JSON key token surrounded by quotes followed by a colon
// (whitespace tolerated). We deliberately do NOT use a regex over the
// entire buffer for `content` — the literal substring `"content":` may
// appear inside an open `content` value if the model is writing JSON-in-
// JSON. That false positive is fine for THIS detector: it can only fire
// to ABORT when filePath is ALSO absent, so the worst case is we miss a
// rejection (false negative), never wrongly abort a legitimate write.
const CONTENT_KEY_REGEX = /"content"\s*:/
const FILE_PATH_KEY_REGEX = /"(?:filePath|file_path|path)"\s*:/

/**
 * Detect the "model emitted `content` before `filePath`" signature in a
 * still-streaming write_file argument buffer.
 *
 * Returns true when BOTH:
 *   1. The buffer contains the literal substring `"content":` (i.e. the
 *      model has started emitting the `content` key — write_file's only
 *      bulky-value field).
 *   2. The buffer does NOT contain `"filePath":` / `"file_path":` /
 *      `"path":` yet (the full alias set the Zod validator accepts).
 *
 * When both hold, the model is already wasting tokens streaming `content`
 * body before the host can know which file is targeted. The watcher uses
 * this signal to fire an early synthetic rejection that educates the
 * model to (a) reorder its JSON keys, or (b) switch to `edit_file` if
 * the target is an existing file.
 *
 * Known false-fire shape (acceptable):
 *   `{"some_other_key":"…","content":"…","filePath":"…"}` — `filePath`
 *   IS in the model's intent, just delayed past `content`. The detector
 *   fires anyway because waiting for `filePath` means letting the
 *   `content` blob waste tokens — exactly what this gate exists to
 *   prevent. The synthetic rejection's error message tells the model to
 *   put `filePath` first; legitimate new-file writes recover on the
 *   retry. Net cost: one extra round-trip in the rare "non-filePath
 *   prefix key" case; net win: zero wasted content tokens in the common
 *   DeepSeek V4 Pro case.
 *
 * False-negative tolerance: if a `content` body contains a literal
 * `"filePath":` substring before the real `filePath` key arrives, this
 * detector returns false. We accept the missed early-abort rather than
 * risk a real false positive that would block legitimate new-file writes
 * whose `content` value happens to contain JSON-shaped text.
 */
export function detectContentBeforeFilePath(buf: string): boolean {
  if (typeof buf !== 'string' || buf.length === 0) return false
  if (!CONTENT_KEY_REGEX.test(buf)) return false
  if (FILE_PATH_KEY_REGEX.test(buf)) return false
  return true
}
