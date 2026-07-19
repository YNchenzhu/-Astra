/**
 * UTF-16 lone-surrogate sanitisation for wire-bound message content.
 *
 * # Why this file exists
 *
 * JavaScript strings are UTF-16. Operations like `String.prototype.slice`,
 * `substring`, `[i]`, and `Array.from(str).slice(...).join('')` (when the
 * size constant is treated as a char count) operate on UTF-16 code units.
 * Characters outside the Basic Multilingual Plane (emoji, CJK Extension B
 * such as 𠮷, etc.) occupy TWO code units — a high surrogate (U+D800–DBFF)
 * followed by a low surrogate (U+DC00–DFFF). Slicing across that boundary
 * leaves a "lone" surrogate in the resulting string.
 *
 * `JSON.stringify` serialises a lone surrogate as a syntactically valid
 * `\uD8XX` escape, but strict downstream JSON parsers (Rust `serde_json`
 * being the canonical case, used by many Anthropic-compatible inference
 * gateways and by axum-based proxies) reject it the moment they read a
 * leading surrogate without a paired `\uDXXX` immediately following — the
 * surfaced error is `unexpected end of hex escape at line 1 column N`.
 *
 * Concretely this has bitten the WebSearch / WebFetch tool result path:
 * descriptions get clipped via `.slice(0, 280)` mid-surrogate, the bad
 * string is stored on the assistant transcript, and the very next request
 * to the gateway fails with HTTP 400 — even though the JSON we sent is
 * itself spec-compliant.
 *
 * # What this module provides
 *
 *   - `replaceUnpairedSurrogates(s)` — replace every lone surrogate with
 *     U+FFFD (REPLACEMENT CHARACTER). Idempotent. Touches only the bad
 *     code units.
 *   - `safeSliceCodeUnits(s, n)` — like `s.slice(0, n)` but never returns
 *     a string that ends inside a surrogate pair. The result is at most
 *     `n` code units long.
 *   - `sanitizeMessagesForWire(messages)` — walk an Anthropic Messages
 *     `messages` array (or any nested message-shaped structure) and apply
 *     `replaceUnpairedSurrogates` to every string field. Used as a
 *     defensive last-mile pass at the wire boundary so a single missed
 *     `.slice` upstream cannot send a 400-inducing request.
 */

/**
 * Replace every UTF-16 code unit that is part of an unpaired surrogate
 * with U+FFFD. Properly paired surrogate pairs (i.e. emoji / non-BMP
 * characters) are preserved verbatim.
 *
 * Cost: O(n) single pass; no allocation when the input is already clean
 * (early-exit on the first offending code unit).
 */
export function replaceUnpairedSurrogates(s: string): string {
  if (typeof s !== 'string' || s.length === 0) return s
  // Fast path: scan once; if nothing is wrong, return the original.
  let firstBad = -1
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++
        continue
      }
      firstBad = i
      break
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      firstBad = i
      break
    }
  }
  if (firstBad < 0) return s

  const out: string[] = [s.slice(0, firstBad)]
  for (let i = firstBad; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        out.push(s[i] + s[i + 1])
        i++
      } else {
        out.push('\uFFFD')
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out.push('\uFFFD')
    } else {
      out.push(s[i])
    }
  }
  return out.join('')
}

/**
 * UTF-16-safe truncation. Returns a prefix of `s` that is at most `n`
 * code units long AND does not end inside a surrogate pair. If `n` would
 * land between a high and a low surrogate, the truncation backs off by
 * one code unit (so the high surrogate is excluded rather than left
 * orphaned).
 *
 * Negative or NaN `n` is treated as 0. Values >= `s.length` return `s`
 * unchanged (no copy).
 */
export function safeSliceCodeUnits(s: string, n: number): string {
  if (typeof s !== 'string') return s
  if (!Number.isFinite(n) || n <= 0) return ''
  const max = Math.floor(n)
  if (max >= s.length) return s
  const lastCode = s.charCodeAt(max - 1)
  // If the kept range would end on a high surrogate, drop it so we don't
  // leave a lone leading surrogate in the prefix.
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    return s.slice(0, max - 1)
  }
  return s.slice(0, max)
}

/**
 * Like `safeSliceCodeUnits` but for the tail of a string. Returns the
 * last up-to-`n` code units of `s`, guaranteed not to start inside a
 * surrogate pair (a leading low surrogate is dropped).
 */
export function safeSliceTailCodeUnits(s: string, n: number): string {
  if (typeof s !== 'string') return s
  if (!Number.isFinite(n) || n <= 0) return ''
  const max = Math.floor(n)
  if (max >= s.length) return s
  const start = s.length - max
  const firstCode = s.charCodeAt(start)
  if (firstCode >= 0xdc00 && firstCode <= 0xdfff) {
    return s.slice(start + 1)
  }
  return s.slice(start)
}

/**
 * Walk a wire-bound message tree (Anthropic Messages format or any plain
 * JSON-shaped value) and replace lone surrogates in every string. Arrays
 * and plain objects are recursed; everything else (numbers, booleans,
 * null, undefined, Buffer / typed-array views) is returned by reference.
 *
 * The function returns a NEW root reference whenever any string was
 * actually modified, and the original reference otherwise (so a clean
 * request body costs only one tree scan with zero allocations).
 *
 * Intended call site: just before `JSON.stringify(body)` in the wire
 * client (see `electron/ai/anthropicCompatHttp.ts`).
 */
export function sanitizeMessagesForWire<T>(value: T): T {
  return sanitiseValue(value) as T
}

function sanitiseValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return replaceUnpairedSurrogates(value)
  }
  if (Array.isArray(value)) {
    let changed = false
    const out = new Array(value.length)
    for (let i = 0; i < value.length; i++) {
      const v = sanitiseValue(value[i])
      if (v !== value[i]) changed = true
      out[i] = v
    }
    return changed ? out : value
  }
  if (value && typeof value === 'object') {
    // Only walk plain objects. Class instances (Date, Map, Buffer, etc.)
    // are returned as-is — the message-tree shapes we care about are
    // always plain JSON-style objects.
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    let changed = false
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      const orig = (value as Record<string, unknown>)[key]
      const next = sanitiseValue(orig)
      if (next !== orig) changed = true
      out[key] = next
    }
    return changed ? out : value
  }
  return value
}
