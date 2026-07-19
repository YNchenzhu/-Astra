/**
 * Tests for injectPendingInterAgentQueue — focused on the typed-handoff
 * receiver path: each parsed protocol kind is validated against its
 * registered Zod schema and the validation status (✓ / ⚠ FAILED) lands
 * in the synthetic `<system-reminder>` injection so the model sees it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  mockedActiveAgent: {
    agentId: 'sub-1',
    status: 'running',
    pendingMessages: [] as string[],
    pendingTeamShutdown: undefined as { requestId: string; receivedAt: number } | undefined,
  },
  tryResolveTeamPermissionFromProtocolMessage: vi.fn(),
  tryResolveTeamPlanApprovalFromProtocolMessage: vi.fn(),
}))

vi.mock('../agents/agentContext', () => ({
  getAgentContext: vi.fn(() => ({ agentId: 'sub-1' })),
}))

vi.mock('../agents/activeAgentRegistry', () => ({
  getActiveAgent: vi.fn(() => hoisted.mockedActiveAgent),
}))

vi.mock('../agents/teamPermissionLeaderBridge', () => ({
  tryResolveTeamPermissionFromProtocolMessage: hoisted.tryResolveTeamPermissionFromProtocolMessage,
}))

vi.mock('../agents/teamPlanApprovalLeaderBridge', () => ({
  tryResolveTeamPlanApprovalFromProtocolMessage:
    hoisted.tryResolveTeamPlanApprovalFromProtocolMessage,
}))

vi.mock('../planning/planRuntime', () => ({
  getActivePlanStatus: vi.fn(() => undefined),
}))

import { injectPendingInterAgentQueue } from './agenticLoopHelpers'
import {
  TEAM_INTER_AGENT_SCHEMA,
  clearInterAgentSchemasForTests,
  stringifyTeamInterAgentMessage,
} from '../agents/teamInterAgentProtocol'

function pushPending(line: string): void {
  hoisted.mockedActiveAgent.pendingMessages.push(line)
}

describe('injectPendingInterAgentQueue — typed handoff annotations', () => {
  beforeEach(() => {
    hoisted.mockedActiveAgent.pendingMessages = []
    hoisted.mockedActiveAgent.pendingTeamShutdown = undefined
    hoisted.tryResolveTeamPermissionFromProtocolMessage.mockReset()
    hoisted.tryResolveTeamPlanApprovalFromProtocolMessage.mockReset()
  })
  afterEach(() => {
    clearInterAgentSchemasForTests()
  })

  it('annotates a valid protocol message with `schema:<kind> ✓`', () => {
    // P0-2: switched from `plan_approval_response` (now silently consumed
    // by `tryResolveTeamPlanApprovalFromProtocolMessage` like
    // `permission_response`) to `idle_notification`, which is still on the
    // annotate-and-inject path. The original assertion was about the
    // schema-tag formatting, not about which kind was used — any
    // non-stateful kind validates the same logic.
    pushPending(
      stringifyTeamInterAgentMessage({
        schema: TEAM_INTER_AGENT_SCHEMA,
        kind: 'idle_notification',
      }),
    )

    const apiMessages: Array<Record<string, unknown>> = []
    const injected = injectPendingInterAgentQueue(apiMessages)

    expect(injected).toBe(true)
    expect(apiMessages).toHaveLength(1)
    const content = apiMessages[0].content as string
    // Per-message annotation
    expect(content).toContain('schema:idle_notification ✓')
    // Header note line
    expect(content).toContain('- idle_notification (schema:idle_notification ✓)')
  })

  it('annotates an invalid protocol message with `⚠ FAILED — ...` and surfaces field errors', () => {
    // shutdown_response is missing the required `requestId` and `approve`.
    pushPending(
      JSON.stringify({
        schema: TEAM_INTER_AGENT_SCHEMA,
        kind: 'shutdown_response',
      }),
    )

    const apiMessages: Array<Record<string, unknown>> = []
    injectPendingInterAgentQueue(apiMessages)

    const content = apiMessages[0].content as string
    expect(content).toMatch(/schema:shutdown_response ⚠ FAILED/)
    // The exact missing-field path should land in the error message so the
    // model can self-correct.
    expect(content.toLowerCase()).toContain('requestid')
  })

  it('mode_set_request with an invalid `detail` enum value gets flagged but still injected', () => {
    pushPending(
      JSON.stringify({
        schema: TEAM_INTER_AGENT_SCHEMA,
        kind: 'mode_set_request',
        detail: 'rocket', // not in the allowed enum
      }),
    )

    const apiMessages: Array<Record<string, unknown>> = []
    injectPendingInterAgentQueue(apiMessages)

    const content = apiMessages[0].content as string
    expect(content).toContain('schema:mode_set_request ⚠ FAILED')
    // Body still present so the agent can inspect what arrived.
    expect(content).toContain('"detail":"rocket"')
  })

  it('non-protocol lines are passed through without schema tags', () => {
    pushPending('[2026-04-14T12:00:00.000Z] just a plain string')

    const apiMessages: Array<Record<string, unknown>> = []
    injectPendingInterAgentQueue(apiMessages)

    const content = apiMessages[0].content as string
    expect(content).toContain('### Message 1')
    expect(content).not.toContain('schema:')
    // No protocol-notes header for unparseable lines.
    expect(content).not.toContain('Team protocol (parsed)')
  })

  it('permission_response is consumed by the bridge and NOT injected', () => {
    pushPending(
      stringifyTeamInterAgentMessage({
        schema: TEAM_INTER_AGENT_SCHEMA,
        kind: 'permission_response',
        requestId: 'pr-1',
        approve: true,
      }),
    )

    const apiMessages: Array<Record<string, unknown>> = []
    const injected = injectPendingInterAgentQueue(apiMessages)

    expect(hoisted.tryResolveTeamPermissionFromProtocolMessage).toHaveBeenCalledTimes(1)
    // Nothing else queued → no synthetic message.
    expect(injected).toBe(false)
    expect(apiMessages).toHaveLength(0)
  })

  it('plan_approval_response is consumed by the plan-approval bridge and NOT injected (P0-2)', () => {
    pushPending(
      stringifyTeamInterAgentMessage({
        schema: TEAM_INTER_AGENT_SCHEMA,
        kind: 'plan_approval_response',
        requestId: 'tplan-bridge-1',
        approve: true,
      }),
    )

    const apiMessages: Array<Record<string, unknown>> = []
    const injected = injectPendingInterAgentQueue(apiMessages)

    expect(hoisted.tryResolveTeamPlanApprovalFromProtocolMessage).toHaveBeenCalledTimes(1)
    expect(hoisted.tryResolveTeamPermissionFromProtocolMessage).not.toHaveBeenCalled()
    expect(injected).toBe(false)
    expect(apiMessages).toHaveLength(0)
  })

  it('mixed batch: one valid + one invalid + one passthrough', () => {
    pushPending(
      stringifyTeamInterAgentMessage({
        schema: TEAM_INTER_AGENT_SCHEMA,
        kind: 'idle_notification',
        detail: 'all green',
      }),
    )
    pushPending(
      JSON.stringify({
        schema: TEAM_INTER_AGENT_SCHEMA,
        kind: 'plan_approval_request',
        // requestId + detail missing
      }),
    )
    pushPending('plain non-protocol line')

    const apiMessages: Array<Record<string, unknown>> = []
    injectPendingInterAgentQueue(apiMessages)

    const content = apiMessages[0].content as string
    expect(content).toContain('schema:idle_notification ✓')
    expect(content).toContain('schema:plan_approval_request ⚠ FAILED')
    expect(content).toContain('### Message 3')
  })

  it('shutdown_request still records pendingTeamShutdown AND gets schema-tagged', () => {
    pushPending(
      stringifyTeamInterAgentMessage({
        schema: TEAM_INTER_AGENT_SCHEMA,
        kind: 'shutdown_request',
        requestId: 'r-7',
      }),
    )

    const apiMessages: Array<Record<string, unknown>> = []
    injectPendingInterAgentQueue(apiMessages)

    expect(hoisted.mockedActiveAgent.pendingTeamShutdown?.requestId).toBe('r-7')
    const content = apiMessages[0].content as string
    expect(content).toContain('shutdown_request (requestId=r-7) (schema:shutdown_request ✓)')
  })
})
