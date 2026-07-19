/**
 * DefaultToolRuntimePort with a PermissionPort preflight.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTransportAdapter } from './transport'
import { DefaultToolRuntimePort } from './toolRuntime/defaultToolRuntimePort'
import { createInitialKernelLoopState } from './kernelTypes'

vi.mock('../ai/agenticToolBatch', () => ({
  runAgenticToolUseBatch: vi.fn().mockResolvedValue([
    { type: 'tool_result', tool_use_id: 'tu_ok', content: 'ran allowed' },
  ]),
  toolResultBlockIndicatesFailure: (block: Record<string, unknown>) =>
    typeof block.content === 'string' && block.content.trimStart().startsWith('Error:'),
}))

vi.mock('../ai/client', () => ({
  streamText: vi.fn(),
}))

describe('DefaultToolRuntimePort preflight ', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('synthesizes failure block for denied tool and still runs allowed tools', async () => {
    const emitted: unknown[] = []
    const transport = createTransportAdapter((ev) => emitted.push(ev))
    const permission = {
      preflight: (req: { toolName: string; toolUseId: string }) => {
        if (req.toolName === 'DangerTool') {
          return { decision: 'deny' as const, reason: 'nope', matchedRule: 'kernel:rule' }
        }
        return { decision: 'allow' as const }
      },
    }
    const port = new DefaultToolRuntimePort(
      { get: () => null, set: () => {} },
      { permissionPort: permission, transport },
    )

    const onToolResult = vi.fn()
    const outcome = await port.executeToolBatch({
      state: createInitialKernelLoopState([]),
      toolUses: [
        { id: 'tu_bad', name: 'DangerTool', input: { x: 1 } },
        { id: 'tu_ok', name: 'Read', input: { path: 'a' } },
      ],
      signal: new AbortController().signal,
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      discoveryExclude: new Set(),
      toolCallbacks: {
        onToolStart: vi.fn(),
        onToolResult,
      },
    })

    // Two result blocks — one synthetic denial + one allowed run — in original order.
    expect(outcome.toolResultBlocks).toHaveLength(2)
    expect(outcome.toolResultBlocks[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_bad',
      is_error: true,
    })
    expect(outcome.toolResultBlocks[1]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_ok',
    })
    expect(outcome.hadFailure).toBe(true)

    // onToolResult fired for the denied tool with success=false.
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tu_bad',
        success: false,
      }),
    )

    // Transport emitted permission_denied_preflight.
    const denialEvents = emitted.filter(
      (e) =>
        (e as { type?: string; orchestrationPhase?: string }).type === 'orchestration_phase' &&
        (e as { orchestrationPhase?: string }).orchestrationPhase ===
          'permission_denied_preflight',
    )
    expect(denialEvents).toHaveLength(1)
  })

  it('no-op when no permissionPort configured — behavior matches legacy path', async () => {
    const port = new DefaultToolRuntimePort({ get: () => null, set: () => {} })
    const outcome = await port.executeToolBatch({
      state: createInitialKernelLoopState([]),
      toolUses: [{ id: 'tu_ok', name: 'Read', input: {} }],
      signal: new AbortController().signal,
      diffPermissionMode: 'default',
      permissionDefaultMode: 'ask',
      discoveryExclude: new Set(),
    })
    expect(outcome.toolResultBlocks).toHaveLength(1)
    expect(outcome.hadFailure).toBe(false)
  })

})
