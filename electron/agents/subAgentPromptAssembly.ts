/**
 * Sub-agent prompt + message assembly.
 *
 * Behavior-preserving extraction of the prompt / message building block from
 * `runSubAgent` (see `subAgentRunner.ts`). This is a pure code move: it builds
 * the `systemPrompt` (stable + volatile split) and the initial `messages`
 * list, with no logic changes and no reordering of side effects.
 */

import type { AgentId } from '../tools/ids'
import type { Tool, ToolDefinition } from '../tools/types'
import type { AgentDefinitionUnion } from './types'
import type { AgentContext } from './agentContext'
import { EDIT_TOOL_NAME, MULTI_EDIT_TOOL_NAME, registryPrimaryToolName } from '../tools/builtinToolAliases'
import { recallForPromptAI } from '../memory/service'
import { getRecallTuning, shouldSkipRetrievalForQuery } from '../memory/recallTuning'
import { logAsyncAgentPhase } from './asyncAgentLifecycle'
import { getWorkspacePath } from '../tools/workspaceState'
import { enhanceSubagentSystemPrompt } from './subagentSystemPrompt'
import {
  formatLspPassiveDiagnosticsSection,
  stripLspPassiveDiagnosticsBlock,
} from '../ai/systemPrompt'
import {
  consumePassiveLspDiagnosticsForPrompt,
  parseLspPassiveInjectMode,
} from '../lsp/formatDiagnosticsForPrompt'
import { shellExecutionToolInDefinitions } from '../tools/schema'
import { readDiskSettings } from '../settings/settingsAccess'
import { getCoordinatorUserContext } from './coordinatorMode'
import { listMcpServerNamesFromToolRegistry } from './mcpNamesFromRegistry'
import { ensureScratchpadDir } from './scratchpadDir'
import { buildPreloadedSkillsPromptAppend } from './subAgentSkillPreload'
import { buildAgentMemoryPromptAppend } from '../memory/agentMemory'
import { isAutoMemoryGloballyDisabled } from '../memory/memoryFeatureFlags'
import {
  buildKnownFilesContextBlock,
  combineKnownFilesAndPrompt,
} from './subAgentKnownFilesContext'
import {
  SUB_AGENT_OUTPUT_LEAD,
  SUB_AGENT_PARENT_OUTPUT_DISCIPLINE,
  COORDINATOR_TOOL_SURFACE_HEADER,
  wrapInheritedParentContext,
  buildWorkspaceRetrievalBlock,
  buildRetrievalIncompleteNotice,
} from './subAgentPrompts'
import { buildOrchestrationContractAppend } from './orchestrationContractPrompt'

