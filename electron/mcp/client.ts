/**
 * MCP Client Manager.
 * Manages connections to multiple MCP servers, discovers their tools,
 * and executes tool calls.
 *
 * NOTE: @modelcontextprotocol/sdk is loaded dynamically via import()
 * to avoid rolldown bundling issues with its internal require("child_process").
 *
 * Persistence: `mcp-servers.json` holds **all** saved server rows. The in-memory
 * map only tracks **currently connected** sessions; connect/disconnect must not
 * rewrite the file to "connected only" (that would drop disconnected entries).
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { writeJsonFileAtomic } from '../fs/atomicWrite'
import { createTransport, type MCPServerConfig } from './transport'
import { applyFilesystemMcpWorkspaceRoot } from './filesystemWorkspaceArgs'
import { normalizeStdioNpxMcpConfig } from './mcpConfigNormalize'
import { fullResyncMcpRegistry } from './fullResyncMcpRegistry'
import {
  clearMcpServerInstructions,
  setMcpServerInstructions,
} from './instructionsTracker'

interface MCPTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** Normalized MCP tool result for app code (registry, UI). SDK may return `content` or `toolResult`. */
export type MCPToolCallNormalizedResult = {
  content: Array<{ type: string; text?: string; data?: unknown }>
  isError?: boolean
}

function normalizeMcpCallToolResult(raw: unknown): MCPToolCallNormalizedResult {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return {
      content: [{ type: 'text', text: raw === undefined || raw === null ? '' : String(raw) }],
    }
  }
  const o = raw as Record<string, unknown>
  const isError = typeof o.isError === 'boolean' ? o.isError : undefined

  if (Array.isArray(o.content)) {
    const content = o.content.map((block): MCPToolCallNormalizedResult['content'][number] => {
      if (block !== null && typeof block === 'object') {
        const b = block as Record<string, unknown>
        return {
          type: typeof b.type === 'string' ? b.type : 'text',
          ...(typeof b.text === 'string' ? { text: b.text } : {}),
          ...(b.data !== undefined ? { data: b.data } : {}),
        }
      }
      return { type: 'text', text: String(block) }
    })
    return { content, isError }
  }

  if ('toolResult' in o) {
    const tr = o.toolResult
    const text = typeof tr === 'string' ? tr : JSON.stringify(tr)
    return { content: [{ type: 'text', text }], isError }
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(o) }],
    isError,
  }
}

async function createMCPClient() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  return new Client({ name: 'astra-ui-clone', version: '0.0.1' })
}

/**
 * BUG-M5 helper: chain a "transport closed" listener so the MCP manager
 * can clear stale state when the child process / SSE connection dies.
 * The MCP SDK transports expose `onclose` (best-effort) and stdio
 * transports back their child process via `_process` or `process`.
 * We listen on whichever surface is available and merge the existing
 * `onclose` (if any) so we don't break the SDK's own teardown chain.
 */
function attachTransportCloseHandler(transport: Transport, handler: () => void): void {
  let fired = false
  const fire = () => {
    if (fired) return
    fired = true
    try {
      handler()
    } catch (e) {
      console.warn('[MCP] transport close handler threw:', e)
    }
  }
  type TransportWithClose = Transport & { onclose?: (() => void) | null }
  const t = transport as TransportWithClose
  const prev = typeof t.onclose === 'function' ? t.onclose : null
  t.onclose = () => {
    try { prev?.() } catch { /* ignore */ }
    fire()
  }
  type ProcessHolder = {
    _process?: { on: (event: string, listener: () => void) => void }
    process?: { on: (event: string, listener: () => void) => void }
  }
  const holder = transport as unknown as ProcessHolder
  const proc = holder._process ?? holder.process
  if (proc && typeof proc.on === 'function') {
    try {
      proc.on('exit', fire)
      proc.on('close', fire)
    } catch {
      /* SDK private surface may differ; onclose is the primary path */
    }
  }
}

type AppMCPClient = Awaited<ReturnType<typeof createMCPClient>>

interface MCPServerConnection {
  config: MCPServerConfig
  client: AppMCPClient
  tools: MCPTool[]
  connected: boolean
  resourceCount: number
  /** 保存 transport 引用以便强制关闭 stdio 子进程 */
  transport?: Transport
}

export interface MCPServerListRow {
  name: string
  transport: string
  connected: boolean
  toolCount: number
  resourceCount: number
  status: string
  lastError?: string
  lastConnectedAt?: number
}

class MCPClientManager {
  private servers = new Map<string, MCPServerConnection>()
  private configPath: string
  /**
   * Serialized writer chain. All on-disk mutations to `mcp-servers.json`
   * run through this chain so concurrent `connect` / `disconnect` / `save`
   * cannot interleave read-modify-write cycles and produce torn JSON or
   * lose rows. Writes themselves go through {@link writeJsonFileAtomic}
   * (temp file + rename) so even a crash mid-write leaves the prior file
   * intact instead of a zero-length stub.
   */
  private writeChain: Promise<void> = Promise.resolve()

