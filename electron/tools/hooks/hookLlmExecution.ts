/**
 * upstream §9.2 — `prompt` and `agent` hook kinds use in-process LLM execution (not shell).
 *
 * - **prompt**: one non-tool model turn; `command` is inline template or `@file:relative/path` / `./file` under cwd.
 * - **agent**: short {@link runAgenticLoop} with read-only tools only; final hook JSON parsed from all streamed text deltas.
 *
 * Nested `prompt`/`agent` hooks are skipped while one is running (see {@link shouldDeferPromptOrAgentHook}).
 */

import path from 'node:path'
import fs from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { HookExecutionKind, HookResult } from './types'
import { HOOK_EXIT_BLOCKING } from './types'
import { hookStdoutToResponse } from './hookNormalize'
import { readDiskSettings } from '../../settings/settingsAccess'
import { resolveAiCredentialsFromDisk } from '../../ai/diskCredentials'
import {
  applyProviderDefaults,
  streamText,
  type ProviderConfig,
  type ProviderId,
} from '../../ai/client'
import { stripInlineThinkingXml } from '../../ai/stripInlineThinkingXml'
import type { ToolDefinition } from '../types'
import { getToolDefinitions } from '../schema'
import { toolRegistry } from '../registry'
import {
  createInMemoryAgentLoopHost,
  runHostedAgentLoop,
} from '../../orchestration/hostedAgentLoop'
import type { AgenticLoopParams } from '../../ai/agenticLoopTypes'
import {
  getAgentContext,
  runWithAgentContextAsync,
  type AgentContext,
} from '../../agents/agentContext'
import { generateQueryChainId } from '../../agents/queryTracking'
import { withQueryOverrideForLlmCall } from '../../agents/queryExecutionContext'
import { asAgentId } from '../ids'
import { DEFAULT_HOOK_TIMEOUT_MS, type CommandHookInput } from './execCommand'

const DEFAULT_HOOK_AGENT_TOOLS = 'read_file,list_files,glob,grep'
const DEFAULT_HOOK_AGENT_MAX_ITER = 6

/**
 * When a prompt/agent hook runs in a subprocess, AsyncLocalStorage has no parent;
 * the parent process injects {@link CLAUDE_HOOK_PARENT_AGENT_ID} / `_STREAM_CONVERSATION_ID`.
 */
function resolveHookAgentParent(env: Record<string, string>): AgentContext | undefined {
  const fromAls = getAgentContext()
  if (fromAls) return fromAls
  const id = env.CLAUDE_HOOK_PARENT_AGENT_ID?.trim()
  if (!id) return undefined
  return {
    agentId: id,
    streamConversationId: env.CLAUDE_HOOK_PARENT_STREAM_CONVERSATION_ID?.trim() || undefined,
  } as AgentContext
}

/**
 * Audit #7 — `hookLlmNestingDepth` was a module-level `let` shared across all
 * concurrent async chains. Multiple prompt/agent hooks kicked off in parallel
 * (e.g. from different sub-agent chains) could collide on the counter and see
 * wrong nesting depths, leading to either spurious recursion blocks or
 * recursion never being detected.
 *
 * We now thread a per-async-chain counter through {@link AsyncLocalStorage}.
 * `runWithHookLlmExecutionContext` establishes a scope; any async work started
 * inside the {@link beginHookLlmExecution}/{@link endHookLlmExecution} bracket
 * observes the same `depth` cell, independently of concurrent chains.
 *
 * Top-level code that never spawned a hook sees `depth = 0` (no scope), which
 * preserves the legacy "never defer" behavior for direct execution.
 */
type HookLlmFrame = { depth: number }

const hookLlmScope = new AsyncLocalStorage<HookLlmFrame>()

function currentFrame(): HookLlmFrame | undefined {
  return hookLlmScope.getStore()
}

/**
 * Execute `fn` inside a fresh hook-llm nesting frame (only the outermost call
 * creates the frame; nested calls reuse it so `endHookLlmExecution` decrements
 * the correct cell). Exported for tests / external callers that need to
 * explicitly open the scope before calling {@link beginHookLlmExecution}.
 */
