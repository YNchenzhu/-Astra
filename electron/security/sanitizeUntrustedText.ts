/**
 * Strip invisible / control Unicode characters from text that will be fed to
 * the LLM as part of system prompts, skill descriptions, or other
 * import-from-disk artifacts.
 *
 * Threat model
 * ------------
 * A malicious skill bundle, imported agent bundle, or third-party plugin
 * file can hide instructions that the LLM reads but the human reviewer does
 * not see. Two main attack surfaces:
 *
 *   1. **Tag Characters** (U+E0000..U+E007F) — visually invisible Latin-1
 *      mirror; researchers have demonstrated that GPT-4 / Claude readily
 *      follow instructions encoded in this range. Has zero legitimate use
 *      in skill descriptions or agent prompts.
 *
 *   2. **Bidi controls** (U+202A..U+202E, U+2066..U+2069, U+061C) — the
 *      Trojan-Source family. A skill description rendered "Delete all
 *      files" can be reordered in the editor to look like "Read all files".
 *      The model sees one stream; the reviewer sees another.
 *
 * Less critical but typically still bogus in skill content:
 *
 *   3. **Zero-width joiners / non-joiners / space** (U+200B..U+200D) —
 *      legitimate in Arabic / Indic scripts, but a SKILL.md description in
 *      English / Chinese has no reason to contain them. Often used to
 *      either hide markers or break literal-string detection in safety
 *      filters.
 *
 *   4. **Byte-order marks / specials** (U+FEFF, U+FFF0..U+FFFF) — same.
 *
 *   5. **Mongolian Vowel Separator** (U+180E) — zero-width per
 *      Unicode 6.3+, used as an exotic injection vector.
 *
 * What we DO NOT strip
 * --------------------
 *   - Variation Selectors (U+FE00..U+FE0F, U+E0100..U+E01EF) — required
 *     for emoji presentation and some CJK ideographs. Stripping these
 *     breaks legitimate content.
 *   - Soft hyphen (U+00AD) — legitimate typography.
 *   - Word Joiner (U+2060) — sometimes legitimate for line-break control.
 *
 * These exclusions are conservative: prefer false negatives (a hostile
 * skill can still smuggle via VS-16 emoji-presentation), but the
 * variation-selector channel is much narrower than Tag / Bidi / ZW and
 * isn't worth the breakage. Re-evaluate if real-world payloads emerge.
 *
 * Reference: see the YouTube talk on "Hidden Unicode Backdoors in AI
 * Agent Skills" + upstream issue threads on related drift bugs.
 */

export interface SanitizationFinding {
  /** Human-readable category — `tagChar`, `bidiControl`, `zeroWidth`, `bom`. */
  category: 'tagChar' | 'bidiControl' | 'zeroWidth' | 'bom' | 'mongolianVowelSeparator'
  /** Total occurrences of characters in this category. */
  count: number
  /** Sample of distinct code points (hex) seen — capped at 4. */
  codepoints: string[]
}

export interface SanitizationResult {
  /** Text with all flagged characters removed. */
  cleaned: string
  /** One entry per category that fired at least once. Empty when input was clean. */
  findings: SanitizationFinding[]
  /** Total characters stripped across all categories. */
  totalStripped: number
}

const BIDI_CONTROL_CHARS = new Set([
  0x202A, 0x202B, 0x202C, 0x202D, 0x202E, // LRE / RLE / PDF / LRO / RLO
  0x2066, 0x2067, 0x2068, 0x2069,         // LRI / RLI / FSI / PDI
  0x061C,                                  // Arabic Letter Mark
])

const ZERO_WIDTH_CHARS = new Set([
  0x200B, // Zero Width Space
  0x200C, // Zero Width Non-Joiner
  0x200D, // Zero Width Joiner
])

const BOM_CHARS = new Set([
  0xFEFF, // Byte Order Mark / Zero Width No-Break Space
])

const MONGOLIAN_VS = 0x180E

/** Inclusive range of "Tag" code points (U+E0000..U+E007F). */
const TAG_RANGE_LO = 0xE0000
const TAG_RANGE_HI = 0xE007F

interface Bucket {
  count: number
  codepoints: Set<number>
}

function emptyBucket(): Bucket {
  return { count: 0, codepoints: new Set() }
}

function bucketToFinding(
  category: SanitizationFinding['category'],
  bucket: Bucket,
): SanitizationFinding | null {
  if (bucket.count === 0) return null
  const cps = Array.from(bucket.codepoints)
    .sort((a, b) => a - b)
    .slice(0, 4)
    .map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`)
  return { category, count: bucket.count, codepoints: cps }
}

/**
 * Strip the high-risk invisible-Unicode subset from `text`. Pure function;
 * never throws on bad input (non-string returns empty findings + the raw
 * string).
 */
export function sanitizeUntrustedText(text: string): SanitizationResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { cleaned: text ?? '', findings: [], totalStripped: 0 }
  }

  const buckets: Record<SanitizationFinding['category'], Bucket> = {
    tagChar: emptyBucket(),
    bidiControl: emptyBucket(),
    zeroWidth: emptyBucket(),
    bom: emptyBucket(),
    mongolianVowelSeparator: emptyBucket(),
  }

  let out = ''
  // Iterate by code point (not code unit) so astral chars in the Tag block
  // are matched as single units rather than two stripped halves.
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0

    if (cp >= TAG_RANGE_LO && cp <= TAG_RANGE_HI) {
      buckets.tagChar.count++
      buckets.tagChar.codepoints.add(cp)
      continue
    }
    if (BIDI_CONTROL_CHARS.has(cp)) {
      buckets.bidiControl.count++
      buckets.bidiControl.codepoints.add(cp)
      continue
    }
    if (ZERO_WIDTH_CHARS.has(cp)) {
      buckets.zeroWidth.count++
      buckets.zeroWidth.codepoints.add(cp)
      continue
    }
    if (BOM_CHARS.has(cp)) {
      buckets.bom.count++
      buckets.bom.codepoints.add(cp)
      continue
    }
    if (cp === MONGOLIAN_VS) {
      buckets.mongolianVowelSeparator.count++
      buckets.mongolianVowelSeparator.codepoints.add(cp)
      continue
    }
    out += ch
  }

  const findings: SanitizationFinding[] = []
  for (const cat of Object.keys(buckets) as Array<SanitizationFinding['category']>) {
    const f = bucketToFinding(cat, buckets[cat])
    if (f) findings.push(f)
  }
  const totalStripped = findings.reduce((sum, f) => sum + f.count, 0)
  return { cleaned: out, findings, totalStripped }
}

/**
 * Concise one-line summary of findings for log output:
 *
 *   `tagChar=3 [U+E0041..]; bidiControl=2 [U+202E,U+2066]`
 *
 * Returns empty string when there are no findings (caller can `if (s) log.warn(s)`).
 */
export function summarizeFindings(findings: SanitizationFinding[]): string {
  if (findings.length === 0) return ''
  return findings
    .map((f) => `${f.category}=${f.count} [${f.codepoints.join(',')}${f.codepoints.length < f.count ? ',…' : ''}]`)
    .join('; ')
}
