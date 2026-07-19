/**
 * Permission + ask-user-question stream-event handlers.
 *
 * Grouped into one module because all three events share:
 *   - desktop-notification on arrival
 *   - diff-preview side effects (register pending change + open/focus target
 *     file tab) when the tool is `write_file` / `edit_file`
 *   - target-state update: setting `pendingPermissionRequest` or
 *     `pendingAskUserQuestion` on the conversation slice so the renderer
 *     can surface the approval card
 *
 * Behavior is preserved byte-for-byte from the pre-split `handleMainStreamEvent`
 * switch — including the always-focus-on-match tab policy that differs from
 * `../diffPreviewBridge.openOrFocusDiffTarget`. If you want to unify the two,
 * do it as an explicit follow-up; this split alone should not change UX.
 */
import type { DiffPreview, StreamEvent } from '../../../types'
import { useFileStore, findTabForWorkspacePath } from '../../useFileStore'
import { useWorkspaceStore } from '../../useWorkspaceStore'
import { toRelativePath } from '../../../services/pathUtils'
import { maybeDesktopNotify } from '../desktopNotify'
import { useSettingsStore } from '../../useSettingsStore'
import type { ChatSessionSlice, ChatState } from '../types'

type ApplyToSlice = (
  fn: (sl: ChatSessionSlice) => ChatSessionSlice,
  extra?: Partial<ChatState>,
) => void

const LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', json: 'json',
  css: 'css', html: 'html', md: 'markdown', yaml: 'yaml', yml: 'yaml',
  sh: 'shell', sql: 'sql', xml: 'xml',
}

function registerDiffPreviewPendingChange(params: {
  changeId: string
  requestId: string
  toolUseId: string
  toolName: string
  diffPreview: DiffPreview
}): void {
  const fileState = useFileStore.getState()
  const wsRoot = useWorkspaceStore.getState().rootPath
  fileState.addPendingChange({
    id: params.changeId,
    filePath: params.diffPreview.filePath,
    originalContent: params.diffPreview.originalContent,
    modifiedContent: params.diffPreview.modifiedContent,
    toolUseId: params.toolUseId,
    toolName: (params.toolName as 'write_file' | 'edit_file') || 'edit_file',
    timestamp: Date.now(),
    requestId: params.requestId,
    ...(params.diffPreview.riskWarnings?.length ? { riskWarnings: params.diffPreview.riskWarnings } : {}),
  })
  const filePath = params.diffPreview.filePath
  const relativePath = toRelativePath(filePath, wsRoot)
  const existingTab = findTabForWorkspacePath(fileState.tabs, filePath, wsRoot)
  if (existingTab) {
    fileState.setActiveTab(existingTab.id)
  } else {
    const ext = relativePath.split('.').pop() || ''
    fileState.openFile({
      id: `ai-diff-${Date.now()}`,
      name: relativePath.split('/').pop() || relativePath,
      path: relativePath,
      language: LANG_MAP[ext] || 'plaintext',
      content: params.diffPreview.originalContent,
      isModified: false,
    })
  }
}

/**
 * P1-33: when a new permission request would replace one already shown in the
 * UI (same session, different requestId), auto-deny the predecessor so the
 * agent waiting on it isn't stuck for the full 5-minute backend timeout.
 * The renderer is still single-slot — converting it to a queue would touch
 * a dozen state-init sites — but this guarantees no silently-orphaned ask.
 */
function autoDenyStalePermission(prev: { requestId: string } | null, nextRequestId: string): void {
  if (!prev || prev.requestId === nextRequestId) return
  const api = (
    globalThis as {
      window?: {
        electronAPI?: {
          ai?: {
            respondPermissionRequest?: (p: {
              requestId: string
              behavior: 'allow' | 'deny'
            }) => Promise<unknown>
          }
        }
      }
    }
  ).window?.electronAPI?.ai
  if (!api?.respondPermissionRequest) return
  console.warn(
    `[permission] auto-denying stale request ${prev.requestId} ` +
      `because a new one (${nextRequestId}) arrived; the renderer is single-slot.`,
  )
  void api.respondPermissionRequest({ requestId: prev.requestId, behavior: 'deny' }).catch(() => {
    /* fire-and-forget */
  })
}

