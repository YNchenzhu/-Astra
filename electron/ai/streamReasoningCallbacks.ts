import type { StreamCallbacks } from './client'
import type { StreamEvent } from './streamHandlerTypes'

type ReasoningCallbacks = Required<Pick<
  StreamCallbacks,
  | 'onThinkingDelta'
  | 'onThinkingBlock'
  | 'onRedactedThinkingBlock'
  | 'onReasoningSummaryDelta'
  | 'onReasoningSummaryBlock'
>>

export function createStreamReasoningCallbacks(
  emitStream: (event: StreamEvent) => void,
): ReasoningCallbacks {
  return {
    onThinkingDelta: (text) => {
      emitStream({ type: 'thinking_delta', text })
    },
    onThinkingBlock: (block) => {
      emitStream({
        type: 'thinking_block_complete',
        thinkingBlock: block,
      })
    },
    onRedactedThinkingBlock: (block) => {
      emitStream({
        type: 'redacted_thinking_block',
        redactedThinkingBlock: block,
      })
    },
    onReasoningSummaryDelta: (text) => {
      emitStream({ type: 'reasoning_summary_delta', text })
    },
    onReasoningSummaryBlock: (block) => {
      emitStream({
        type: 'reasoning_summary_block_complete',
        reasoningSummaryBlock: block,
      })
    },
  }
}
