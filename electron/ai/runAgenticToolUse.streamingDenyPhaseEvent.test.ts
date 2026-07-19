/**
 * Audit #5 (Patch A): the `settingsDenyAll` branch inside `runAgenticToolUseBody`
 * must emit a `permission_denied_preflight` phase event so the renderer's
 * `PreflightDenialToast` lights up in the streaming-tool-executor path.
 *
 * In the non-streaming `DefaultToolRuntimePort.preflight` path the kernel
 * already emits this event AND filters the tool out before `runAgenticToolUse`
 * sees it, so no double-emit is possible — see
 * `electron/orchestration/toolRuntime/defaultToolRuntimePort.ts:147 / :216`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { StreamEvent } from './streamHandlerTypes'

// Capture every stream event emitted to the renderer during a test run.
// Must be declared via factory because vi.mock is hoisted above imports.
const emittedEvents: StreamEvent[] = []
vi.mock('./streamHandlerRegistry', () => ({
  emitStreamEventToRenderer: (ev: StreamEvent) => {
    emittedEvents.push(ev)
  },
  // Other named exports the SUT does not use in this test, but the module
  // exports — declare as stubs so unrelated imports don't crash.
  ensureGlobalStreamEventSender: () => {},
  registerActiveMainStream: () => {},
  unregisterActiveMainStream: () => {},
  setLastQueryLoopBridge: () => {},
  lastQueryLoopBridge: null,
  queryLoopChannelsByConversation: new Map(),
  getHandleSendMessageQueryLoopIterable: () => null,
  cancelStream: () => {},
}))

import { runAgenticToolUse } from './runAgenticToolUse'
import { setPermissionMode } from './interactionState'
import {
  runWithAgentContextAsync,
  type AgentContext,
} from '../agents/agentContext'
import { asAgentId } from '../tools/ids'
import type { ProviderConfig } from './client'

function buildAgentCtx(conversationId?: string): AgentContext {
  return {
    config: { id: 'anthropic' } as unknown as ProviderConfig,
    model: 'claude',
    systemPrompt: '',
    messages: [],
    signal: new AbortController().signal,
    agentId: asAgentId('main'),
    ...(conversationId ? { streamConversationId: conversationId } : {}),
  }
}

afterEach(() => {
  emittedEvents.length = 0
  setPermissionMode('default')
  vi.restoreAllMocks()
})

describe('runAgenticToolUseBody: streaming-path settingsDenyAll emits permission_denied_preflight', () => {
  it('emits exactly one preflight-denial event with `rule-match` when a matching deny rule blocks the tool', async () => {
    await runWithAgentContextAsync(buildAgentCtx('conv-stream-deny-1'), async () => {
      await runAgenticToolUse({
        toolUse: {
          id: 'tu-deny-rule',
          name: 'read_file',
          input: { filePath: 'package.json' },
        },
        signal: new AbortController().signal,
        callbacks: { onToolStart: () => {}, onToolResult: () => {} },
        diffPermissionMode: 'default',
        permissionDefaultMode: 'ask',
        permissionRules: [{ id: 'block-read', pattern: 'read_file', mode: 'deny' }],
        discoveryExclude: new Set(),
        getInlineSkillSession: () => null,
        setInlineSkillSession: () => {},
      })
    })

    const denials = emittedEvents.filter(
      (ev) =>
        (ev as { type?: string; orchestrationPhase?: string }).type === 'orchestration_phase' &&
        (ev as { orchestrationPhase?: string }).orchestrationPhase ===
          'permission_denied_preflight',
    )
    expect(denials).toHaveLength(1)

    const denial = denials[0] as unknown as {
      conversationId?: string
      permissionDenial?: {
        toolName: string
        toolUseId: string
        reason: string
        matchedRule?: string
      }
    }
    expect(denial.conversationId).toBe('conv-stream-deny-1')
    expect(denial.permissionDenial?.toolName).toBe('read_file')
    expect(denial.permissionDenial?.toolUseId).toBe('tu-deny-rule')
    expect(denial.permissionDenial?.reason).toMatch(/Permission denied/i)
    // Rule-match path → 'rule-match'; renderer toast surfaces the marker
    // verbatim ("规则：rule-match").
    expect(denial.permissionDenial?.matchedRule).toBe('rule-match')
  })

  it('emits with `settings-deny-all` marker when global deny mode blocks a non-read-only tool (no rule match)', async () => {
    // No matching rule, but the default mode is `deny`. A NON-read-only tool
    // (`bash`) should still be blocked by `settingsDenyAll && !tool.isReadOnly`
    // (see `runAgenticToolUseBody.ts:541`).
    await runWithAgentContextAsync(buildAgentCtx('conv-stream-deny-2'), async () => {
      await runAgenticToolUse({
        toolUse: {
          id: 'tu-deny-global',
          name: 'bash',
          input: { command: 'echo x' },
        },
        signal: new AbortController().signal,
        callbacks: { onToolStart: () => {}, onToolResult: () => {} },
        diffPermissionMode: 'default',
        permissionDefaultMode: 'deny',
        permissionRules: [],
        discoveryExclude: new Set(),
        getInlineSkillSession: () => null,
        setInlineSkillSession: () => {},
      })
    })

    const denials = emittedEvents.filter(
      (ev) =>
        (ev as { type?: string; orchestrationPhase?: string }).type === 'orchestration_phase' &&
        (ev as { orchestrationPhase?: string }).orchestrationPhase ===
          'permission_denied_preflight',
    )
    expect(denials).toHaveLength(1)

    const denial = denials[0] as unknown as {
      permissionDenial?: { matchedRule?: string; toolName: string }
    }
    expect(denial.permissionDenial?.toolName).toBe('bash')
    expect(denial.permissionDenial?.matchedRule).toBe('settings-deny-all')
  })

  it('does NOT emit when settings is "deny" but the tool is read-only with no matching rule (read_file passes)', async () => {
    // `read_file` is read-only, so `shouldBlock = matchedRule || !tool.isReadOnly`
    // is FALSE when no matching rule and the tool is read-only. The settings
    // deny default spares it; runAgenticToolUse falls through to the normal
    // path. No preflight-denial event should fire.
    await runWithAgentContextAsync(buildAgentCtx('conv-stream-deny-3'), async () => {
      await runAgenticToolUse({
        toolUse: {
          id: 'tu-readonly-spared',
          name: 'read_file',
          input: { filePath: 'package.json' },
        },
        signal: new AbortController().signal,
        callbacks: { onToolStart: () => {}, onToolResult: () => {} },
        diffPermissionMode: 'default',
        permissionDefaultMode: 'deny',
        permissionRules: [],
        discoveryExclude: new Set(),
        getInlineSkillSession: () => null,
        setInlineSkillSession: () => {},
      })
    })

    const denials = emittedEvents.filter(
      (ev) =>
        (ev as { type?: string; orchestrationPhase?: string }).type === 'orchestration_phase' &&
        (ev as { orchestrationPhase?: string }).orchestrationPhase ===
          'permission_denied_preflight',
    )
    expect(denials).toHaveLength(0)
  })

  it('omits conversationId when AgentContext has none', async () => {
    await runWithAgentContextAsync(buildAgentCtx(undefined), async () => {
      await runAgenticToolUse({
        toolUse: {
          id: 'tu-no-conv',
          name: 'read_file',
          input: { filePath: 'package.json' },
        },
        signal: new AbortController().signal,
        callbacks: { onToolStart: () => {}, onToolResult: () => {} },
        diffPermissionMode: 'default',
        permissionDefaultMode: 'ask',
        permissionRules: [{ id: 'block-read', pattern: 'read_file', mode: 'deny' }],
        discoveryExclude: new Set(),
        getInlineSkillSession: () => null,
        setInlineSkillSession: () => {},
      })
    })

    const denial = emittedEvents.find(
      (ev) =>
        (ev as { orchestrationPhase?: string }).orchestrationPhase ===
        'permission_denied_preflight',
    ) as unknown as { conversationId?: string }
    expect(denial).toBeDefined()
    expect(denial.conversationId).toBeUndefined()
  })
})
