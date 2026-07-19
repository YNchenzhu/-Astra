/**
 * Unit tests for the `prose_edit_verify_reminder` collector
 * (2026-06 verify-depth uplift).
 *
 * Scans `state.toolUseBlocks` for file-mutation tools targeting prose
 * extensions and nudges the model to re-read the final document. Code
 * files never trigger it; cadence + per-file re-nudge throttles bound
 * the noise.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetProseVerifyReminderTrackingForTests,
  collectProseTargets,
  proseEditVerifyReminderCollector,
  MIN_ITERATIONS_BETWEEN_NUDGES,
  RENUDGE_FILE_AFTER_ITERATIONS,
} from './proseEditVerifyReminder'
import {
  expectPushMessageAction,
  makeAttachmentFixture,
} from './testFixtures'

const ORIGINAL_ENV = process.env.POLE_PROSE_VERIFY_REMINDER

const getAgentContextMock = vi.fn()

vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => getAgentContextMock(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.POLE_PROSE_VERIFY_REMINDER
  getAgentContextMock.mockReturnValue({
    agentId: 'main',
    streamConversationId: 'conv-prose',
  })
  __resetProseVerifyReminderTrackingForTests()
})

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.POLE_PROSE_VERIFY_REMINDER
  else process.env.POLE_PROSE_VERIFY_REMINDER = ORIGINAL_ENV
})

function writeBlock(path: string, name = 'write_file') {
  return { id: `tu_${path}`, name, input: { filePath: path } }
}

function fixtureWithBlocks(
  blocks: Array<Record<string, unknown>>,
  iteration = 1,
) {
  return makeAttachmentFixture({
    iteration,
    stateOverrides: { toolUseBlocks: blocks },
  })
}

describe('collectProseTargets', () => {
  it('picks prose extensions from mutating tools (filePath / file_path / path aliases)', () => {
    const targets = collectProseTargets([
      { name: 'write_file', input: { filePath: 'docs/guide.md' } },
      { name: 'edit_file', input: { file_path: 'notes.txt' } },
      { name: 'Write', input: { path: 'chapter.adoc' } },
    ])
    expect(targets).toEqual(['docs/guide.md', 'notes.txt', 'chapter.adoc'])
  })

  it('ignores code files, read-only tools, and missing paths', () => {
    const targets = collectProseTargets([
      { name: 'write_file', input: { filePath: 'src/app.ts' } },
      { name: 'read_file', input: { filePath: 'docs/guide.md' } },
      { name: 'edit_file', input: {} },
      { name: 'bash', input: { command: 'echo hi > x.md' } },
    ])
    expect(targets).toEqual([])
  })

  it('dedups repeated edits to the same file within one batch', () => {
    const targets = collectProseTargets([
      { name: 'edit_file', input: { filePath: 'a.md' } },
      { name: 'edit_file', input: { filePath: 'a.md' } },
    ])
    expect(targets).toEqual(['a.md'])
  })
})

describe('proseEditVerifyReminderCollector — gating', () => {
  it('runs at post_tool only', () => {
    expect(proseEditVerifyReminderCollector.callSites).toEqual(['post_tool'])
  })

  it('returns null when the batch touched no prose files', async () => {
    const result = await proseEditVerifyReminderCollector.run(
      fixtureWithBlocks([writeBlock('src/app.ts')]),
    )
    expect(result).toBeNull()
  })

  it('returns null when explicitly disabled (POLE_PROSE_VERIFY_REMINDER=0)', async () => {
    process.env.POLE_PROSE_VERIFY_REMINDER = '0'
    const result = await proseEditVerifyReminderCollector.run(
      fixtureWithBlocks([writeBlock('docs/guide.md')]),
    )
    expect(result).toBeNull()
  })

  it('fires for sub-agents too (delegated writing tasks)', async () => {
    getAgentContextMock.mockReturnValue({
      agentId: 'sub-1',
      streamConversationId: 'conv-prose',
    })
    const result = await proseEditVerifyReminderCollector.run(
      fixtureWithBlocks([writeBlock('docs/guide.md')]),
    )
    expect(result).not.toBeNull()
  })
})

describe('proseEditVerifyReminderCollector — emission + throttles', () => {
  it('emits a push_message listing the edited prose files', async () => {
    const result = await proseEditVerifyReminderCollector.run(
      fixtureWithBlocks([writeBlock('docs/guide.md'), writeBlock('notes.txt', 'edit_file')]),
    )
    const body = String(expectPushMessageAction(result).message.content)
    expect(body).toContain('docs/guide.md')
    expect(body).toContain('notes.txt')
    expect(body).toContain('re-read')
  })

  it('does not re-nudge the same file within RENUDGE_FILE_AFTER_ITERATIONS', async () => {
    const first = await proseEditVerifyReminderCollector.run(
      fixtureWithBlocks([writeBlock('docs/guide.md')], 1),
    )
    expect(first).not.toBeNull()
    const second = await proseEditVerifyReminderCollector.run(
      fixtureWithBlocks(
        [writeBlock('docs/guide.md')],
        1 + MIN_ITERATIONS_BETWEEN_NUDGES,
      ),
    )
    expect(second).toBeNull()
  })

  it('re-nudges the same file after the re-nudge window elapses', async () => {
    const first = await proseEditVerifyReminderCollector.run(
      fixtureWithBlocks([writeBlock('docs/guide.md')], 1),
    )
    expect(first).not.toBeNull()
    const later = await proseEditVerifyReminderCollector.run(
      fixtureWithBlocks(
        [writeBlock('docs/guide.md')],
        1 + RENUDGE_FILE_AFTER_ITERATIONS,
      ),
    )
    expect(later).not.toBeNull()
  })

  it('applies the global cadence throttle even for a brand-new file', async () => {
    const first = await proseEditVerifyReminderCollector.run(
      fixtureWithBlocks([writeBlock('a.md')], 1),
    )
    expect(first).not.toBeNull()
    // Different file, but too soon after the previous nudge.
    const tooSoon = await proseEditVerifyReminderCollector.run(
      fixtureWithBlocks([writeBlock('b.md')], 2),
    )
    expect(tooSoon).toBeNull()
    // Same file qualifies once the cadence gap has passed.
    const afterGap = await proseEditVerifyReminderCollector.run(
      fixtureWithBlocks([writeBlock('b.md')], 1 + MIN_ITERATIONS_BETWEEN_NUDGES),
    )
    expect(afterGap).not.toBeNull()
  })

  it('reports fileCount to appendixReport', async () => {
    const ctx = fixtureWithBlocks([writeBlock('docs/guide.md')], 7)
    await proseEditVerifyReminderCollector.run(ctx)
    expect(ctx.state.appendixReport).toHaveBeenCalledWith(
      'P2_Q_compaction_reminder',
      expect.objectContaining({
        kind: 'prose_edit_verify_reminder',
        fileCount: 1,
        iteration: 7,
      }),
    )
  })
})
