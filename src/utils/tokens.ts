/**
 * Token Counting Utilities
 *
 * Estimates token counts for messages and content.
 * Uses a simple heuristic: ~4 characters per token (Claude's average).
 */

import type { Message } from './messages'

const CHARS_PER_TOKEN = 4

/**
 * Estimate token count for a string.
 * Uses simple heuristic: divide character count by 4.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Estimate token count for a message.
 */
export function estimateMessageTokens(message: Message): number {
  let total = 0

  for (const content of message.content) {
    if (content.type === 'text' && content.text) {
      total += estimateTokens(content.text)
    } else if (content.type === 'tool_use') {
      total += estimateTokens(JSON.stringify(content.input || {}))
      total += estimateTokens(content.name || '')
    } else if (content.type === 'tool_result') {
      total += estimateTokens(content.content || '')
    }
  }

  return total
}

/**
 * Estimate token count for a list of messages.
 */
export function estimateConversationTokens(messages: Message[]): number {
  return messages.reduce((total, msg) => total + estimateMessageTokens(msg), 0)
}

/**
 * Check if adding a message would exceed token limit.
 */
export function wouldExceedTokenLimit(
  messages: Message[],
  newMessage: Message,
  limit: number,
): boolean {
  const currentTokens = estimateConversationTokens(messages)
  const newTokens = estimateMessageTokens(newMessage)
  return currentTokens + newTokens > limit
}
