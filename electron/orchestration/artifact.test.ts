/**
 * ArtifactPort + Terminal manifest.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFileArtifactPort, createInMemoryArtifactPort } from './artifact'
import { createInitialKernelLoopState } from './kernelTypes'
import { OrchestrationKernel } from './kernel'
import { createTransportAdapter, noopHookPolicy } from './transport'
import { DefaultToolRuntimePort } from './toolRuntime/defaultToolRuntimePort'
import { createNoopMcpSessionAdapter } from './mcpSessionAdapter'

vi.mock('./phases/iteration', () => ({
  runAgenticLoop: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../agents/agentContext', () => ({
  getAgentContext: vi.fn().mockReturnValue(null),
}))

describe('createInMemoryArtifactPort ', () => {
  it('publish assigns id + at and stores entry', () => {
    const port = createInMemoryArtifactPort()
    const e = port.publish({
      kind: 'diff',
      producer: 'Edit',
      payload: { filePath: 'a.ts' },
    })
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(typeof e.at).toBe('number')
    expect(port.list()).toEqual([e])
  })

  it('filter by producerTurn + kind', () => {
    const port = createInMemoryArtifactPort()
    port.publish({ kind: 'diff', producer: 'Edit', producerTurn: 1, payload: {} })
    port.publish({ kind: 'diff', producer: 'Edit', producerTurn: 2, payload: {} })
    port.publish({ kind: 'canvas', producer: 'Canvas', producerTurn: 2, payload: {} })
    expect(port.list({ producerTurn: 2 })).toHaveLength(2)
    expect(port.list({ producerTurn: 2, kind: 'canvas' })).toHaveLength(1)
  })

  it('maxEntries evicts oldest FIFO', () => {
    const port = createInMemoryArtifactPort({ maxEntries: 2 })
    port.publish({ kind: 'diff', producer: 'a', payload: {} })
    const second = port.publish({ kind: 'diff', producer: 'b', payload: {} })
    const third = port.publish({ kind: 'diff', producer: 'c', payload: {} })
    const ids = port.list().map((e) => e.id)
    expect(ids).toEqual([second.id, third.id])
  })

  it('onPublish observer fires synchronously', () => {
    const seen: string[] = []
    const port = createInMemoryArtifactPort({
      onPublish: (e) => seen.push(e.producer),
    })
    port.publish({ kind: 'summary', producer: 'X', payload: {} })
    expect(seen).toEqual(['X'])
  })
})

describe('createFileArtifactPort', () => {
  function tmpDir(): string {
    const d = path.join(os.tmpdir(), `artifact-port-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(d, { recursive: true })
    return d
  }

  it('persists every published artifact to disk', () => {
    const dir = tmpDir()
    try {
      const port = createFileArtifactPort(dir)
      const e = port.publish({ kind: 'diff', producer: 'Edit', payload: { filePath: 'x.ts' } })
      const indexFile = path.join(dir, 'artifacts', 'index.json')
      const entryFile = path.join(dir, 'artifacts', `${e.id}.json`)
      expect(fs.existsSync(indexFile)).toBe(true)
      expect(fs.existsSync(entryFile)).toBe(true)
      const indexed = JSON.parse(fs.readFileSync(indexFile, 'utf-8'))
      expect(indexed).toHaveLength(1)
      expect(indexed[0].id).toBe(e.id)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reloads existing artifacts from disk on construction', () => {
    const dir = tmpDir()
    try {
      const a = createFileArtifactPort(dir)
      a.publish({ kind: 'diff', producer: 'Edit', producerTurn: 1, payload: { p: 1 } })
      a.publish({ kind: 'canvas', producer: 'Canvas', producerTurn: 2, payload: { c: 2 } })

      // Fresh port over the same directory should see the two prior artifacts.
      const b = createFileArtifactPort(dir)
      const list = b.list()
      expect(list).toHaveLength(2)
      expect(list.map((e) => e.kind).sort()).toEqual(['canvas', 'diff'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('clear() removes index and per-entry files', () => {
    const dir = tmpDir()
    try {
      const port = createFileArtifactPort(dir)
      port.publish({ kind: 'diff', producer: 'Edit', payload: {} })
      port.clear()
      const artifactsDir = path.join(dir, 'artifacts')
      const remaining = fs.existsSync(artifactsDir) ? fs.readdirSync(artifactsDir) : []
      expect(remaining).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maxEntries evicts oldest from disk too', () => {
    const dir = tmpDir()
    try {
      const port = createFileArtifactPort(dir, { maxEntries: 2 })
      const first = port.publish({ kind: 'diff', producer: 'a', payload: {} })
      port.publish({ kind: 'diff', producer: 'b', payload: {} })
      port.publish({ kind: 'diff', producer: 'c', payload: {} })
      const evicted = path.join(dir, 'artifacts', `${first.id}.json`)
      expect(fs.existsSync(evicted)).toBe(false)
      // Index reflects the surviving two
      const indexed = JSON.parse(fs.readFileSync(path.join(dir, 'artifacts', 'index.json'), 'utf-8'))
      expect(indexed).toHaveLength(2)
      expect(indexed.find((e: { id: string }) => e.id === first.id)).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('OrchestrationKernel emits artifact manifest at Terminal ', () => {
  afterEach(async () => {
    const { runAgenticLoop } = await import('./phases/iteration')
    vi.mocked(runAgenticLoop).mockReset()
    vi.mocked(runAgenticLoop).mockResolvedValue(undefined)
  })

  it('emits orchestration_phase `artifact_manifest` with entries for current turn', async () => {
    const artifactPort = createInMemoryArtifactPort()
    const emit = vi.fn()
    const ports = {
      tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
      permission: { noteToolInvocation: vi.fn() },
      session: createNoopMcpSessionAdapter(),
      transport: createTransportAdapter(emit),
      hooks: noopHookPolicy,
    }
    const kernel = new OrchestrationKernel(
      ports,
      undefined,
      createInitialKernelLoopState([]),
      'conv-artifact',
      { artifactPort },
    )

    // Producer publishes during the turn (simulating a tool).
    const { runAgenticLoop } = await import('./phases/iteration')
    vi.mocked(runAgenticLoop).mockImplementationOnce(async () => {
      artifactPort.publish({
        kind: 'diff',
        producer: 'Edit',
        producerTurn: 1,
        payload: { filePath: 'a.ts' },
      })
    })

    await kernel.runLegacyDelegateMainChat({
      rendererMessages: [{ role: 'user', content: 'go' }],
      agenticParams: {
        config: { id: 'anthropic', apiKey: 'x' } as import('../ai/client').ProviderConfig,
        model: 'claude',
        messages: [],
        signal: new AbortController().signal,
      },
      agenticCallbacks: {
        onTextDelta: vi.fn(),
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onMessageEnd: vi.fn(),
        onError: vi.fn(),
      },
    })

    const manifestEvents = emit.mock.calls
      .map((c) => c[0] as { orchestrationPhase?: string; artifactManifest?: unknown })
      .filter((ev) => ev.orchestrationPhase === 'artifact_manifest')
    expect(manifestEvents).toHaveLength(1)
    const manifest = manifestEvents[0].artifactManifest as import('./artifact').ArtifactManifest
    expect(manifest.turn).toBe(1)
    expect(manifest.entries).toHaveLength(1)
    expect(manifest.entries[0]).toMatchObject({ kind: 'diff', producer: 'Edit' })
  })

  it('no manifest event when artifact port is empty or absent', async () => {
    const emit = vi.fn()
    const ports = {
      tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
      permission: { noteToolInvocation: vi.fn() },
      session: createNoopMcpSessionAdapter(),
      transport: createTransportAdapter(emit),
      hooks: noopHookPolicy,
    }
    const kernel = new OrchestrationKernel(
      ports,
      undefined,
      createInitialKernelLoopState([]),
      'conv-artifact-empty',
    )
    await kernel.runLegacyDelegateMainChat({
      rendererMessages: [{ role: 'user', content: 'go' }],
      agenticParams: {
        config: { id: 'anthropic', apiKey: 'x' } as import('../ai/client').ProviderConfig,
        model: 'claude',
        messages: [],
        signal: new AbortController().signal,
      },
      agenticCallbacks: {
        onTextDelta: vi.fn(),
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onMessageEnd: vi.fn(),
        onError: vi.fn(),
      },
    })
    const manifestEvents = emit.mock.calls
      .map((c) => c[0] as { orchestrationPhase?: string })
      .filter((ev) => ev.orchestrationPhase === 'artifact_manifest')
    expect(manifestEvents).toHaveLength(0)
  })
})
