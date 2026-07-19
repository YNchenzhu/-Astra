/**
 * Internal implementation of `runAgenticToolUse` — extracted to keep the
 * public entry point small.
 */

import fs from 'node:fs'
import { toolRegistry } from '../tools/registry'
import { taskRuntimeStore } from '../tools/TaskRuntimeStore'
import {
  getPermissionMode,
  getDiffPermissionMode,
  requestPermission,
  emit as emitStreamEvent,
  type DiffPreview,
} from './interactionState'
import {
  awaitTeamLeaderToolPermission,
  isWorkerToolPermissionDelegatedToTeamLeader,
} from '../agents/teamPermissionLeaderBridge'
import type { HookResponse } from '../tools/hooks/types'
import { updateFromToolUse } from '../session/service'
import {
  computeFileEditResult,
  computeFileEditResultMulti,
  normalizeOneFileEdit,
} from './fileEditSemantics'
import { assertPreWriteIntegrity } from '../tools/writeIntegrityGuard'
import { stripInternalToolArgMarkers } from './transformer/parseToolArguments'
import { computeFileMutationRiskWarnings } from './fileMutationRisk'
import {
  createDiffTransactionFromPreview,
  shadowMarkPermissionApproved,
  shadowMarkPermissionRejected,
  shadowResolveToolResult,
} from '../diff'
import type { DiffTxId } from '../diff'
import {
  canonicalBuiltinToolName,
  registryPrimaryToolName,
  isAgenticFullFileReplaceTool,
  isAgenticWorkspaceFileDiffTool,
  isAgenticWorkspaceFileMutationTool,
  extractWorkspaceFilePathFromToolInput,
  isBuiltinMultiEditTool,
  isMcpWorkspaceFileDiffTool,
  toRendererFileToolName,
} from '../tools/builtinToolAliases'
import { extractMcpServerName } from '../agents/subAgentToolResolver'
import { buildLspDiagnosticsTrailer } from '../lsp/lspDiagnosticsTrailer'
import { resolvePathForTool } from '../tools/workspaceState'
import { isResolvedPathInKnownMemoryWritableTree } from '../memory/memoryPathGate'
import { recordMainAgentMemoryWrite } from '../memory/extractionState'
import {
  recordSuccessfulRead,
  findCurrentReadIdForPath,
  findReadReceiptByReadId,
  hasCurrentScopeReceiptMatchingDisk,
} from '../tools/readFileState'
import { anchorEdit as anchorKeepRateEdit } from '../telemetry/keepRate'
import { getWorkspacePath } from '../tools/workspaceState'
import {
  hookWorkspaceCwd,
  runPreToolUsePhase,
  runPermissionHookPhase,
  permissionHookAutoAllow,
  permissionHookAutoDeny,
  runPostToolHooksSafe,
  mergeHookUpdatedInputValidated,
} from './hookIntegration'
import { firePermissionDeniedHooks } from '../tools/hooks/runtimeHookBridges'
import { excludeSkillToolInput } from '../skills/skillDiscovery'
import { getPolicyEngine } from '../orchestration/toolRuntime/policy'
import { applyToolResultSizeBudget } from './toolResultBudget'
import { classifyToolError } from './classifyToolError'
import type { ToolResult, ToolUseContext } from '../tools/types'
import { createToolUseContext } from '../tools/toolExecContext'
import { getAgentContext, setAgentContextPendingHookStop } from '../agents/agentContext'
import {
  canUseDurableHITL,
  tryConsumePendingHumanResume,
} from '../orchestration/hitl'
import {
  buildPermissionDeniedPhase,
  createTransportAdapter,
  emitPhaseEvent,
} from '../orchestration/transport'
import { emitStreamEventToRenderer } from './streamHandlerRegistry'
import { markToolUseProfilerPhase } from '../agents/toolUseProfiler'
import { getToolUseExecutionContext, runWithToolUseExecutionContext } from '../agents/toolUseContext'
import { validateToolZodInput } from '../tools/toolInputZod'
import { mapToolUseToToolResultBlockParam } from './mapToolUseToToolResultBlockParam'
import { toolResultContentForAbortedSignal } from './siblingShellAbortReason'
import { getDeferredToolExecutionBlockMessage } from '../tools/deferredToolExecutionGuard'
import { findSkill } from '../skills/skillTool'
import { shouldSkipPlanModeAskForSafeSkill } from '../skills/safeSkillProperties'
import {
  canonicaliseSessionMemoryToolInput,
  gateSessionMemoryInternalAgentToolUse,
} from '../tools/fileToolValidation'
import { classifyBashCommand } from '../tools/bash'
import { isAcceptEditsFilesystemShellCommand } from './acceptEditsShellAllowlist'
import type { RunAgenticToolUseParams } from './runAgenticToolUse'
import { TODO_WRITE_TOOL_NAME } from '../tools/builtinToolAliases'
import { formatUnknownToolError } from '../tools/unknownToolError'

const PLAN_MODE_NON_FILE_PROMPT_EXEMPT = new Set<string>([
  'ExitPlanMode',
  'AskUserQuestion',
  TODO_WRITE_TOOL_NAME,
])

export async function runAgenticToolUseScoped(
  params: RunAgenticToolUseParams,
): Promise<Record<string, unknown>> {
  const { toolUse } = params
  return runWithToolUseExecutionContext(
    {
      toolUseId: toolUse.id,
      toolName: toolUse.name,
      agentId: getAgentContext()?.agentId,
      startedAt: Date.now(),
    },
    () => executeAgenticToolUseBody(params),
  )
}