export function withHookLlmFrame<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const existing = currentFrame()
  if (existing) return fn() as T | Promise<T>
  return hookLlmScope.run({ depth: 0 }, fn) as T | Promise<T>
}

export function beginHookLlmExecution(): void {
  const frame = currentFrame()
  if (frame) frame.depth++
}

export function endHookLlmExecution(): void {
  const frame = currentFrame()
  if (frame) frame.depth = Math.max(0, frame.depth - 1)
}

/** When >0, {@link runHooks} should not start another prompt/agent hook (prevents recursion). */
export function getHookLlmNestingDepth(): number {
  return currentFrame()?.depth ?? 0
}

export function shouldDeferPromptOrAgentHook(kind: HookExecutionKind | undefined): boolean {
  return getHookLlmNestingDepth() > 0 && (kind === 'prompt' || kind === 'agent')
}

const ARGUMENTS_TOKEN = /\$(?:\{ARGUMENTS\}|ARGUMENTS\b)/

function substituteHookPlaceholders(template: string, env: Record<string, string>): string {
  let out = template
  const stdinJson = env.CLAUDE_HOOK_STDIN_JSON ?? ''
  const pairs: Array<[string, string]> = [
    ['ARGUMENTS', stdinJson],
    ['CLAUDE_HOOK_STDIN_JSON', stdinJson],
    ['CLAUDE_TOOL_INPUT', env.CLAUDE_TOOL_INPUT ?? ''],
    ['CLAUDE_HOOK_EVENT', env.CLAUDE_HOOK_EVENT ?? ''],
    ['CLAUDE_TOOL_NAME', env.CLAUDE_TOOL_NAME ?? ''],
    ['CLAUDE_CWD', env.CLAUDE_CWD ?? env.CLAUDE_PROJECT_DIR ?? ''],
    ['CLAUDE_PROJECT_DIR', env.CLAUDE_PROJECT_DIR ?? env.CLAUDE_CWD ?? ''],
    ['CLAUDE_TOOL_OUTPUT', env.CLAUDE_TOOL_OUTPUT ?? ''],
    ['CLAUDE_TOOL_SUCCESS', env.CLAUDE_TOOL_SUCCESS ?? ''],
  ]
  for (const [k, v] of pairs) {
    out = out.split(`\${${k}}`).join(v)
    out = out.split(`$${k}`).join(v)
  }
  return out
}

function finalizeHookPromptBody(rawTemplate: string, env: Record<string, string>): string {
  const hasArguments = ARGUMENTS_TOKEN.test(rawTemplate)
  const out = substituteHookPlaceholders(rawTemplate, env)
  const stdinJson = env.CLAUDE_HOOK_STDIN_JSON ?? ''
  if (!hasArguments && stdinJson) {
    return `${out.trimEnd()}\n\n${stdinJson}\n`
  }
  return out
}

function isPathInsideOrEqualDir(fileAbs: string, rootAbs: string): boolean {
  const rel = path.relative(rootAbs, fileAbs)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Load prompt body: `@file:rel`, `./x`, `../x`, or absolute path → file under cwd; else inline template.
 */
export function resolveHookPromptTemplate(command: string, cwd: string, env: Record<string, string>): string {
  const t = command.trim()
  if (t.startsWith('@file:')) {
    const rel = t.slice('@file:'.length).trim()
    return finalizeHookPromptBody(readHookTemplateFile(cwd, rel), env)
  }
  if (t.startsWith('./') || t.startsWith('../') || path.isAbsolute(t)) {
    const rel = t.startsWith('./') || t.startsWith('../') ? t : t
    return finalizeHookPromptBody(readHookTemplateFile(cwd, rel), env)
  }
  return finalizeHookPromptBody(t, env)
}

function readHookTemplateFile(cwd: string, relOrAbs: string): string {
  const resolved = path.isAbsolute(relOrAbs)
    ? path.normalize(relOrAbs)
    : path.resolve(cwd, relOrAbs)
  const root = path.resolve(cwd)
  if (!isPathInsideOrEqualDir(resolved, root)) {
    throw new Error(`Hook template path escapes cwd: ${relOrAbs}`)
  }
  return fs.readFileSync(resolved, 'utf-8')
}

function extractJsonPayload(text: string): string | null {
  const t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) return fence[1]!.trim()
  const i = t.indexOf('{')
  const j = t.lastIndexOf('}')
  if (i >= 0 && j > i) return t.slice(i, j + 1)
  return null
}

