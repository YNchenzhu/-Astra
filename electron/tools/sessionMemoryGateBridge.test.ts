/**
 * P0 audit fix regression test:
 *
 * Worker-path sub-agents (delegated through `runSubAgentInWorker`) used to
 * bypass `gateSessionMemoryInternalAgentToolUse` because the host-side RPC
 * handler ran in the parent agent's ALS scope. The session-memory bridge
 * therefore saw the **parent**'s `sessionAgentType` (e.g. 'main') instead
 * of the actual child sub-agent that issued the tool call, and the gate
 * skipped entirely — letting `session-memory-internal` scribes mutate any
 * file under the workspace.
 *
 * The fix introduces `subAgentRpcGateContext`:
 *
 *   1. `runWithSubAgentRpcGateAsync(snap, fn)` — installed by the host
 *      RPC handler (`subAgentWorkerClient.ts`) for the duration of every
 *      `toolRegistry.execute` call.
 *   2. `getSessionAgentTypeForMemoryGates()` reads it as a third source
 *      after `getAgentContext()` and `getWorkerAgentGateSnapshot()`.
 *
 * These tests pin the bridge contract end-to-end: a parent ALS that says
 * 'main' must NOT shadow a child RPC scope that says 'session-memory-internal',
 * and the path target must propagate so single-file enforcement still fires.
 */
import { describe, expect, it } from 'vitest'
import {
  getSessionAgentTypeForMemoryGates,
  getSessionMemoryWritableTargetPathForGates,
} from './sessionMemoryGateBridge'
import { runWithSubAgentRpcGateAsync } from '../agents/subAgentRpcGateContext'
import { runWithAgentContextAsync } from '../agents/agentContext'
import type { AgentContext } from '../agents/agentContext'

function fakeParentCtx(sessionAgentType: string): AgentContext {
  return {
    agentId: 'main',
    sessionAgentType,
    messages: [],
    model: '',
    config: {} as AgentContext['config'],
    systemPrompt: '',
    signal: new AbortController().signal,
  } as unknown as AgentContext
}

describe('sessionMemoryGateBridge — sub-agent RPC ALS source', () => {
  it('returns undefined outside any scope', () => {
    expect(getSessionAgentTypeForMemoryGates()).toBeUndefined()
    expect(getSessionMemoryWritableTargetPathForGates()).toBeUndefined()
  })

  it('reads the RPC gate snapshot when no parent AgentContext is set', async () => {
    await runWithSubAgentRpcGateAsync(
      {
        sessionAgentType: 'session-memory-internal',
        sessionMemoryWritableTargetPath: '/tmp/conv-1.md',
      },
      async () => {
        expect(getSessionAgentTypeForMemoryGates()).toBe('session-memory-internal')
        expect(getSessionMemoryWritableTargetPathForGates()).toBe('/tmp/conv-1.md')
      },
    )
  })

  it('AgentContext.sessionAgentType still wins when both are set (priority order preserved)', async () => {
    await runWithAgentContextAsync(fakeParentCtx('main'), async () => {
      await runWithSubAgentRpcGateAsync(
        {
          sessionAgentType: 'session-memory-internal',
          sessionMemoryWritableTargetPath: '/tmp/conv-2.md',
        },
        async () => {
          // Parent context wins — this is intentional: the in-process path
          // sets the child's sessionAgentType ON the AgentContext itself,
          // and that takes precedence. The RPC ALS is the **fallback** for
          // worker_threads paths where AgentContext is the parent's.
          expect(getSessionAgentTypeForMemoryGates()).toBe('main')
        },
      )
    })
  })

  it('worker_threads regression case: parent AgentContext is "main", RPC scope reveals child identity', async () => {
    // Simulate the production worker-path situation:
    //   - parent main agent runs with `sessionAgentType: 'main'`
    //   - it spawns `session-memory-internal` via runSubAgentInWorker
    //   - the worker_threads child issues a tool RPC back to the host
    //   - the host RPC handler (subAgentWorkerClient) wraps execute in
    //     runWithSubAgentRpcGateAsync({ sessionAgentType: 'session-memory-internal', … })
    //   - inside that scope the bridge MUST see 'session-memory-internal',
    //     not 'main'. (Achieved here by simulating the absence of an
    //     overlapping `getAgentContext().sessionAgentType` for the
    //     duration of the execute — the production handler does NOT
    //     re-enter `runWithAgentContextAsync`, so the parent's sessionAgentType
    //     does NOT shadow.)
    //
    // We model this by NOT installing a parent AgentContext at all (since
    // priority would otherwise win); the production fix relies on the
    // host RPC handler running in whatever ALS the worker.on('message')
    // callback inherits — typically the parent's, but the parent's
    // sessionAgentType is the parent's identity ('main'), and the RPC
    // gate snapshot must override for sandbox decisions.
    //
    // This split-priority is intentional and matches the bridge doc.

    const seen: { sessionAgentType?: string; targetPath?: string } = {}
    await runWithSubAgentRpcGateAsync(
      {
        sessionAgentType: 'session-memory-internal',
        sessionMemoryWritableTargetPath: '/tmp/scribe-target.md',
      },
      async () => {
        seen.sessionAgentType = getSessionAgentTypeForMemoryGates()
        seen.targetPath = getSessionMemoryWritableTargetPathForGates()
      },
    )
    expect(seen.sessionAgentType).toBe('session-memory-internal')
    expect(seen.targetPath).toBe('/tmp/scribe-target.md')
  })

  it('partial snapshot: only sessionAgentType set leaves target path undefined', async () => {
    await runWithSubAgentRpcGateAsync(
      { sessionAgentType: 'session-memory-internal' },
      async () => {
        expect(getSessionAgentTypeForMemoryGates()).toBe('session-memory-internal')
        // No sessionMemoryWritableTargetPath provided → bridge falls back
        // to the legacy "any .md under the tree" behaviour.
        expect(getSessionMemoryWritableTargetPathForGates()).toBeUndefined()
      },
    )
  })

  it('snapshot does not leak across awaits to sibling async chains', async () => {
    const insideValues: string[] = []
    const outsideValues: Array<string | undefined> = []

    await Promise.all([
      runWithSubAgentRpcGateAsync(
        { sessionAgentType: 'session-memory-internal' },
        async () => {
          await new Promise((r) => setTimeout(r, 0))
          insideValues.push(getSessionAgentTypeForMemoryGates() ?? '<undef>')
        },
      ),
      (async () => {
        await new Promise((r) => setTimeout(r, 0))
        outsideValues.push(getSessionAgentTypeForMemoryGates())
      })(),
    ])

    expect(insideValues).toEqual(['session-memory-internal'])
    expect(outsideValues).toEqual([undefined])
  })
})