export function handlePermissionRequestEvent(
  event: StreamEvent,
  apply: ApplyToSlice,
  otherSession: boolean,
): void {
  if (!event.requestId || !event.toolName || !event.description || !event.input) return
  const diffPreview: DiffPreview | undefined = event.diffPreview
  if (diffPreview) {
    registerDiffPreviewPendingChange({
      changeId: `change-${event.requestId}`,
      requestId: event.requestId,
      toolUseId: event.requestId,
      toolName: event.toolName,
      diffPreview,
    })
  }
  apply((sl) => {
    autoDenyStalePermission(sl.pendingPermissionRequest, event.requestId!)
    return {
      ...sl,
      pendingPermissionRequest: {
        requestId: event.requestId!,
        toolName: event.toolName!,
        description: event.description!,
        input: event.input!,
        isDestructive: event.isDestructive,
        mode: event.mode,
        diffPreview,
      },
    }
  })
  const raw = (event.description || '需要确认工具调用').trim()
  const preview = raw.length > 120 ? `${raw.slice(0, 117)}…` : raw
  maybeDesktopNotify({
    enabled: useSettingsStore.getState().notifyOnAskUserQuestion,
    title: '需要你的确认',
    body: `${event.toolName}: ${preview}`,
    otherSession,
  })
}

export function handleTeamPermissionRequestEvent(
  event: StreamEvent,
  apply: ApplyToSlice,
  otherSession: boolean,
): void {
  const tid =
    typeof event.teamRequestId === 'string' && event.teamRequestId.trim()
      ? event.teamRequestId.trim()
      : ''
  if (!tid || !event.toolName || !event.description || !event.input) return
  const teamDelegated = {
    teamRequestId: tid,
    workerAgentId: String(event.workerAgentId || '').trim(),
    ...(typeof event.teamName === 'string' && event.teamName.trim()
      ? { teamName: event.teamName.trim() }
      : {}),
  }
  const diffPreview: DiffPreview | undefined = event.diffPreview
  if (diffPreview) {
    registerDiffPreviewPendingChange({
      changeId: `change-${tid}`,
      requestId: tid,
      toolUseId: tid,
      toolName: event.toolName,
      diffPreview,
    })
    apply((sl) => {
      autoDenyStalePermission(sl.pendingPermissionRequest, tid)
      return {
        ...sl,
        pendingPermissionRequest: {
          requestId: tid,
          toolName: event.toolName!,
          description: event.description!,
          input: event.input!,
          isDestructive: event.isDestructive,
          mode: event.mode,
          diffPreview,
          teamDelegated,
        },
      }
    })
  } else {
    apply((sl) => {
      autoDenyStalePermission(sl.pendingPermissionRequest, tid)
      return {
        ...sl,
        pendingPermissionRequest: {
          requestId: tid,
          toolName: event.toolName!,
          description: event.description!,
          input: event.input!,
          isDestructive: event.isDestructive,
          mode: event.mode,
          diffPreview,
          teamDelegated,
        },
      }
    })
    const raw = (event.description || 'Teammate requests tool approval').trim()
    const preview = raw.length > 120 ? `${raw.slice(0, 117)}…` : raw
    maybeDesktopNotify({
      enabled: useSettingsStore.getState().notifyOnAskUserQuestion,
      title: '队友权限待审批',
      body: `${event.toolName}: ${preview}`,
      otherSession,
    })
  }
}

