import type { ToolResult, ToolUseContext } from './types'
import { buildTool } from './buildTool'
import {
  consumePrePlanMode,
  getPermissionMode,
  type PermissionMode,
  setPermissionMode,
} from '../ai/interactionState'
import {
  awaitChatLeaderPlanApproval,
  awaitTeamLeaderPlanApproval,
  getChatLeaderPlanApprovalConversationId,
  isWorkerExitPlanDelegatedToTeamLeader,
} from '../agents/teamPlanApprovalLeaderBridge'
import {
  awaitMainChatPlanApproval,
  type PlanApprovalEnvelope,
  type PlanTodo,
} from '../agents/mainChatPlanApprovalBridge'
import { getAgentContext } from '../agents/agentContext'
import { cancelStream } from '../ai/streamHandler'
import { exitPlanModeInputZod } from './toolInputZod'
import { persistPlanFromOutput, initPlanRuntime } from '../planning/planRuntime'
import { markPendingPlanVerification } from '../planning/planVerificationState'
import { getPrimaryWorkspaceRoot } from '../security/workspaceAccess'

/**
 * When the model approved a plan via structured `todos` / `phases` but did
 * NOT supply a `planMarkdown` body, synthesize a markdown plan so the plan
 * is still persisted to `.cursor/plans/*.plan.md` (and the plan tab + live
 * progress can light up). Returns '' when there is nothing actionable to
 * persist (no todos / phases), leaving the legacy "no file" behaviour.
 */
function synthesizePlanMarkdownForPersist(p: {
  name?: string
  overview?: string
  todos?: Array<{ content?: string; status?: string }>
  phases?: Array<{ name?: string; todos?: Array<{ content?: string; status?: string }> }>
}): string {
  const itemLine = (t: { content?: string; status?: string } | undefined): string | null => {
    const c = String(t?.content ?? '').trim()
    if (!c) return null
    const box = t?.status === 'completed' || t?.status === 'cancelled' ? '[x]' : '[ ]'
    return `- ${box} ${c}`
  }
  const body: string[] = []
  if (Array.isArray(p.phases) && p.phases.length > 0) {
    for (const ph of p.phases) {
      const phaseLines = (ph?.todos ?? [])
        .map(itemLine)
        .filter((l): l is string => l !== null)
      if (phaseLines.length === 0) continue
      body.push('', `## ${String(ph?.name ?? 'Phase').trim() || 'Phase'}`, '', ...phaseLines)
    }
  } else if (Array.isArray(p.todos) && p.todos.length > 0) {
    const todoLines = p.todos.map(itemLine).filter((l): l is string => l !== null)
    if (todoLines.length > 0) body.push('', '## Todos', '', ...todoLines)
  }
  if (body.length === 0) return ''
  const head: string[] = [`# ${p.name?.trim() || 'Plan'}`]
  if (p.overview?.trim()) head.push('', p.overview.trim())
  return [...head, ...body, ''].join('\n')
}

