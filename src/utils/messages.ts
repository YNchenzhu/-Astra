/**
 * Message Utilities
 *
 * Helper functions for creating and processing messages.
 */

export type MessageRole = 'user' | 'assistant'

export type MessageContent = {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
  is_error?: boolean
}

export type Message = {
  id: string
  role: MessageRole
  content: MessageContent[]
  timestamp: number
}

export function createMessage(
  role: MessageRole,
  content: MessageContent[],
): Message {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    role,
    content,
    timestamp: Date.now(),
  }
}

export function createTextMessage(role: MessageRole, text: string): Message {
  return createMessage(role, [{ type: 'text', text }])
}

export function createToolUseMessage(
  toolName: string,
  input: Record<string, unknown>,
): MessageContent {
  return {
    type: 'tool_use',
    id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    name: toolName,
    input,
  }
}

export function createToolResultMessage(
  toolUseId: string,
  content: string,
  isError: boolean = false,
): MessageContent {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    is_error: isError,
  }
}

export function extractTextContent(message: Message): string {
  return message.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text || '')
    .join('\n')
}

export function extractToolUses(message: Message) {
  return message.content.filter((c) => c.type === 'tool_use')
}

export function extractToolResults(message: Message) {
  return message.content.filter((c) => c.type === 'tool_result')
}
