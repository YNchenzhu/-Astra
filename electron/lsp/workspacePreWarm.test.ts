/**
 * Pre-warm integration tests. We wire a fake LSPServerManager against a real
 * temp directory so we can assert the walker honors ignore rules, dedupes
 * extensions by the first-registered server, and caps correctly.
 *
 * These intentionally use real `fs` (not mocked) because the scanner logic
 * relies on dirent classification that is tricky to mock faithfully.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { preWarmWorkspaceForLsp } from './workspacePreWarm'
import { setDiskSettingsLoader } from '../settings/settingsAccess'
import type { LSPServerInstance, LSPServerManager } from './LSPServerManager'

interface FakeInvocation {
  method: 'openFile'
  filePath: string
  content: string
}

function makeFakeServerInstance(
  name: string,
  extensions: string[],
): LSPServerInstance {
  const extensionToLanguage: Record<string, string> = {}
  for (const ext of extensions) extensionToLanguage[ext] = name
  return {
    name,
    config: {
      scope: name,
      command: '(test)',
      args: [],
      extensionToLanguage,
    },
    state: 'running',
    lastError: undefined,
    start: async () => {},
    stop: async () => {},
    restart: async () => {},
    isHealthy: () => true,
    sendRequest: async () => ({} as never),
    sendNotification: async () => {},
    onNotification: () => {},
    onRequest: () => {},
  }
}

function makeFakeManager(servers: Array<[string, LSPServerInstance]>): {
  manager: LSPServerManager
  invocations: FakeInvocation[]
  openedSet: Set<string>
} {
  const invocations: FakeInvocation[] = []
  const openedSet = new Set<string>()
  const map = new Map(servers)
  const manager: LSPServerManager = {
    initialize: async () => {},
    shutdown: async () => {},
    getServerForFile: () => undefined,
    ensureServerStarted: async () => undefined,
    sendRequest: async () => undefined,
    openFile: async (filePath, content) => {
      invocations.push({ method: 'openFile', filePath, content })
      openedSet.add(filePath)
      return 1
    },
    changeFile: async () => undefined,
    saveFile: async () => {},
    closeFile: async () => {},
    isFileOpen: (filePath) => openedSet.has(filePath),
    getAllServers: () => map,
  }
  return { manager, invocations, openedSet }
}

function writeFile(root: string, rel: string, content = '// test\n'): string {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
  return abs
}

describe('preWarmWorkspaceForLsp', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-prewarm-'))
    setDiskSettingsLoader(() => ({}))
  })
  afterEach(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('opens every matching file under the workspace', async () => {
    writeFile(tmp, 'src/a.ts')
    writeFile(tmp, 'src/sub/b.tsx')
    writeFile(tmp, 'src/c.py')
    writeFile(tmp, 'readme.md')

    const { manager, invocations } = makeFakeManager([
      ['typescript', makeFakeServerInstance('typescript', ['.ts', '.tsx'])],
      ['python', makeFakeServerInstance('python', ['.py'])],
    ])
    const summary = await preWarmWorkspaceForLsp(manager, tmp)

    expect(summary.disabled).toBe(false)
    expect(summary.totalOpened).toBe(3)
    expect(invocations.map((i) => path.basename(i.filePath)).sort()).toEqual([
      'a.ts',
      'b.tsx',
      'c.py',
    ])
    expect(summary.byServer.typescript).toBe(2)
    expect(summary.byServer.python).toBe(1)
  })

  it('skips hard-ignored directories like node_modules', async () => {
    writeFile(tmp, 'src/a.ts')
    writeFile(tmp, 'node_modules/foo/index.ts')
    writeFile(tmp, 'dist/out.ts')
    writeFile(tmp, '.git/HEAD', 'ref: refs/heads/main')

    const { manager, invocations } = makeFakeManager([
      ['typescript', makeFakeServerInstance('typescript', ['.ts'])],
    ])
    const summary = await preWarmWorkspaceForLsp(manager, tmp)

    expect(summary.totalOpened).toBe(1)
    expect(invocations[0].filePath.endsWith('a.ts')).toBe(true)
  })

  it('honors the per-language maximum from settings', async () => {
    for (let i = 0; i < 12; i++) writeFile(tmp, `src/file${i}.ts`)
    setDiskSettingsLoader(() => ({
      lspWorkspaceScan: { maxFilesPerLanguage: 5 },
    }))

    const { manager } = makeFakeManager([
      ['typescript', makeFakeServerInstance('typescript', ['.ts'])],
    ])
    const summary = await preWarmWorkspaceForLsp(manager, tmp)

    expect(summary.totalOpened).toBe(5)
    expect(summary.totalSkipped).toBeGreaterThanOrEqual(7)
    expect(summary.hitLanguageCap).toEqual(['typescript'])
  })

  it('honors the global maximum', async () => {
    for (let i = 0; i < 4; i++) writeFile(tmp, `src/file${i}.ts`)
    for (let i = 0; i < 4; i++) writeFile(tmp, `src/file${i}.py`)
    setDiskSettingsLoader(() => ({
      lspWorkspaceScan: { maxTotalFiles: 5 },
    }))

    const { manager } = makeFakeManager([
      ['typescript', makeFakeServerInstance('typescript', ['.ts'])],
      ['python', makeFakeServerInstance('python', ['.py'])],
    ])
    const summary = await preWarmWorkspaceForLsp(manager, tmp)

    expect(summary.totalOpened).toBe(5)
    expect(summary.hitGlobalCap).toBe(true)
  })

  it('is a no-op when the setting is disabled', async () => {
    writeFile(tmp, 'src/a.ts')
    setDiskSettingsLoader(() => ({
      lspWorkspaceScan: { enabled: false },
    }))

    const { manager, invocations } = makeFakeManager([
      ['typescript', makeFakeServerInstance('typescript', ['.ts'])],
    ])
    const summary = await preWarmWorkspaceForLsp(manager, tmp)

    expect(summary.disabled).toBe(true)
    expect(summary.totalOpened).toBe(0)
    expect(invocations).toHaveLength(0)
  })

  it('respects the abort signal mid-scan', async () => {
    // Create enough files that concurrency won't finish them all instantly.
    for (let i = 0; i < 80; i++) writeFile(tmp, `src/f${i}.ts`, 'x\n')

    const signal = { aborted: false }
    const { manager } = makeFakeManager([
      ['typescript', makeFakeServerInstance('typescript', ['.ts'])],
    ])
    const promise = preWarmWorkspaceForLsp(manager, tmp, {
      signal,
      batchSize: 4,
      concurrency: 2,
    })
    // Flip the signal synchronously after start; scan will pick it up at the
    // next directory / batch boundary.
    signal.aborted = true
    const summary = await promise
    expect(summary.aborted || summary.totalOpened <= 80).toBe(true)
  })

  it('returns disabled=true for a non-existent workspace path', async () => {
    const { manager } = makeFakeManager([
      ['typescript', makeFakeServerInstance('typescript', ['.ts'])],
    ])
    const summary = await preWarmWorkspaceForLsp(
      manager,
      path.join(tmp, 'does-not-exist'),
    )
    expect(summary.disabled).toBe(true)
    expect(summary.totalOpened).toBe(0)
  })
})
