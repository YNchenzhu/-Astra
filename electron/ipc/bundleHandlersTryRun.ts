/**
 * Try-Run (sandbox single-shot LLM preview) handlers for bundles.
 */

import type { BrowserWindow } from 'electron'
import type { App } from 'electron'
import crypto from 'node:crypto'
import { z } from 'zod'
import { BUNDLE_IPC_CHANNELS } from './bundleHandlersChannels'
import { validatedHandle } from './validatedHandle'
import { MAX_SHORT, MAX_LONG } from './bundleHandlersSchemas'
import { listBundles } from '../agents/bundles/bundleRegistry'
import { getBuiltInAgent } from '../agents/builtInAgents'
import { composeSystemPrompt } from '../agents/bundles/bundleSerialize'
import { readDiskSettings } from '../settings/settingsAccess'
import { resolveAiCredentialsFromDisk } from '../ai/diskCredentials'
import type { ProviderConfig, ProviderId } from '../ai/client'
import {
  createInMemoryAgentLoopHost,
  runHostedAgentLoop,
} from '../orchestration/hostedAgentLoop'
import type { AgenticLoopCallbacks } from '../orchestration/phases/iteration'
import { toolRegistry } from '../tools/registry'
import { toolsToApiDefinitions } from '../agents/subAgentToolResolver'
import {
  consumePassiveLspDiagnosticsForPrompt,
  parseLspPassiveInjectMode,
} from '../lsp/formatDiagnosticsForPrompt'
import { shellExecutionToolInDefinitions } from '../tools/schema'
import { appendLspPassiveDiagnosticsBlock } from '../ai/systemPrompt'
import { extractMcpServerName } from '../ai/resolvePrimaryChatTools'

// In-flight runs keyed by runId. Values are AbortControllers so a
// renderer-side "取消" button can halt the stream mid-flight. Cleaned
// up on `end` / `error` / explicit cancel (see handlers below).
const tryRunControllers = new Map<string, AbortController>()

/**
 * Build a ProviderConfig from disk settings. Mirrors the pattern
 * streamHandler.ts uses — we centralize here for the try-run path so
 * the preview always uses the same provider as the main chat.
 */
const buildProviderConfig = (): ProviderConfig | null => {
  try {
    const settings = readDiskSettings()
    const creds = resolveAiCredentialsFromDisk(settings)
    if (!creds.apiKey && creds.providerId !== 'bedrock' && creds.providerId !== 'vertex') {
      // Most providers require an api key; bedrock / vertex can work
      // off ambient AWS/GCP creds. If neither apiKey nor cloud setup
      // is present, callers should surface the "未配置 API Key" hint.
      return null
    }
    return {
      id: creds.providerId as ProviderId,
      name: creds.providerId,
      apiKey: creds.apiKey ?? '',
      baseUrl: creds.baseUrl || undefined,
      awsRegion: creds.awsRegion,
      projectId: creds.projectId,
    }
  } catch (err) {
    console.warn('[bundleHandlers] buildProviderConfig failed:', err)
    return null
  }
}

/** Broadcast a try-run event to the main window. Guards against a
 *  destroyed window (renderer hot-reload / quit mid-stream). */
const sendTryRun = (
  getMainWindow: () => BrowserWindow | null | undefined,
  channel: string,
  payload: unknown,
): void => {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send(channel, payload)
  } catch (err) {
    console.warn(`[bundleHandlers] send ${channel} failed:`, err)
  }
}

