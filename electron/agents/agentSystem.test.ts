import { describe, it, expect } from 'vitest'
import {
  ALL_AGENT_DISALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  COORDINATOR_MODE_ALLOWED_TOOLS,
  COORDINATOR_OC_CORE_TOOL_NAMES,
  getCoordinatorModeAllowedToolNames,
  buildTaskNotificationXml,
  type AgentNotification,
} from './types'
import { getBuiltInAgents } from './builtInAgents'

describe('Agent types and constants', () => {
  describe('tool filtering constants', () => {
    it('ALL_AGENT_DISALLOWED_TOOLS should contain interactive tools', () => {
      expect(ALL_AGENT_DISALLOWED_TOOLS.has('EnterPlanMode')).toBe(true)
      expect(ALL_AGENT_DISALLOWED_TOOLS.has('ExitPlanMode')).toBe(true)
      expect(ALL_AGENT_DISALLOWED_TOOLS.has('AskUserQuestion')).toBe(true)
      expect(ALL_AGENT_DISALLOWED_TOOLS.has('TaskOutput')).toBe(true)
      expect(ALL_AGENT_DISALLOWED_TOOLS.has('TaskStop')).toBe(true)
      expect(ALL_AGENT_DISALLOWED_TOOLS.has('Agent')).toBe(true)
    })

    it('CUSTOM_AGENT_DISALLOWED_TOOLS should be superset of ALL', () => {
      for (const tool of ALL_AGENT_DISALLOWED_TOOLS) {
        expect(CUSTOM_AGENT_DISALLOWED_TOOLS.has(tool)).toBe(true)
      }
    })

    it('ASYNC_AGENT_ALLOWED_TOOLS should include core file tools (OpenClaude + legacy names)', () => {
      expect(ASYNC_AGENT_ALLOWED_TOOLS.has('Read')).toBe(true)
      expect(ASYNC_AGENT_ALLOWED_TOOLS.has('read_file')).toBe(true)
      expect(ASYNC_AGENT_ALLOWED_TOOLS.has('Write')).toBe(true)
      expect(ASYNC_AGENT_ALLOWED_TOOLS.has('write_file')).toBe(true)
      expect(ASYNC_AGENT_ALLOWED_TOOLS.has('Edit')).toBe(true)
      expect(ASYNC_AGENT_ALLOWED_TOOLS.has('edit_file')).toBe(true)
      expect(ASYNC_AGENT_ALLOWED_TOOLS.has('Glob')).toBe(true)
      expect(ASYNC_AGENT_ALLOWED_TOOLS.has('glob')).toBe(true)
      expect(ASYNC_AGENT_ALLOWED_TOOLS.has('Grep')).toBe(true)
      expect(ASYNC_AGENT_ALLOWED_TOOLS.has('grep')).toBe(true)
      expect(ASYNC_AGENT_ALLOWED_TOOLS.has('Bash')).toBe(true)
      expect(ASYNC_AGENT_ALLOWED_TOOLS.has('bash')).toBe(true)
      expect(ASYNC_AGENT_ALLOWED_TOOLS.has('MemdirScan')).toBe(true)
      expect(ASYNC_AGENT_ALLOWED_TOOLS.has('TaskOutput')).toBe(false)
    })

    it('COORDINATOR default allowlist includes OC core + extensions', () => {
      expect(COORDINATOR_MODE_ALLOWED_TOOLS.has('Agent')).toBe(true)
      expect(COORDINATOR_MODE_ALLOWED_TOOLS.has('SendMessage')).toBe(true)
      expect(COORDINATOR_MODE_ALLOWED_TOOLS.has('TaskOutput')).toBe(true)
      expect(COORDINATOR_MODE_ALLOWED_TOOLS.has('TeamStatus')).toBe(true)
      expect(COORDINATOR_MODE_ALLOWED_TOOLS.has('TaskStop')).toBe(true)
      expect(COORDINATOR_OC_CORE_TOOL_NAMES).toContain('TaskOutput')
      expect(getCoordinatorModeAllowedToolNames().length).toBeGreaterThanOrEqual(
        COORDINATOR_OC_CORE_TOOL_NAMES.length,
      )
    })
  })

  describe('buildTaskNotificationXml', () => {
    it('should produce valid XML for completed agent', () => {
      const notification: AgentNotification = {
        agentId: 'agent-123',
        agentType: 'Explore',
        description: 'Search for auth code',
        status: 'completed',
        summary: 'Found 5 auth-related files',
        result: {
          success: true,
          agentId: 'agent-123',
          agentType: 'Explore',
          output: 'Found files: auth.ts, login.ts, session.ts, middleware.ts, types.ts',
          totalTokens: 5000,
          totalToolUses: 8,
          totalDurationMs: 12000,
        },
      }

      const xml = buildTaskNotificationXml(notification)
      expect(xml).toContain('<task-notification>')
      expect(xml).toContain('<task_id>agent-123</task_id>')
      expect(xml).toContain('<status>completed</status>')
      expect(xml).toContain('<summary>Found 5 auth-related files</summary>')
      expect(xml).toContain('<result>')
      expect(xml).toContain('<total_tokens>5000</total_tokens>')
      expect(xml).toContain('</task-notification>')
    })

    it('should handle failed agent without result', () => {
      const notification: AgentNotification = {
        agentId: 'agent-456',
        agentType: 'Debug',
        description: 'Fix auth bug',
        status: 'failed',
        summary: 'Agent failed due to timeout',
      }

      const xml = buildTaskNotificationXml(notification)
      expect(xml).toContain('<status>failed</status>')
      expect(xml).not.toContain('<result>')
      expect(xml).not.toContain('<usage>')
    })
  })

  describe('built-in agents', () => {
    const agents = getBuiltInAgents()

    it('should have at least 8 built-in agents (report §2.4 + Coordinator/Debug)', () => {
      expect(agents.length).toBeGreaterThanOrEqual(8)
    })

    it('should include all expected agent types', () => {
      const types = agents.map(a => a.agentType)
      expect(types).toContain('general-purpose')
      expect(types).toContain('fork')
      expect(types).toContain('Explore')
      expect(types).toContain('Plan')
      expect(types).toContain('Coordinator')
      expect(types).toContain('Debug')
      expect(types).toContain('Verification')
      expect(types).toContain('statusline-setup')
      expect(types).toContain('claude-code-guide')
    })

    it('Explore should be read-only with correct disallowed tools (registry primary names)', () => {
      const explore = agents.find(a => a.agentType === 'Explore')!
      expect(explore.isReadOnly).toBe(true)
      expect(explore.disallowedTools).toContain('Write')
      expect(explore.disallowedTools).toContain('Edit')
      expect(explore.disallowedTools).toContain('Agent')
      expect(explore.disallowedTools).toContain('SendMessage')
      expect(explore.disallowedTools).toContain('TeamCreate')
    })

    it('Plan should be read-only', () => {
      const plan = agents.find(a => a.agentType === 'Plan')!
      expect(plan.isReadOnly).toBe(true)
    })

    it('Coordinator should have orchestration tools', () => {
      const coord = agents.find(a => a.agentType === 'Coordinator')!
      expect(coord.tools).toContain('Agent')
      expect(coord.tools).toContain('SendMessage')
      expect(coord.tools).toContain('TeamStatus')
      expect(coord.tools).toContain('TaskStop')
      expect(coord.tools).toContain('Read')
      expect(coord.tools).toContain('Grep')
      expect(coord.tools).toContain('Glob')
    })

    it('core built-in agents use maxTurns 150; guide agents use shorter budgets', () => {
      const core = new Set([
        'general-purpose',
        'Explore',
        'Plan',
        'Coordinator',
        'Debug',
        'Verification',
      ])
      for (const agent of agents) {
        if (core.has(agent.agentType)) {
          expect(agent.maxTurns).toBe(150)
        }
      }
      expect(agents.find(a => a.agentType === 'statusline-setup')?.maxTurns).toBe(80)
      expect(agents.find(a => a.agentType === 'claude-code-guide')?.maxTurns).toBe(100)
    })

    it('Verification should be read-only and default foreground (not background)', () => {
      const verify = agents.find(a => a.agentType === 'Verification')!
      expect(verify.isReadOnly).toBe(true)
      expect(verify.background).not.toBe(true)
      expect(verify.criticalReminder).toBeTruthy()
    })

    it('all agents should have getSystemPrompt', () => {
      for (const agent of agents) {
        expect(typeof agent.getSystemPrompt).toBe('function')
        const prompt = agent.getSystemPrompt()
        expect(prompt.length).toBeGreaterThan(50)
      }
    })

    it('all agents should have color', () => {
      // Internal / non-user-selectable agents do not surface in the agent
      // picker and therefore don't need a UI color:
      //   - general-purpose: legacy default; colorless by design.
      //   - session-memory-internal: host-only sandbox (see
      //     SESSION_MEMORY_INTERNAL_AGENT.whenToUse — "Internal host use
      //     only — not user-selectable").
      const NO_COLOR_REQUIRED = new Set(['general-purpose', 'session-memory-internal'])
      for (const agent of agents) {
        if (!NO_COLOR_REQUIRED.has(agent.agentType)) {
          expect(agent.color).toBeTruthy()
        }
      }
    })

    it('fork built-in uses 200 maxTurns (§3.3)', () => {
      expect(agents.find((a) => a.agentType === 'fork')?.maxTurns).toBe(200)
    })
  })
})
