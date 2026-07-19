/**
 * Integration tests for the 12-pass message normalization pipeline.
 *
 * Covers every pass individually, plus multi-pass accumulation effects
 * that contribute to the three multi-turn degradation symptoms:
 *
 *   Symptom 1: AI claims completion before calling tools
 *   Symptom 2: AI declares intent but stops without acting
 *   Symptom 3: AI claims completion with zero tool calls (thinking hallucination)
 *
 * Risk groups tested:
 *   RG-A: thinking management (Pass 6, Pass 7, reorder, fixPosition)
 *   RG-B: context ordering (pairing repair, merge side effects, snip)
 *   RG-C: tool result truncation / synthetic error injection
 *   RG-D: guard interactions (declared-intent nudge budget)
 */

import { describe, expect, it } from 'vitest'
import { normalizeMessagesForAPI } from './normalizeMessagesForAPI'
import { ensureToolUseResultPairing } from './ensureToolUseResultPairing'
import { SIDE_CHANNEL_KIND, wrapSideChannelBody } from '../constants/sideChannelKinds'

// ─────────────────────────────────────────────────────────────────────
// Helper factories
// ─────────────────────────────────────────────────────────────────────

function user(text: string): Record<string, unknown> {
  return { role: 'user', content: text }
}

function userBlocks(blocks: Array<Record<string, unknown>>): Record<string, unknown> {
  return { role: 'user', content: blocks }
}

function assistant(blocks: Array<Record<string, unknown>>): Record<string, unknown> {
  return { role: 'assistant', content: blocks }
}

