import { describe, it, expect } from 'vitest'
import {
  buildPostCompactFileHintUserMessage,
  extractLikelyFilePathsFromMessages,
} from './postCompactFileHints'

describe('postCompactFileHints', () => {
  it('extracts paths from tool_result JSON strings', () => {
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: '1', content: '{"path":"g:/a/b.ts"}' }],
      },
    ]
    expect(extractLikelyFilePathsFromMessages(messages)).toEqual(['g:/a/b.ts'])
  })

  it('buildPostCompactFileHintUserMessage returns null for empty', () => {
    expect(buildPostCompactFileHintUserMessage([])).toBeNull()
  })
})
