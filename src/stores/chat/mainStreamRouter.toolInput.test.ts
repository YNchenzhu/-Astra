/**
 * `tool_input_delta` (Cursor-3-style live argument writing) + the
 * `stopToolTask` placeholder-convergence path.
 *
 * Split out of the original monolithic `handleMainStreamEvent.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../services/electronAPI', async () => {
  const m = await import('./mainStreamRouter.testMocks')
  return m.electronApiMock()
})
vi.mock('../useSettingsStore', async () => {
  const m = await import('./mainStreamRouter.testMocks')
  return m.settingsStoreMock()
})
vi.mock('../useFileStore', async () => {
  const m = await import('./mainStreamRouter.testMocks')
  return m.fileStoreMock()
})
vi.mock('../useWorkspaceStore', async () => {
  const m = await import('./mainStreamRouter.testMocks')
  return m.workspaceStoreMock()
})
vi.mock('../useBuddyStore', async () => {
  const m = await import('./mainStreamRouter.testMocks')
  return m.buddyStoreMock()
})

import type { ChatMessage, StreamEvent } from '../../types'
import { handleMainStreamEvent, useChatStore } from './storeCompose'
import { pendingAssistantByConversation } from './sessionSlice'
import { flushPendingDeltasNow } from './streamingDeltaBatcher'
import { flushPendingToolInputsNow } from './toolInputDeltaBatcher'
import {
  CONV_ID,
  ASSISTANT_ID,
  TOOL_USE_ID,
  installAssistant,
  getFirstToolUse,
  resetChatStoreState,
  flushAndClearPending,
} from './mainStreamRouter.testHelpers'

beforeEach(() => {
  resetChatStoreState()
})

afterEach(() => {
  flushAndClearPending()
})

// --- tool_input_delta + placeholder 收敛 ------------------------------------

describe('handleMainStreamEvent: tool_input_delta (Cursor 3-style live writing)', () => {
  const STREAMING_TOOL_USE_ID = 'tool-streaming-1'

  function installEmptyAssistant(): void {
    const message: ChatMessage = {
      id: ASSISTANT_ID,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      blocks: [],
      toolUses: [],
    }
    useChatStore.setState({
      currentConversationId: CONV_ID,
      messages: [message],
      sessionBuffers: {
        [CONV_ID]: {
          messages: [message],
          todos: [],
          isTyping: true,
          pendingPermissionRequest: null,
          pendingAskUserQuestion: null,
          pendingTeamPlanApproval: null,
          pendingPlanApproval: null,
        },
      },
      isTyping: true,
    })
    pendingAssistantByConversation.set(CONV_ID, ASSISTANT_ID)
  }

  it('creates a placeholder tool_use + streamingInput when no entry exists', () => {
    installEmptyAssistant()

    handleMainStreamEvent({
      type: 'tool_input_delta',
      conversationId: CONV_ID,
      toolUseId: STREAMING_TOOL_USE_ID,
      toolName: 'write_file',
      partialJson: '{"filePath":"a.ts","content":"hel',
    } as unknown as StreamEvent)

    const m = useChatStore.getState().messages[0]
    expect(m.blocks?.[0]).toMatchObject({
      type: 'tool_use',
      id: STREAMING_TOOL_USE_ID,
      name: 'write_file',
      status: 'running',
    })
    expect(m.toolUses?.[0]).toMatchObject({
      id: STREAMING_TOOL_USE_ID,
      name: 'write_file',
      status: 'running',
      streamingInput: { partialJson: '{"filePath":"a.ts","content":"hel' },
    })
  })

  it('updates streamingInput on subsequent deltas without duplicating blocks', () => {
    installEmptyAssistant()

    // First delta seeds the placeholder synchronously.
    handleMainStreamEvent({
      type: 'tool_input_delta',
      conversationId: CONV_ID,
      toolUseId: STREAMING_TOOL_USE_ID,
      toolName: 'write_file',
      partialJson: '{"filePath":"a.ts","content":"h',
    } as unknown as StreamEvent)
    // Subsequent delta is coalesced into the rAF batcher; flush to observe it.
    handleMainStreamEvent({
      type: 'tool_input_delta',
      conversationId: CONV_ID,
      toolUseId: STREAMING_TOOL_USE_ID,
      toolName: 'write_file',
      partialJson: '{"filePath":"a.ts","content":"hello"}',
    } as unknown as StreamEvent)
    flushPendingToolInputsNow()

    const m = useChatStore.getState().messages[0]
    expect(m.blocks?.filter((b) => b.type === 'tool_use')).toHaveLength(1)
    expect(m.toolUses).toHaveLength(1)
    expect(m.toolUses?.[0].streamingInput?.partialJson).toBe(
      '{"filePath":"a.ts","content":"hello"}',
    )
  })

  it('coalesces subsequent deltas (batched, not applied until flush)', () => {
    installEmptyAssistant()

    handleMainStreamEvent({
      type: 'tool_input_delta',
      conversationId: CONV_ID,
      toolUseId: STREAMING_TOOL_USE_ID,
      toolName: 'write_file',
      partialJson: '{"a":1',
    } as unknown as StreamEvent)
    // First delta is synchronous.
    expect(
      useChatStore.getState().messages[0]?.toolUses?.[0]?.streamingInput?.partialJson,
    ).toBe('{"a":1')

    // Two more deltas: both batched (latest-wins), not yet visible.
    handleMainStreamEvent({
      type: 'tool_input_delta',
      conversationId: CONV_ID,
      toolUseId: STREAMING_TOOL_USE_ID,
      toolName: 'write_file',
      partialJson: '{"a":1,"b":2',
    } as unknown as StreamEvent)
    handleMainStreamEvent({
      type: 'tool_input_delta',
      conversationId: CONV_ID,
      toolUseId: STREAMING_TOOL_USE_ID,
      toolName: 'write_file',
      partialJson: '{"a":1,"b":2,"c":3}',
    } as unknown as StreamEvent)
    expect(
      useChatStore.getState().messages[0]?.toolUses?.[0]?.streamingInput?.partialJson,
    ).toBe('{"a":1')

    flushPendingToolInputsNow()
    expect(
      useChatStore.getState().messages[0]?.toolUses?.[0]?.streamingInput?.partialJson,
    ).toBe('{"a":1,"b":2,"c":3}')
  })

  // Regression: a late tool_input_delta arriving AFTER tool_start (which
  // cleared streamingInput) must NOT resurrect the streaming caret via the
  // batched path. Guard: applyToolInputBatch skips entries whose
  // streamingInput is already null (authoritative).
  it('does not resurrect streamingInput when a delta lands after tool_start', () => {
    installEmptyAssistant()

    handleMainStreamEvent({
      type: 'tool_input_delta',
      conversationId: CONV_ID,
      toolUseId: STREAMING_TOOL_USE_ID,
      toolName: 'write_file',
      partialJson: '{"filePath":"a.ts"',
    } as unknown as StreamEvent)
    handleMainStreamEvent({
      type: 'tool_start',
      conversationId: CONV_ID,
      toolUse: { id: STREAMING_TOOL_USE_ID, name: 'write_file', input: { filePath: 'a.ts' } },
    } as unknown as StreamEvent)
    // Late delta — placeholder block exists, so it takes the batched path.
    handleMainStreamEvent({
      type: 'tool_input_delta',
      conversationId: CONV_ID,
      toolUseId: STREAMING_TOOL_USE_ID,
      toolName: 'write_file',
      partialJson: '{"filePath":"a.ts","content":"x',
    } as unknown as StreamEvent)
    flushPendingToolInputsNow()

    const tu = useChatStore.getState().messages[0]?.toolUses?.[0]
    expect(tu?.streamingInput).toBeUndefined()
    expect(tu?.status).toBe('running')
  })

  // Regression: a pending batched delta must NOT advance streamingInput on a
  // message that has been finalized (isStreaming=false, e.g. user cancel).
  it('drops batched tool-input writes after the message is finalized', () => {
    installEmptyAssistant()

    handleMainStreamEvent({
      type: 'tool_input_delta',
      conversationId: CONV_ID,
      toolUseId: STREAMING_TOOL_USE_ID,
      toolName: 'write_file',
      partialJson: '{"a":1',
    } as unknown as StreamEvent)
    handleMainStreamEvent({
      type: 'tool_input_delta',
      conversationId: CONV_ID,
      toolUseId: STREAMING_TOOL_USE_ID,
      toolName: 'write_file',
      partialJson: '{"a":1,"b":2}',
    } as unknown as StreamEvent)

    // Simulate cancel/finalize WITHOUT flushing (the bug scenario): flip
    // isStreaming on both the live messages and the session buffer the patch
    // reads from.
    useChatStore.setState((s) => {
      const flip = (msgs: ChatMessage[]) => msgs.map((m) => ({ ...m, isStreaming: false }))
      return {
        messages: flip(s.messages),
        sessionBuffers: {
          ...s.sessionBuffers,
          [CONV_ID]: {
            ...s.sessionBuffers[CONV_ID],
            messages: flip(s.sessionBuffers[CONV_ID].messages),
          },
        },
      }
    })

    flushPendingToolInputsNow()

    // Guard skipped the finalized message — streamingInput stays at the
    // last synchronously-applied value, not the batched second one.
    const tu = useChatStore.getState().messages[0]?.toolUses?.[0]
    expect(tu?.streamingInput?.partialJson).toBe('{"a":1')
  })

  it('drops streamingInput when tool_start arrives with the canonical input', () => {
    installEmptyAssistant()

    handleMainStreamEvent({
      type: 'tool_input_delta',
      conversationId: CONV_ID,
      toolUseId: STREAMING_TOOL_USE_ID,
      toolName: 'write_file',
      partialJson: '{"filePath":"a.ts","content":"hello"}',
    } as unknown as StreamEvent)
    handleMainStreamEvent({
      type: 'tool_start',
      conversationId: CONV_ID,
      toolUse: {
        id: STREAMING_TOOL_USE_ID,
        name: 'write_file',
        input: { filePath: 'a.ts', content: 'hello' },
      },
    } as unknown as StreamEvent)

    const tu = useChatStore.getState().messages[0]?.toolUses?.[0]
    expect(tu?.input).toEqual({ filePath: 'a.ts', content: 'hello' })
    expect(tu?.streamingInput).toBeUndefined()
  })

  it('converges a placeholder to "error" + clears streamingInput on `error` event', () => {
    installEmptyAssistant()

    handleMainStreamEvent({
      type: 'tool_input_delta',
      conversationId: CONV_ID,
      toolUseId: STREAMING_TOOL_USE_ID,
      toolName: 'write_file',
      partialJson: '{"filePath":"a.ts","content":"hal',
    } as unknown as StreamEvent)
    handleMainStreamEvent({
      type: 'error',
      conversationId: CONV_ID,
      error: 'network refused',
    } as unknown as StreamEvent)

    const m = useChatStore.getState().messages[0]
    const tu = m.toolUses?.[0]
    expect(tu?.status).toBe('error')
    expect(tu?.streamingInput).toBeUndefined()
    const block = m.blocks?.find((b) => b.type === 'tool_use')
    expect(block && block.type === 'tool_use' ? block.status : null).toBe('error')
  })

  it('converges a placeholder to "stopped" + clears streamingInput on `message_stop`', () => {
    installEmptyAssistant()

    handleMainStreamEvent({
      type: 'tool_input_delta',
      conversationId: CONV_ID,
      toolUseId: STREAMING_TOOL_USE_ID,
      toolName: 'write_file',
      partialJson: '{"filePath":"a.ts","content":"hal',
    } as unknown as StreamEvent)
    handleMainStreamEvent({
      type: 'message_stop',
      conversationId: CONV_ID,
    } as unknown as StreamEvent)

    const tu = useChatStore.getState().messages[0]?.toolUses?.[0]
    expect(tu?.status).toBe('stopped')
    expect(tu?.streamingInput).toBeUndefined()
  })

  it('leaves real running tools (no streamingInput) alone on `error`', () => {
    // Seed an assistant that already has a real running tool (from
    // tool_start) — `error` should NOT mark it as error since the
    // agentic loop's tool_result path is the right place to surface
    // that. Only placeholders (with streamingInput) get converged here.
    installAssistant()

    handleMainStreamEvent({
      type: 'error',
      conversationId: CONV_ID,
      error: 'boom',
    } as unknown as StreamEvent)

    const tu = getFirstToolUse()
    // Pre-existing tool kept its original status (no false-positive 'error')
    expect(tu?.status).toBe('running')
    expect(tu?.streamingInput).toBeUndefined()
  })

  it('clears streamingInput on tool_result even if tool_start never arrived', () => {
    installEmptyAssistant()

    handleMainStreamEvent({
      type: 'tool_input_delta',
      conversationId: CONV_ID,
      toolUseId: STREAMING_TOOL_USE_ID,
      toolName: 'write_file',
      partialJson: '{"filePath":"a.ts","content":"hello"}',
    } as unknown as StreamEvent)
    handleMainStreamEvent({
      type: 'tool_result',
      conversationId: CONV_ID,
      toolResult: {
        id: STREAMING_TOOL_USE_ID,
        name: 'write_file',
        success: true,
        output: 'wrote 1 line to a.ts',
      },
    } as unknown as StreamEvent)

    const tu = useChatStore.getState().messages[0]?.toolUses?.[0]
    expect(tu?.streamingInput).toBeUndefined()
    expect(tu?.status).toBe('completed')
    expect(tu?.result).toBe('wrote 1 line to a.ts')
  })

  // Regression: preamble text emitted by the model BEFORE a tool_use call
  // (e.g. "I'll write the formatted list to a txt file...") was rendered
  // BELOW the Write tool's OUTPUT card because the streaming-delta batcher
  // hadn't flushed by the time the first `tool_input_delta` arrived. The
  // tool_use boundary then got pushed to `blocks` first, and the later
  // flushed text deltas couldn't merge back across the boundary.
  // See `mainStreamRouter.ts` `case 'tool_input_delta'`.
  it('preserves preamble text BEFORE the tool placeholder when text was streamed first', () => {
    installEmptyAssistant()

    handleMainStreamEvent({
      type: 'text_delta',
      conversationId: CONV_ID,
      text: '根据对照表，准备写入 txt 文件。',
    } as unknown as StreamEvent)
    handleMainStreamEvent({
      type: 'tool_input_delta',
      conversationId: CONV_ID,
      toolUseId: STREAMING_TOOL_USE_ID,
      toolName: 'write_file',
      partialJson: '{"filePath":"a.txt","content":"hel',
    } as unknown as StreamEvent)

    const blocks = useChatStore.getState().messages[0]?.blocks ?? []
    expect(blocks.length).toBeGreaterThanOrEqual(2)
    expect(blocks[0]).toMatchObject({
      type: 'text',
      text: '根据对照表，准备写入 txt 文件。',
    })
    expect(blocks[1]).toMatchObject({
      type: 'tool_use',
      id: STREAMING_TOOL_USE_ID,
      name: 'write_file',
      status: 'running',
    })
  })

  // Companion: subsequent `tool_input_delta` events for the same tool id
  // must NOT force a flush (perf — Write/Edit args streaming would defeat
  // the rAF batcher otherwise). New text between deltas stays queued.
  it('does not force-flush text on subsequent tool_input_delta for the same tool id', () => {
    installEmptyAssistant()

    handleMainStreamEvent({
      type: 'tool_input_delta',
      conversationId: CONV_ID,
      toolUseId: STREAMING_TOOL_USE_ID,
      toolName: 'write_file',
      partialJson: '{"filePath":"a.txt","content":"h',
    } as unknown as StreamEvent)
    handleMainStreamEvent({
      type: 'text_delta',
      conversationId: CONV_ID,
      text: 'mid-stream chatter',
    } as unknown as StreamEvent)
    handleMainStreamEvent({
      type: 'tool_input_delta',
      conversationId: CONV_ID,
      toolUseId: STREAMING_TOOL_USE_ID,
      toolName: 'write_file',
      partialJson: '{"filePath":"a.txt","content":"hello"}',
    } as unknown as StreamEvent)

    const before = useChatStore.getState().messages[0]?.blocks ?? []
    expect(before.some((b) => b.type === 'text')).toBe(false)

    flushPendingDeltasNow()
    const after = useChatStore.getState().messages[0]?.blocks ?? []
    expect(after.some((b) => b.type === 'text' && b.text === 'mid-stream chatter')).toBe(true)
  })
})

// --- P1-6: stopToolTask placeholder convergence ---------------------------

describe('stopToolTask: placeholder local convergence', () => {
  const PLACEHOLDER_ID = 'tool-placeholder-1'

  function installAssistantWithPlaceholder(): void {
    const message: ChatMessage = {
      id: ASSISTANT_ID,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      blocks: [
        {
          type: 'tool_use',
          id: PLACEHOLDER_ID,
          name: 'write_file',
          input: {} as Record<string, unknown>,
          status: 'running',
        },
      ],
      toolUses: [
        {
          id: PLACEHOLDER_ID,
          name: 'write_file',
          input: {} as Record<string, unknown>,
          status: 'running',
          streamingInput: { partialJson: '{"filePath":"a.ts","content":"hel' },
        },
      ],
    }
    useChatStore.setState({
      currentConversationId: CONV_ID,
      messages: [message],
      sessionBuffers: {
        [CONV_ID]: {
          messages: [message],
          todos: [],
          isTyping: true,
          pendingPermissionRequest: null,
          pendingAskUserQuestion: null,
          pendingTeamPlanApproval: null,
          pendingPlanApproval: null,
        },
      },
    })
    pendingAssistantByConversation.set(CONV_ID, ASSISTANT_ID)
  }

  it('stops a placeholder (with streamingInput) WITHOUT touching the IPC stopTask', async () => {
    installAssistantWithPlaceholder()
    // Reset the stopTask mock so we can assert it was NEVER called.
    const electronApiMod = (await import('../../services/electronAPI')) as unknown as {
      stopTask: ReturnType<typeof vi.fn>
    }
    electronApiMod.stopTask.mockClear()

    await useChatStore.getState().stopToolTask(PLACEHOLDER_ID)

    const m = useChatStore.getState().messages[0]
    const tu = m.toolUses?.[0]
    expect(tu?.status).toBe('stopped')
    expect(tu?.streamingInput).toBeUndefined()
    // Critical: IPC was bypassed because the task isn't registered yet
    // in the main-process runtime — there's nothing to "stop" there.
    expect(electronApiMod.stopTask).not.toHaveBeenCalled()
  })

  it('still goes through IPC for a real running tool (no streamingInput)', async () => {
    // Seed a regular running tool — no streamingInput. The slice should
    // hit the normal `stopTask` IPC path.
    installAssistant() // existing helper: seeds Bash tool with status 'running'
    const electronApiMod = (await import('../../services/electronAPI')) as unknown as {
      stopTask: ReturnType<typeof vi.fn>
    }
    electronApiMod.stopTask.mockClear()
    electronApiMod.stopTask.mockResolvedValueOnce({ success: true })

    await useChatStore.getState().stopToolTask(TOOL_USE_ID)

    expect(electronApiMod.stopTask).toHaveBeenCalledWith(TOOL_USE_ID)
    const tu = getFirstToolUse()
    expect(tu?.status).toBe('stopped')
  })
})
