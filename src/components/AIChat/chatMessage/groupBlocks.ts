import type { ContentBlock } from '../../../types'

/**
 * Group consecutive tool_use blocks together, leave other blocks as-is.
 * Returns an array of either single ContentBlock or ContentBlock[] (grouped tools).
 *
 * Example:
 *   [thinking, tool, tool, text, tool, tool, tool]
 *   -> [thinking, [tool, tool], text, [tool, tool, tool]]
 *
 * The grouping rule mirrors the render-time block layout in ChatMessage
 * exactly.
 */
export function groupBlocks(blocks: ContentBlock[]): Array<ContentBlock | ContentBlock[]> {
  const result: Array<ContentBlock | ContentBlock[]> = []
  let toolGroup: ContentBlock[] = []

  const flushTools = () => {
    if (toolGroup.length === 1) {
      result.push(toolGroup[0])
    } else if (toolGroup.length > 1) {
      result.push([...toolGroup])
    }
    toolGroup = []
  }

  for (const block of blocks) {
    if (block.type === 'tool_use') {
      toolGroup.push(block)
    } else {
      flushTools()
      result.push(block)
    }
  }
  flushTools()

  return result
}