async function executeAgenticToolUseBody(
  params: RunAgenticToolUseParams,
): Promise<Record<string, unknown>> {
  // NOTE: `diffPermissionMode` is intentionally not destructured here. It
  // only supplies the per-turn initial value consumed by `handleSendMessage`
  // via `setDiffPermissionMode`; the body re-reads the live value through
  // `getDiffPermissionMode()` below (so mid-turn toggles take effect), and
  // pulling it out of `params` again would just create dead duplicate state.
  const {
    toolUse,
    signal,
    callbacks,
    permissionDefaultMode,
    permissionRules,
    discoveryExclude,
    getInlineSkillSession,
    setInlineSkillSession,
  } = params

  let fileMutationApprovedViaPermissionUi = false
  let fileContentApprovedViaPermissionUi: string | null = null

  const skillScopeForHooks = getInlineSkillSession()?.skillName?.trim() || undefined

  if (toolUse.name === 'Skill') {
    excludeSkillToolInput(toolUse.input, discoveryExclude)
  }
  callbacks.onToolStart(toolUse)
  emitStreamEvent({
    type: 'tool_progress',
    phase: 'start',
    toolUseId: toolUse.id,
    toolName: toolUse.name,
  })
  taskRuntimeStore.start(toolUse.id, 'agent')
  taskRuntimeStore.append(toolUse.id, 'meta', `Tool start: ${toolUse.name}\n`)
  markToolUseProfilerPhase('start', toolUse.id, toolUse.name)

  let toolProgressPhaseEndSent = false
  const emitToolProgressEnd = (success: boolean) => {
    if (toolProgressPhaseEndSent) return
    toolProgressPhaseEndSent = true
    emitStreamEvent({
      type: 'tool_progress',
      phase: 'end',
      toolUseId: toolUse.id,
      toolName: toolUse.name,
      success,
    })
    markToolUseProfilerPhase('end', toolUse.id, toolUse.name, { success })
    if (getAgentContext()?.agentId === 'main') {
      const tu = getToolUseExecutionContext()
      emitStreamEvent({
        type: 'tool_use_summary',
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        success,
        metadata: {
          durationMs: tu ? Date.now() - tu.startedAt : undefined,
        },
      })
    }
  }

  const tool = toolRegistry.get(toolUse.name)
  if (!tool) {
    const missingToolFailure = formatUnknownToolError(
      toolUse.name,
      toolRegistry.list(),
    )
    emitToolProgressEnd(false)
    taskRuntimeStore.markFailed(toolUse.id, missingToolFailure.error)
    callbacks.onToolResult({
      id: toolUse.id,
      name: toolUse.name,
      success: false,
      ...missingToolFailure,
    })
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `Error: ${missingToolFailure.error}`,
      is_error: true,
    }
  }

  // Audit Bug A4: inline Skill sessions may declare an `allowedTools`
  // whitelist. Before this check the whitelist was only used to filter the
  // model's visible tool list, so a model could still successfully call a
  // disallowed tool (replay, buggy fine-tune, etc.). Enforce at runtime so
  // the denial becomes authoritative.
  const inlineSkillForGate = getInlineSkillSession()
  if (
    inlineSkillForGate?.allowedTools &&
    inlineSkillForGate.allowedTools.length > 0
  ) {
    const allowed = new Set(inlineSkillForGate.allowedTools)
    const canonical = canonicalBuiltinToolName(toolUse.name)
    // Audit P1#2 — the allowlist entries are registry primary names (e.g.
    // `read_file`), but models frequently emit PascalCase aliases (`Read`).
    // `canonicalBuiltinToolName('Read')` is still `Read`, so without the
    // registry-primary normalisation the gate false-rejected tools the
    // registry itself would resolve fine.
    const registryPrimary = registryPrimaryToolName(toolUse.name)
    // Accept the raw name OR the canonical builtin name OR any `mcp__…`
    // tool that matches an explicit `mcp__server__*` / `mcp__server__tool`
    // pattern in the allowlist.
    const isMcpToolAllowed =
      toolUse.name.startsWith('mcp__') &&
      [...allowed].some((p) =>
        p === toolUse.name ||
        (p.endsWith('*') && toolUse.name.startsWith(p.slice(0, -1))),
      )
    if (
      !allowed.has(toolUse.name) &&
      !allowed.has(canonical) &&
      !allowed.has(registryPrimary) &&
      !isMcpToolAllowed
    ) {
      const msg = `Tool "${toolUse.name}" is not in the active skill's allowed list (${[...allowed].join(', ')}).`
      emitToolProgressEnd(false)
      taskRuntimeStore.markFailed(toolUse.id, msg)
      callbacks.onToolResult({
        id: toolUse.id,
        name: toolUse.name,
        success: false,
        error: msg,
      })
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Error: ${msg}`,
        is_error: true,
      }
    }
  }

  // Audit BUG-R1: enforce the sub-agent's resolved tool-surface allowlist at
  // execution time, not only when generating the prompt-side tool list. The
  // allowlist is stamped onto the ALS context by `runSubAgent` from
  // `resolveAgentTools(agentDef)`; the main chat (`agentId === 'main'`) and
  // legacy paths leave it undefined and are unaffected.
  const agentCtx = getAgentContext()
  const subAgentAllowedTools = agentCtx?.allowedToolNamesForRuntime
  const subAgentMcpServers = agentCtx?.mcpServers
  if (
    toolUse.name.startsWith('mcp__') &&
    Array.isArray(subAgentMcpServers) &&
    subAgentMcpServers.length > 0
  ) {
    // P1-15 leftover: do NOT use `/^mcp__([^_]+)__/` — that truncates server
    // names containing single underscores (e.g. `my_server` becomes `my`)
    // and either rejects valid tools or accepts them for the wrong reason.
    // Reuse the same `extractMcpServerName` logic as `subAgentToolResolver`.
    const server = extractMcpServerName(toolUse.name)
    const allowedServers = new Set(
      subAgentMcpServers.map((s) => String(s).trim()).filter(Boolean),
    )
    if (!server || !allowedServers.has(server)) {
      const msg = `MCP tool "${toolUse.name}" is not from this sub-agent's allowed MCP servers (${[...allowedServers].join(', ') || 'none'}).`
      emitToolProgressEnd(false)
      taskRuntimeStore.markFailed(toolUse.id, msg)
      callbacks.onToolResult({
        id: toolUse.id,
        name: toolUse.name,
        success: false,
        error: msg,
      })
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Error: ${msg}`,
        is_error: true,
      }
    }
  }
  if (subAgentAllowedTools && subAgentAllowedTools.length > 0) {
    const allowedSubAgentSet = new Set(subAgentAllowedTools)
    const canonicalSubAgent = canonicalBuiltinToolName(toolUse.name)
    // Audit P1#2 — same normalisation as the inline-skill gate above: the
    // allowlist holds registry primary names, models emit aliases.
    const registryPrimarySubAgent = registryPrimaryToolName(toolUse.name)
    const isMcpSubAgentAllowed =
      toolUse.name.startsWith('mcp__') &&
      [...allowedSubAgentSet].some((p) =>
        p === toolUse.name ||
        (p.endsWith('*') && toolUse.name.startsWith(p.slice(0, -1))),
      )
    if (
      !allowedSubAgentSet.has(toolUse.name) &&
      !allowedSubAgentSet.has(canonicalSubAgent) &&
      !allowedSubAgentSet.has(registryPrimarySubAgent) &&
      !isMcpSubAgentAllowed
    ) {
      const msg = `Tool "${toolUse.name}" is not in this sub-agent's allowed tool surface.`
      emitToolProgressEnd(false)
      taskRuntimeStore.markFailed(toolUse.id, msg)
      callbacks.onToolResult({
        id: toolUse.id,
        name: toolUse.name,
        success: false,
        error: msg,
      })
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Error: ${msg}`,
        is_error: true,
      }
    }
  }

  const deferredBlock = getDeferredToolExecutionBlockMessage(tool)
  if (deferredBlock) {
    emitToolProgressEnd(false)
    taskRuntimeStore.markFailed(toolUse.id, deferredBlock)
    callbacks.onToolResult({
      id: toolUse.id,
      name: toolUse.name,
      success: false,
      error: deferredBlock,
    })
    // 2026-05 — sibling validation paths above (zod input mismatch, etc.)
    // set `is_error: true` on the tool_result. The deferred-block path
    // didn't, leaving Anthropic strict tool_use clients to see the call
    // as a successful tool with `Error:` text in content. Matching the
    // shape makes the failure unambiguous on the wire.
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `Error: ${deferredBlock}`,
      is_error: true,
    }
  }

  // C-grade stream-time preflight rejection (`streamWriteInputWatcher.ts`):
  // the watcher aborted the SSE stream mid-arguments and left a synthetic
  // tool_use whose `input` is intentionally partial (`{filePath}`) or empty
  // (`{}`). Surface the pre-baked educative error directly — running Zod on
  // that input would report a misleading "missing/empty required
  // argument(s)" message and teach the model to blindly re-issue the same
  // doomed call (which the watcher would abort again — an infinite loop).
  // Mirrors `streamingToolExecutor.addTool` for the non-streaming paths
  // (`bypassStreamingForPolicy`, orchestrated port, fallback batch).
  const preflightError = toolUse.preflightError
  if (typeof preflightError === 'string' && preflightError.length > 0) {
    emitToolProgressEnd(false)
    taskRuntimeStore.markFailed(toolUse.id, preflightError)
    callbacks.onToolResult({
      id: toolUse.id,
      name: toolUse.name,
      success: false,
      error: preflightError,
    })
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `Error: ${preflightError}`,
      is_error: true,
    }
  }

  const zodParsed = validateToolZodInput(tool, toolUse.input)
  if (!zodParsed.ok) {
    const msg = zodParsed.message
    // The Zod gate has consumed the internal refusal sentinels; strip them so
    // a refused tool_use isn't persisted (and later replayed) carrying them.
    // On the success path below, `toolUse.input = zodParsed.data` already drops
    // them via the schema transform.
    stripInternalToolArgMarkers(toolUse.input)
    emitToolProgressEnd(false)
    taskRuntimeStore.markFailed(toolUse.id, msg)
    callbacks.onToolResult({
      id: toolUse.id,
      name: toolUse.name,
      success: false,
      error: msg,
    })
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `Error: ${msg}`,
      is_error: true,
    }
  }
  toolUse.input = zodParsed.data

  if (tool.validateInput) {
    try {
      const v = await tool.validateInput(toolUse.input)
      if (!v.valid) {
        const msg = v.message || 'Invalid tool input.'
        emitToolProgressEnd(false)
        taskRuntimeStore.markFailed(toolUse.id, msg)
        callbacks.onToolResult({
          id: toolUse.id,
          name: toolUse.name,
          success: false,
          error: msg,
        })
        return mapToolUseToToolResultBlockParam({
          toolUseId: toolUse.id,
          success: false,
          error: msg,
        })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      emitToolProgressEnd(false)
      taskRuntimeStore.markFailed(toolUse.id, msg)
      callbacks.onToolResult({
        id: toolUse.id,
        name: toolUse.name,
        success: false,
        error: msg,
      })
      return mapToolUseToToolResultBlockParam({
        toolUseId: toolUse.id,
        success: false,
        error: msg,
      })
    }
  }

  if (typeof tool.checkPermissions === 'function') {
    try {
      const perm = await Promise.resolve(tool.checkPermissions(toolUse.input))
      if (!perm || perm.allowed !== true) {
        const reason = perm?.reason || 'Blocked by tool.checkPermissions().'
        firePermissionDeniedHooks(
          toolUse.name,
          toolUse.input,
          reason,
          hookWorkspaceCwd(),
          skillScopeForHooks,
        )
        emitToolProgressEnd(false)
        taskRuntimeStore.markFailed(toolUse.id, reason)
        callbacks.onToolResult({
          id: toolUse.id,
          name: toolUse.name,
          success: false,
          error: reason,
        })
        return mapToolUseToToolResultBlockParam({
          toolUseId: toolUse.id,
          success: false,
          error: reason,
        })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      firePermissionDeniedHooks(toolUse.name, toolUse.input, msg, hookWorkspaceCwd(), skillScopeForHooks)
      emitToolProgressEnd(false)
      taskRuntimeStore.markFailed(toolUse.id, msg)
      callbacks.onToolResult({
        id: toolUse.id,
        name: toolUse.name,
        success: false,
        error: msg,
      })
      return mapToolUseToToolResultBlockParam({
        toolUseId: toolUse.id,
        success: false,
        error: msg,
      })
    }
  }

  let skillInvocationName: string | undefined
  if (toolUse.name === 'Skill') {
    if (toolUse.input.end_inline_skill_session === true) {
      skillInvocationName = undefined
    } else {
      const sn = String(toolUse.input.skill ?? '')
        .replace(/^[/@]/, '')
        .trim()
      skillInvocationName = sn || undefined
    }
  }

  /**
   * Audit v3 systemic fix — hard sandbox for `session-memory-internal`.
   *
   * This runs **before** any permission/diff logic so an out-of-sandbox path can
   * never reach diff-preview rendering or the approval UI. The child-agent path
   * gate inside toolWriteFile/toolEditFile still stays as a defense-in-depth
   * second check; this early gate closes the Bug 1/2/3 escalation windows where
   * bypassPermissions + diff approval could otherwise combine to permit a write.
   *
   * Audit v4 (May 2026): canonicalise relative paths before the gate AND
   * before downstream `resolvePathForTool` so models emitting bare
   * basenames (`conv-X.md`) or workspace-relative paths
   * (`.claude/projects/.../X.md`) hit the correct sandbox target instead
   * of the agent's meaningless CWD. See
   * `canonicaliseSessionMemoryToolInput` doc-comment for the H6
   * incident this addresses.
   */
  canonicaliseSessionMemoryToolInput(toolUse.input)
  {
    const sessionGate = gateSessionMemoryInternalAgentToolUse(toolUse.name, toolUse.input)
    if (!sessionGate.ok) {
      const err = sessionGate.error
      firePermissionDeniedHooks(
        toolUse.name,
        toolUse.input,
        err,
        hookWorkspaceCwd(),
        skillScopeForHooks,
      )
      taskRuntimeStore.markFailed(toolUse.id, err)
      emitToolProgressEnd(false)
      callbacks.onToolResult({
        id: toolUse.id,
        name: toolUse.name,
        success: false,
        error: err,
      })
      return mapToolUseToToolResultBlockParam({
        toolUseId: toolUse.id,
        success: false,
        error: err,
      })
    }
  }

  const currentMode = getPermissionMode()
  const isWorkspaceFileMutationTool = isAgenticWorkspaceFileMutationTool(toolUse.name)
  const isWorkspaceFileDiffTool = isAgenticWorkspaceFileDiffTool(toolUse.name)

  const fpRaw = extractWorkspaceFilePathFromToolInput(toolUse.input)
  let resolvedTarget: string | undefined
  if (fpRaw) {
    try {
      const resolveResult = resolvePathForTool(fpRaw)
      if (resolveResult.ok) {
        resolvedTarget = resolveResult.resolved
      }
    } catch {
      resolvedTarget = undefined
    }
  }
  const nl = toolUse.name.toLowerCase()
  const bashCommand =
    nl === 'bash' || nl === 'powershell'
      ? String((toolUse.input as { command?: string }).command ?? '')
      : undefined
  const acceptEditsShellPassthrough =
    currentMode === 'acceptEdits' &&
    bashCommand !== undefined &&
    bashCommand.trim() !== '' &&
    isAcceptEditsFilesystemShellCommand(
      bashCommand,
      nl === 'powershell' ? 'powershell' : 'posix',
    )

  // Chunk 7 — deep permission check goes through PolicyEngine so every rule
  // resolution (kernel preflight via PolicyEngine.evaluate + this in-tool deep
  // check) shares one entry point. The underlying matcher is unchanged.
  const { effectiveMode, matchedRule } = getPolicyEngine().evaluateRules(
    toolUse.name,
    permissionDefaultMode,
    permissionRules,
    { bashCommand, filePath: resolvedTarget, skillInvocationName },
  )

  const settingsAllowAll = effectiveMode === 'allow'
  const settingsDenyAll = effectiveMode === 'deny'
  const toolPolicySkipsNonFilePrompt =
    currentMode === 'bypassPermissions' || settingsAllowAll
  // 热读 —— 每个工具调用开始时重新从全局状态取 diff 权限,
  // 让用户可以在对话进行中切换"变更审核 ↔ 自动写入"并即时生效。
  // params.diffPermissionMode 只作为 turn 初始值,由 `handleSendMessage` 用
  // `setDiffPermissionMode` 同步到同一个全局源;其后这里始终 override。
  const diffPermissionModeLive = getDiffPermissionMode()
  const skipFileMutationApprovalUi =
    currentMode === 'bypassPermissions' ||
    diffPermissionModeLive === 'bypassPermissions' ||
    currentMode === 'acceptEdits'

  if (settingsDenyAll) {
    // Global "deny" spares read-only tools; an explicit matching rule still blocks any tool.
    const shouldBlock = matchedRule || !tool.isReadOnly
    if (shouldBlock) {
      const deniedError = matchedRule
        ? `Permission denied: Settings → Permissions rule blocks ${toolUse.name}.`
        : `Permission denied: Settings → Permissions is set to "deny" for ${toolUse.name}.`
      // Streaming-path UX parity (audit #5): emit `permission_denied_preflight`
      // so `PreflightDenialToast` shows the red corner toast for streaming-path
      // denials too. In the non-streaming `DefaultToolRuntimePort.preflight`
      // path this branch is unreachable because preflight already filtered
      // the denied tool out of `allowed` (see `toolRuntime/defaultToolRuntimePort.ts:216`), so
      // there is no double-fire.
      try {
        const convId = getAgentContext()?.streamConversationId?.trim()
        // P2 §6.3 migration — strict builder.
        // iteration=0 sentinel mirrors `DefaultToolRuntimePort` so renderer
        // routing stays consistent (renderer groups by toolUseId).
        emitPhaseEvent(
          createTransportAdapter(emitStreamEventToRenderer),
          buildPermissionDeniedPhase({
            iteration: 0,
            ...(convId ? { conversationId: convId } : {}),
            permissionDenial: {
              toolName: toolUse.name,
              toolUseId: toolUse.id,
              reason: deniedError,
              matchedRule: matchedRule ? 'rule-match' : 'settings-deny-all',
            },
          }),
        )
      } catch (err) {
        console.warn(
          '[runAgenticToolUseBody] emit permission_denied_preflight failed:',
          err,
        )
      }
      firePermissionDeniedHooks(
        toolUse.name,
        toolUse.input,
        deniedError,
        hookWorkspaceCwd(),
        skillScopeForHooks,
      )
      taskRuntimeStore.markFailed(toolUse.id, deniedError)
      emitToolProgressEnd(false)
      callbacks.onToolResult({
        id: toolUse.id,
        name: toolUse.name,
        success: false,
        error: deniedError,
      })
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Error: ${deniedError}`,
        is_error: true,
      }
    }
  }

  // 同样用热读值,保证切换"自动写入"立即对当前 turn 生效
  const diffAutoApplyFileWrites = diffPermissionModeLive === 'bypassPermissions'

  let requiresAsk: boolean
  if (isWorkspaceFileMutationTool) {
    if (skipFileMutationApprovalUi) {
      requiresAsk = false
    } else {
      requiresAsk =
        currentMode === 'dontAsk' ||
        (currentMode === 'plan' && !PLAN_MODE_NON_FILE_PROMPT_EXEMPT.has(tool.name)) ||
        currentMode === 'default' ||
        currentMode === 'auto'
    }
  } else if (toolPolicySkipsNonFilePrompt) {
    requiresAsk = false
  } else {
    requiresAsk =
      currentMode === 'plan' &&
      !tool.isReadOnly &&
      !PLAN_MODE_NON_FILE_PROMPT_EXEMPT.has(tool.name)
  }

  const policyTier = getAgentContext()?.policyTier ?? 'inherit'
  if (policyTier === 'restricted' && !tool.isReadOnly && effectiveMode === 'allow') {
    requiresAsk = true
  }

  /** upstream §5.1: acceptEdits auto-allows narrow filesystem shell (mkdir/touch/rm/sed/…). */
  if (acceptEditsShellPassthrough) {
    requiresAsk = false
  }

  /**
   * upstream SkillTool §9.3–9.6: plan-mode prompt for read-only Skill can be skipped when
   * deny/allow rules did not already decide and frontmatter uses only SAFE_SKILL_PROPERTIES.
   */
  if (
    shouldSkipPlanModeAskForSafeSkill({
      toolName: toolUse.name,
      skillInvocationName: skillInvocationName,
      currentMode: currentMode,
      requiresAsk,
      // `findSkill` returns a richer `SkillDefinition`; downcast to the
      // narrow `SkillFrontmatterLookup` shape the safe-skill gate expects.
      findSkill: (name) => {
        const sk = findSkill(name) as (undefined | { frontmatterKeys?: string[] })
        return sk ? { frontmatterKeys: sk.frontmatterKeys } : undefined
      },
    })
  ) {
    requiresAsk = false
  }

  /** Report §5.8 + §5.3 step 5: `auto` mode — classifier gates bash / PowerShell permission UI. */
  if (
    currentMode === 'auto' &&
    bashCommand !== undefined &&
    bashCommand.trim() !== '' &&
    (nl === 'bash' || nl === 'powershell')
  ) {
    const shellKind = nl === 'powershell' ? 'powershell' : 'posix'
    const cls = await classifyBashCommand(bashCommand, shellKind, {
      cwd: hookWorkspaceCwd(),
    })
    const restrictedForceAsk =
      policyTier === 'restricted' && !tool.isReadOnly && effectiveMode === 'allow'
    if (cls.matches) {
      requiresAsk = true
    } else if (!restrictedForceAsk) {
      requiresAsk = false
    }
  }

  /** upstream `dontAsk`: no permission dialogs — deny anything that would have asked. */
  if (currentMode === 'dontAsk' && requiresAsk) {
    const deniedError = `Permission denied: mode is dontAsk (no prompts) for ${toolUse.name}.`
    firePermissionDeniedHooks(
      toolUse.name,
      toolUse.input,
      deniedError,
      hookWorkspaceCwd(),
      skillScopeForHooks,
    )
    taskRuntimeStore.markFailed(toolUse.id, deniedError)
    emitToolProgressEnd(false)
    callbacks.onToolResult({
      id: toolUse.id,
      name: toolUse.name,
      success: false,
      error: deniedError,
    })
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `Error: ${deniedError}`,
      is_error: true,
    }
  }

  let executionInput: Record<string, unknown> = { ...toolUse.input }
  const hookCwd = hookWorkspaceCwd()

  let diffPreview: DiffPreview | undefined
  let earlyEditFailureError: string | undefined
  /**
   * P1 shadow: the DT id for this tool invocation, if one was created. Threaded through the
   * permission / execution transitions below so we can observe the full lifecycle without
   * adding any new control flow.
   */
  let shadowDtId: DiffTxId | null = null
  if (isWorkspaceFileDiffTool && !skipFileMutationApprovalUi) {
    const filePath = extractWorkspaceFilePathFromToolInput(executionInput)
    if (filePath) {
      try {
        const resolveResult = resolvePathForTool(filePath)
        if (resolveResult.ok) {
          const resolved = resolveResult.resolved
          const originalContent = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf-8') : ''
          let modifiedContent = ''
          if (isAgenticFullFileReplaceTool(toolUse.name)) {
            modifiedContent = (executionInput.content as string) || ''
          } else if (isBuiltinMultiEditTool(toolUse.name)) {
            // Multi-edit batch: simulate the entire batch in-memory against
            // the current disk content so the approval UI shows the
            // post-batch diff, not a misleading single-edit preview. Using
            // {@link computeFileEditResultMulti} keeps the preview semantics
            // byte-identical to what {@link toolMultiEditFile} will produce
            // on commit (same substring guard, same per-edit no-op refusal,
            // same final-no-op refusal).
            const rawEdits = Array.isArray(executionInput.edits)
              ? (executionInput.edits as Array<Record<string, unknown>>)
              : []
            const parsedEdits = rawEdits.map((e) => ({
              oldString:
                typeof e?.oldString === 'string'
                  ? (e.oldString as string)
                  : typeof e?.old_string === 'string'
                    ? (e.old_string as string)
                    : '',
              newString:
                typeof e?.newString === 'string'
                  ? (e.newString as string)
                  : typeof e?.new_string === 'string'
                    ? (e.new_string as string)
                    : '',
              replaceAll: e?.replaceAll === true || e?.replace_all === true,
            }))
            const batch = computeFileEditResultMulti(originalContent, parsedEdits)
            if (batch.success) {
              modifiedContent = batch.newContent
            } else {
              // Same fail-fast contract as the single-edit branch: do NOT
              // build a bogus "clear the file" diff preview — short-circuit
              // with the batch error and surface it to the model without
              // prompting the user.
              earlyEditFailureError =
                batch.error || 'multi_edit_file: failed to apply edits.'
            }
          } else {
            // MCP edit_file uses { edits: [{ oldText, newText }] } — extract for diff preview.
            let oldStr: string
            let newStr: string
            let replaceAll: boolean
            if (isMcpWorkspaceFileDiffTool(toolUse.name)) {
              const mcpEdits = Array.isArray(executionInput.edits)
                ? (executionInput.edits as Array<Record<string, unknown>>)
                : undefined
              oldStr = String(mcpEdits?.[0]?.oldText ?? mcpEdits?.[0]?.old_string ?? '')
              newStr = String(mcpEdits?.[0]?.newText ?? mcpEdits?.[0]?.new_string ?? '')
              replaceAll = false // MCP edit_file does single-replace per edit
            } else {
              oldStr = (executionInput.oldString as string) || (executionInput.old_string as string) || ''
              newStr = (executionInput.newString as string) || (executionInput.new_string as string) || ''
              replaceAll =
                executionInput.replaceAll === true || executionInput.replace_all === true
            }
            const ne = normalizeOneFileEdit(
              resolved,
              fs.existsSync(resolved) ? originalContent : undefined,
              oldStr,
              newStr,
              replaceAll,
            )
            const edited = computeFileEditResult(originalContent, ne.oldString, ne.newString, {
              replaceAll: ne.replaceAll,
            })
            if (edited.success) {
              modifiedContent = edited.newContent
            } else {
              // Edit cannot be applied (e.g. old_string not found). Do NOT fall
              // through and build a bogus "clear the file" diff preview — that
              // would pop up an approval UI showing a meaningless destructive
              // change. Instead record the error so we can short-circuit below,
              // returning the failure to the model without prompting the user
              // and without executing the mutation tool.
              earlyEditFailureError =
                edited.error || 'The old_string was not found in the file.'
            }
          }
          // Supervisor-layer destructive-clear guard.
          //
          // A correct approval UI must never show the user "AI wants to delete
          // every byte in this file and replace it with nothing." Delegate the
          // decision to the shared writeIntegrityGuard so the rule used to
          // block the approval matches the rule every downstream write path
          // uses to block the disk mutation. If the two ever disagree, the UX
          // bug we fixed here (approval dialog pops up, user approves, tool
          // then fails with the very error the approval should have prevented)
          // comes right back.
          if (!earlyEditFailureError) {
            const preview = assertPreWriteIntegrity({
              resolvedPath: resolved,
              displayPath: filePath,
              previousContent: originalContent,
              nextContent: modifiedContent,
              fileExisted: fs.existsSync(resolved),
              intent: isAgenticFullFileReplaceTool(toolUse.name) ? 'write' : 'edit',
            })
            if (!preview.ok) {
              earlyEditFailureError = preview.error
            }
          }

          if (!earlyEditFailureError && originalContent !== modifiedContent) {
            const riskWarnings = computeFileMutationRiskWarnings(originalContent, modifiedContent)
            diffPreview = {
              filePath: resolved.replace(/\\/g, '/'),
              originalContent,
              modifiedContent,
              ...(riskWarnings.length > 0 ? { riskWarnings } : {}),
            }

            // P1 shadow: create a DiffTransaction mirroring this preview. We do this once,
            // right after diffPreview is finalised, so the DT's baseSnapshot matches exactly
            // what the approval UI will show the user. Failures are swallowed — observation
            // must never break execution.
            shadowDtId = createDiffTransactionFromPreview({
              toolUseId: toolUse.id,
              toolName: toolUse.name,
              toolInput: executionInput as Record<string, unknown>,
              preview: diffPreview,
              fileExisted: fs.existsSync(resolved),
              baseReadId:
                typeof (executionInput as Record<string, unknown>).baseReadId === 'string'
                  ? ((executionInput as Record<string, unknown>).baseReadId as string)
                  : typeof (executionInput as Record<string, unknown>).base_read_id === 'string'
                    ? ((executionInput as Record<string, unknown>).base_read_id as string)
                    : null,
            })
          }
        }
      } catch {
        // best-effort
      }
    }
  }

  if (earlyEditFailureError) {
    taskRuntimeStore.markFailed(toolUse.id, earlyEditFailureError)
    emitToolProgressEnd(false)
    callbacks.onToolResult({
      id: toolUse.id,
      name: toolUse.name,
      success: false,
      error: earlyEditFailureError,
    })
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `Error: ${earlyEditFailureError}`,
      is_error: true,
    }
  }

  let requirePermissionUi = requiresAsk
  let permissionHookResponse: HookResponse | undefined
  if (requirePermissionUi) {
    const { response: permHookResp } = await runPermissionHookPhase(
      toolUse.name,
      executionInput,
      hookCwd,
      skillScopeForHooks,
    )
    permissionHookResponse = permHookResp
    if (permissionHookAutoDeny(permHookResp)) {
      const deniedError =
        permHookResp?.reason ||
        permHookResp?.systemMessage ||
        `Permission denied for ${toolUse.name} (hook).`
      firePermissionDeniedHooks(
        toolUse.name,
        executionInput,
        deniedError,
        hookWorkspaceCwd(),
        skillScopeForHooks,
      )
      taskRuntimeStore.markFailed(toolUse.id, deniedError)
      emitToolProgressEnd(false)
      callbacks.onToolResult({
        id: toolUse.id,
        name: toolUse.name,
        success: false,
        error: deniedError,
      })
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Error: ${deniedError}`,
        is_error: true,
      }
    }
    if (permissionHookAutoAllow(permHookResp)) {
      const hookMaySkipUserPermissionUi =
        !isWorkspaceFileMutationTool || diffAutoApplyFileWrites || currentMode === 'bypassPermissions'
      if (hookMaySkipUserPermissionUi) {
        requirePermissionUi = false
      }
    }
  }

  if (permissionHookResponse?.updatedInput) {
    // Audit fix (hooks B-P0-2): hook-sourced input rewrites must re-pass the
    // tool's Zod schema — the loop's own validation already ran, so an
    // unvalidated merge here was a schema bypass for poisoned hook configs.
    const mergedByHook = mergeHookUpdatedInputValidated(
      toolUse.name,
      executionInput,
      permissionHookResponse,
    )
    if (!mergedByHook.ok) {
      taskRuntimeStore.markFailed(toolUse.id, mergedByHook.reason)
      emitToolProgressEnd(false)
      callbacks.onToolResult({
        id: toolUse.id,
        name: toolUse.name,
        success: false,
        error: mergedByHook.reason,
      })
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Error: ${mergedByHook.reason}`,
        is_error: true,
      }
    }
    executionInput = mergedByHook.input
  }

  if (requirePermissionUi) {
    const description =
      isWorkspaceFileDiffTool && diffPreview
        ? `Apply changes to ${diffPreview.filePath.split('/').pop()}?`
        : `Allow ${toolUse.name} in plan mode?`
    // P2.1 T2.1.5 — Durable HITL for permission ask. Same shape as AskUserQuestion:
    //   - flag-OFF: legacy `requestPermission` in-process await path is unchanged.
    //   - flag-ON: first check the inbox for a queued resume (post-restart recovery), then
    //     either return the resumed decision or throw `InterruptForHITL` so the loop pauses.
    // Team-leader delegated permission (worker → leader IPC) stays on the legacy path —
    // that flow has its own cross-worker coordination that isn't process-restart-safe yet.
    let decision: import('./interactionState').PermissionDecision
    if (isWorkerToolPermissionDelegatedToTeamLeader()) {
      decision = await awaitTeamLeaderToolPermission({
        toolName: toolUse.name,
        description,
        input: executionInput,
        isDestructive: !tool.isReadOnly,
        signal,
        diffPreview,
      })
    } else if (canUseDurableHITL(getAgentContext()?.streamConversationId)) {
      const conversationId = getAgentContext()?.streamConversationId
      const resumed = tryConsumePendingHumanResume(conversationId, toolUse.id)
      if (resumed.resumed) {
        // The renderer's reply shape mirrors PermissionDecision (allow/deny/reason).
        decision = (resumed.value as import('./interactionState').PermissionDecision) ?? {
          behavior: 'deny',
          reason: 'malformed resume value',
        }
      } else {
        // Durable HITL for `permission_ask` is not wired end-to-end yet
        // (`onStreamEvent` is unset on the orchestrated main chat; no renderer
        // consumer for `hitlPending.kind === 'permission_ask'`). Fall back to
        // in-memory `requestPermission` so `每次审批` shows the approval UI.
        decision = await requestPermission({
          toolName: toolUse.name,
          description,
          input: executionInput,
          isDestructive: !tool.isReadOnly,
          ...(signal ? { signal } : {}),
          diffPreview,
        })
      }
    } else {
      decision = await requestPermission({
        toolName: toolUse.name,
        description,
        input: executionInput,
        isDestructive: !tool.isReadOnly,
        signal,
        diffPreview,
      })
    }

    if (decision.behavior !== 'allow') {
      const deniedError =
        decision.reason === 'cancelled'
          ? `Permission cancelled (stream or tool stopped) for ${toolUse.name}.`
          : `Permission denied for ${toolUse.name}.`
      shadowMarkPermissionRejected(shadowDtId, decision.reason || deniedError)
      firePermissionDeniedHooks(
        toolUse.name,
        executionInput,
        deniedError,
        hookWorkspaceCwd(),
        skillScopeForHooks,
      )
      taskRuntimeStore.markFailed(toolUse.id, deniedError)
      emitToolProgressEnd(false)
      callbacks.onToolResult({
        id: toolUse.id,
        name: toolUse.name,
        success: false,
        error: deniedError,
      })
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Error: ${deniedError}`,
        is_error: true,
      }
    }

    if (decision.updatedInput) {
      executionInput = { ...executionInput, ...decision.updatedInput }
      if (isMcpWorkspaceFileDiffTool(toolUse.name)) {
        const fp = extractWorkspaceFilePathFromToolInput(executionInput)
        if (fp && typeof executionInput.path !== 'string') {
          executionInput = { ...executionInput, path: fp }
        }
      }
    }
    fileMutationApprovedViaPermissionUi = true
    shadowMarkPermissionApproved(shadowDtId, 'user approved via permission UI')

    // 系统级修复：用户在审批 UI 中已经看到了当前磁盘内容 vs. 目标内容的完整 diff。
    // Keep the exact bytes shown in the diff. The receipt is stamped once,
    // immediately before execution, and only if disk still matches this
    // approved snapshot. That prevents approval waits from laundering an
    // external modification into a new valid baseReadId.
    fileContentApprovedViaPermissionUi = diffPreview?.originalContent ?? null
  }

  let fileContentBefore: string | null = null
  let filePathForDiff: string | null = null

  if (isWorkspaceFileDiffTool) {
    const rawFp = extractWorkspaceFilePathFromToolInput(executionInput)
    filePathForDiff = rawFp || null
    if (filePathForDiff) {
      try {
        const resolveResult = resolvePathForTool(filePathForDiff)
        if (resolveResult.ok) {
          const resolved = resolveResult.resolved
          if (fs.existsSync(resolved)) {
            fileContentBefore = fs.readFileSync(resolved, 'utf-8')
          } else {
            fileContentBefore = ''
          }
        } else {
          fileContentBefore = ''
        }
      } catch {
        fileContentBefore = ''
      }
    }
  }

  const activeInlineSkillSession = getInlineSkillSession()
  const preTool = await runPreToolUsePhase(
    toolUse.name,
    executionInput,
    hookCwd,
    activeInlineSkillSession?.skillName,
  )
  if (preTool.blocked) {
    const deniedError = preTool.reason || 'Blocked by PreToolUse hook.'
    // Loop-stop request (continue:false / preventContinuation): record on
    // the AgentContext so the agentic loop terminates with `hook_stopped`
    // after this batch returns. Distinct from a per-tool deny, which still
    // produces a `tool_result: Error: ...` to let the model adapt.
    if (preTool.loopStopRequested) {
      setAgentContextPendingHookStop({ reason: deniedError })
    }
    firePermissionDeniedHooks(
      toolUse.name,
      executionInput,
      deniedError,
      hookCwd,
      skillScopeForHooks,
    )
    taskRuntimeStore.markFailed(toolUse.id, deniedError)
    emitToolProgressEnd(false)
    callbacks.onToolResult({
      id: toolUse.id,
      name: toolUse.name,
      success: false,
      error: deniedError,
    })
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `Error: ${deniedError}`,
      is_error: true,
    }
  }
  executionInput = preTool.input

  if (signal.aborted) {
    const content = toolResultContentForAbortedSignal(signal)
    const msg = content.startsWith('Error: ') ? content.slice('Error: '.length) : content
    taskRuntimeStore.markFailed(toolUse.id, msg)
    emitToolProgressEnd(false)
    callbacks.onToolResult({
      id: toolUse.id,
      name: toolUse.name,
      success: false,
      error: msg,
    })
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content,
      is_error: true,
    }
  }

  markToolUseProfilerPhase('pre_execute', toolUse.id, toolUse.name)

  // Treat the approved diff as a read receipt exactly once, immediately
  // before execution. Reuse an already-current receipt whenever possible so
  // a model-supplied baseReadId is not invalidated. If a re-stamp is required
  // (for example an mtime-only save), thread the generated readId into the
  // execution input. If disk bytes changed since the preview, do not stamp:
  // the downstream hash/mtime gate must reject the stale approval.
  if (
    fileMutationApprovedViaPermissionUi &&
    (isWorkspaceFileDiffTool || isMcpWorkspaceFileDiffTool(toolUse.name))
  ) {
    const approvedFp = extractWorkspaceFilePathFromToolInput(executionInput)
    if (approvedFp) {
      try {
        const rr = resolvePathForTool(approvedFp)
        if (rr.ok) {
          const resolved = rr.resolved
          if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            const diskNow = fs.readFileSync(resolved, 'utf-8')
            const statNow = fs.statSync(resolved)
            if (
              fileContentApprovedViaPermissionUi === null ||
              diskNow === fileContentApprovedViaPermissionUi
            ) {
              const approvedReadId = hasCurrentScopeReceiptMatchingDisk(
                resolved,
                statNow.mtimeMs,
                diskNow,
              )
                ? findCurrentReadIdForPath(resolved)
                : recordSuccessfulRead(resolved, {
                    mtimeMs: statNow.mtimeMs,
                    isPartialView: false,
                    fullFileContent: diskNow,
                  }).readId

              if (approvedReadId) {
                const hasCamelReadId = typeof executionInput.baseReadId === 'string'
                const hasSnakeReadId = typeof executionInput.base_read_id === 'string'
                if (hasCamelReadId || hasSnakeReadId) {
                  executionInput = {
                    ...executionInput,
                    ...(hasCamelReadId ? { baseReadId: approvedReadId } : {}),
                    ...(hasSnakeReadId ? { base_read_id: approvedReadId } : {}),
                  }
                }
              }
            }
          }
        }
      } catch {
        // best-effort — in-lock assertReadBeforeWrite snapshot fallback
        // will still close the gate correctly if something is genuinely
        // wrong with the file.
      }
    }
  }

  let result: ToolResult
  try {
    // upstream alignment stage 1: build a per-execution ToolUseContext from
    // values already living in `params` and the agent AsyncLocalStorage. Tools
    // that don't declare a ctx parameter ignore this argument — no breaking
    // change. Tools that need abort signal, agent identity, or permission
    // mode read them from `ctx` instead of reaching into module globals.
    const agentCtx = getAgentContext()
    const liveDiffMode = getDiffPermissionMode()
    const toolExecCtx: ToolUseContext = createToolUseContext({
      toolUseId: toolUse.id,
      toolName: toolUse.name,
      abortSignal: signal,
      agentId: agentCtx?.agentId ?? 'main',
      agentType: agentCtx?.sessionAgentType,
      isSubAgent: (agentCtx?.agentId ?? 'main') !== 'main',
      permissionMode: liveDiffMode === 'bypassPermissions' ? 'bypassPermissions' : 'default',
      permissionDefaultMode,
      permissionRules,
      discoveryExclude,
      // upstream alignment stage 2: tools can stream progress chunks to the
      // renderer mid-execution. Each chunk is a serializable JSON payload
      // (see ToolProgressEvent). The renderer's `mainStreamRouter` appends
      // chunks to the matching tool block so the user sees activity while a
      // long-running tool (bash output, web fetch, grep, etc.) is still
      // executing. upstream's `setToolJSX(<JSX>)` collapses into "emit a
      // chunk + Renderer's tool block decides how to paint it".
      emitToolProgress: (progress) => {
        emitStreamEvent({
          type: 'tool_progress',
          phase: 'chunk',
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          data: progress,
        })
      },
    })
    result = await toolRegistry.execute(toolUse.name, executionInput, {
      skipRegistryInputValidation: true,
      ctx: toolExecCtx,
    })
  } catch (err) {
    emitToolProgressEnd(false)
    throw err
  }
  const toolMeta = toolRegistry.get(toolUse.name)
  result = applyToolResultSizeBudget(toolUse.name, result, {
    toolUseId: toolUse.id,
    maxChars: toolMeta?.maxResultChars,
  })
  if (!result.success && result.error) {
    // Tools that already set `toolErrorClass` (e.g. `'aborted'`,
    // `'worker_crashed'`, `'invalid_input'`, `'cache_miss'`) carry domain-
    // specific intent that the heuristic would clobber — and those values
    // also fall outside the closed `ToolErrorClass` union, so re-running the
    // regex matcher would just downgrade them to `'unknown'`. Only invoke
    // the heuristic as a fallback when the tool didn't classify itself.
    const explicitClass = result.toolErrorClass
    if (!explicitClass) {
      const c = classifyToolError(result.error, { toolName: toolUse.name })
      result = { ...result, toolErrorClass: c.class, telemetryHint: c.telemetryHint }
    } else if (!result.telemetryHint) {
      // Preserve the explicit class but still surface a telemetryHint so
      // OTel exporters have a stable label even for infrastructural buckets.
      result = { ...result, telemetryHint: explicitClass }
    }
  }
  emitToolProgressEnd(result.success)

  await runPostToolHooksSafe(toolUse.name, executionInput, result, hookCwd, skillScopeForHooks)

  // PostToolUse hooks (plankton-code-quality etc.) may have modified the
  // file after our write — formatting, lint-fix, import sorting.  Without
  // a fresh receipt the stale mtime/content from the original write causes
  // the next edit to fail with "modified on disk" or the self_mutation
  // guard to fire prematurely.  Re-stamp the receipt so it reflects the
  // post-hook disk state.
  if (result.success && (isWorkspaceFileMutationTool || isWorkspaceFileDiffTool)) {
    const hookFp = extractWorkspaceFilePathFromToolInput(executionInput)
    if (hookFp) {
      try {
        const rr = resolvePathForTool(hookFp)
        // Per-conversation memory-write mutex (F5 follow-up): when the MAIN
        // agent — not a forked extract / session-memory-internal scribe —
        // writes to a known memory-tree path, record it so the next
        // autoExtract round for THIS conversation skips its LLM call and
        // just advances the cursor. The global `recordMemoryApiWrite` flag
        // is no longer used by the extract pipeline (it self-poisoned all
        // other conversations), so the bookkeeping has to ride on the
        // tool-execution path. Subagents (`agentId !== 'main'`) are
        // excluded — their writes already happen inside a fork whose
        // results aren't fed back to the parent transcript.
        if (rr.ok) {
          const ctx = getAgentContext()
          if (
            (ctx?.agentId ?? 'main') === 'main' &&
            isResolvedPathInKnownMemoryWritableTree(rr.resolved)
          ) {
            const convId = ctx?.streamConversationId?.trim()
            if (convId) recordMainAgentMemoryWrite(convId)
          }
        }
        if (rr.ok && fs.existsSync(rr.resolved) && fs.statSync(rr.resolved).isFile()) {
          // B1 (audit fix): grab the pre-edit snapshot BEFORE
          // `recordSuccessfulRead` overwrites the receipt with the
          // post-edit content. We only trust full-file snapshots —
          // partial-view receipts (offset/limit reads) can't reconstruct
          // the pre-edit hash, so `reverted` detection silently falls
          // back to `modified` for those edits. That's fine: partial
          // reads + write/edit is the rare path; full reads dominate.
          let contentBefore: string | null = null
          try {
            const priorReadId = findCurrentReadIdForPath(rr.resolved)
            if (priorReadId) {
              const priorReceipt = findReadReceiptByReadId(priorReadId)
              if (
                priorReceipt &&
                !priorReceipt.record.isPartialView &&
                priorReceipt.record.contentSnapshot != null
              ) {
                contentBefore = priorReceipt.record.contentSnapshot
              }
            }
          } catch {
            /* readFileState lookup is best-effort; fall through with null */
          }

          const diskNow = fs.readFileSync(rr.resolved, 'utf-8')
          const statNow = fs.statSync(rr.resolved)
          // Double-rotation fix (2026-07): the builtin edit/write tools already
          // rotated the readId via recordSelfMutationReadReceipt and promised
          // it to the model in the "readId for next edit:" trailer. Re-recording
          // here unconditionally rotated the readId AGAIN, invalidating the
          // promised id — every chained edit that echoed the trailer id then
          // failed once with READ_ID_NOT_FOUND. Only re-stamp when a
          // PostToolUse hook (formatter / lint-fix / import sort) actually
          // changed the file, i.e. the current-scope receipt no longer
          // matches the post-hook disk state.
          if (!hasCurrentScopeReceiptMatchingDisk(rr.resolved, statNow.mtimeMs, diskNow)) {
            recordSuccessfulRead(rr.resolved, {
              mtimeMs: statNow.mtimeMs,
              isPartialView: false,
              fullFileContent: diskNow,
              source: 'self_mutation',
            })
          }
          // Keep Rate anchor: schedule +5/+30/+180min survival checks so
          // we can later A/B-test harness changes against "did the user
          // keep what the agent wrote". Fire-and-forget; failures here
          // must never affect the tool's success path. `contentBefore`
          // is populated from the previous full-read receipt above,
          // which enables the `reverted` outcome.
          try {
            anchorKeepRateEdit({
              toolName: toolUse.name,
              resolvedPath: rr.resolved,
              workspaceRoot: getWorkspacePath(),
              contentBefore,
              contentAfter: diskNow,
              agentId: getAgentContext()?.agentId,
            })
          } catch {
            /* telemetry is best-effort */
          }
        }
      } catch {
        // best-effort — the pre-existing receipt is still valid enough to
        // block un-read edits; mtime mismatch on the next turn is a
        // recoverable "please re-read" error rather than silent corruption.
      }
    }
  }

  // Loop-level LSP diagnostics decorator (method B from the LSP feedback fix).
  //
  // Builtin file-mutation tools (edit_file / write_file / NotebookEdit) await
  // the LSP and attach a fresh trailer themselves, marking
  // `result.diagnosticsAttached = true`. This block backfills a best-effort
  // snapshot trailer for OTHER mutation paths — primarily the MCP filesystem
  // bridge (mcp_filesystem__edit_file, etc.) and any third-party file-diff
  // tool — so the agent still sees diagnostics in the same tool_result.
  //
  // We don't await any LSP work here (the tool already returned); we just
  // snapshot the diagnostics store. `mode: 'snapshot'` keeps the trailer
  // silent when the store is empty, so quiet edits stay quiet.
  if (
    result.success &&
    result.diagnosticsAttached !== true &&
    (isWorkspaceFileMutationTool ||
      isWorkspaceFileDiffTool ||
      isMcpWorkspaceFileDiffTool(toolUse.name))
  ) {
    const fp = extractWorkspaceFilePathFromToolInput(executionInput)
    if (fp) {
      try {
        const rr = resolvePathForTool(fp)
        if (rr.ok) {
          const trailer = buildLspDiagnosticsTrailer(rr.resolved, {
            lspApplicable: false,
            diagnosticsArrived: false,
            timeoutMs: 0,
            mode: 'snapshot',
          })
          if (trailer) {
            result = {
              ...result,
              output: `${result.output ?? ''}${trailer}`,
              diagnosticsAttached: true,
            }
          }
        }
      } catch {
        // Snapshotting diagnostics must never fail the tool result. If the
        // store throws or path resolution fails, we just skip the trailer —
        // the next-turn passive injection will still surface the issue.
      }
    }
  }

  if (result.deferredRuntimeStoreCompletion === true) {
    // The tool has handed back a "spawn accepted" receipt (e.g. background
    // Agent) but the underlying work is still in flight. Append the tool's
    // returned payload as text so the runtime stream contains the receipt,
    // but DO NOT mark the record terminal — the tool's own completion
    // callback will flip status when the actual work finishes/fails. This
    // is what stops `TaskOutput` from telling the parent "Status: completed,
    // (no output)" while the sub-agent is still booting.
    if (result.output) {
      taskRuntimeStore.append(toolUse.id, 'text', `${result.output}\n`)
    }
  } else if (result.success) {
    taskRuntimeStore.append(toolUse.id, 'text', `${result.output || 'Tool completed successfully.'}\n`)
    taskRuntimeStore.markCompleted(toolUse.id)
  } else {
    taskRuntimeStore.markFailed(toolUse.id, result.error || 'Unknown error')
  }

  if (toolUse.name === 'Skill' && result.success && result.clearInlineSkillSession) {
    setInlineSkillSession(null)
  } else if (toolUse.name === 'Skill' && result.success && result.inlineSkillSession !== undefined) {
    const s = result.inlineSkillSession
    // `effort` is declared on `ToolResult.inlineSkillSession` as the narrow
    // `SkillEffort` union, but TypeScript widens it to `string` through
    // optional-access so we re-assert it here. Invalid values (not in the
    // union) are treated as `undefined` so downstream session state never
    // sees a garbage effort value.
    const validEfforts = new Set(['low', 'medium', 'high', 'max'])
    const effort: 'low' | 'medium' | 'high' | 'max' | undefined =
      typeof s.effort === 'string' && validEfforts.has(s.effort)
        ? (s.effort as 'low' | 'medium' | 'high' | 'max')
        : undefined
    setInlineSkillSession(
      (s.allowedTools && s.allowedTools.length > 0) ||
        Boolean(s.model?.trim()) ||
        Boolean(effort) ||
        Boolean(s.skillName?.trim())
        ? {
            skillName: s.skillName?.trim() || undefined,
            allowedTools: s.allowedTools?.length ? s.allowedTools : undefined,
            model: s.model?.trim() || undefined,
            effort,
          }
        : null,
    )
  }

  if (result.success && isWorkspaceFileDiffTool && filePathForDiff && fileContentBefore !== null) {
    try {
      const resolveResult = resolvePathForTool(filePathForDiff)
      if (resolveResult.ok) {
        const resolved = resolveResult.resolved
        const fileContentAfter = fs.readFileSync(resolved, 'utf-8')

        // P1 shadow: resolve the DT with the actual post-write content so the broadcast
        // event downstream observers receive carries an authoritative `appliedContentHash`.
        // Do this BEFORE emitting file_change_applied so any future consumer reading the
        // DT via IPC sees it in Applied state when the event arrives.
        shadowResolveToolResult(shadowDtId, {
          success: true,
          postWriteContent: fileContentAfter,
          postWriteReadId: null, // P1 does not thread readId through; P3 will.
        })

        if (fileContentBefore !== fileContentAfter) {
          emitStreamEvent({
            type: 'file_change_applied',
            filePath: resolved.replace(/\\/g, '/'),
            originalContent: fileContentBefore,
            modifiedContent: fileContentAfter,
            toolUseId: toolUse.id,
            toolName: toRendererFileToolName(toolUse.name),
            alreadyReviewedViaPermissionUi: fileMutationApprovedViaPermissionUi,
          })
        }
      }
    } catch (err) {
      console.warn('[Agentic Loop] Failed to capture post-edit content for diff:', err)
    }
  }

  // P1 shadow: if the tool failed (for any reason — hash gate, lock, disk, crash), close
  // the DT with Failed. Applied is handled inside the success branch above, right next to
  // file_change_applied emission. Splitting the two resolutions like this keeps the DT
  // lifecycle aligned with the existing stream-event contract.
  if (!result.success && shadowDtId) {
    shadowResolveToolResult(shadowDtId, {
      success: false,
      error: result.error,
    })
  }

  callbacks.onToolResult({
    id: toolUse.id,
    name: toolUse.name,
    success: result.success,
    output: result.output,
    error: result.error,
    // Forward structured failure fields when present (populated by
    // `buildToolFailure(...)` at the tool layer). Spreading these here is
    // the single point where the renderer's `tool_result` event gains the
    // structured `errorWhat / errorTried / errorContext / errorNext` —
    // every intermediate callback signature is widened to accept them.
    toolErrorClass: result.toolErrorClass,
    errorWhat: result.errorWhat,
    errorTried: result.errorTried,
    errorContext: result.errorContext,
    errorNext: result.errorNext,
  })

  updateFromToolUse(toolUse.name, toolUse.input, {
    success: result.success,
    output: result.output,
    error: result.error,
  })

  return mapToolUseToToolResultBlockParam({
    toolUseId: toolUse.id,
    success: result.success,
    output: result.output,
    error: result.error,
  })
}
