import { describe, it, expect } from 'vitest'
import { computeExpectedLineRangeViolation } from './fileEditSemantics'

// Test corpus: a tiny file that mimics the user's reported failure shape —
// `_clean_content` ends at line 5, `_find_chapters` starts at line 7.
// The bug we're guarding against: an oldString that accidentally bridges the
// boundary between these two functions. With expectedLineRange declared
// inside `_clean_content`, the bridge edit must be refused.
const TWO_FUNCTION_FILE = [
  'def _clean_content(content):',                  // line 1
  "    content = re.sub(r'^\\s+', '', content)",   // line 2
  "    content = re.sub(r'\\s+$', '', content,",   // line 3
  '                     flags=re.MULTILINE)',      // line 4
  '    return content',                            // line 5
  '',                                              // line 6
  'def _find_chapters(content):',                  // line 7
  '    chapters = []',                             // line 8
  '    return chapters',                           // line 9
].join('\n')

describe('computeExpectedLineRangeViolation', () => {
  describe('hit fully inside declared window', () => {
    it('passes when the match is within bounds', () => {
      const result = computeExpectedLineRangeViolation(
        TWO_FUNCTION_FILE,
        '    return content',
        '    return content.strip()',
        { expectedLineRange: [1, 6] },
      )
      expect(result.ok).toBe(true)
    })

    it('passes when the match exactly fills the declared window (single line)', () => {
      const result = computeExpectedLineRangeViolation(
        TWO_FUNCTION_FILE,
        '    chapters = []',
        '    chapters: list[str] = []',
        { expectedLineRange: [8, 8] },
      )
      expect(result.ok).toBe(true)
    })

    it('passes for a multi-line edit that exactly fills the window', () => {
      const result = computeExpectedLineRangeViolation(
        TWO_FUNCTION_FILE,
        'def _find_chapters(content):\n    chapters = []\n    return chapters',
        'def _find_chapters(content):\n    return []',
        { expectedLineRange: [7, 9] },
      )
      expect(result.ok).toBe(true)
    })
  })

  describe('hit crosses declared window (the user-reported bug)', () => {
    it('rejects an oldString that bridges _clean_content and _find_chapters', () => {
      // This is exactly the failure mode the user reported: the model glued
      // _clean_content's regex closing onto _find_chapters' signature.
      const bridgedOld =
        "    return content\n\ndef _find_chapters(content):"
      const result = computeExpectedLineRangeViolation(
        TWO_FUNCTION_FILE,
        bridgedOld,
        '    return content.strip()',
        { expectedLineRange: [1, 5] }, // model thinks the edit is inside _clean_content
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('OUT_OF_WINDOW')
      expect(result.message).toContain('expectedLineRange [1, 5]')
      // The actual hit spans lines 5-7. The error must surface that.
      expect(result.message).toMatch(/lines 5-7/)
      // And it must explain the boundary-blindness pitfall.
      expect(result.message).toContain('bridged a logical boundary')
      expect(result.hits).toEqual([{ minLine1: 5, maxLine1: 7 }])
    })

    it('rejects when the start of the hit is before the window', () => {
      const result = computeExpectedLineRangeViolation(
        TWO_FUNCTION_FILE,
        '    return content',
        '    return content.strip()',
        { expectedLineRange: [7, 9] }, // model said _find_chapters; actually inside _clean_content
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('OUT_OF_WINDOW')
      expect(result.message).toContain('line 5')
    })

    it('rejects when the end of the hit overshoots the window', () => {
      const result = computeExpectedLineRangeViolation(
        TWO_FUNCTION_FILE,
        '    chapters = []\n    return chapters',
        '    return []',
        { expectedLineRange: [8, 8] }, // window covers only line 8; hit is 8-9
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toContain('lines 8-9')
    })
  })

  describe('replaceAll: every hit must be inside', () => {
    const CONST_FILE = [
      'const x = 1',         // line 1
      'const y = x + 1',     // line 2
      'const z = x + 2',     // line 3
      'const w = x',         // line 4
    ].join('\n')

    it('passes when ALL replaceAll hits land inside the window', () => {
      const result = computeExpectedLineRangeViolation(
        CONST_FILE,
        'x',
        'X',
        { replaceAll: true, expectedLineRange: [1, 4] },
      )
      expect(result.ok).toBe(true)
    })

    it('rejects when ANY replaceAll hit lands outside the window', () => {
      const result = computeExpectedLineRangeViolation(
        CONST_FILE,
        'x',
        'X',
        { replaceAll: true, expectedLineRange: [1, 2] },
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('OUT_OF_WINDOW')
      expect(result.message).toContain('matches total')
      // Hits on lines 3 and 4 are out of window.
      expect(result.message).toMatch(/line 3/)
      expect(result.message).toMatch(/line 4/)
    })

    it('truncates the violation list with a "+N more" suffix beyond 3', () => {
      // 5 hits all out of window
      const FIVE_HIT_FILE = ['x1', 'x2', 'x3', 'x4', 'x5'].map((s) => `var ${s}`).join('\n')
      // This file has 5 lines, each starts with 'var '. Range [1,1] forces 4
      // out-of-window violations.
      const result = computeExpectedLineRangeViolation(
        FIVE_HIT_FILE,
        'var ',
        'let ',
        { replaceAll: true, expectedLineRange: [1, 1] },
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toContain('+1 more out-of-window hit')
    })
  })

  describe('boundary cases', () => {
    it('returns ok when oldString is empty (file-creation semantics)', () => {
      const result = computeExpectedLineRangeViolation(
        '',
        '',
        'new content',
        { expectedLineRange: [1, 1] },
      )
      expect(result.ok).toBe(true)
    })

    it('returns ok when oldString is not found (lets the regular edit error surface)', () => {
      const result = computeExpectedLineRangeViolation(
        TWO_FUNCTION_FILE,
        'this string is not in the file',
        'replacement',
        { expectedLineRange: [1, 9] },
      )
      expect(result.ok).toBe(true)
    })

    it('rejects when match only succeeds via newline normalization (CRLF mismatch)', () => {
      // File has CRLF endings; oldString uses LF only.
      const crlfFile = 'line1\r\nline2\r\nline3\r\n'
      const lfOld = 'line1\nline2'
      const result = computeExpectedLineRangeViolation(
        crlfFile,
        lfOld,
        'replaced',
        { expectedLineRange: [1, 2] },
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('NORMALIZED_HIT_INCOMPATIBLE')
      expect(result.message).toContain('CRLF/LF normalization')
    })
  })
})
