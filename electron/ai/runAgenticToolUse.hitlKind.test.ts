/**
 * P1 audit fix regression test: HITL `kind` derivation in
 * {@link runAgenticToolUse}.
 *
 * Two distinct producers throw `InterruptForHITL`:
 *
 *   1. The deep permission gate in `runAgenticToolUseBody.ts` throws with
 *      `question = { kind: 'permission_ask', toolName, … }`.
 *   2. `AskUserQuestionTool.ts` throws with a bare
 *      `question = { questions, metadata }` and no `kind` tag.
 *
 * The previous implementation hardcoded `kind: 'ask_user_question'` for
 * BOTH, which caused permission asks to surface through the AskUserQuestion
 * UI bridge with a payload of the wrong shape (see `toolExec.ts` HITL
 * branch — it suppresses the auxiliary stream event for `permission_ask`
 * because that path has its own permission UI).
 *
 * The fix derives `kind` from `err.question.kind` with a fallback to
 * `'ask_user_question'` for legacy / unknown shapes. These tests pin the
 * mapping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const recordPendingHITLMock = vi.fn<(id: string | undefined, payload: Record<string, unknown>) => void>()
const buildPausedToolResultBlockMock = vi.fn((id: string) => ({
  type: 'tool_result',
  tool_use_id: id,
  is_error: false,
  content: '[paused]',
  _hitlPlaceholder: true,
}))

vi.mock('../orchestration/hitl', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../orchestration/hitl')
  return {
    ...actual,
    recordPendingHITL: (id: string | undefined, payload: Record<string, unknown>) =>
      recordPendingHITLMock(id, payload),
    buildPausedToolResultBlock: (id: string) => buildPausedToolResultBlockMock(id),
  }
})

const runAgenticToolUseScopedMock = vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>()
vi.mock('./runAgenticToolUseBody', () => ({
  runAgenticToolUseScoped: (params: Record<string, unknown>) => runAgenticToolUseScopedMock(params),
}))

vi.mock('../agents/agentContext', () => ({
  getAgentContext: () => ({ streamConversationId: 'conv-test' }),
}))

import { runAgenticToolUse } from './runAgenticToolUse'
import { InterruptForHITL } from '../orchestration/hitl'

const baseParams = () => ({
  toolUse: { id: 'tu_1', name: 'AnyTool', input: {} },
  signal: new AbortController().signal,
  callbacks: {
    onToolStart: vi.fn(),
    onToolResult: vi.fn(),
  },
  diffPermissionMode: 'default' as const,
  permissionDefaultMode: 'ask' as const,
  discoveryExclude: new Set<string>(),
  getInlineSkillSession: () => null,
  setInlineSkillSession: vi.fn(),
})

beforeEach(() => {
  recordPendingHITLMock.mockClear()
  buildPausedToolResultBlockMock.mockClear()
  runAgenticToolUseScopedMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runAgenticToolUse — HITL kind derivation', () => {
  it('records kind="permission_ask" when the throw payload tags itself as permission_ask', async () => {
    const permissionPayload = {
      kind: 'permission_ask' as const,
      toolName: 'Write',
      description: 'write to /etc/hosts',
    }
    runAgenticToolUseScopedMock.mockRejectedValueOnce(
      new InterruptForHITL('tu_1', permissionPayload),
    )

    const result = await runAgenticToolUse(baseParams())

    expect(buildPausedToolResultBlockMock).toHaveBeenCalledWith('tu_1')
    expect(recordPendingHITLMock).toHaveBeenCalledTimes(1)
    expect(recordPendingHITLMock).toHaveBeenCalledWith(
      'conv-test',
      expect.objectContaining({
        toolUseId: 'tu_1',
        kind: 'permission_ask',
        question: permissionPayload,
      }),
    )
    expect((result as { _hitlPlaceholder?: boolean })._hitlPlaceholder).toBe(true)
  })

  it('records kind="ask_user_question" for AskUserQuestionTool-style payloads (no kind tag)', async () => {
    const askPayload = {
      questions: [{ id: 'q1', prompt: 'pick one?' }],
      metadata: { source: 'ask_user_question' },
    }
    runAgenticToolUseScopedMock.mockRejectedValueOnce(
      new InterruptForHITL('tu_2', askPayload),
    )

    const params = baseParams()
    params.toolUse.id = 'tu_2'
    await runAgenticToolUse(params)

    expect(recordPendingHITLMock).toHaveBeenCalledTimes(1)
    expect(recordPendingHITLMock).toHaveBeenCalledWith(
      'conv-test',
      expect.objectContaining({
        toolUseId: 'tu_2',
        kind: 'ask_user_question',
        question: askPayload,
      }),
    )
  })

  it('falls back to kind="ask_user_question" when question is null', async () => {
    runAgenticToolUseScopedMock.mockRejectedValueOnce(
      new InterruptForHITL('tu_3', null),
    )

    const params = baseParams()
    params.toolUse.id = 'tu_3'
    await runAgenticToolUse(params)

    expect(recordPendingHITLMock).toHaveBeenCalledWith(
      'conv-test',
      expect.objectContaining({ kind: 'ask_user_question' }),
    )
  })

  it('falls back to kind="ask_user_question" for unknown/typo kind tags', async () => {
    runAgenticToolUseScopedMock.mockRejectedValueOnce(
      new InterruptForHITL('tu_4', { kind: 'something_else', extra: 1 }),
    )

    const params = baseParams()
    params.toolUse.id = 'tu_4'
    await runAgenticToolUse(params)

    expect(recordPendingHITLMock).toHaveBeenCalledWith(
      'conv-test',
      expect.objectContaining({ kind: 'ask_user_question' }),
    )
  })

  it('does NOT record any HITL when scoped runner throws a non-HITL error', async () => {
    runAgenticToolUseScopedMock.mockRejectedValueOnce(new Error('boom'))

    await expect(runAgenticToolUse(baseParams())).rejects.toThrow('boom')

    expect(recordPendingHITLMock).not.toHaveBeenCalled()
    expect(buildPausedToolResultBlockMock).not.toHaveBeenCalled()
  })
})
