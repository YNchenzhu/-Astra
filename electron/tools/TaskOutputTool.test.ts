import { describe, expect, it } from 'vitest'
import { taskOutputTool } from './TaskOutputTool'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../constants/toolLimits'

describe('TaskOutputTool', () => {
  // Regression guard: when this tool inherits the registry default
  // `DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000`, `applyToolResultSizeBudget`
  // spills the JSON-wrapped sub-agent payload (which the Agent tool already
  // raised to 100k of headroom) into a 2k preview. That defeats the whole
  // point of TaskOutput — it exists to read back already-buffered task
  // streams that may legitimately be large. Pagination via offset/limit
  // remains the caller's lever for bounded reads.
  it('declares maxResultChars well above DEFAULT_MAX_RESULT_SIZE_CHARS so large readbacks are not spilled', () => {
    expect(taskOutputTool.maxResultChars).toBeDefined()
    expect(taskOutputTool.maxResultChars!).toBeGreaterThan(DEFAULT_MAX_RESULT_SIZE_CHARS)
    // Must comfortably exceed the Agent tool cap (100k) since TaskOutput's
    // own response wraps the Agent record + headers.
    expect(taskOutputTool.maxResultChars!).toBeGreaterThanOrEqual(200_000)
  })
})
