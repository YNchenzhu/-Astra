/**
 * Diagnostic — when does the "read-before-edit" hint actually reach the model?
 *
 * Design under test (per the user's description):
 *   - The agent is allowed to edit a file repeatedly WITHOUT re-reading,
 *     because each successful edit self-stamps a fresh read receipt and the
 *     tool result carries a trailer telling the model the rotated readId.
 *   - BUT when the next edit will REQUIRE a fresh `read_file` first, that
 *     fact must be fed back to the model IN THE CURRENT edit's tool result.
 *
 * Observed symptom: the agent sometimes edits without reading when it
 * shouldn't — i.e. it seems not to see the hint.
 *
 * This test pins down WHERE the hint can be lost between "edit tool emits it"
 * and "model reads it on the next turn", by running the hint through the REAL
 * post-execution result pipeline:
 *   1. `buildNextEditTrailer`           — the real trailer generator.
 *   2. `applyToolResultSizeBudget`      — execution-time spill/truncation.
 *   3. `clampToolResultsInMessages`     — pre-model history budget clamp.
 *
 * Findings asserted below (so a future refactor that changes the answer
 * fails loudly):
 *   A. The trailer survives execution-time budgeting for a NORMAL (short)
 *      edit output — so that is NOT the cause.
 *   B. It even survives a pathologically large output, because the trailer
 *      sits near the HEAD of the edit result (right after the one-line
 *      summary), and both the 400K head-slice and the head+tail spill
 *      preview keep the head.
 *   C. The HISTORY-level clamp replaces the edit result BODY with a
 *      placeholder, but (fix ①, 2026-06) the read-before-edit guidance is
 *      now PRESERVED in that placeholder — both the rotated `readId for next
 *      edit` and the `NEXT EDIT REQUIRES A FRESH read_file` warning — so a
 *      later same-file edit no longer edits blind. Previously the whole
 *      trailer was wiped; this test pins the preservation.
 */

import { describe, it, expect } from 'vitest'
import { buildNextEditTrailer } from '../../tools/readFileState'
import {
  applyToolResultSizeBudget,
  clampToolResultsInMessages,
} from '../toolResultBudget'
import { clearCompletedToolResultsExceptRecent } from '../../context/idleToolResultClear'
import { microCompact } from '../../context/compact'
import {
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
} from '../../constants/toolLimits'

type Msg = Record<string, unknown>

const REREAD_MARKER = 'NEXT EDIT REQUIRES A FRESH read_file'
const READID_MARKER = 'readId for next edit:'

// Mirrors the real edit success output shape in toolEditFile.ts:
//   `Edited <path> (result N bytes on disk, UTF-8).${readIdTrailer}${lspTrailer}`
function buildEditOutput(opts: {
  reread: boolean
  lspTailChars?: number
}): string {
  const summary = 'Edited g:/fake/src/payment/refund.ts (result 1834 bytes on disk, UTF-8).'
  const trailer = opts.reread
    ? buildNextEditTrailer(null, 'edit_file')
    : buildNextEditTrailer({ readId: 'read-abc123' }, 'edit_file')
  const lspTail = opts.lspTailChars
    ? `\n[LSP diagnostics]\n${'warning: unused symbol on some line; '.repeat(Math.ceil(opts.lspTailChars / 40))}`
    : ''
  return `${summary}${trailer}${lspTail}`
}

