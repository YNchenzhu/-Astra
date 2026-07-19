import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../agents/agentContext', () => ({
  getAgentContext: vi.fn(() => ({ agentId: 'main', streamConversationId: 'conv-xyz' })),
}))

import { taskCreateTool } from './TaskCreateTool'
import { taskManager } from './TaskManager'
import { getAgentContext } from '../agents/agentContext'

beforeEach(() => {
  taskManager.clear()
  vi.mocked(getAgentContext).mockReturnValue({
    agentId: 'main',
    streamConversationId: 'conv-xyz',
  } as never)
})
afterEach(() => {
  taskManager.clear()
  vi.clearAllMocks()
})

describe('TaskCreate — audit F-16/#3 conversation binding', () => {
  it('stamps the active conversationId on the created task', async () => {
    const r = await taskCreateTool.execute({ subject: 'bind me to conv' })
    expect(r.success).toBe(true)
    const created = taskManager.listTasks().find((t) => t.subject === 'bind me to conv')
    expect(created?.conversationId).toBe('conv-xyz')
  })

  it('leaves conversationId unset when there is no conversation context', async () => {
    vi.mocked(getAgentContext).mockReturnValue({ agentId: 'main' } as never)
    const r = await taskCreateTool.execute({ subject: 'no conv here' })
    expect(r.success).toBe(true)
    const created = taskManager.listTasks().find((t) => t.subject === 'no conv here')
    expect(created?.conversationId).toBeUndefined()
  })
})