/**
 * P0-2 (upstream §6.2 leader-side notification of `plan_approval_request`):
 * a teammate worker has called ExitPlanMode and is blocked awaiting our
 * approval.
 *
 * Two delivery paths converge here:
 *   1. **Team mailbox path** — the leader's main agent sees the request
 *      injected as a `<system-reminder>` (via `injectPendingInterAgentQueue`)
 *      and can self-respond with `SendMessage(schema:plan_approval_response)`.
 *   2. **Renderer-teammate path** — the user spawned the teammate from the
 *      panel with `planModeRequired:true`; the worker has no team. The
 *      slot is filled here and the inline `TeamPlanApprovalCard` shows
 *      Approve/Deny buttons.
 *
 * Both paths use the same pending-Promise map in
 * `teamPlanApprovalLeaderBridge`, so a single resolve from either delivery
 * mechanism unblocks the worker.
 *
 * Single-slot semantics: if a second teammate raises a request while the
 * first is pending, we keep the older one (its Promise is still in flight
 * in the main process) and emit a console warning. This matches the
 * single-slot policy used for `pendingPermissionRequest` /
 * `pendingAskUserQuestion`, but without the auto-deny carve-out — silently
 * denying a teammate's plan approval because a second teammate raised one
 * would be surprising. The user just has to resolve the first card; the
 * second arrival is queued by the worker's own 10-minute wait.
 */
export function handleTeamPlanApprovalRequestEvent(
  event: StreamEvent,
  apply: ApplyToSlice,
  otherSession: boolean,
): void {
  const tid =
    typeof event.teamRequestId === 'string' && event.teamRequestId.trim()
      ? event.teamRequestId.trim()
      : ''
  if (!tid) return
  const worker =
    typeof event.workerAgentId === 'string' && event.workerAgentId.trim()
      ? event.workerAgentId.trim()
      : 'teammate'
  const planRaw =
    typeof event.planMarkdown === 'string' && event.planMarkdown.trim()
      ? event.planMarkdown.trim()
      : '(no plan body provided)'

  apply((sl) => {
    if (sl.pendingTeamPlanApproval && sl.pendingTeamPlanApproval.requestId !== tid) {
      console.warn(
        `[team-plan-approval] new request ${tid} arrived while ${sl.pendingTeamPlanApproval.requestId} ` +
          `is still pending; keeping the existing card. The second worker will see its own ` +
          `card after the first is resolved (its 10-minute timeout is unchanged).`,
      )
      return sl
    }
    return {
      ...sl,
      pendingTeamPlanApproval: {
        requestId: tid,
        workerAgentId: worker,
        ...(typeof event.teamName === 'string' && event.teamName.trim()
          ? { teamName: event.teamName.trim() }
          : {}),
        planMarkdown: planRaw,
        ...(Array.isArray(event.allowedPrompts) && event.allowedPrompts.length > 0
          ? { allowedPrompts: event.allowedPrompts as Array<Record<string, unknown>> }
          : {}),
        receivedAt: Date.now(),
      },
    }
  })

  const preview = planRaw.length > 140 ? `${planRaw.slice(0, 137)}…` : planRaw
  maybeDesktopNotify({
    enabled: useSettingsStore.getState().notifyOnAskUserQuestion,
    title: `队友计划待审批 — ${worker}`,
    body: preview,
    otherSession,
  })
}

/**
 * the IDE `create_plan`-style main-chat plan-approval gate. Parks the
 * structured plan envelope into `pendingPlanApproval` so the
 * `PlanApprovalCard` renders inline beside the chat. Single-slot
 * semantics: if a second `plan_approval_request` arrives while one is
 * already pending, auto-cancel the predecessor — unlike the team
 * variant (which keeps the older request because the other teammate's
 * 10-minute timer is still ticking), the main-agent flow only has one
 * agent at a time, so a new request necessarily supersedes the old one.
 */
function autoCancelStalePlanApproval(
  prev: { requestId: string } | null,
  nextRequestId: string,
): void {
  if (!prev || prev.requestId === nextRequestId) return
  const api = (
    globalThis as {
      window?: {
        electronAPI?: {
          ai?: {
            respondPlanApproval?: (p: {
              requestId: string
              outcome: 'accepted' | 'rejected' | 'cancelled'
            }) => Promise<unknown>
          }
        }
      }
    }
  ).window?.electronAPI?.ai
  if (!api?.respondPlanApproval) return
  console.warn(
    `[plan-approval] auto-cancelling stale request ${prev.requestId} ` +
      `because a new one (${nextRequestId}) arrived; the renderer is single-slot.`,
  )
  void api
    .respondPlanApproval({ requestId: prev.requestId, outcome: 'cancelled' })
    .catch(() => {
      /* fire-and-forget */
    })
}