export const exitPlanModeTool = buildTool({
  name: 'ExitPlanMode',
  description:
    'Prompts the user to exit plan mode and start implementation. Should be called after a concrete plan is prepared.',
  zInputSchema: exitPlanModeInputZod,
  inputSchema: [
    {
      name: 'allowedPrompts',
      type: 'array',
      description:
        'Optional semantic permissions needed during implementation (e.g. run tests, install dependencies).',
      items: {
        type: 'object',
        description: 'Permission object with tool and prompt fields',
      },
    },
    {
      name: 'planMarkdown',
      type: 'string',
      description:
        'Optional full plan markdown / ```plan-json fenced block. When present, the plan is persisted under <workspace>/.cursor/plans/ and TaskList entries are seeded. In plan-json, each todo may declare an optional `files` array (paths or simple globs, e.g. "src/parser/**") naming the files that step is expected to touch — the host uses it to keep execution focused on the current step.',
    },
    {
      name: 'name',
      type: 'string',
      description: 'Optional short title for the plan (Cursor `create_plan` style).',
    },
    {
      name: 'overview',
      type: 'string',
      description: 'Optional one-sentence summary shown above the plan body.',
    },
    {
      name: 'isProject',
      type: 'boolean',
      description: 'Optional: mark this plan as a longer-running project.',
    },
    {
      name: 'todos',
      type: 'array',
      description:
        'Optional structured todo list. Each item: { id?: string, content: string, status: "pending"|"in_progress"|"completed"|"cancelled" }.',
      items: { type: 'object', description: 'Plan todo' },
    },
    {
      name: 'phases',
      type: 'array',
      description:
        'Optional grouping of todos into named phases: [{ name: string, todos: [...] }]. Use when the plan has clear sequential stages.',
      items: { type: 'object', description: 'Plan phase' },
    },
  ],
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(
    {
      allowedPrompts: rawAllowedPrompts,
      planMarkdown,
      name,
      overview,
      isProject,
      todos,
      phases,
    },
    ctx?: ToolUseContext,
  ) {
    if (getPermissionMode() !== 'plan') {
      return {
        success: false,
        error:
          'You are not in plan mode. ExitPlanMode can only be used after EnterPlanMode.',
      }
    }

    const allowedPrompts = Array.isArray(rawAllowedPrompts)
      ? (rawAllowedPrompts as Array<Record<string, unknown>>)
      : []

    // Read planMarkdown up-front so it can be both ferried to the team lead
    // (when this run is a teammate awaiting leader approval) and persisted
    // locally after approval. The string is trimmed once here and reused —
    // re-parsing the input record below would let an empty string through
    // as a "did the caller supply this?" signal.
    const planMarkdownInput =
      typeof planMarkdown === 'string' ? planMarkdown.trim() : ''

    // P0-2 (upstream §6.2): teammate workers cannot self-approve exiting
    // plan mode. Two delegation paths exist; we try them in priority
    // order and fall through to local `requestPermission` if neither
    // applies.
    //
    //   1. **Team mailbox** — the worker is part of a real team (TeamFile
    //      with a `leadAgentId` other than us). Approval rides on the
    //      mailbox protocol; the lead's main agent sees the request via
    //      `injectPendingInterAgentQueue` and responds via SendMessage.
    //
    //   2. **Direct chat leader** (renderer-teammate path) — the worker
    //      was spawned from the TeammatePanel with `planModeRequired:true`;
    //      no TeamFile exists. The "leader" is the main chat conversation
    //      that started this run. Approval emits a stream event there;
    //      the user clicks Approve/Deny on an inline card; resolution
    //      lands via IPC `ai:respond-team-plan-approval`.
    //
    // Mailbox wins when both apply (team membership is more specific
    // than ad-hoc spawn). Worker tool result and `skipModeMutation`
    // semantics are identical for both — the worker remains in plan
    // mode for its own tool gating (its `permissionModeOverride` is
    // immutable post-spawn), and the success message tells the
    // parent/leader the plan is approved.
    if (isWorkerExitPlanDelegatedToTeamLeader()) {
      const decision = await awaitTeamLeaderPlanApproval({
        planMarkdown: planMarkdownInput || '(no plan markdown supplied)',
        ...(allowedPrompts.length > 0 ? { allowedPrompts } : {}),
      })
      if (!decision.approved) {
        const reason =
          decision.reason === 'timeout'
            ? 'Team lead did not respond before the approval timeout. Re-call ExitPlanMode after pinging the lead, or refine the plan and retry.'
            : decision.reason === 'aborted'
              ? 'Plan-approval wait was aborted (parent task cancellation).'
              : decision.reason === 'delivery_failed'
                ? 'Could not deliver plan_approval_request to the team lead mailbox — check team registration. Plan mode unchanged.'
                : decision.reason === 'no_leader'
                  ? 'Plan approval requires a team lead, but no leader is currently registered for this team.'
                  : `Team lead declined exiting plan mode${decision.detail ? `: ${decision.detail}` : '.'}`
        return { success: false, error: reason }
      }
      return finalizeExitPlanMode({
        planMarkdownInput,
        approvalNote: decision.detail
          ? ` (lead note: ${decision.detail})`
          : ' (approved by team lead)',
        skipModeMutation: true,
      })
    }

    const chatLeaderCid = getChatLeaderPlanApprovalConversationId()
    if (chatLeaderCid) {
      const decision = await awaitChatLeaderPlanApproval({
        delegateConversationId: chatLeaderCid,
        planMarkdown: planMarkdownInput || '(no plan markdown supplied)',
        ...(allowedPrompts.length > 0 ? { allowedPrompts } : {}),
      })
      if (!decision.approved) {
        const reason =
          decision.reason === 'timeout'
            ? 'User did not respond to the plan-approval card before the timeout. Refine the plan and retry, or ask the user to re-spawn the teammate.'
            : decision.reason === 'aborted'
              ? 'Plan-approval wait was aborted (parent task cancellation).'
              : decision.reason === 'no_leader'
                ? 'No main chat conversation is registered to receive the approval card.'
                : `User declined exiting plan mode${decision.detail ? `: ${decision.detail}` : '.'}`
        return { success: false, error: reason }
      }
      return finalizeExitPlanMode({
        planMarkdownInput,
        approvalNote: decision.detail
          ? ` (user note: ${decision.detail})`
          : ' (approved by user from main chat)',
        skipModeMutation: true,
      })
    }

    // Main chat agent: the IDE `create_plan`-style structured gate. Replaces
    // the legacy generic `requestPermission` allow/deny dialog with a
    // dedicated PlanApprovalCard that carries the full plan envelope and
    // resolves to one of three outcomes.
    const envelope: PlanApprovalEnvelope = {
      planMarkdown: planMarkdownInput || '(no plan markdown supplied)',
      ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}),
      ...(typeof overview === 'string' && overview.trim()
        ? { overview: overview.trim() }
        : {}),
      ...(typeof isProject === 'boolean' ? { isProject } : {}),
      ...(Array.isArray(todos) && todos.length > 0
        ? { todos: todos as Array<PlanTodo> }
        : {}),
      ...(Array.isArray(phases) && phases.length > 0
        ? { phases: phases as Array<{ name: string; todos: Array<PlanTodo> }> }
        : {}),
      ...(allowedPrompts.length > 0 ? { allowedPrompts } : {}),
    }

    const decision = await awaitMainChatPlanApproval(envelope, {
      ...(ctx?.abortSignal ? { signal: ctx.abortSignal } : {}),
    })

    if (decision.outcome === 'cancelled') {
      // Abort the entire turn — the loop's next iteration checks
      // `state.signal.aborted` and terminates with `aborted_streaming`.
      // Returning `success: false` here is mostly for the model record;
      // the loop usually won't deliver this back since the abort fires
      // synchronously after.
      //
      // When the bridge reported `reason: 'aborted'`, abort propagation
      // already happened upstream (the conversation-cancel drain hook fired
      // because `cancelStream` was already invoked). Re-calling `cancelStream`
      // is harmless (idempotent abort) but pointless — skip the work.
      if (decision.reason !== 'aborted') {
        const cid = getAgentContext()?.streamConversationId
        if (cid) {
          try {
            cancelStream(cid)
          } catch {
            /* best-effort; abort propagation is what matters */
          }
        }
      }
      return {
        success: false,
        error: decision.detail
          ? `User cancelled plan approval: ${decision.detail}`
          : 'User cancelled plan approval and aborted the turn.',
      }
    }

    if (decision.outcome === 'rejected') {
      // Stay in plan mode — model receives the rejection reason and can
      // revise the plan, then call ExitPlanMode again. Matches the IDE's
      // `outcome: "rejected"` semantics.
      const tail =
        decision.reason === 'timeout'
          ? 'User did not respond before the approval timeout.'
          : decision.detail
            ? `User rejected the plan: ${decision.detail}`
            : 'User rejected the plan. Revise and call ExitPlanMode again.'
      return { success: false, error: tail }
    }

    // Main-chat approval: if the model only gave structured todos/phases (no
    // planMarkdown), synthesize a markdown body so the plan is still persisted
    // to `.cursor/plans/` and the live plan tab can open (plan:active).
    const effectivePlanMarkdown =
      planMarkdownInput ||
      synthesizePlanMarkdownForPersist({
        name,
        overview,
        todos: todos as unknown as Array<{ content?: string; status?: string }> | undefined,
        phases: phases as unknown as
          | Array<{ name?: string; todos?: Array<{ content?: string; status?: string }> }>
          | undefined,
      })

    return finalizeExitPlanMode({
      planMarkdownInput: effectivePlanMarkdown,
      approvalNote: decision.detail
        ? ` (user note: ${decision.detail})`
        : '',
      skipModeMutation: false,
    })
  },
})