describe('read-before-edit hint visibility — where the trailer survives or is lost', () => {
  it('A: trailer text exists and names the two branches', () => {
    expect(buildNextEditTrailer(null, 'edit_file')).toContain(REREAD_MARKER)
    expect(buildNextEditTrailer({ readId: 'read-x' }, 'edit_file')).toContain(READID_MARKER)
  })

  it('A: NORMAL short edit output keeps the must-reread hint through execution budgeting', () => {
    const output = buildEditOutput({ reread: true })
    const res = applyToolResultSizeBudget('edit_file', { success: true, output })
    expect(output.length).toBeLessThan(DEFAULT_MAX_RESULT_SIZE_CHARS)
    expect(res.output).toContain(REREAD_MARKER)
  })

  it('B: even a huge edit output keeps the hint, because the trailer sits near the HEAD', () => {
    // 120K of trailing LSP noise → forces spill + head/tail preview.
    const output = buildEditOutput({ reread: true, lspTailChars: 120_000 })
    expect(output.length).toBeGreaterThan(DEFAULT_MAX_RESULT_SIZE_CHARS)
    const res = applyToolResultSizeBudget('edit_file', { success: true, output }, { toolUseId: 'edit-huge-1' })
    // The summary + trailer live in the first ~400 chars, which the head
    // preview (4.8K) always retains — so the hint is NOT lost here.
    expect(res.output).toContain(REREAD_MARKER)
  })

  // Helper: build a pressured history whose OLDEST tool_result is the edit
  // block, so the global oldest-first sweep clamps the edit block first.
  function pressuredHistoryWith(editOutput: string): Msg[] {
    const filler = 'r'.repeat(45_000) // under the 50K per-block cap → survives Pass 1
    const messages: Msg[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-1', content: editOutput, is_error: false }] },
    ]
    // Six 45K fillers → ~270K total > 200K global cap, none over the per-block
    // cap, so Pass 1 is a no-op and Pass 2 (oldest-first) must clamp.
    for (let i = 0; i < 6; i++) {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `f${i}`, content: filler, is_error: false }],
      })
    }
    return messages
  }

  it('C: clamp removes the edit body but PRESERVES the "must re-read" warning (fix ①)', () => {
    const editOutput = buildEditOutput({ reread: true })
    const messages = pressuredHistoryWith(editOutput)
    const totalBefore = messages
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as Msg[]) : []))
      .filter((b) => b.type === 'tool_result')
      .reduce((n, b) => n + String(b.content).length, 0)
    expect(totalBefore).toBeGreaterThan(MAX_TOOL_RESULTS_PER_MESSAGE_CHARS)

    const clamped = clampToolResultsInMessages(messages)
    const clampedEditText = String((clamped[0].content as Msg[])[0].content)

    // eslint-disable-next-line no-console
    console.log('[edit-read-hint-visibility]', JSON.stringify({
      totalToolResultChars: totalBefore,
      globalCap: MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
      editBlockAfterClamp: clampedEditText,
      hintSurvivedHistoryClamp: clampedEditText.includes(REREAD_MARKER),
    }, null, 2))

    // Body is gone (placeholder), but the read-before-edit warning survives.
    expect(clampedEditText).toContain('tool_result truncated')
    expect(clampedEditText).toContain(REREAD_MARKER)
  })

  it('C2: clamp PRESERVES the rotated readId for the chained-edit case', () => {
    const editOutput = buildEditOutput({ reread: false }) // "readId for next edit: read-abc123"
    const messages = pressuredHistoryWith(editOutput)
    const clamped = clampToolResultsInMessages(messages)
    const clampedEditText = String((clamped[0].content as Msg[])[0].content)

    expect(clampedEditText).toContain('tool_result truncated')
    expect(clampedEditText).toContain(READID_MARKER)
    expect(clampedEditText).toContain('read-abc123') // the actual id survives
  })

  // Build an assistant(tool_use edit_file) + user(tool_result) pair.
  function editGroup(id: string, output: string): Msg[] {
    return [
      { role: 'assistant', content: [{ type: 'tool_use', id, name: 'edit_file', input: { file_path: 'g:/fake/x.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: false }] },
    ]
  }

  it('D: idle-tool-result-clear PRESERVES the edit guidance (separate path, fix ③-companion)', () => {
    // edit-1 is the OLDEST group; keepRecentGroups=1 forces it to be cleared.
    const editOutput = buildEditOutput({ reread: false }) // readId branch
    const msgs: Msg[] = [
      ...editGroup('edit-1', editOutput),
      ...editGroup('n1', 'newer edit output 1'),
      ...editGroup('n2', 'newer edit output 2'),
    ]
    const cleared = clearCompletedToolResultsExceptRecent(msgs, 1)
    const clearedEditText = String((cleared[1].content as Msg[])[0].content)

    expect(clearedEditText).toContain('[Old tool result content cleared]')
    expect(clearedEditText).toContain(READID_MARKER) // preserved, not a bare placeholder
    expect(clearedEditText).toContain('read-abc123')
  })

  it('E: micro-compact PRESERVES the must-reread guidance even when a long path pushes it past the head preview', () => {
    const longPath =
      'g:/fake/src/very/deeply/nested/module/aaaaaa/bbbbbb/payment/refund_service_impl.ts'
    const editOutput = `Edited ${longPath} (result 1834 bytes on disk, UTF-8).${buildNextEditTrailer(null, 'edit_file')}`
    expect(editOutput.length).toBeGreaterThan(200) // micro-compact only truncates >200
    const msgs: Msg[] = [
      ...editGroup('edit-1', editOutput),
      ...editGroup('n1', 'z'.repeat(300)),
      ...editGroup('n2', 'y'.repeat(300)),
    ]
    const out = microCompact(msgs, 1)
    const truncEditText = String((out[1].content as Msg[])[0].content)

    expect(truncEditText).toContain('Previous tool output truncated')
    expect(truncEditText).toContain(REREAD_MARKER) // survives via the appended hint note
  })
})