export async function assembleSubAgentPrompt(args: {
  agentDef: AgentDefinitionUnion
  model: string
  agentTools: Tool[]
  toolDefinitions: ToolDefinition[]
  parentSystemPrompt: string | undefined
  parentContext: AgentContext | null
  prompt: string
  parentMessages: Array<Record<string, unknown>> | undefined
  appendParentPrompt: boolean
  agentId: AgentId
}): Promise<{
  systemPrompt: string
  stableSystemContext: string
  volatileUserContext: string
  messages: { role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }[]
}> {
  const {
    agentDef,
    model,
    agentTools,
    toolDefinitions,
    parentSystemPrompt,
    parentContext,
    prompt,
    parentMessages,
    appendParentPrompt,
    agentId,
  } = args

  const reminder = agentDef.criticalReminder ? `${agentDef.criticalReminder}\n\n` : ''
  const cwdRaw = getWorkspacePath()
  const cwd =
    typeof cwdRaw === 'string' && cwdRaw.trim() ? cwdRaw.trim() : process.cwd()
  const lspInjectMode = parseLspPassiveInjectMode(
    readDiskSettings().injectLspPassiveDiagnostics,
  )
  let corePrompt = parentSystemPrompt ?? agentDef.getSystemPrompt()
  if (parentSystemPrompt && lspInjectMode !== 'off') {
    corePrompt = stripLspPassiveDiagnosticsBlock(corePrompt)
  }
  // Inject EDIT_FILE_CONTRACT_BLOCK for any sub-agent that actually has the
  // Edit OR MultiEdit tool on its surface. Both tools require the same
  // read-before-write + verbatim-old_string contract — the only difference
  // is single vs batched mutation. The tool registry stores these under
  // `edit_file` / `multi_edit_file` (snake_case) while the canonical names
  // are `Edit` / `MultiEdit` — normalize both sides via
  // `registryPrimaryToolName` so the check works regardless of which form
  // the agent's tool surface happens to expose. Fork sub-agents that inherit
  // the main chat's prompt already carry the contract — the enhancer is
  // idempotent via a marker check, so this flag is safe to pass whenever
  // the tool surface warrants it.
  const editToolRegistryName = registryPrimaryToolName(EDIT_TOOL_NAME)
  const multiEditToolRegistryName = registryPrimaryToolName(MULTI_EDIT_TOOL_NAME)
  const subagentHasEditTool = agentTools.some((t) => {
    const reg = registryPrimaryToolName(t.name)
    return reg === editToolRegistryName || reg === multiEditToolRegistryName
  })
  const withSubagentEnv = enhanceSubagentSystemPrompt(corePrompt, model, {
    cwd,
    compactEnv: Boolean(agentDef.omitClaudeMd),
    includeEditFileContract: subagentHasEditTool,
  })
  const systemPromptBase = parentSystemPrompt ? withSubagentEnv : reminder + withSubagentEnv
  // Path A — auto-injected Orchestration Contract for non-built-in
  // agents. Built-in prompts already say all this by hand; bundle /
  // custom / plugin agents (especially imported industry bundles)
  // typically do not, and this appendix derives the contract from
  // existing AgentDefinition metadata. No-op when env opt-out is set.
  // Forks skip this — they inherit the parent's prompt verbatim and
  // re-wrapping would double-inject.
  const orchestrationContractAppend = parentSystemPrompt
    ? ''
    : buildOrchestrationContractAppend({
        source: agentDef.source,
        orchestrationRole: agentDef.orchestrationRole,
        isReadOnly: agentDef.isReadOnly,
        coordinatorPhase: agentDef.coordinatorPhase,
        maxTurns: agentDef.maxTurns,
        toolNames: agentTools.map((t) => t.name),
      })
  // upstream §7.2: track the stable (cache-friendly) prefix and the
  // volatile user-scope sections separately so the `systemPromptLayers`
  // we hand to `streamText` reflect the same split the main chat uses.
  // Previously the sub-agent collapsed everything into `systemContext`
  // with an empty `userContext`, breaking the default block-mode cache
  // layout and `anthropic.messages.countTokens` accuracy (audit Bug 5).
  let stableSystemContext = `${SUB_AGENT_OUTPUT_LEAD}\n\n${systemPromptBase}${orchestrationContractAppend}\n\n${SUB_AGENT_PARENT_OUTPUT_DISCIPLINE}`
  const skillsAppend = buildPreloadedSkillsPromptAppend(agentDef.skills)
  if (skillsAppend) {
    stableSystemContext = `${stableSystemContext}\n\n${skillsAppend}`
    logAsyncAgentPhase(agentId, 'skills_loaded', String(agentDef.skills?.length ?? 0))
  }
  const agentMemoryAppend = buildAgentMemoryPromptAppend(
    agentDef.agentType,
    cwd,
    agentDef.memory,
  )
  if (agentMemoryAppend.trim()) {
    stableSystemContext = `${stableSystemContext}\n\n${agentMemoryAppend}`
  }
  // Volatile user-scope sections are accumulated separately; merged with
  // the stable prefix into `systemPrompt` at the end of this function so
  // non-layered callers still get a single string.
  const volatileUserContextParts: string[] = []

  // Parent user-context inheritance (feature audit). Fresh sub-agents
  // spawned via Task / Spawn tools don't get the parent's session
  // summary / memory recall / LSP diagnostics — previously they re-did
  // their own recall and lost continuity with what the main chat was
  // already discussing. When the parent's `systemPromptLayers.userContext`
  // is present, inject it as the first volatile block so the child sees
  // the same world the parent does. Opt-out via
  // `POLE_SUBAGENT_INHERIT_USER_CONTEXT=0` for workloads that prefer
  // a cleaner slate (e.g. isolated verification agents).
  const parentUserCtx = parentContext?.systemPromptLayers?.userContext?.trim()
  const shouldInheritParentUserCtx =
    !!parentUserCtx &&
    process.env.POLE_SUBAGENT_INHERIT_USER_CONTEXT !== '0' &&
    // Fork path already received `parentSystemPrompt` — skip to avoid
    // double-injection; fork's parent context is already in the stable
    // prefix.
    !parentSystemPrompt &&
    // Session-memory-internal writes memory; it shouldn't inherit a
    // snapshot of what parent already has.
    agentDef.agentType !== 'session-memory-internal'
  if (shouldInheritParentUserCtx) {
    volatileUserContextParts.push(wrapInheritedParentContext(parentUserCtx!))
  }

  let systemPrompt = stableSystemContext

  // Vector-aware context injection for *fresh* sub-agents (not forks).
  //
  // Forks inherit the parent's system prompt — which already carries the
  // parent's memory + workspace snippets — so re-running recall would just
  // duplicate work. Fresh sub-agents (Task / Spawn / built-in agents) get
  // their own one-shot recall so they aren't worse-off than the main chat.
  //
  // Skipped:
  //   - When auto-memory is globally disabled.
  //   - For internal/system agents (e.g. session-memory-internal) whose job
  //     is *to write* memory, not consume it.
  //   - When `prompt` is empty (defensive — recall on empty string is noise).
  if (!parentSystemPrompt
    && !isAutoMemoryGloballyDisabled()
    && agentDef.agentType !== 'session-memory-internal'
    && typeof prompt === 'string'
    && prompt.trim().length > 0
  ) {
    // Same fast-path / tuning the main chat uses (V-1 / V-4 fixes). Without
    // this gate sub-agents would happily run a full embed + RRF + LLM
    // selector on a single-token prompt like "ok", and the workspace top-K
    // would silently swallow sub-floor hits regardless of cosine.
    const tuning = getRecallTuning()
    if (!shouldSkipRetrievalForQuery(prompt, tuning)) {
      // Budgeted retrieval — was previously unbounded.
      //
      // Production symptom: a single sub-agent took ~20s to "start"
      // (parent issued the Agent tool, but the first model call only fired
      // ~20s later). Tracing showed both retrieval calls below were synchronous
      // pre-launch work:
      //
      //   - `recallForPromptAI` runs `findRelevantMemories`, which (when the
      //     `memoryAiRecallEnabled` setting is on — default) issues a FULL
      //     LLM round-trip via `sideQueryLLM` to pick relevant memory entries
      //     (~5-10s on a busy gateway).
      //   - `queryWorkspaceIndex` runs an embedding forward pass + vector
      //     query (~2-5s on a cold cache).
      //
      // Multiplied by N parallel sub-agents this also pushed N+1 extra LLM
      // requests through the same API key, frequently tripping
      // upstream concurrency limits and the new TTFB watchdog
      // (`Stream first-activity timeout`). The main chat already has the
      // exact same risk and bounds it via `RETRIEVAL_BUDGET_MS = 800`; we
      // mirror that pattern here with a slightly more generous 1500ms cap
      // so cold disk caches still have a shot, and skip whichever source
      // doesn't finish in time.
      //
      // Override via `POLE_SUBAGENT_RETRIEVAL_BUDGET_MS` (set to `0` to
      // restore the legacy unbounded behaviour for debugging).
      const budgetEnv = process.env.POLE_SUBAGENT_RETRIEVAL_BUDGET_MS
      const budgetParsed =
        budgetEnv != null && budgetEnv !== '' ? Number(budgetEnv) : NaN
      const SUBAGENT_RETRIEVAL_BUDGET_MS = Number.isFinite(budgetParsed)
        ? Math.max(0, budgetParsed)
        : 1500

      const collectedRetrievalBlocks: string[] = []
      const retrievalTasks: Array<Promise<void>> = []

      retrievalTasks.push(
        (async () => {
          try {
            const memBlock = await recallForPromptAI(prompt, undefined, {
              minScore: tuning.minScore,
            })
            if (memBlock.trim()) collectedRetrievalBlocks.push(memBlock)
          } catch (err) {
            console.warn(`[subAgentRunner ${agentId}] memory recall failed:`, err)
          }
        })(),
      )

      if (tuning.workspaceEnabled) {
        retrievalTasks.push(
          (async () => {
            try {
              const ws = (cwd && cwd.trim()) || null
              if (!ws) return
              const { queryWorkspaceIndex } = await import('../embedding/workspaceIndex')
              const hits = await queryWorkspaceIndex(ws, prompt, tuning.workspaceTopK, {
                minScore: tuning.workspaceMinScore,
              })
              const block = buildWorkspaceRetrievalBlock(hits)
              if (block) {
                collectedRetrievalBlocks.push(block)
              }
            } catch (err) {
              console.warn(
                `[subAgentRunner ${agentId}] workspace semantic retrieval failed:`,
                err,
              )
            }
          })(),
        )
      }

      let retrievalBudgetExceeded = false
      if (SUBAGENT_RETRIEVAL_BUDGET_MS > 0) {
        const allTasks = Promise.all(retrievalTasks).then(() => undefined)
        const budgetTimer = new Promise<void>((resolve) =>
          setTimeout(resolve, SUBAGENT_RETRIEVAL_BUDGET_MS),
        )
        const startedAt = Date.now()
        await Promise.race([allTasks, budgetTimer])
        const elapsed = Date.now() - startedAt
        if (elapsed >= SUBAGENT_RETRIEVAL_BUDGET_MS) {
          retrievalBudgetExceeded = true
          // Whatever finished is in `collectedRetrievalBlocks` already; the
          // late tasks keep running but their results are dropped. We log
          // for diagnosability — repeated sightings mean the budget should
          // probably move, the embedding/selector pipeline should be
          // optimized, or the user wants the retrieval off entirely.
          logAsyncAgentPhase(
            agentId,
            'retrieval_budget_exceeded',
            `${elapsed}ms (budget=${SUBAGENT_RETRIEVAL_BUDGET_MS}ms)`,
          )
        }
      } else {
        // Legacy unbounded path — kept as an explicit opt-out for users who
        // want to debug what the retrieval pipeline actually returns
        // without the budget gate hiding late results.
        await Promise.all(retrievalTasks)
      }

      for (const b of collectedRetrievalBlocks) {
        volatileUserContextParts.push(b)
      }

      // Audit P2 (2026-06) — the retrieval budget silently dropped late
      // memory / workspace-vector results on a slow gateway, so a sub-agent
      // could start with PARTIAL or ZERO recall and silently reason as if it
      // had the full picture. Surface the gap to the model (cheap, no extra
      // latency) so it knows to do its own Read / Grep / Glob instead of
      // assuming the retrieved context is complete. Only emitted on the slow
      // path; a recall that finished within budget adds nothing.
      if (retrievalBudgetExceeded) {
        volatileUserContextParts.push(
          buildRetrievalIncompleteNotice({
            recalled: collectedRetrievalBlocks.length,
            workspaceEnabled: tuning.workspaceEnabled,
            budgetMs: SUBAGENT_RETRIEVAL_BUDGET_MS,
          }),
        )
      }
    }
  }

  // P0: do NOT drain pending LSP diagnostics for session-memory-internal.
  // `consumePassiveLspDiagnosticsForPrompt` is a one-shot drain (see
  // `LSPDiagnosticRegistry.checkForLSPDiagnostics`: marks `attachmentSent=true`
  // and removes from the pending map). If session-memory runs while diagnostics
  // are pending, it silently steals them from the main agent which never sees
  // the file errors it is supposed to act on. session-memory has no use for
  // them (it writes prose summaries to memory.md, not code).
  if (lspInjectMode !== 'off' && agentDef.agentType !== 'session-memory-internal') {
    // method C: the legacy upstream §9.3 gate (only drain when shell is in
    // tool listing) is opt-in via `lspPassiveDiagnosticsRequireShellTool`.
    // Default false ⇒ sub-agents without shell access still get diagnostics.
    const requireShellTool =
      readDiskSettings().lspPassiveDiagnosticsRequireShellTool === true
    const passive = consumePassiveLspDiagnosticsForPrompt(lspInjectMode, {
      shellExecutionToolInListing: shellExecutionToolInDefinitions(toolDefinitions),
      requireShellTool,
    })
    // LSP passive diagnostics are a turn-scoped volatile block; append to
    // the user-scope layer, not the stable prefix.
    const lspSection = formatLspPassiveDiagnosticsSection(passive)
    if (lspSection) {
      volatileUserContextParts.push(lspSection)
    }
  }

  if (agentDef.agentType === 'Coordinator') {
    // Auto-resolve a workspace-relative scratchpad when the env override
    // isn't set, so the cross-sub-agent shared file surface works out of
    // the box. `ensureScratchpadDir` also mkdir's the directory so the
    // first worker write doesn't fight a race in `mkdir -p`.
    const scratchpad = ensureScratchpadDir(getWorkspacePath())
    const coordCtx = getCoordinatorUserContext(
      listMcpServerNamesFromToolRegistry().map((name) => ({ name })),
      scratchpad,
    )
    if (coordCtx.workerToolsContext) {
      // Coordinator tool surface is session-stable (rebuilt from MCP
      // registry), so it stays in the cacheable prefix.
      stableSystemContext = `${stableSystemContext}\n\n${COORDINATOR_TOOL_SURFACE_HEADER}\n${coordCtx.workerToolsContext}`
    }
  }

  // Rebuild flat `systemPrompt` for non-layered callers as stable + volatile,
  // matching what `mergeSystemPromptLayers` would produce.
  const volatileUserContext = volatileUserContextParts.join('\n\n').trim()
  systemPrompt = volatileUserContext
    ? `${stableSystemContext}\n\n${volatileUserContext}`
    : stableSystemContext

  // 3. Build message list (preserve structured content blocks for forked API transcripts)
  let messages: {
    role: 'user' | 'assistant'
    content: string | Array<Record<string, unknown>>
  }[]
  if (parentMessages && parentMessages.length > 0) {
    const inherited = parentMessages.map((m) => {
      const role = m.role as 'user' | 'assistant'
      const c = m.content
      if (typeof c === 'string') return { role, content: c }
      if (Array.isArray(c)) return { role, content: c as Array<Record<string, unknown>> }
      return { role, content: JSON.stringify(c) }
    })
    if (appendParentPrompt) {
      inherited.push({ role: 'user', content: prompt })
    }
    messages = inherited
  } else {
    // Fresh agent: prompt — optionally prefixed with a "known files already read"
    // block so this sub-agent doesn't waste turns re-Reading what the parent or
    // a sibling already opened. Skipped for fork (handled above), session-memory-internal
    // (sandboxed scribe), and when the user opted out via env.
    const inheritReceipts =
      agentDef.agentType !== 'session-memory-internal' &&
      process.env.POLE_SUBAGENT_INHERIT_READ_RECEIPTS !== '0'
    const knownFilesBlock = inheritReceipts
      ? buildKnownFilesContextBlock({
          conversationId:
            typeof parentContext?.streamConversationId === 'string'
              ? parentContext.streamConversationId
              : undefined,
          currentAgentId: String(agentId),
        })
      : ''
    const initialUserBody = combineKnownFilesAndPrompt(knownFilesBlock, prompt)
    messages = [{ role: 'user', content: initialUserBody }]
  }

  const initial = agentDef.initialPrompt?.trim()
  if (initial) {
    messages = messages.map((m, i) => {
      if (i !== 0 || m.role !== 'user') return m
      const c = m.content
      if (typeof c === 'string') {
        return { role: m.role, content: `${initial}\n\n${c}` }
      }
      if (Array.isArray(c)) {
        return {
          role: m.role,
          content: [{ type: 'text', text: `${initial}\n\n` }, ...c],
        }
      }
      return { role: m.role, content: `${initial}\n\n${JSON.stringify(c)}` }
    })
  }

  return { systemPrompt, stableSystemContext, volatileUserContext, messages }
}