function parseProviderId(raw: string): ProviderId {
  const allowed: ProviderId[] = [
    'anthropic',
    'openai',
    'openai2',
    'gemini',
    'bedrock',
    'vertex',
    'foundry',
    'compatible',
    'dashscope',
    'minimax',
    'zhipu',
    'kimi',
    'deepseek',
  ]
  const s = raw.trim().toLowerCase()
  return (allowed.includes(s as ProviderId) ? s : 'anthropic') as ProviderId
}

export function resolveHookLlmRuntime(
  env: Record<string, string>,
): { config: ProviderConfig; model: string; maxTokens: number } | { error: string } {
  const parent = getAgentContext()
  const disk = resolveAiCredentialsFromDisk(readDiskSettings())
  const envProvider = env.CLAUDE_HOOK_PROVIDER_ID?.trim()
  const providerId = parseProviderId(envProvider || disk.providerId || parent?.config.id || 'anthropic')

  const apiKey =
    (env.CLAUDE_HOOK_API_KEY?.trim() ||
      disk.apiKey ||
      parent?.config.apiKey ||
      '') as string

  const baseUrl =
    env.CLAUDE_HOOK_BASE_URL?.trim() ||
    disk.baseUrl ||
    parent?.config.baseUrl ||
    undefined

  const model =
    env.CLAUDE_HOOK_MODEL?.trim() ||
    disk.model ||
    parent?.model ||
    'claude-sonnet-4-20250514'

  const maxTokRaw = env.CLAUDE_HOOK_MAX_TOKENS?.trim()
  const maxTokens =
    maxTokRaw && Number.isFinite(Number(maxTokRaw))
      ? Math.min(8192, Math.max(256, Number(maxTokRaw)))
      : Math.min(4096, disk.maxTokens || 2048)

  if (!apiKey.trim() && providerId !== 'compatible') {
    return {
      error:
        'prompt/agent hook: no API key (set CLAUDE_HOOK_API_KEY or disk settings / parent agent config)',
    }
  }

  const config = applyProviderDefaults({
    id: providerId,
    name: providerId,
    apiKey,
    baseUrl,
    awsRegion: env.CLAUDE_HOOK_AWS_REGION?.trim() || disk.awsRegion || parent?.config.awsRegion,
    projectId: env.CLAUDE_HOOK_PROJECT_ID?.trim() || disk.projectId || parent?.config.projectId,
  })

  return { config, model, maxTokens }
}

const PROMPT_HOOK_SYSTEM = `You are a Claude Code lifecycle hook. Reply with a single JSON object only (no markdown fences unless they wrap only JSON), matching hook stdout schema: fields like continue, permissionDecision, decision, updatedInput, additionalContext, reason, preventContinuation, hookSpecificOutput with hookEventName when applicable. No other prose.`

const AGENT_HOOK_SYSTEM = `You are a Claude Code lifecycle hook running as a short agent. You may call read-only tools. When finished, your last message must be only a JSON object (hook response): continue, permissionDecision, decision, updatedInput, additionalContext, reason, preventContinuation, hookSpecificOutput, etc. No markdown outside JSON.`

function filterReadOnlyHookTools(env: Record<string, string>): ToolDefinition[] {
  const raw = env.CLAUDE_HOOK_AGENT_TOOLS?.trim() || DEFAULT_HOOK_AGENT_TOOLS
  const allow = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  const all = getToolDefinitions(undefined)
  return all.filter((t) => allow.has(t.name) && isToolReadOnlyByName(t.name))
}

