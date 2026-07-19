import { describe, it, expect } from 'vitest'
import {
  createAgentTool,
  emitSubAgentStreamEvent,
  normalizeAgentToolInput,
} from './agentTool'
import { validateRequiredStringFields } from '../tools/toolValidateCommon'
import { taskRuntimeStore } from '../tools/TaskRuntimeStore'
import { asAgentId } from '../tools/ids'
import type { AgentDefinitionUnion, SubAgentEvent } from './types'

describe('normalizeAgentToolInput', () => {
  it('fills description from first line of prompt when description missing', () => {
    const input: Record<string, unknown> = {
      prompt: 'Line one title\n\nMore body',
      subagent_type: 'Explore',
    }
    normalizeAgentToolInput(input)
    expect(input.description).toBe('Line one title')
    expect(input.prompt).toBe('Line one title\n\nMore body')
  })

  it('maps task to prompt and derives description', () => {
    const input: Record<string, unknown> = {
      task: 'Do the thing',
      subagent_type: 'general-purpose',
    }
    normalizeAgentToolInput(input)
    expect(input.prompt).toBe('Do the thing')
    expect(input.description).toBe('Do the thing')
  })

  it('keeps explicit description and separate prompt', () => {
    const input: Record<string, unknown> = {
      description: 'Short label',
      prompt: 'Long instructions here',
    }
    normalizeAgentToolInput(input)
    expect(input.description).toBe('Short label')
    expect(input.prompt).toBe('Long instructions here')
  })

  it('passes validateRequiredStringFields after normalization', async () => {
    const input: Record<string, unknown> = { task: 'Only task field' }
    normalizeAgentToolInput(input)
    const v = await validateRequiredStringFields('description', 'prompt')(input)
    expect(v).toEqual({ valid: true })
  })

  it('appends thoroughness to prompt and removes key', () => {
    const input: Record<string, unknown> = {
      prompt: 'Find all API routes',
      thoroughness: 'very thorough',
    }
    normalizeAgentToolInput(input)
    expect(input.prompt).toContain('[Thoroughness: very thorough]')
    expect(input.thoroughness).toBeUndefined()
  })

  it('Explore + name only: derives description from prompt first line (no description field)', () => {
    const promptFirstLine = '探索项目 G:\\workspace-code\\projects\\cc-haha-main 的完整架构，我需要以下信息：'
    const input: Record<string, unknown> = {
      prompt: `${promptFirstLine}\n\n1. 项目入口\n2. 更多…`,
      subagent_type: 'Explore',
      name: 'explore-full-architecture',
    }
    normalizeAgentToolInput(input)
    expect(input.description).toBe(promptFirstLine)
    expect(typeof input.prompt).toBe('string')
    expect((input.prompt as string).includes('1. 项目入口')).toBe(true)
  })
})

describe('createAgentTool', () => {
  it('declares maxResultChars >= SUBAGENT_OUTPUT_FALLBACK_MAX_CHARS so sub-agent output survives the size budget', () => {
    // Regression guard: without this override the registry default
    // (DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000) clamps a JSON-wrapped
    // sub-agent payload to a 2k preview, dropping ~96% of the reported
    // output. The override must leave headroom for the SubAgentResult
    // JSON wrapper (success/agentId/totalTokens/...) on top of the
    // 80_000-char inner output cap.
    const noAgents: AgentDefinitionUnion[] = []
    const tool = createAgentTool(() => noAgents)
    expect(tool.maxResultChars).toBeGreaterThanOrEqual(80_000 + 10_000)
  })
})

describe('emitSubAgentStreamEvent → taskRuntimeStore live readback', () => {
  // Regression guard: previously a `subagent_text` delta only updated the
  // ActiveAgent's `latestTextOutput` buffer (a renderer-side concern), so
  // calling `TaskOutput` against the parent tool_use id while the sub-agent
  // was still streaming returned only the initial "Tool start: Agent" meta
  // chunk. The user-visible symptom was "TaskOutput shows only summary"
  // even though the sub-agent had emitted a long detailed report.
  it('streams subagent_text deltas into the parent tool_use record via the linkAlias mapping', () => {
    const agentId = asAgentId(`test-agent-${Date.now()}`)
    const parentToolUseId = `parent-tooluse-${Date.now()}`
    taskRuntimeStore.start(parentToolUseId, 'agent')
    taskRuntimeStore.linkAlias(agentId, parentToolUseId)

    try {
      const event: SubAgentEvent = {
        type: 'subagent_text',
        agentId,
        text: 'Hello from sub-agent — line 1\n',
      }
      emitSubAgentStreamEvent(event)
      emitSubAgentStreamEvent({
        type: 'subagent_text',
        agentId,
        text: 'and line 2.\n',
      })

      const slice = taskRuntimeStore.getSlice(parentToolUseId, 0, 100)
      expect(slice).not.toBeNull()
      const textChunks = slice!.items.filter((c) => c.stream === 'text')
      const joined = textChunks.map((c) => c.text).join('')
      expect(joined).toBe('Hello from sub-agent — line 1\nand line 2.\n')
    } finally {
      taskRuntimeStore.unlinkAlias(agentId)
      taskRuntimeStore.removeRecord(parentToolUseId)
    }
  })

  it('is a no-op when the agentId has no alias / no record (defensive)', () => {
    const orphanId = asAgentId(`orphan-${Date.now()}`)
    expect(() =>
      emitSubAgentStreamEvent({
        type: 'subagent_text',
        agentId: orphanId,
        text: 'text without a parent record',
      }),
    ).not.toThrow()
    // Cleanup the auto-created `kind: 'other'` record that taskRuntimeStore.append
    // creates on first write so subsequent tests start clean.
    taskRuntimeStore.removeRecord(orphanId)
  })
})
