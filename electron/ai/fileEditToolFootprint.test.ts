/**
 * Code-size acceptance for edit_file implementation surface (upstream FileEditTool tree analogue).
 * upstream keeps FileEditTool in one folder; here logic is split across a few modules — sum stays bounded.
 */

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Core edit semantics + validation + read-before-write gate + shared file I/O module (tools.ts). */
const EDIT_SURFACE_FILES = [
  'fileEditSemantics.ts',
  'tools.ts',
  path.join('..', 'utils', 'settings', 'validateEditTool.ts'),
  path.join('..', 'tools', 'readFileState.ts'),
]

describe('edit_file implementation footprint', () => {
  it('tracked source files stay within budget (bytes on disk)', () => {
    let sum = 0
    for (const rel of EDIT_SURFACE_FILES) {
      const abs = path.resolve(__dirname, rel)
      expect(fs.existsSync(abs), `missing ${abs}`).toBe(true)
      sum += fs.statSync(abs).size
    }
    // 2026-07 raise (150k → 165k): scope genuinely grew — literal-\uXXXX
    // auto-decode retry, advisory warnings channel (replace_all boundary
    // collisions + placeholder-introduction detection), baseReadId path-typo
    // recovery, and the self-script stale-receipt clarification notes.
    // 2026-07 raise (165k → 180k): whitespace-tolerant fallback tier
    // (drift elimination — tab/space swaps, indent shifts, NBSP, trailing
    // spaces) + the shared editOldStringLocatable gate/applier matcher.
    // 2026-07 raise (180k → 182k): path-bound readId receipt forwarding and
    // safe same-path receipt rebinding expanded the stale-edit recovery gate.
    const maxBytes = 182_000
    expect(sum, `edit surface grew to ${sum} B (cap ${maxBytes} B — raise cap only if scope grows)`).toBeLessThanOrEqual(
      maxBytes,
    )
  })
})