  /**
   * BUG-M3 fix: per-server lifecycle (connect/disconnect/reconnect) lock.
   * Two concurrent `connect("foo")` calls would both see `servers.has("foo")
   * === false`, both create transports, and the second `set()` would orphan
   * the first transport's child process. Serialize per name so callers
   * compose deterministically — concurrent calls to *different* servers
   * still parallelize.
   */
  private serverOpChains = new Map<string, Promise<unknown>>()

  constructor(configPath: string) {
    this.configPath = configPath
  }

  /**
   * BUG-M3 helper: chain `op` after any pending lifecycle op for `serverName`,
   * keep the chain alive past rejections (so a single failure never wedges
   * later operations on the same server), and return op's result.
   */
  private async withServerLock<T>(serverName: string, op: () => Promise<T>): Promise<T> {
    const prev = this.serverOpChains.get(serverName) ?? Promise.resolve()
    let resolveNext: (value: unknown) => void = () => {}
    const next = new Promise<unknown>((r) => (resolveNext = r))
    this.serverOpChains.set(
      serverName,
      prev.catch(() => undefined).then(() => next),
    )
    try {
      await prev.catch(() => undefined)
      return await op()
    } finally {
      resolveNext(undefined)
      // Drop the slot when this chain is the tail (avoid unbounded growth).
      queueMicrotask(() => {
        if (this.serverOpChains.get(serverName) === next) {
          this.serverOpChains.delete(serverName)
        }
      })
    }
  }

  /**
   * Enqueue a mutation against the on-disk config list and wait for it.
   * Each mutator receives the freshest `loadConfigs()` result so it can
   * compose its update on top of whatever the previous write produced.
   */
  private queueConfigMutation(
    label: string,
    mutator: (all: MCPServerConfig[]) => MCPServerConfig[] | void,
  ): Promise<void> {
    const next = this.writeChain.then(async () => {
      try {
        const all = this.loadConfigs()
        const result = mutator(all)
        const out = Array.isArray(result) ? result : all
        writeJsonFileAtomic(this.configPath, out)
      } catch (e) {
        console.warn(`[MCP] ${label} failed:`, e)
      }
    })
    // Keep chain alive even on rejection so later writers still serialize.
    this.writeChain = next.catch(() => undefined)
    return next
  }

  /**
   * Merge one server row into the on-disk list; other saved rows are preserved.
   */
  mergeServerConfigIntoFile(config: MCPServerConfig): Promise<void> {
    return this.queueConfigMutation('mergeServerConfigIntoFile', (all) => {
      const i = all.findIndex((c) => c.name === config.name)
      const merged = { ...(i >= 0 ? all[i] : {}), ...config } as MCPServerConfig
      if (i >= 0) all[i] = merged
      else all.push(merged)
      return all
    })
  }

  patchServerFieldsInFile(serverName: string, patch: Partial<MCPServerConfig>): void {
    void this.queueConfigMutation('patchServerFieldsInFile', (all) => {
      const i = all.findIndex((c) => c.name === serverName)
      if (i < 0) return all
      all[i] = { ...all[i], ...patch } as MCPServerConfig
      return all
    })
  }

  /**
   * Replace the full on-disk config list (used by `mcp:save-configs` /
   * project-approve flows). Runs through the same serialized writer chain
   * as the merge/patch helpers so it cannot interleave with concurrent
   * connect/disconnect mutations.
   */
  async replaceAllConfigs(configs: MCPServerConfig[]): Promise<void> {
    await this.queueConfigMutation('replaceAllConfigs', () => configs.slice())
  }

  async connect(
    config: MCPServerConfig,
    options?: { workspacePathHint?: string | null },
  ): Promise<MCPTool[]> {
    return this.withServerLock(config.name, () => this.connectInner(config, options))
  }

