import { describe, it, expect } from 'vitest'
import {
  ALL_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  COORDINATOR_MODE_ALLOWED_TOOLS,
  IN_PROCESS_TEAMMATE_ALLOWED_TOOLS,
} from './tools'
import {
  ALL_AGENT_DISALLOWED_TOOLS as AGENTS_DISALLOWED,
  ASYNC_AGENT_ALLOWED_TOOLS as AGENTS_ASYNC,
  COORDINATOR_MODE_ALLOWED_TOOLS as AGENTS_COORD,
  IN_PROCESS_TEAMMATE_ALLOWED_TOOLS as AGENTS_TEAMMATE,
} from '../agents/types'

describe('electron/constants/tools barrel', () => {
  it('re-exports the same Set references as agents/types (no drift)', () => {
    expect(ALL_AGENT_DISALLOWED_TOOLS).toBe(AGENTS_DISALLOWED)
    expect(ASYNC_AGENT_ALLOWED_TOOLS).toBe(AGENTS_ASYNC)
    expect(IN_PROCESS_TEAMMATE_ALLOWED_TOOLS).toBe(AGENTS_TEAMMATE)
    expect(COORDINATOR_MODE_ALLOWED_TOOLS).toBe(AGENTS_COORD)
  })

  it('teammate allowlist includes registered OC-style task tool names', () => {
    expect(IN_PROCESS_TEAMMATE_ALLOWED_TOOLS.has('TaskCreate')).toBe(true)
    expect(IN_PROCESS_TEAMMATE_ALLOWED_TOOLS.has('TaskGet')).toBe(true)
  })
})