function isToolReadOnlyByName(name: string): boolean {
  const tool = toolRegistry.get(name)
  return tool?.isReadOnly === true
}

function hookAgentMaxIterations(env: Record<string, string>): number {
  const raw = env.CLAUDE_HOOK_AGENT_MAX_ITERATIONS?.trim()
  if (raw && Number.isFinite(Number(raw))) {
    return Math.min(20, Math.max(1, Number(raw)))
  }
  return DEFAULT_HOOK_AGENT_MAX_ITER
}

export function execPromptHookModel(input: CommandHookInput): Promise<HookResult> {
  return Promise.resolve(withHookLlmFrame(() => execPromptHookModelInner(input)))
}

async function execPromptHookModelInner(input: CommandHookInput): Promise<HookResult> {
  const { env, cwd, timeoutMs = DEFAULT_HOOK_TIMEOUT_MS.prompt } = input
  const rt = resolveHookLlmRuntime(env)
  if ('error' in rt) {
    return { exitCode: HOOK_EXIT_BLOCKING, stdout: '', stderr: rt.error }
  }
  let userBody: string
  try {
    userBody = resolveHookPromptTemplate(input.command, cwd, env)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { exitCode: HOOK_EXIT_BLOCKING, stdout: '', stderr: `prompt hook template: ${msg}` }
  }

  const ac = AbortSignal.timeout(Math.max(5000, Math.min(600_000, timeoutMs)))
  let accumulated = ''
  let streamErr: string | null = null

  beginHookLlmExecution()
  try {
    await withQueryOverrideForLlmCall('sdk', async () => {
      await streamText(
        rt.config,
        {
          model: rt.model,
          maxTokens: rt.maxTokens,
          messages: [{ role: 'user', content: userBody }],
          systemPrompt: PROMPT_HOOK_SYSTEM,
          alwaysThinking: false,
          streamRetries: 1,
        },
        {
          onTextDelta: (d) => {
            accumulated += d
          },
          onMessageEnd: () => {},
          onError: (msg) => {
            streamErr = msg
          },
        },
        ac,
      )
    })
  } finally {
    endHookLlmExecution()
  }

  if (streamErr) {
    return { exitCode: HOOK_EXIT_BLOCKING, stdout: accumulated.trim(), stderr: streamErr }
  }

  // 3P thinking gateways sometimes inline chain-of-thought as <thinking>/<think>
  // XML even when extended-thinking isn't activated on the wire. Strip before
  // JSON-payload extraction so the parser doesn't pick up text inside reasoning.
  accumulated = stripInlineThinkingXml(accumulated)
  const json = extractJsonPayload(accumulated) ?? accumulated.trim()
  const parsed = hookStdoutToResponse(json) ?? hookStdoutToResponse(accumulated)
  return {
    exitCode: 0,
    stdout: json,
    stderr: '',
    parsedOutput: parsed ?? undefined,
  }
}

export function execAgentHookModel(input: CommandHookInput): Promise<HookResult> {
  return Promise.resolve(withHookLlmFrame(() => execAgentHookModelInner(input)))
}