  private async connectInner(
    config: MCPServerConfig,
    options?: { workspacePathHint?: string | null },
  ): Promise<MCPTool[]> {
    if (this.servers.has(config.name)) {
      await this.disconnectInner(config.name)
    }

    const resolved = applyFilesystemMcpWorkspaceRoot(
      normalizeStdioNpxMcpConfig(config),
      options?.workspacePathHint,
    )
    const transport = await createTransport(resolved)
    const client = await createMCPClient()

    await client.connect(transport)

    // Capture the MCP server's `instructions` field (from InitializeResult)
    // for the `mcp_instructions_delta` host-attachment collector. Best-effort
    // — different SDK versions expose it via different getters, and a
    // server may not publish any instructions at all. A throw here must
    // not break the connect path.
    try {
      const sdkClient = client as unknown as {
        getInstructions?: () => string | undefined
        getServerVersion?: () => { instructions?: string | null } | undefined
      }
      const fromGetter =
        typeof sdkClient.getInstructions === 'function'
          ? sdkClient.getInstructions()
          : undefined
      const fromServerInfo =
        typeof sdkClient.getServerVersion === 'function'
          ? sdkClient.getServerVersion()?.instructions
          : undefined
      setMcpServerInstructions(config.name, fromGetter ?? fromServerInfo ?? '')
    } catch {
      // Silently skip — the collector treats absence as "no change".
    }

    // BUG-M5 fix: detect child-process / transport death so the next
    // tool call doesn't dispatch into a stale connection. The MCP SDK's
    // `client.transport` exposes an `onclose` callback we can chain into.
    // Cleanup is best-effort: when the transport reports closed we drop
    // the server map entry and log; reconnects are opt-in via the
    // existing `reconnectServer` API.
    attachTransportCloseHandler(transport, () => {
      const live = this.servers.get(config.name)
      if (!live || live.transport !== transport) return
      console.warn(
        `[MCP] server "${config.name}" transport closed unexpectedly; clearing live entry. Call reconnectServer to restore.`,
      )
      this.servers.delete(config.name)
      this.patchServerFieldsInFile(config.name, {
        lastError: 'transport closed unexpectedly',
      })
    })

    const toolsResult = await client.listTools()
    const tools = toolsResult.tools || []

    let resourceCount = 0
    try {
      const lr = await client.listResources()
      resourceCount = lr.resources?.length ?? 0
    } catch {
      resourceCount = 0
    }

    const prev = this.loadConfigs().find((c) => c.name === config.name)
    // Default true: launch will auto-reconnect unless user opted out via disconnect(..., false).
    const mergedConfig: MCPServerConfig = {
      ...prev,
      ...config,
      command: resolved.command,
      args: [...resolved.args],
      lastError: undefined,
      lastConnectedAt: Date.now(),
      resourceCount,
      autoConnectOnLaunch: config.autoConnectOnLaunch ?? prev?.autoConnectOnLaunch ?? true,
    }

    this.servers.set(config.name, {
      config: mergedConfig,
      client,
      tools,
      connected: true,
      resourceCount,
      transport, // 保存 transport 引用
    })

    this.mergeServerConfigIntoFile(mergedConfig)
    return tools
  }

  async disconnect(serverName: string): Promise<void> {
    return this.withServerLock(serverName, () => this.disconnectInner(serverName))
  }