export function handlePlanApprovalRequestEvent(
  event: StreamEvent,
  apply: ApplyToSlice,
  otherSession: boolean,
): void {
  const rid =
    typeof event.requestId === 'string' && event.requestId.trim()
      ? event.requestId.trim()
      : ''
  if (!rid) return
  const planRaw =
    typeof event.planMarkdown === 'string' && event.planMarkdown.trim()
      ? event.planMarkdown.trim()
      : '(no plan body provided)'
  const env = event.planEnvelope ?? undefined

  apply((sl) => {
    autoCancelStalePlanApproval(sl.pendingPlanApproval, rid)
    return {
      ...sl,
      pendingPlanApproval: {
        requestId: rid,
        planMarkdown: planRaw,
        ...(env?.name ? { name: env.name } : {}),
        ...(env?.overview ? { overview: env.overview } : {}),
        ...(typeof env?.isProject === 'boolean' ? { isProject: env.isProject } : {}),
        ...(env?.todos && env.todos.length > 0 ? { todos: env.todos } : {}),
        ...(env?.phases && env.phases.length > 0 ? { phases: env.phases } : {}),
        ...(Array.isArray(event.allowedPrompts) && event.allowedPrompts.length > 0
          ? { allowedPrompts: event.allowedPrompts as Array<Record<string, unknown>> }
          : {}),
        receivedAt: Date.now(),
      },
    }
  })

  const titleSuffix = env?.name ? ` — ${env.name}` : ''
  const preview = planRaw.length > 140 ? `${planRaw.slice(0, 137)}…` : planRaw
  maybeDesktopNotify({
    enabled: useSettingsStore.getState().notifyOnAskUserQuestion,
    title: `计划待审批${titleSuffix}`,
    body: preview,
    otherSession,
  })
}

/**
 * P1-33: same approach as `autoDenyStalePermission` — when a new
 * AskUserQuestion arrives while the renderer slot is occupied by a
 * different request, auto-resolve the predecessor with empty answers so
 * the agent waiting on it isn't silently stuck.
 */
function autoCancelStaleAskQuestion(prev: { requestId: string } | null, nextRequestId: string): void {
  if (!prev || prev.requestId === nextRequestId) return
  const api = (
    globalThis as {
      window?: {
        electronAPI?: {
          ai?: {
            respondAskUserQuestion?: (p: {
              requestId: string
              answers: Record<string, string>
            }) => Promise<unknown>
          }
        }
      }
    }
  ).window?.electronAPI?.ai
  if (!api?.respondAskUserQuestion) return
  console.warn(
    `[ask-user] auto-resolving stale request ${prev.requestId} ` +
      `because a new one (${nextRequestId}) arrived; the renderer is single-slot.`,
  )
  void api.respondAskUserQuestion({ requestId: prev.requestId, answers: {} }).catch(() => {
    /* fire-and-forget */
  })
}

export function handleAskUserQuestionEvent(
  event: StreamEvent,
  apply: ApplyToSlice,
  otherSession: boolean,
): void {
  const rid = event.requestId
  const qs = event.questions
  if (!rid || !qs) return
  apply((sl) => {
    autoCancelStaleAskQuestion(sl.pendingAskUserQuestion, rid)
    return {
      ...sl,
      pendingAskUserQuestion: {
        requestId: rid,
        questions: qs,
        metadata: event.metadata,
        ...(event.previewFormat ? { previewFormat: event.previewFormat } : {}),
      },
    }
  })
  const raw = qs[0]?.question?.trim() || '助手需要你选择一项或多项'
  const preview = raw.length > 120 ? `${raw.slice(0, 117)}…` : raw
  maybeDesktopNotify({
    enabled: useSettingsStore.getState().notifyOnAskUserQuestion,
    title: '需要你的选择',
    body: preview,
    otherSession,
  })
}