export function registerTryRunHandlers(
  app: App,
  getMainWindow: () => BrowserWindow | null | undefined,
  getWorkspacePath: () => string | undefined | null,
): void {
  // `app` and `getWorkspacePath` are part of the public registration
  // contract (mirroring `registerBundleHandlers` so call sites stay
  // uniform) but the try-run preview path does not yet wire them through
  // — workspace-rooted tools are intentionally excluded from try-run
  // since the sandbox is meant to be path-free.  `void` discards them
  // explicitly to avoid `no-unused-vars` while documenting intent.
  void app
  void getWorkspacePath
  // bundle:try-run-agent — returns { ok: true, runId } synchronously,
  // then streams events. Caller tracks the runId so concurrent runs
  // and their cancellations stay disambiguated.
  validatedHandle(
    BUNDLE_IPC_CHANNELS.tryRun,
    z.tuple([
      z.object({
        bundleId: z.string().min(1).max(256),
        agentType: z.string().min(1).max(256),
        /** Conversation so far. Each run is stateless from the main
         *  process's POV — the renderer owns history and sends it back
         *  on every call. Keeps cancel/retry/reset trivially correct. */
        messages: z
          .array(
            z.object({
              role: z.enum(['user', 'assistant']),
              content: z.string().max(MAX_LONG * 8),
            }),
          )
          .min(1)
          .max(64),
        /** Optional model override — when unset, uses the agent's
         *  `model` (if set) or settings.model. */
        modelOverride: z.string().max(MAX_SHORT).optional(),
        /** Optional system prompt override — lets the UI feed a live
         *  draft prompt without needing to save first. */
        systemPromptOverride: z.string().max(MAX_LONG * 4).optional(),
      }),
    ]),
    async (_event, [params]) => {
      const { bundleId, agentType, messages, modelOverride, systemPromptOverride } = params

      // Resolve the agent entry. Try-Run is a *preview* of the requested
      // bundle, so all downstream capability gating must read from this
      // entry — the active bundle (if any) is irrelevant here.
      const entry = listBundles().find((b) => b.meta.id === bundleId)
      if (!entry) {
        return { ok: false as const, error: `未找到工作包 "${bundleId}"` }
      }
      const agent = entry.agents.find((a) => a.agentType === agentType)
      if (!agent) {
        return {
          ok: false as const,
          error: `未找到智能体 "${agentType}"(在 "${bundleId}" 里)`,
        }
      }

      // System prompt resolution:
      //   1. explicit override (renderer draft mode)
      //   2. composeSystemPrompt(agent, builtin.getSystemPrompt)
      //   3. empty (model still answers, just without a persona)
      let systemPrompt = ''
      if (typeof systemPromptOverride === 'string') {
        systemPrompt = systemPromptOverride
      } else {
        const builtin = getBuiltInAgent(agentType)
        systemPrompt = composeSystemPrompt(
          agent,
          builtin ? () => builtin.getSystemPrompt() : undefined,
        )
      }

      // Model resolution: override > agent.model (unless 'inherit') > settings
      const settings = readDiskSettings()
      const creds = resolveAiCredentialsFromDisk(settings)
      let model = modelOverride?.trim() || ''
      if (!model) {
        const agentModel = agent.model?.trim()
        if (agentModel && agentModel !== 'inherit') model = agentModel
      }
      if (!model) model = creds.model || 'claude-sonnet-4-5'

      const config = buildProviderConfig()
      if (!config) {
        return {
          ok: false as const,
          error:
            '未配置 API Key / 连接信息。请先在设置 · API 配置中完成,再试跑。',
        }
      }

      const runId = crypto.randomBytes(8).toString('hex')
      const controller = new AbortController()
      tryRunControllers.set(runId, controller)

      // TryRun enhancement: use agentic loop (read-only tools only) so the
      // preview exercises the agent's real tool-surface and reasoning path.
      let readOnlyTools = toolRegistry.getAll().filter((t) => t.isReadOnly === true)

      // Apply previewed-bundle capability overlay: even in preview, the
      // tool surface must not exceed *this* bundle's declared boundaries.
      // (Audit BUG-DD1 — previously read from `getActiveBundle()` which
      // overlaid the workspace's currently-active bundle's caps onto the
      // preview, producing misleading try-run results when the user is
      // previewing a different bundle than the one in use.)
      const previewCaps = entry.capabilities
      if (previewCaps) {
        const caps = previewCaps
        if (Array.isArray(caps.enabledTools) && caps.enabledTools.length > 0) {
          const allow = new Set(caps.enabledTools.map((n) => n.trim()))
          readOnlyTools = readOnlyTools.filter((t) => allow.has(t.name))
        }
        if (Array.isArray(caps.disallowedTools) && caps.disallowedTools.length > 0) {
          const deny = new Set(caps.disallowedTools.map((n) => n.trim()))
          readOnlyTools = readOnlyTools.filter((t) => !deny.has(t.name))
        }
        if (Array.isArray(caps.enabledMcpServers) && caps.enabledMcpServers.length > 0) {
          const mcpAllow = new Set(caps.enabledMcpServers.map((n) => n.trim()))
          readOnlyTools = readOnlyTools.filter((t) => {
            if (!t.name.startsWith('mcp__')) return true
            const server = extractMcpServerName(t.name)
            return server !== null && mcpAllow.has(server)
          })
        }
      }

      const toolDefinitions = toolsToApiDefinitions(readOnlyTools)

      const effectiveTemperature = agent.temperature ?? entry.capabilities?.temperature
      const effectiveTopP = agent.topP ?? entry.capabilities?.topP

      // Inject passive LSP diagnostics (same pattern as main chat & sub-agents)
      // method C: legacy upstream §9.3 shell-gate is opt-in via the
      // `lspPassiveDiagnosticsRequireShellTool` setting; default false.
      const lspInjectMode = parseLspPassiveInjectMode(settings.injectLspPassiveDiagnostics)
      if (lspInjectMode !== 'off') {
        const lspPassiveBlock = consumePassiveLspDiagnosticsForPrompt(lspInjectMode, {
          shellExecutionToolInListing: shellExecutionToolInDefinitions(toolDefinitions),
          requireShellTool: settings.lspPassiveDiagnosticsRequireShellTool === true,
        })
        systemPrompt = appendLspPassiveDiagnosticsBlock(systemPrompt, lspPassiveBlock)
      }

      const loopCallbacks: AgenticLoopCallbacks = {
        onTextDelta: (text) => {
          sendTryRun(getMainWindow, BUNDLE_IPC_CHANNELS.tryRunDelta, { runId, text })
        },
        onToolStart: (toolUse) => {
          sendTryRun(getMainWindow, BUNDLE_IPC_CHANNELS.tryRunDelta, {
            runId,
            text: `\n[工具开始: ${toolUse.name}]\n`,
          })
        },
        onToolResult: (toolResult) => {
          const summary = toolResult.success
            ? `[工具结果: ${toolResult.name}]`
            : `[工具错误: ${toolResult.name} — ${toolResult.error ?? 'unknown'}]`
          sendTryRun(getMainWindow, BUNDLE_IPC_CHANNELS.tryRunDelta, { runId, text: `\n${summary}\n` })
        },
        onMessageEnd: (usage) => {
          sendTryRun(getMainWindow, BUNDLE_IPC_CHANNELS.tryRunEnd, { runId, usage: usage ?? null })
          tryRunControllers.delete(runId)
        },
        onError: (error) => {
          sendTryRun(getMainWindow, BUNDLE_IPC_CHANNELS.tryRunError, { runId, error })
          tryRunControllers.delete(runId)
        },
      }

      void (async () => {
        try {
          const loopParams = {
              config,
              model,
              messages,
              systemPrompt,
              maxTokens: Math.min(creds.maxTokens ?? 4096, 8192),
              enableTools: toolDefinitions.length > 0,
              toolDefinitionsOverride: toolDefinitions,
              maxIterationsOverride: 5,
              signal: controller.signal,
              ...(effectiveTemperature !== undefined ? { temperature: effectiveTemperature } : {}),
              ...(effectiveTopP !== undefined ? { topP: effectiveTopP } : {}),
            }
          await runHostedAgentLoop(
            createInMemoryAgentLoopHost(loopParams),
            loopParams,
            loopCallbacks,
          )
        } catch (err) {
          if (!controller.signal.aborted) {
            sendTryRun(getMainWindow, BUNDLE_IPC_CHANNELS.tryRunError, {
              runId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
          tryRunControllers.delete(runId)
        }
      })()

      return { ok: true as const, runId, model, systemPromptLength: systemPrompt.length }
    },
  )

  // bundle:try-run-cancel — abort an in-flight run. Returns false when
  // the runId is unknown (already completed / never existed).
  validatedHandle(
    BUNDLE_IPC_CHANNELS.tryRunCancel,
    z.tuple([z.object({ runId: z.string().min(1).max(64) })]),
    async (_event, [{ runId }]) => {
      const controller = tryRunControllers.get(runId)
      if (!controller) return { ok: false as const }
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
      tryRunControllers.delete(runId)
      return { ok: true as const }
    },
  )
}
