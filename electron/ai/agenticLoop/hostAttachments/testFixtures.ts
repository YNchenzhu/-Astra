/**
 * Shared test fixtures for `hostAttachments/<name>.test.ts` files.
 *
 * Each collector's unit tests need:
 *
 *   - an `AttachmentContext` shaped enough for the collector to run
 *     (`state` with `iteration`, `apiMessages`, `appendixReport`,
 *     `syncConversation`, `loopContextManager`, `callbacks`, `config`),
 *   - a way to override individual fields per test.
 *
 * Centralising the shape here avoids ~20 lines of duplicate scaffolding
 * per file. Each helper returns a fresh object — never share state
 * across tests.
 *
 * Not exported from a barrel; imported directly via relative path so
 * vitest sees it as test-only and tree-shaking doesn't complain.
 */

import { vi } from 'vitest'
import type { AttachmentCallSite, AttachmentContext } from '../hostAttachments'
import type { LoopState } from '../loopShared'

export interface MakeFixtureOpts {
  callSite?: AttachmentCallSite
  apiMessages?: Array<Record<string, unknown>>
  iteration?: number
  /** Optional override for the ctx manager's reported state. */
  ctxManagerState?: Partial<{
    level: string
    estimatedTokens: number
    usagePercentOfWindow: number
    compactCount: number
    consecutiveCompactFailures: number
  }>
  /** Optional overrides spread into LoopState. */
  stateOverrides?: Partial<Record<string, unknown>>
}

/**
 * Build a minimal `AttachmentContext` + reachable `LoopState` suitable
 * for invoking any collector directly. The state shape is the bare
 * minimum the collectors in `hostAttachments/*.ts` actually read.
 */
export function makeAttachmentFixture(
  opts: MakeFixtureOpts = {},
): AttachmentContext {
  const ctxManagerState = {
    level: 'idle',
    estimatedTokens: 0,
    compactCount: 0,
    consecutiveCompactFailures: 0,
    ...opts.ctxManagerState,
  }
  const state: Partial<LoopState> = {
    apiMessages: opts.apiMessages ?? [],
    iteration: opts.iteration ?? 1,
    appendixReport: vi.fn(),
    syncConversation: vi.fn(),
    acceptHostTranscript: vi.fn(),
    config: { id: 'anthropic', name: 'anthropic', apiKey: '', baseUrl: '' } as unknown as LoopState['config'],
    loopContextManager: {
      getState: () => ctxManagerState,
    } as unknown as LoopState['loopContextManager'],
    ...opts.stateOverrides,
  }
  return {
    state: state as LoopState,
    systemPrompt: 'test-sys',
    callSite: opts.callSite ?? 'post_tool',
  }
}

/** Test-only: assert that a value is a `push_message` action. */
export function expectPushMessageAction(
  result: unknown,
): { kind: 'push_message'; message: Record<string, unknown> } {
  if (
    typeof result !== 'object' ||
    result === null ||
    (result as { kind?: string }).kind !== 'push_message'
  ) {
    throw new Error(
      `expected push_message action, got: ${JSON.stringify(result)}`,
    )
  }
  return result as { kind: 'push_message'; message: Record<string, unknown> }
}

/** Test-only: assert that a value is a `concat_to_last_user` action. */
export function expectConcatAction(
  result: unknown,
): { kind: 'concat_to_last_user'; text: string } {
  if (
    typeof result !== 'object' ||
    result === null ||
    (result as { kind?: string }).kind !== 'concat_to_last_user'
  ) {
    throw new Error(
      `expected concat_to_last_user action, got: ${JSON.stringify(result)}`,
    )
  }
  return result as { kind: 'concat_to_last_user'; text: string }
}
