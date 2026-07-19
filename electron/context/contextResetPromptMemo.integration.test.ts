import type { IpcMain } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildSystemPromptLayers,
  invalidateAllSystemPromptMemoCaches,
  systemPromptInstructionCacheSize,
  userContextLayerCacheSize,
} from '../ai/systemPrompt'
import { registerContextHandlers } from './handlers'

function mockIpcMainWithHandlers(): {
  ipc: IpcMain
  invoke: (channel: string, ...args: unknown[]) => unknown
} {
  const registry = new Map<string, (...args: unknown[]) => unknown>()
  const ipc = {
    handle(channel: string, listener: (...args: unknown[]) => unknown) {
      registry.set(channel, listener)
    },
  } as unknown as IpcMain
  return {
    ipc,
    invoke(channel: string, ...args: unknown[]) {
      const fn = registry.get(channel)
      if (!fn) throw new Error(`No ipc handler registered: ${channel}`)
      return fn(null as never, ...args)
    },
  }
}

/**
 * Ensures `context:reset` (清空上下文 → resetContext IPC) clears §6.2 memo caches,
 * not only the instruction block cache.
 */
describe('context:reset → prompt memo invalidation', () => {
  afterEach(() => {
    invalidateAllSystemPromptMemoCaches()
  })

  it('registered handler clears instruction + userContext layer caches', () => {
    const { ipc, invoke } = mockIpcMainWithHandlers()
    registerContextHandlers(ipc)

    buildSystemPromptLayers({
      cwd: '/tmp/ws',
      platform: 'linux',
      outputStyle: 'concise',
      language: 'en',
      memoryContext: 'mem',
      sessionContext: '',
      lspPassiveDiagnosticsContext: '',
    })
    expect(systemPromptInstructionCacheSize()).toBeGreaterThanOrEqual(1)
    expect(userContextLayerCacheSize()).toBe(1)

    const out = invoke('context:reset', undefined) as { success: boolean }
    expect(out).toEqual({ success: true })
    expect(systemPromptInstructionCacheSize()).toBe(0)
    expect(userContextLayerCacheSize()).toBe(0)
  })
})