async function execAgentHookModelInner(input: CommandHookInput): Promise<HookResult> {
  const { env, cwd, timeoutMs = DEFAULT_HOOK_TIMEOUT_MS.agent } = input
  const rt = resolveHookLlmRuntime(env)
  if ('error' in rt) {
    return { exitCode: HOOK_EXIT_BLOCKING, stdout: '', stderr: rt.error }
  }

  let task: string
  try {
    task = resolveHookPromptTemplate(input.command, cwd, env)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { exitCode: HOOK_EXIT_BLOCKING, stdout: '', stderr: `agent hook template: ${msg}` }
  }

  const tools = filterReadOnlyHookTools(env)
  if (tools.length === 0) {
    return {
      exitCode: HOOK_EXIT_BLOCKING,
      stdout: '',
      stderr:
        'agent hook: no read-only tools matched CLAUDE_HOOK_AGENT_TOOLS (default read_file,list_files,glob,grep)',
    }
  }

  const parent = resolveHookAgentParent(env)
  const ac = AbortSignal.timeout(Math.max(10_000, Math.min(900_000, timeoutMs)))
  let accumulated = ''
  let streamErr: string | null = null

  const hookCtx: AgentContext = {
    config: rt.config,
    model: rt.model,
    systemPrompt: AGENT_HOOK_SYSTEM,
    systemPromptLayers: { systemContext: AGENT_HOOK_SYSTEM, userContext: '', userMessageContext: '' },
    messages: [],
    signal: ac,
    agentId: asAgentId(`hook_agent_${Date.now()}`),
    querySource: 'sdk',
    queryChainId: generateQueryChainId(),
    // Audit fix (hooks B-P0-3): agent hooks used to run under
    // `bypassPermissions`, so a hallucinated / prompt-injected call to a
    // tool OUTSIDE the read-only wire list (the model can name any tool)
    // executed without any gate. Two changes:
    //   1. `allowedToolNamesForRuntime` — hard runtime allowlist; calls to
    //      tools not in the read-only set are rejected before execution.
    //   2. permission mode 'default' instead of blanket bypass — the
    //      whitelisted tools are all read-only and never require the
    //      permission UI, so legit hook behaviour is unchanged.
    permissionModeOverride: 'default',
    allowedToolNamesForRuntime: tools.map((t) => t.name),
    policyTier: 'inherit',
    ...(parent?.streamConversationId
      ? { parentAgentId: parent.agentId, streamConversationId: undefined }
      : {}),
  }

  beginHookLlmExecution()
  try {
    await runWithAgentContextAsync(hookCtx, async () => {
      const loopParams: AgenticLoopParams = {
          config: rt.config,
          model: rt.model,
          messages: [
            {
              role: 'user',
              content:
                `${task}\n\n---\nHook stdin (JSON): ${env.CLAUDE_HOOK_STDIN_JSON || env.CLAUDE_TOOL_INPUT || '{}'}\nEvent: ${env.CLAUDE_HOOK_EVENT || ''}\nTool: ${env.CLAUDE_TOOL_NAME || ''}\n`,
            },
          ],
          systemPrompt: AGENT_HOOK_SYSTEM,
          systemPromptLayers: hookCtx.systemPromptLayers,
          maxTokens: rt.maxTokens,
          enableTools: true,
          toolDefinitionsOverride: tools,
          maxIterationsOverride: hookAgentMaxIterations(env),
          signal: ac,
          alwaysThinking: false,
          // Read-only allowlist (enforced via allowedToolNamesForRuntime on
          // the ALS context above) is the hard gate — no diff/file writes can
          // reach execution, so the previous `diffPermissionMode:
          // 'bypassPermissions'` grant is gone. `allow` keeps whitelisted
          // read-only tools running without a permission UI (hooks are
          // headless and cannot answer prompts).
          permissionDefaultMode: 'allow',
          permissionRules: [],
        }
      return runHostedAgentLoop(
        createInMemoryAgentLoopHost(loopParams),
        loopParams,
        {
          onTextDelta: (t) => {
            accumulated += t
          },
          onMessageEnd: () => {},
          onError: (msg) => {
            streamErr = msg
          },
          onToolStart: () => {},
          onToolResult: () => {},
        },
      )
    })
  } finally {
    endHookLlmExecution()
  }

  if (streamErr) {
    return { exitCode: HOOK_EXIT_BLOCKING, stdout: accumulated.trim(), stderr: streamErr }
  }

  // 3P thinking gateways sometimes inline chain-of-thought as <thinking>/<think>
  // XML even when extended-thinking isn't activated on the wire. Strip before
  // JSON-payload extraction so the parser doesn't pick up text inside reasoning.
  accumulated = stripInlineThinkingXml(accumulated)
  const json = extractJsonPayload(accumulated) ?? accumulated.trim()
  const parsed = hookStdoutToResponse(json) ?? hookStdoutToResponse(accumulated)
  return {
    exitCode: 0,
    stdout: json,
    stderr: '',
    parsedOutput: parsed ?? undefined,
  }
}