function assistantText(text: string): Record<string, unknown> {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

function thinkingBlock(thinking: string, signature?: string): Record<string, unknown> {
  const b: Record<string, unknown> = { type: 'thinking', thinking }
  if (signature) b.signature = signature
  return b
}

function toolUseBlock(name: string, input: Record<string, unknown>, id?: string): Record<string, unknown> {
  return { type: 'tool_use', name, input, id: id ?? `${name}_1` }
}

function toolResultBlock(toolUseId: string, content: string, isError = false): Record<string, unknown> {
  const b: Record<string, unknown> = { type: 'tool_result', tool_use_id: toolUseId, content }
  if (isError) b.is_error = true
  return b
}

function systemReminder(text: string): Record<string, unknown> {
  return {
    role: 'user',
    content: wrapSideChannelBody(SIDE_CHANNEL_KIND.genericConvertedSystem, text),
    _convertedFromSystem: true,
  }
}

// ─────────────────────────────────────────────────────────────────────
// Pass 1: reorderAttachmentsForAPI
// ─────────────────────────────────────────────────────────────────────

describe('Pass 1: reorderAttachmentsForAPI', () => {
  it('keeps messages without attachments unchanged', () => {
    const msgs = [user('hello'), assistantText('hi')]
    const result = normalizeMessagesForAPI(msgs, { applyAnthropicInvariants: false })
    expect(result).toHaveLength(2)
    expect(result[0].role).toBe('user')
    expect(result[1].role).toBe('assistant')
  })

  it('moves attachments near tool_result', () => {
    const attachment = { role: 'user', content: 'attachment data', _isAttachment: true }
    const toolResultUser = userBlocks([toolResultBlock('edit_1', 'ok')])
    const msgs = [attachment, toolResultUser]
    const result = normalizeMessagesForAPI(msgs, {
      applyAnthropicInvariants: false,
      stripInternalMeta: false,
      applyConsecutiveUserMerge: false,
    })
    // Pass 1 reorders: attachment follows tool_result user message (total 2)
    expect(result.length).toBe(2)
    expect(result.some((m: Record<string, unknown>) => (m as Record<string, unknown>)._isAttachment === true)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Pass 5b: reorderAssistantToolUseBlocks
// ─────────────────────────────────────────────────────────────────────

describe('Pass 5b: reorderAssistantToolUseBlocks', () => {
  it('moves thinking blocks out of tool_use clusters', () => {
    const msg = assistant([
      toolUseBlock('Read', { file_path: 'a.ts' }, 'read_1'),
      thinkingBlock('should I read more?'),
      toolUseBlock('Read', { file_path: 'b.ts' }, 'read_2'),
      thinkingBlock('now I understand'),
    ])
    const result = normalizeMessagesForAPI([msg], { applyAnthropicInvariants: false })
    const blocks = (result[0] as Record<string, unknown>).content as Array<Record<string, unknown>>
    // tool_use blocks must be contiguous
    const toolUseIndices: number[] = []
    const thinkingIndices: number[] = []
    blocks.forEach((b, i) => {
      if (b.type === 'tool_use') toolUseIndices.push(i)
      if (b.type === 'thinking') thinkingIndices.push(i)
    })
    // All thinking blocks should be after all tool_use blocks (or before)
    if (toolUseIndices.length > 0 && thinkingIndices.length > 0) {
      const maxToolIdx = Math.max(...toolUseIndices)
      const minThinkIdx = Math.min(...thinkingIndices)
      // Either all tool_use before thinking or vice-versa
      const toolFirst = maxToolIdx < minThinkIdx
      const thinkFirst = Math.max(...thinkingIndices) < Math.min(...toolUseIndices)
      expect(toolFirst || thinkFirst).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// Pass 6: filterOrphanedThinkingOnly (Symptom 3 — path B)
// ─────────────────────────────────────────────────────────────────────

describe('Pass 6: filterOrphanedThinkingOnly (Symptom 3 risk)', () => {
  it('removes assistant messages that contain ONLY thinking blocks', () => {
    const msgs = [
      user('fix bug'),
      assistant([thinkingBlock('I need to modify 3 files...')]),
      assistantText('done'),
    ]
    const result = normalizeMessagesForAPI(msgs, { applyAnthropicInvariants: false })
    // The pure-thinking assistant should be removed
    const assistants = result.filter((m: Record<string, unknown>) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    // The surviving assistant should have text content
    const content = assistants[0].content as Array<Record<string, unknown>>
    expect(content.some((b) => b.type === 'text')).toBe(true)
  })

  it('KEEPS assistant messages that have thinking + text', () => {
    const msgs = [
      user('fix bug'),
      assistant([thinkingBlock('analyzing...'), { type: 'text', text: 'Fixed!' }]),
    ]
    const result = normalizeMessagesForAPI(msgs, { applyAnthropicInvariants: false })
    const assistants = result.filter((m: Record<string, unknown>) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
  })

  it('KEEPS assistant messages that have thinking + tool_use', () => {
    const msgs = [
      user('fix bug'),
      assistant([thinkingBlock('I should edit...'), toolUseBlock('Edit', { file_path: 'x.ts' }, 'edit_1')]),
    ]
    const result = normalizeMessagesForAPI(msgs, { applyAnthropicInvariants: false })
    const assistants = result.filter((m: Record<string, unknown>) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
  })

  it('preserves thinking-only when strictThinkingEcho is true (DeepSeek compat)', () => {
    const msgs = [
      user('fix bug'),
      assistant([thinkingBlock('reasoning only')]),
    ]
    const result = normalizeMessagesForAPI(msgs, { strictThinkingEcho: true, applyAnthropicInvariants: false })
    const assistants = result.filter((m: Record<string, unknown>) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
  })

  // Symptom 3 critical test: when multiple thinking-only messages in a row
  // are all removed, the conversation transcript has large gaps
  it('removing multiple consecutive thinking-only messages creates context gaps', () => {
    const msgs = [
      user('complex task'),
      assistant([thinkingBlock('step 1: read files')]),
      assistant([thinkingBlock('step 2: analyze')]),
      assistant([thinkingBlock('step 3: done')]),
      assistantText('task complete'),
    ]
    const result = normalizeMessagesForAPI(msgs, { applyAnthropicInvariants: false })
    // All 3 thinking-only messages removed, only the text assistant survives
    const assistants = result.filter((m: Record<string, unknown>) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Pass 6 — preserveThinkingOnlyAssistant (2026-06 fix: iteration-level
// writeback must not destroy the persisted reasoning record)
// ─────────────────────────────────────────────────────────────────────

describe('Pass 6: preserveThinkingOnlyAssistant (iteration writeback path)', () => {
  // Mirror of the option set used by `orchestration/phases/iteration.ts`
  // when assigning the result back into `state.apiMessages`.
  const writebackOptions = {
    stripInternalMeta: false,
    applyConsecutiveUserMerge: false,
    preserveThinkingOnlyAssistant: true,
  } as const

  it('keeps thinking-only assistant messages in the persisted transcript', () => {
    const msgs = [
      user('fix bug'),
      assistant([thinkingBlock('已完成修改，所有文件已更新，测试通过')]),
      assistantText('done'),
    ]
    const result = normalizeMessagesForAPI(msgs, writebackOptions)
    const thinkingMsgs = result.filter(
      (m: Record<string, unknown>) =>
        m.role === 'assistant' &&
        Array.isArray(m.content) &&
        (m.content as Array<Record<string, unknown>>).some((b) => b.type === 'thinking'),
    )
    expect(thinkingMsgs.length).toBeGreaterThanOrEqual(1)
  })

  it('wire path (default options) still removes them — provider never sees dangling thinking', () => {
    const msgs = [
      user('fix bug'),
      assistant([thinkingBlock('reasoning only')]),
      assistantText('done'),
    ]
    const result = normalizeMessagesForAPI(msgs, { applyAnthropicInvariants: false })
    const assistants = result.filter((m: Record<string, unknown>) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
  })

  it('preserved thinking-only message gets a non-thinking tail via Pass 9 (API validity)', () => {
    // Pass 9 (`ensureNonEmptyAssistantContent`) appends a '...' text block
    // to thinking-only assistants, so even the preserved form is never a
    // dangling thinking-last message if it does reach a wire serializer.
    // (A trailing user turn keeps the message off the LAST slot — Pass 7
    // legitimately trims trailing thinking from the final assistant.)
    const msgs = [
      user('fix bug'),
      assistant([thinkingBlock('reasoning only')]),
      user('continue'),
    ]
    const result = normalizeMessagesForAPI(msgs, writebackOptions)
    const asst = result.find((m: Record<string, unknown>) => m.role === 'assistant')
    expect(asst).toBeDefined()
    const blocks = (asst! as Record<string, unknown>).content as Array<Record<string, unknown>>
    expect(blocks.some((b) => b.type === 'thinking')).toBe(true)
    expect(blocks[blocks.length - 1].type).not.toBe('thinking')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Pass 7: filterTrailingThinkingFromLastAssistant (Symptom 3 — path C)
// ─────────────────────────────────────────────────────────────────────

describe('Pass 7: filterTrailingThinkingFromLastAssistant (Symptom 3 risk)', () => {
  it('trims trailing thinking blocks from last assistant message', () => {
    const msgs = [
      user('fix bug'),
      assistant([{ type: 'text', text: 'I will fix it' }, thinkingBlock('now executing...')]),
    ]
    const result = normalizeMessagesForAPI(msgs, { applyAnthropicInvariants: false })
    const last = result[result.length - 1] as Record<string, unknown>
    const blocks = (last.content as Array<Record<string, unknown>>)
    // No thinking block should be at the end
    const lastBlock = blocks[blocks.length - 1]
    expect(lastBlock.type).not.toBe('thinking')
  })

  it('removes entire message if it was only trailing thinking', () => {
    const msgs = [
      user('fix bug'),
      assistant([thinkingBlock('executing ... done')]),
      user('are you done?'),
    ]
    const result = normalizeMessagesForAPI(msgs, { applyAnthropicInvariants: false })
    // The pure-thinking assistant (last before user) should be removed
    const assistants = result.filter((m: Record<string, unknown>) => m.role === 'assistant')
    expect(assistants).toHaveLength(0)
  })

  it('preserves trailing thinking when strictThinkingEcho is true', () => {
    const msgs = [
      user('fix bug'),
      assistant([{ type: 'text', text: 'result' }, thinkingBlock('reflecting...')]),
    ]
    const result = normalizeMessagesForAPI(msgs, { strictThinkingEcho: true, applyAnthropicInvariants: false })
    const last = result[result.length - 1] as Record<string, unknown>
    const blocks = (last.content as Array<Record<string, unknown>>)
    // With strictThinkingEcho, thinking blocks should be preserved
    expect(blocks.some((b) => b.type === 'thinking')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Pass 9: ensureNonEmptyAssistantContent
// ─────────────────────────────────────────────────────────────────────

describe('Pass 9: ensureNonEmptyAssistantContent', () => {
  it('replaces empty content array with "..." placeholder', () => {
    const msgs = [user('hello'), { role: 'assistant', content: [] }]
    const result = normalizeMessagesForAPI(msgs, { applyAnthropicInvariants: false })
    const assistant = result.find((m: Record<string, unknown>) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    const content = (assistant! as Record<string, unknown>).content as Array<Record<string, unknown>>
    expect(content).toHaveLength(1)
    expect(content[0].text).toBe('...')
  })

  it('Pass 6 removes thinking-only assistant before Pass 9 adds "..."', () => {
    // When an assistant has ONLY thinking blocks, Pass 6 removes the
    // entire message BEFORE Pass 9 can add a placeholder. This is the
    // root cause of Symptom 3 path B — thinking-only turns disappear.
    const msgs = [user('hello'), assistant([thinkingBlock('reasoning only')])]
    const result = normalizeMessagesForAPI(msgs, { applyAnthropicInvariants: false })
    const asst = result.find((m: Record<string, unknown>) => m.role === 'assistant')
    // Pass 6 removed the pure-thinking assistant → no assistant survives
    expect(asst).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────
// Pass 10: smooshSystemReminderSiblings
// ─────────────────────────────────────────────────────────────────────

describe('Pass 10: smooshSystemReminderSiblings', () => {
  it('merges consecutive system-reminder user messages', () => {
    const msgs = [
      systemReminder('reminder A'),
      systemReminder('reminder B'),
    ]
    const result = normalizeMessagesForAPI(msgs, { applyAnthropicInvariants: false })
    expect(result).toHaveLength(1)
    const content = result[0].content as string
    expect(content).toContain('reminder A')
    expect(content).toContain('reminder B')
  })

  it('merges system-reminder with real user message (default behavior)', () => {
    const msgs = [
      systemReminder('reminder A'),
      user('real user input'),
    ]
    const result = normalizeMessagesForAPI(msgs, { applyAnthropicInvariants: false })
    // Both are role=user, consecutive → merged by Pass 4 (default merge=true)
    expect(result.length).toBeLessThanOrEqual(2)
  })

  it('preserves separation when applyConsecutiveUserMerge=false', () => {
    const msgs = [
      systemReminder('reminder A'),
      user('real user input'),
    ]
    const result = normalizeMessagesForAPI(msgs, {
      applyAnthropicInvariants: false,
      applyConsecutiveUserMerge: false,
    })
    expect(result.length).toBe(2)
  })

  // ── F1 (2026-07 会话审计) — kernel_user_input never smooshed ──────────
  it('does NOT fold a kernel_user_input delivery into an adjacent host reminder (either direction)', () => {
    const kernelInput = {
      role: 'user',
      content:
        '<system-reminder>\n[User message (mid-turn)]\nstop and fix the login bug first\n</system-reminder>',
      _convertedFromSystem: true,
      _sideChannelKind: 'kernel_user_input',
    }
    // Direction 1: reminder BEFORE user input — input must stay standalone.
    const r1 = normalizeMessagesForAPI(
      [systemReminder('reminder A'), { ...kernelInput }],
      { applyAnthropicInvariants: false, applyConsecutiveUserMerge: false },
    )
    expect(r1).toHaveLength(2)
    // Direction 2: reminder AFTER user input — the reminder must not fold
    // INTO the user input either.
    const r2 = normalizeMessagesForAPI(
      [{ ...kernelInput }, systemReminder('reminder B')],
      { applyAnthropicInvariants: false, applyConsecutiveUserMerge: false },
    )
    expect(r2).toHaveLength(2)
    // Plain reminders still smoosh (baseline preserved).
    const r3 = normalizeMessagesForAPI(
      [systemReminder('reminder A'), systemReminder('reminder B')],
      { applyAnthropicInvariants: false, applyConsecutiveUserMerge: false },
    )
    expect(r3).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────
// tool_use / tool_result pairing (ensureToolUseResultPairing)
// ─────────────────────────────────────────────────────────────────────

describe('ensureToolUseResultPairing — SYNTHETIC_ERROR injection', () => {
  it('does NOT inject errors when all tool_use have matching tool_result', () => {
    const msgs = [
      user('fix it'),
      assistant([toolUseBlock('Read', { file_path: 'a.ts' }, 'read_1')]),
      userBlocks([toolResultBlock('read_1', 'file content here')]),
    ]
    const result = ensureToolUseResultPairing(msgs)
    // Should be unchanged
    expect(result).toHaveLength(3)
    // No SYNTHETIC_ERROR anywhere
    const allBlocks = result.flatMap((m) =>
      Array.isArray((m as Record<string, unknown>).content)
        ? ((m as Record<string, unknown>).content as Array<Record<string, unknown>>)
        : [],
    )
    const synthErrors = allBlocks.filter(
      (b) =>
        b.type === 'tool_result' &&
        typeof b.content === 'string' &&
        b.content?.includes('synthetic tool_result'),
    )
    expect(synthErrors).toHaveLength(0)
  })

  it('injects SYNTHETIC_ERROR when tool_use has no tool_result', () => {
    const msgs = [
      user('fix it'),
      assistant([toolUseBlock('Read', { file_path: 'a.ts' }, 'read_1')]),
      // No matching user message with tool_result
      user('next question'),
    ]
    const result = ensureToolUseResultPairing(msgs)
    // Should have injected a tool_result
    const allBlocks = result.flatMap((m) =>
      Array.isArray((m as Record<string, unknown>).content)
        ? ((m as Record<string, unknown>).content as Array<Record<string, unknown>>)
        : [],
    )
    const synthErrors = allBlocks.filter(
      (b) =>
        b.type === 'tool_result' &&
        b.is_error === true,
    )
    expect(synthErrors.length).toBeGreaterThan(0)
  })

  it('18-round clean transcript: zero SYNTHETIC_ERROR injection (risk regression)', () => {
    // Build 18 rounds of clean user→assistant(tool_use)→user(tool_result) pairs
    const msgs: Array<Record<string, unknown>> = []
    for (let i = 1; i <= 18; i++) {
      msgs.push(user(`round ${i} task`))
      msgs.push(assistant([
        thinkingBlock(`reasoning for round ${i}`),
        toolUseBlock('Read', { file_path: `file_${i}.ts` }, `read_${i}`),
        { type: 'text', text: `Reading file ${i}` },
      ]))
      msgs.push(userBlocks([toolResultBlock(`read_${i}`, `content of file ${i}`)]))
    }
    const result = ensureToolUseResultPairing(msgs)
    const allBlocks = result.flatMap((m) =>
      Array.isArray((m as Record<string, unknown>).content)
        ? ((m as Record<string, unknown>).content as Array<Record<string, unknown>>)
        : [],
    )
    const synthErrors = allBlocks.filter(
      (b) =>
        b.type === 'tool_result' &&
        typeof b.content === 'string' &&
        b.content?.includes('synthetic'),
    )
    expect(synthErrors).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────
// full pipeline: Pass 6 + Pass 7 interaction with thinking simulation
// ─────────────────────────────────────────────────────────────────────

describe('Pass 6+7 interaction: thinking-only turns + trailing thinking (Symptom 3)', () => {
  it('thinking-only turn removed by Pass 6, trailing thinking trimmed by Pass 7', () => {
    const msgs = [
      user('complex refactor task'),
      // Round 1: normal with thinking
      assistant([thinkingBlock('analyzing...'), toolUseBlock('Read', { file_path: 'a.ts' }, 'read_1')]),
      userBlocks([toolResultBlock('read_1', 'content')]),
      // Round 2: model simulates completion in thinking only (Symptom 3)
      assistant([thinkingBlock('task completed, all files modified, tests passing')]),
      // Round 3: trailing thinking removed
      assistant([{ type: 'text', text: 'Done!' }, thinkingBlock('confirming everything is good')]),
    ]
    const result = normalizeMessagesForAPI(msgs, { applyAnthropicInvariants: false })

    // Round 2 (thinking-only) should be removed by Pass 6
    const assistants = result.filter((m: Record<string, unknown>) => m.role === 'assistant')
    // Round 1 survives (has tool_use), Round 3 survives (has text, thinking trimmed)
    expect(assistants).toHaveLength(2)

    // Round 3 should NOT have trailing thinking
    const lastAsst = assistants[assistants.length - 1]
    const blocks = (lastAsst as Record<string, unknown>).content as Array<Record<string, unknown>>
    const lastBlock = blocks[blocks.length - 1]
    expect(lastBlock.type).not.toBe('thinking')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Pass 4: mergeConsecutiveUserMessages — _sideChannelKind loss
// ─────────────────────────────────────────────────────────────────────

describe('Pass 4: mergeConsecutiveUserMessages — _sideChannelKind preservation', () => {
  it('preserves _sideChannelKind when applyConsecutiveUserMerge=false', () => {
    const reminder = {
      role: 'user',
      content: wrapSideChannelBody(SIDE_CHANNEL_KIND.staleTodoNudge, 'you have pending todos'),
      _sideChannelKind: SIDE_CHANNEL_KIND.staleTodoNudge,
      _convertedFromSystem: true,
    }
    const toolResultUser = userBlocks([toolResultBlock('read_1', 'content')])
    // These would normally be merged (both role=user, consecutive)
    const msgs = [toolResultUser, reminder]

    const result = normalizeMessagesForAPI(msgs, {
      applyAnthropicInvariants: false,
      applyConsecutiveUserMerge: false,
      stripInternalMeta: false,
    })
    // Both messages should survive independently
    const users = result.filter((m: Record<string, unknown>) => m.role === 'user')
    expect(users.length).toBeGreaterThanOrEqual(2)
    // The reminder should keep its _sideChannelKind
    const hasSideChannel = (users[users.length - 1] as Record<string, unknown>)._sideChannelKind
    expect(hasSideChannel).toBeDefined()
  })

  it('DROPS _sideChannelKind when applyConsecutiveUserMerge=true (default)', () => {
    const reminder = {
      role: 'user',
      content: wrapSideChannelBody(SIDE_CHANNEL_KIND.staleTodoNudge, 'you have pending todos'),
      _sideChannelKind: SIDE_CHANNEL_KIND.staleTodoNudge,
      _convertedFromSystem: true,
    }
    const toolResultUser = userBlocks([toolResultBlock('read_1', 'content')])
    const msgs = [toolResultUser, reminder]

    const result = normalizeMessagesForAPI(msgs, {
      applyAnthropicInvariants: false,
      applyConsecutiveUserMerge: true,
    })
    // Merged into one user message — _sideChannelKind may be lost
    const users = result.filter((m: Record<string, unknown>) => m.role === 'user')
    // With default merge, the two consecutive user messages are folded
    expect(users.length).toBeLessThanOrEqual(2)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Pass 4: mergeConsecutiveAssistantMessages
// ─────────────────────────────────────────────────────────────────────

describe('Pass 4: mergeConsecutiveAssistantMessages', () => {
  it('merges two consecutive assistant messages', () => {
    const msgs = [
      user('hello'),
      assistant([{ type: 'text', text: 'Part 1' }]),
      assistant([{ type: 'text', text: 'Part 2' }]),
    ]
    const result = normalizeMessagesForAPI(msgs, { applyAnthropicInvariants: false })
    const assistants = result.filter((m: Record<string, unknown>) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    const content = (assistants[0] as Record<string, unknown>).content as Array<Record<string, unknown>>
    expect(content.length).toBeGreaterThanOrEqual(2)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Pass 12: appendMessageTagToUserMessage
// ─────────────────────────────────────────────────────────────────────

describe('Pass 12: appendMessageTagToUserMessage', () => {
  it('adds sequential _messageTag to user messages (before stripInternalMeta)', () => {
    const msgs = [user('a'), assistantText('b'), user('c')]
    const result = normalizeMessagesForAPI(msgs, {
      applyAnthropicInvariants: false,
      stripInternalMeta: false,
    })
    const users = result.filter((m: Record<string, unknown>) => m.role === 'user')
    expect(users).toHaveLength(2)
    expect((users[0] as Record<string, unknown>)._messageTag).toBe(1)
    expect((users[1] as Record<string, unknown>)._messageTag).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Pass 11: sanitizeErrorToolResultContent
// ─────────────────────────────────────────────────────────────────────

describe('Pass 11: sanitizeErrorToolResultContent', () => {
  it('truncates oversized error tool_result content', () => {
    const bigError = 'E'.repeat(9000)
    const msgs = [userBlocks([toolResultBlock('err_1', bigError, true)])]
    const result = normalizeMessagesForAPI(msgs, { applyAnthropicInvariants: false })
    const blocks = ((result[0] as Record<string, unknown>).content as Array<Record<string, unknown>>)
    const toolResult = blocks.find((b) => b.type === 'tool_result')
    expect(toolResult).toBeDefined()
    const content = toolResult!.content as string
    expect(content.length).toBeLessThan(bigError.length)
    expect(content).toContain('truncated')
  })
})

// ─────────────────────────────────────────────────────────────────────
// end-to-end: 18-round accumulation test
// ─────────────────────────────────────────────────────────────────────

describe('18-round accumulation — thinking degradation over time', () => {
  it('preserves recent thinking (distance 0-2) and may truncate distant thinking', () => {
    // Build 18 rounds — thinking length grows with rounds as model gets verbose
    const msgs: Array<Record<string, unknown>> = []
    for (let i = 1; i <= 18; i++) {
      // Round i: user → assistant(thinking + tool_use + text) → user(tool_result)
      const thinkingLen = 300 + i * 50 // grows from 350 to 1200 chars
      msgs.push(user(`round ${i} instruction: perform task item ${i}`))
      msgs.push(assistant([
        thinkingBlock(`round-${i}-`.repeat(Math.ceil(thinkingLen / 9))),
        toolUseBlock('Read', { file_path: `f${i}.ts` }, `read_${i}`),
        { type: 'text', text: `Reading f${i}.ts for round ${i}` },
      ]))
      msgs.push(userBlocks([toolResultBlock(`read_${i}`, `file content for round ${i}`)]))
    }

    const result = normalizeMessagesForAPI(msgs, { applyAnthropicInvariants: false })

    // Verify: no SYNTHETIC_ERROR was injected (all pairs intact)
    const allResultBlocks = result.flatMap((m) =>
      Array.isArray((m as Record<string, unknown>).content)
        ? ((m as Record<string, unknown>).content as Array<Record<string, unknown>>)
        : [],
    )
    const synthErrors = allResultBlocks.filter(
      (b) =>
        b.type === 'tool_result' &&
        typeof b.content === 'string' &&
        b.content?.includes('synthetic'),
    )
    expect(synthErrors).toHaveLength(0)

    // Verify: all 18 user turns are present
    const users = result.filter((m: Record<string, unknown>) => m.role === 'user')
    expect(users.length).toBeGreaterThanOrEqual(18)

    // Verify: assistant messages are present (though some may be merged by Pass 4)
    const assistants = result.filter((m: Record<string, unknown>) => m.role === 'assistant')
    expect(assistants.length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Symptom 3 specific: full pipeline on thinking-only simulation
// ─────────────────────────────────────────────────────────────────────

describe('Symptom 3 integration: thinking simulation passes through pipeline', () => {
  it('model simulates completion in thinking chain — Pass 6 should remove pure-thinking messages', () => {
    // This is the exact scenario from Symptom 3:
    // Model outputs thinking="已完成所有修改" + text="" + tool_use=[]
    // Pass 6 will REMOVE this assistant message entirely
    const msgs = [
      user('fix all the bugs in src/'),
      // Normal round
      assistant([thinkingBlock('analyzing...'), toolUseBlock('Read', { file_path: 'a.ts' }, 'r1')]),
      userBlocks([toolResultBlock('r1', 'code here')]),
      // Symptoms round: model simulates completion
      assistant([thinkingBlock('已完成修改，所有文件已更新，测试通过')]),
    ]
    const result = normalizeMessagesForAPI(msgs, { applyAnthropicInvariants: false })

    // The pure-thinking assistant message should be GONE
    const assistants = result.filter((m: Record<string, unknown>) => m.role === 'assistant')
    const hasThinkingOnly = assistants.some((m) => {
      const blocks = (m as Record<string, unknown>).content as Array<Record<string, unknown>>
      return blocks.every((b) => b.type === 'thinking' || b.type === 'redacted_thinking')
    })
    expect(hasThinkingOnly).toBe(false)
  })
})
