import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as lspManager from '../lsp/manager'
import { lspTool } from './LSPTool'

describe('LSPTool (no regex fallback)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns error when no LSP manager', async () => {
    vi.spyOn(lspManager, 'getInitializationStatus').mockReturnValue({ status: 'success' })
    vi.spyOn(lspManager, 'waitForInitialization').mockResolvedValue(undefined)
    vi.spyOn(lspManager, 'getLspServerManager').mockReturnValue(undefined)

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-tool-test-'))
    const file = path.join(dir, 'x.ts')
    fs.writeFileSync(file, 'export function foo() {}\n')

    const r = await lspTool.execute!({
      operation: 'documentSymbol',
      filePath: file,
    })

    expect(r.success).toBe(false)
    expect(r.error).toMatch(/No LSP server available/)
  })

  it('returns error when manager has no server for file', async () => {
    vi.spyOn(lspManager, 'getInitializationStatus').mockReturnValue({ status: 'success' })
    vi.spyOn(lspManager, 'waitForInitialization').mockResolvedValue(undefined)
    vi.spyOn(lspManager, 'getLspServerManager').mockReturnValue({
      getServerForFile: () => undefined,
    } as ReturnType<typeof lspManager.getLspServerManager>)

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-tool-test-'))
    const file = path.join(dir, 'y.ts')
    fs.writeFileSync(file, 'const x = 1\n')

    const r = await lspTool.execute!({
      operation: 'goToDefinition',
      filePath: file,
      line: 1,
      character: 1,
    })

    expect(r.success).toBe(false)
    expect(r.error).toMatch(/No LSP server available/)
  })

  it('workspaceSymbol does NOT require filePath and routes to any running server', async () => {
    // Regression: previously the schema forced filePath for ALL operations,
    // making `workspaceSymbol` paradoxical ("you must tell me which file
    // to look in if you want to find symbol X anywhere"). The fix routes
    // workspaceSymbol straight to the first running server via
    // getAllServers() and skips the per-file ceremony.
    vi.spyOn(lspManager, 'getInitializationStatus').mockReturnValue({ status: 'success' })
    vi.spyOn(lspManager, 'waitForInitialization').mockResolvedValue(undefined)

    const symbolPayload = [
      {
        name: 'ToolUseCardProps',
        kind: 11,
        location: {
          uri: 'file:///abs/src/components/AIChat/ToolUseCard.tsx',
          range: { start: { line: 41, character: 17 }, end: { line: 41, character: 33 } },
        },
      },
    ]
    const sendRequest = vi.fn().mockResolvedValue(symbolPayload)
    const fakeServers = new Map<string, { state: string; sendRequest: typeof sendRequest }>([
      ['typescript-language-server', { state: 'running', sendRequest }],
    ])

    vi.spyOn(lspManager, 'getLspServerManager').mockReturnValue({
      getAllServers: () => fakeServers,
      getServerForFile: () => undefined,
    } as unknown as ReturnType<typeof lspManager.getLspServerManager>)

    const r = await lspTool.execute!({
      operation: 'workspaceSymbol',
      query: 'ToolUseCardProps',
    })

    expect(r.success).toBe(true)
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest).toHaveBeenCalledWith('workspace/symbol', { query: 'ToolUseCardProps' })
    expect(r.output).toContain('ToolUseCardProps')
    expect(r.output).toContain('Interface')
  })

  it('workspaceSymbol surfaces a clear error when no server is running', async () => {
    vi.spyOn(lspManager, 'getInitializationStatus').mockReturnValue({ status: 'success' })
    vi.spyOn(lspManager, 'waitForInitialization').mockResolvedValue(undefined)
    vi.spyOn(lspManager, 'getLspServerManager').mockReturnValue({
      getAllServers: () => new Map([
        ['pyright', { state: 'error', sendRequest: vi.fn() }],
      ]),
      getServerForFile: () => undefined,
    } as unknown as ReturnType<typeof lspManager.getLspServerManager>)

    const r = await lspTool.execute!({
      operation: 'workspaceSymbol',
      query: 'foo',
    })

    expect(r.success).toBe(false)
    expect(r.error).toMatch(/No running LSP server/)
  })

  it('workspaceSymbol prefers a running server that already has open documents', async () => {
    // tsserver only loads a project after a didOpen — querying a
    // running-but-empty server throws "No Project". The tool must pick the
    // server that has documents open instead of blindly taking the first.
    vi.spyOn(lspManager, 'getInitializationStatus').mockReturnValue({ status: 'success' })
    vi.spyOn(lspManager, 'waitForInitialization').mockResolvedValue(undefined)

    const coldSendRequest = vi.fn().mockResolvedValue([])
    const warmSendRequest = vi.fn().mockResolvedValue([])
    const fakeServers = new Map([
      ['typescript', { state: 'running', sendRequest: coldSendRequest }],
      ['python', { state: 'running', sendRequest: warmSendRequest }],
    ])

    vi.spyOn(lspManager, 'getLspServerManager').mockReturnValue({
      getAllServers: () => fakeServers,
      getServerForFile: () => undefined,
      hasOpenFilesForServer: (name: string) => name === 'python',
    } as unknown as ReturnType<typeof lspManager.getLspServerManager>)

    const r = await lspTool.execute!({
      operation: 'workspaceSymbol',
      query: 'foo',
    })

    expect(r.success).toBe(true)
    expect(coldSendRequest).not.toHaveBeenCalled()
    expect(warmSendRequest).toHaveBeenCalledWith('workspace/symbol', { query: 'foo' })
  })

  it('workspaceSymbol maps tsserver "No Project" to an actionable hint', async () => {
    vi.spyOn(lspManager, 'getInitializationStatus').mockReturnValue({ status: 'success' })
    vi.spyOn(lspManager, 'waitForInitialization').mockResolvedValue(undefined)

    const sendRequest = vi.fn().mockRejectedValue(
      new Error("LSP request 'workspace/symbol' failed for 'typescript': No Project.\nError: No Project."),
    )
    vi.spyOn(lspManager, 'getLspServerManager').mockReturnValue({
      getAllServers: () => new Map([
        ['typescript', { state: 'running', sendRequest }],
      ]),
      getServerForFile: () => undefined,
      hasOpenFilesForServer: () => true,
    } as unknown as ReturnType<typeof lspManager.getLspServerManager>)

    const r = await lspTool.execute!({
      operation: 'workspaceSymbol',
      query: 'foo',
    })

    expect(r.success).toBe(false)
    expect(r.error).toMatch(/has not loaded any project/)
    expect(r.error).toMatch(/typescript/)
  })

  it('rename without newName returns validation error before LSP call', async () => {
    vi.spyOn(lspManager, 'getInitializationStatus').mockReturnValue({ status: 'success' })
    vi.spyOn(lspManager, 'waitForInitialization').mockResolvedValue(undefined)
    const sendRequest = vi.fn()
    vi.spyOn(lspManager, 'getLspServerManager').mockReturnValue({
      getServerForFile: () => ({}),
      isFileOpen: () => true,
      sendRequest,
      getServerCapabilities: () => undefined,
    } as ReturnType<typeof lspManager.getLspServerManager>)

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-tool-test-'))
    const file = path.join(dir, 'r.ts')
    fs.writeFileSync(file, 'const a = 1\n')

    const r = await lspTool.execute!({
      operation: 'rename',
      filePath: file,
      line: 1,
      character: 8,
    })

    expect(r.success).toBe(false)
    expect(r.error).toMatch(/newName/)
    expect(sendRequest).not.toHaveBeenCalled()
  })
})