  private async disconnectInner(serverName: string): Promise<void> {
    const conn = this.servers.get(serverName)
    if (!conn) return

    // Drop the instructions tracker entry up-front so the
    // `mcp_instructions_delta` collector can surface this server as
    // `removed` on its next post-tool pass. Idempotent — no-op when
    // the server never published instructions.
    clearMcpServerInstructions(serverName)

    try {
      // 尝试优雅关闭，500ms 超时
      await Promise.race([
        conn.client.close(),
        new Promise((resolve) => setTimeout(resolve, 500))
      ])
    } catch {
      // ignore
    }

    // 强制终止 stdio transport 的子进程
    if (conn.transport && typeof conn.transport === 'object') {
      try {
        // StdioClientTransport 在 SDK 内部把子进程挂在 `_process` 或
        // `process` 上（不同 SDK 版本字段名不同）；声明一个最小结构去
        // 读取这些“私有”字段，避免落回 `any`。
        type ProcessHolder = {
          _process?: { kill: (signal?: NodeJS.Signals) => boolean; killed: boolean }
          process?: { kill: (signal?: NodeJS.Signals) => boolean; killed: boolean }
        }
        const holder = conn.transport as unknown as ProcessHolder
        const proc = holder._process || holder.process
        if (proc && typeof proc.kill === 'function') {
          try {
            if (!proc.killed) {
              proc.kill('SIGTERM')
              // 等待 200ms 后强制 SIGKILL
              await new Promise((resolve) => setTimeout(resolve, 200))
              if (!proc.killed) {
                proc.kill('SIGKILL')
              }
            }
          } catch {
            // 进程可能已经退出
          }
        }
      } catch {
        // transport 结构可能不同，忽略
      }
    }

    this.servers.delete(serverName)
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<MCPToolCallNormalizedResult> {
    const conn = this.servers.get(serverName)
    if (!conn || !conn.connected) {
      throw new Error(`Server "${serverName}" is not connected`)
    }
    const raw: unknown = await conn.client.callTool({ name: toolName, arguments: args })
    return normalizeMcpCallToolResult(raw)
  }

  async reconnectServer(
    serverName: string,
    options?: { workspacePathHint?: string | null },
  ): Promise<MCPTool[]> {
    const cfg = this.loadConfigs().find((c) => c.name === serverName)
    if (!cfg) {
      throw new Error(`No saved config for "${serverName}"`)
    }
    // MCP-02: force tool re-sync after reconnect so newly-added tools
    // become visible to the agent immediately. Without this the agent
    // continues using the stale tool list from the previous connection.
    // `fullResyncMcpRegistry` only references this module via `import type`,
    // so a static import here does not create a runtime cycle.
    const result = await this.connect(cfg, options)
    fullResyncMcpRegistry(this)
    return result
  }

  listServers(): Array<{ name: string; transport: string; connected: boolean; toolCount: number }> {
    return [...this.servers.values()].map((conn) => ({
      name: conn.config.name,
      transport: conn.config.transport,
      connected: conn.connected,
      toolCount: conn.tools.length,
    }))
  }

  /** One row per **saved** config, merged with live connection state. */
  listServersDetailed(): MCPServerListRow[] {
    const saved = this.loadConfigs()
    return saved.map((cfg) => {
      const live = this.servers.get(cfg.name)
      if (live) {
        return {
          name: cfg.name,
          transport: cfg.transport,
          connected: true,
          toolCount: live.tools.length,
          resourceCount: live.resourceCount,
          status: 'connected',
          lastError: live.config.lastError,
          lastConnectedAt: live.config.lastConnectedAt,
        }
      }
      return {
        name: cfg.name,
        transport: cfg.transport,
        connected: false,
        toolCount: 0,
        resourceCount: cfg.resourceCount ?? 0,
        status: cfg.lastError ? 'error' : 'disconnected',
        lastError: cfg.lastError,
        lastConnectedAt: cfg.lastConnectedAt,
      }
    })
  }

  getAllTools(): Array<{ serverName: string; tool: MCPTool }> {
    const result: Array<{ serverName: string; tool: MCPTool }> = []
    for (const [serverName, conn] of this.servers) {
      for (const tool of conn.tools) {
        result.push({ serverName, tool })
      }
    }
    return result
  }

  resolveTool(fullToolName: string): { serverName: string; toolName: string } | null {
    for (const [serverName, conn] of this.servers) {
      for (const tool of conn.tools) {
        const prefixed = `mcp__${serverName}__${tool.name}`
        if (prefixed === fullToolName || tool.name === fullToolName) {
          return { serverName, toolName: tool.name }
        }
      }
    }
    return null
  }

  getConfig(serverName: string): MCPServerConfig | undefined {
    return this.servers.get(serverName)?.config
  }

  getClient(serverName: string): AppMCPClient | undefined {
    return this.servers.get(serverName)?.client
  }

  loadConfigs(): MCPServerConfig[] {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'))
        return Array.isArray(raw) ? raw : []
      }
    } catch {
      // ignore
    }
    return []
  }

  async disconnectAll(): Promise<void> {
    const names = [...this.servers.keys()]
    await Promise.all(names.map((name) => this.disconnect(name)))
  }

  async listResourcesForServer(serverName: string): Promise<
    Array<{ uri: string; name: string; description?: string; mimeType?: string }>
  > {
    const client = this.getClient(serverName)
    if (!client) {
      throw new Error(`Server "${serverName}" is not connected`)
    }
    const lr = await client.listResources()
    return (lr.resources || []).map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }))
  }

  async readResourceForServer(
    serverName: string,
    uri: string,
    tempDir: string,
  ): Promise<Array<{ uri: string; mimeType?: string; text?: string; blobSavedTo?: string }>> {
    const client = this.getClient(serverName)
    if (!client) {
      throw new Error(`Server "${serverName}" is not connected`)
    }
    const result = await client.readResource({ uri })
    const out: Array<{ uri: string; mimeType?: string; text?: string; blobSavedTo?: string }> = []
    for (const c of result.contents || []) {
      if ('text' in c && typeof c.text === 'string') {
        out.push({ uri: c.uri, mimeType: c.mimeType, text: c.text })
      } else if ('blob' in c && typeof c.blob === 'string') {
        fs.mkdirSync(tempDir, { recursive: true })
        const safe = Buffer.from(uri).toString('base64url').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
        const dest = path.join(tempDir, `${serverName}-${safe}-${Date.now()}.bin`)
        fs.writeFileSync(dest, Buffer.from(c.blob, 'base64'))
        out.push({ uri: c.uri, mimeType: c.mimeType, blobSavedTo: dest })
      }
    }
    return out
  }

  async pingServer(serverName: string): Promise<void> {
    const client = this.getClient(serverName)
    if (!client) {
      throw new Error(`Server "${serverName}" is not connected`)
    }
    await client.ping()
  }
}

export { MCPClientManager, type MCPServerConnection }