/**
 * Common post-approval path. Shared between the local-`requestPermission`
 * branch and the teammate `awaitTeamLeaderPlanApproval` branch so plan
 * persistence + prePlanMode restore logic stays in exactly one place.
 *
 * `skipModeMutation` is set by the teammate-bridge branch — see the call
 * site for rationale. When skipped, the parent chat's mode is left
 * untouched and the worker's own override (captured on its agentContext
 * at spawn time) governs the rest of its tool gating.
 */
function finalizeExitPlanMode(params: {
  planMarkdownInput: string
  /** Optional suffix appended to the success message (e.g. lead note). */
  approvalNote: string
  /** P0-2: when true, skip stored-mode mutation (teammate bridge path). */
  skipModeMutation: boolean
}): ToolResult {
  let modeNote = ''
  if (!params.skipModeMutation) {
    // P0-1 (upstream §3.4 ExitPlanMode): restore the pre-plan permission
    // mode instead of hard-resetting to `default`. Without this, a user
    // who was in `acceptEdits` / `bypassPermissions` and entered plan
    // would silently lose their elevated mode after exiting — a real
    // privilege regression that surfaced as "why am I being asked again
    // for the same edit I auto-approved earlier?".
    //
    // Safety carve-out: never auto-restore `bypassPermissions` from the
    // exit path. The user explicitly approved the *plan*, not "skip every
    // permission prompt for the implementation that follows". Coming from
    // bypass, downgrade to `acceptEdits` (still trusted, but each
    // mutation surfaces) — they can re-enable bypass via the input bar
    // toggle if they really want it back.
    const restored = consumePrePlanMode()
    const safeRestoreMode: PermissionMode =
      restored && restored !== 'plan' && restored !== 'bypassPermissions'
        ? restored
        : restored === 'bypassPermissions'
          ? 'acceptEdits'
          : 'default'
    setPermissionMode(safeRestoreMode)
    modeNote =
      safeRestoreMode === 'default'
        ? ''
        : safeRestoreMode === 'acceptEdits' && restored === 'bypassPermissions'
          ? ' Permission mode downgraded from `bypassPermissions` to `acceptEdits` for the implementation phase — re-enable via the input bar toggle if intended.'
          : ` Restored prior permission mode \`${safeRestoreMode}\`.`
  }

  // If the caller provided a plan markdown/JSON block, persist it to
  // `<workspace>/.cursor/plans/*.plan.md` and seed the TaskList. This
  // used to be declared in the schema but never executed; the plan was
  // effectively discarded. We now honor it — failures are non-fatal and
  // only annotate the tool output so the model still sees that it left
  // plan mode successfully.
  let persistNote = ''
  if (params.planMarkdownInput) {
    const workspacePath = getPrimaryWorkspaceRoot()
    if (workspacePath) {
      try {
        initPlanRuntime()
        const res = persistPlanFromOutput({
          workspacePath,
          rawOutput: params.planMarkdownInput,
          fallbackName: 'Plan',
        })
        if (res) {
          persistNote = ` Plan recorded at ${res.planFilePath}; seeded ${res.seededTaskIds.length} task(s).`
        } else {
          persistNote = ' Plan markdown did not contain actionable todos; skipped persistence.'
        }
      } catch (err) {
        persistNote = ` (plan persist failed: ${err instanceof Error ? err.message : String(err)})`
      }
    } else {
      persistNote = ' (plan persist skipped: no workspace root)'
    }
  }

  // Phase D-3 (verify_plan_reminder host attachment): mark this
  // conversation as "pending verification" so the reminder collector
  // can nudge the model to call `VerifyPlanExecution` after some
  // iterations of implementation work. Best-effort — no conversation
  // id → no pending entry → no reminder (acceptable for direct API /
  // scripted callers).
  const conversationId = getAgentContext()?.streamConversationId?.trim()
  if (conversationId) {
    const planText = params.planMarkdownInput?.trim() ?? ''
    const planId =
      planText.slice(0, 64).split('\n')[0]?.trim().replace(/^#\s*/, '') ||
      `plan-${Date.now()}`
    // The reminder collector tracks its own per-conversation
    // `firstObservedAtIteration` so the tool doesn't need to know
    // the current iteration number.
    markPendingPlanVerification(conversationId, {
      planId,
      planText: planText.slice(0, 8_000),
      exitedAt: Date.now(),
    })
  }

  return {
    success: true,
    output: `Exited plan mode. You can now implement changes.${persistNote}${modeNote}${params.approvalNote}`,
  }
}
