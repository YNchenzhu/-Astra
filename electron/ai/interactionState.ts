import { getAgentContext } from '../agents/agentContext'
import { bindAgentContext } from '../agents/agentContextBind'
import {
  applyChatPermissionKillswitches,
  applyDiffPermissionKillswitch,
} from './permissionRuntimeKillswitch'
import { getAskUserQuestionPreviewFormat } from '../tools/askUserQuestionPrompt'
import { attachPermissionRelay } from './permissionRelayBridge'

// Audit P3: the dynamic-import `.then` handler runs after the caller's
// agentic loop scope may have unwound. Hook bridges sometimes read
// `getAgentContext()` (for routing the elicitation to the right agent's
// IPC channel), so bind the handler to the current AsyncResource so the
// ALS scope is restored before the bridge fires.
function fireElicitationHooksDeferred(payload: Record<string, unknown>): void {
  void import('../tools/hooks/runtimeHookBridges')
    .then(bindAgentContext((m) => {
      m.fireElicitationHooks(payload)
    }))
    .catch(() => {})
}

function fireElicitationResultHooksDeferred(payload: Record<string, unknown>): void {
  void import('../tools/hooks/runtimeHookBridges')
    .then(bindAgentContext((m) => {
      m.fireElicitationResultHooks(payload)
    }))
    .catch(() => {})
}

/**
 * Chat-level permission behavior (upstream-style subset).
 * - `acceptEdits`: auto-approve workspace file write/edit tool UI; also skips permission UI for a
 *   narrow set of filesystem shell commands (mkdir/touch/rm/sed/…) when policy would otherwise ask
 *   (see `acceptEditsShellAllowlist` + `runAgenticToolUse`).
 * - `dontAsk`: never show permission prompts; operations that would ask are denied.
 * Report §5.10: `permissionRuntimeKillswitch` may downgrade stored modes via env at read time.
 */
/**
 * External: default | plan | bypassPermissions | acceptEdits | dontAsk.
 * Internal (report §5.1): `auto` — Stage 1/2 bash classifier in `runAgenticToolUse`; `bubble` — maps to `default` for tool policy.
 */
export type PermissionMode =
  | 'default'
  | 'plan'
  | 'bypassPermissions'
  | 'acceptEdits'
  | 'dontAsk'
  | 'auto'
  | 'bubble'
  | 'allow'
  | 'ask'
  | 'deny'

export type PermissionDecision = {
  behavior: 'allow' | 'deny'
  /** `cancelled` = abort / conversation cleared; `denied` = user chose deny in UI */
  reason?: 'cancelled' | 'denied'
  updatedInput?: Record<string, unknown>
}

export type DiffPreview = {
  filePath: string
  originalContent: string
  modifiedContent: string
  /** Shown in inline diff UI for destructive patterns (e.g. full-file delete). */
  riskWarnings?: string[]
}

export type AskQuestionOption = {
  label: string
  description: string
  preview?: string
}

export type AskQuestionItem = {
  question: string
  header: string
  options: AskQuestionOption[]
  multiSelect?: boolean
}

export type AskQuestionAnnotations = Record<
  string,
  {
    preview?: string
    notes?: string
  }
>

type StreamEventSender = (event: Record<string, unknown>) => void

// P1-30: permission mode is now per-conversation, with the legacy module-
// level singleton retained as the *fallback default* for newly-opened
// conversations and renderer IPC writes that don't carry a conversationId.
// Previously every parallel chat shared the same singleton, so toggling
// "auto-write" in one conversation silently flipped the permission state
// of every other in-flight conversation — including any agentic loop
// already past its permission gate.
let storedPermissionMode: PermissionMode = 'default'
let storedDiffPermissionMode: 'default' | 'bypassPermissions' = 'default'
const permissionModeByConversation = new Map<string, PermissionMode>()
const diffPermissionModeByConversation = new Map<
  string,
  'default' | 'bypassPermissions'
>()

// P0-1 (upstream §3.3 prePlanMode): when transitioning *into* plan mode we
// remember the prior mode so `ExitPlanMode` can restore it instead of
// hard-resetting to `default`. Without this, a user (or agent) that was in
// `acceptEdits` / `bypassPermissions` and entered plan would be silently
// downgraded to `default` after exiting — a real, unannounced privilege
// drop. The prePlan slot is per-conversation (mirroring the per-conv
// permission map) plus a global fallback for callers without a stream
// context.
let storedPrePlanMode: PermissionMode | undefined
const prePlanModeByConversation = new Map<string, PermissionMode>()

function activeConversationIdFromContext(): string | undefined {
  const cid = getAgentContext()?.streamConversationId
  if (typeof cid !== 'string') return undefined
  const trimmed = cid.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
let streamEventSender: StreamEventSender | null = null
let requestCounter = 0

function nextRequestId(prefix: string): string {
  requestCounter += 1
  return `${prefix}-${Date.now()}-${requestCounter}`
}

export function emit(event: Record<string, unknown>): void {
  if (!streamEventSender) return
  const conv = getAgentContext()?.streamConversationId
  streamEventSender(
    conv !== undefined && conv !== '' ? { ...event, conversationId: conv } : event,
  )
}

/**
 * Emit to a specific chat session (upstream report §7.9 — leader UI for teammate permission).
 * When `conversationId` is empty, sends without tagging (broadcast-style; prefer a real id).
 */
export function emitStreamEventForConversation(
  conversationId: string | undefined | null,
  event: Record<string, unknown>,
): void {
  if (!streamEventSender) return
  const cid =
    typeof conversationId === 'string' && conversationId.trim()
      ? conversationId.trim()
      : undefined
  streamEventSender(cid ? { ...event, conversationId: cid } : event)
}

export function setStreamEventSender(sender: StreamEventSender | null): void {
  streamEventSender = sender
}

function mapStoredPermissionMode(stored: PermissionMode): PermissionMode {
  if (stored === 'bubble') return 'default'
  return stored
}

export function getPermissionMode(): PermissionMode {
  const ctxOverride = getAgentContext()?.permissionModeOverride
  if (ctxOverride !== undefined) {
    return applyChatPermissionKillswitches(mapStoredPermissionMode(ctxOverride))
  }
  // P1-30: prefer the per-conversation override; fall back to global default.
  const cid = activeConversationIdFromContext()
  const perConv = cid ? permissionModeByConversation.get(cid) : undefined
  const stored: PermissionMode = perConv ?? storedPermissionMode
  return applyChatPermissionKillswitches(mapStoredPermissionMode(stored))
}

/**
 * Read the effective permission mode for an EXPLICIT conversation id,
 * independent of the current ALS context. Applies the same killswitch /
 * `bubble` mapping as {@link getPermissionMode} but resolves the
 * conversation directly instead of via `getAgentContext()`.
 *
 * Used by the orchestration kernel's live chat-mode resolver: a turn that
 * started in `plan` must stop gating mutating tools once `ExitPlanMode`
 * restores a non-plan mode mid-run. Reading by id (not ALS) keeps that
 * correct even when the policy preflight runs outside the loop's async
 * scope.
 */
export function getPermissionModeForConversation(
  conversationId: string | undefined,
): PermissionMode {
  const cid =
    typeof conversationId === 'string' && conversationId.trim()
      ? conversationId.trim()
      : undefined
  const stored: PermissionMode =
    (cid ? permissionModeByConversation.get(cid) : undefined) ?? storedPermissionMode
  return applyChatPermissionKillswitches(mapStoredPermissionMode(stored))
}

/**
 * Read the **raw stored** permission mode for a conversation (or the global
 * fallback). Unlike {@link getPermissionMode}, this skips the ALS override
 * and the killswitch translation — it reflects exactly what
 * {@link setPermissionMode} last wrote. Used by the prePlanMode bookkeeping
 * inside {@link setPermissionMode} so transition detection is not skewed by
 * env-driven downgrades or sub-agent ALS overrides.
 */
function getStoredPermissionMode(cid: string | undefined): PermissionMode {
  if (cid) {
    const perConv = permissionModeByConversation.get(cid)
    if (perConv !== undefined) return perConv
  }
  return storedPermissionMode
}

/**
 * Set the chat-permission mode for a conversation (or globally if no
 * `conversationId` is supplied — used by the renderer "Plan / Default" toggle
 * which targets the active chat tab and by tools running outside a stream
 * context). Tools dispatched inside an agentic loop pick up the conversation
 * from ALS automatically.
 *
 * P0-1: transparently records the prior mode into the prePlanMode slot when
 * transitioning into `plan`, and clears it when transitioning out. All entry
 * paths (UI toggle, EnterPlanMode tool, IPC, SDK) get correct restore
 * semantics for free — `ExitPlanMode` reads the prior via
 * {@link consumePrePlanMode} and returns the user to where they were.
 */
export function setPermissionMode(
  mode: PermissionMode,
  conversationId?: string,
): void {
  const cid =
    typeof conversationId === 'string' && conversationId.trim()
      ? conversationId.trim()
      : activeConversationIdFromContext()

  // Snapshot the prior mode before we mutate, so the prePlan transition
  // logic below sees the actual previous state (not the value we are
  // about to write).
  const previous = getStoredPermissionMode(cid)
  if (previous !== 'plan' && mode === 'plan') {
    // Entering plan: remember where we came from so ExitPlanMode can
    // restore it. Idempotent overwrites are fine — re-entering plan from
    // an unchanged base mode just rewrites the same value.
    if (cid) {
      prePlanModeByConversation.set(cid, previous)
    } else {
      storedPrePlanMode = previous
    }
  } else if (previous === 'plan' && mode !== 'plan') {
    // Leaving plan via any path other than `consumePrePlanMode` (e.g. UI
    // toggle, kill-switch downgrade, sub-agent override) — drop the saved
    // pre-plan slot to avoid restoring a stale value on the next exit.
    if (cid) {
      prePlanModeByConversation.delete(cid)
    } else {
      storedPrePlanMode = undefined
    }
  }

  if (cid) {
    permissionModeByConversation.set(cid, mode)
  } else {
    storedPermissionMode = mode
  }
  emit({
    type: 'mode_changed',
    mode: applyChatPermissionKillswitches(mode),
  })
}

/**
 * P0-1: read the saved pre-plan mode without clearing it. Used by tests /
 * diagnostics. {@link consumePrePlanMode} is the production read path used
 * by `ExitPlanMode` so the slot is freed atomically with the read.
 */
export function getPrePlanMode(conversationId?: string): PermissionMode | undefined {
  const cid =
    typeof conversationId === 'string' && conversationId.trim()
      ? conversationId.trim()
      : activeConversationIdFromContext()
  if (cid) {
    const v = prePlanModeByConversation.get(cid)
    if (v !== undefined) return v
  }
  return storedPrePlanMode
}

/**
 * P0-1: read-and-clear the saved pre-plan mode. Returns `undefined` when no
 * prior mode was saved (e.g. plan was entered before the bookkeeping
 * existed, or the conversation is fresh). Callers should fall back to
 * `'default'` in that case.
 *
 * NOTE: this only consumes the slot — it does **not** call
 * {@link setPermissionMode}. Callers are responsible for the actual
 * permission switch so they can apply additional policy (e.g. Exit may
 * downgrade `bypassPermissions` to `default` for safety).
 */
export function consumePrePlanMode(conversationId?: string): PermissionMode | undefined {
  const cid =
    typeof conversationId === 'string' && conversationId.trim()
      ? conversationId.trim()
      : activeConversationIdFromContext()
  if (cid) {
    const v = prePlanModeByConversation.get(cid)
    prePlanModeByConversation.delete(cid)
    if (v !== undefined) return v
    // Per-conversation map miss can happen when EnterPlanMode used a
    // different cid path (rare); fall through to global slot.
  }
  const g = storedPrePlanMode
  storedPrePlanMode = undefined
  return g
}

/**
 * 读最新的 diff 权限模式。`runAgenticToolUse` 在每个工具开始前调一次,
 * 所以用户在对话进行中切换"变更审核 ↔ 自动写入"不用等任务结束。
 *
 * killswitch 在读取时(而不是写入时)应用,保证环境变量变化能即时生效。
 * `permissionRuntimeKillswitch` 对 interactionState 只有 `type` 依赖,不会
 * 造成运行时循环。
 */
export function getDiffPermissionMode(): 'default' | 'bypassPermissions' {
  // P1-30: per-conversation override, fall back to global default.
  const cid = activeConversationIdFromContext()
  const perConv = cid ? diffPermissionModeByConversation.get(cid) : undefined
  const stored: 'default' | 'bypassPermissions' = perConv ?? storedDiffPermissionMode
  return applyDiffPermissionKillswitch(stored)
}

/**
 * 写入 diff 权限模式。两条路径调用:
 *   1. `handleSendMessage` 每个 turn 开始时,用 params.diffPermissionMode 同步(保留老行为)
 *   2. 渲染端 IPC `ai:set-diff-permission-mode` —— 聊天输入框用户点"自动写入/变更审核"
 *      时立即发过来,**不等任务结束**也能让下一个工具调用看到新值。
 *
 * P1-30: when called with a `conversationId` (or inside an ALS context with a
 * `streamConversationId`), the change is scoped to that conversation only —
 * other parallel chats keep their previous mode. Without any conversation
 * context, the global default is updated as before.
 */
export function setDiffPermissionMode(
  mode: 'default' | 'bypassPermissions',
  conversationId?: string,
): void {
  const cid =
    typeof conversationId === 'string' && conversationId.trim()
      ? conversationId.trim()
      : activeConversationIdFromContext()
  if (cid) {
    if (diffPermissionModeByConversation.get(cid) === mode) return
    diffPermissionModeByConversation.set(cid, mode)
  } else {
    if (storedDiffPermissionMode === mode) return
    storedDiffPermissionMode = mode
  }
  emit({
    type: 'diff_permission_mode_changed',
    mode,
  })
}

/**
 * P1-30: free per-conversation permission overrides when a conversation is
 * fully torn down. Callers without a clear teardown moment may simply leave
 * the entries in place — they're tiny (one enum value per conv) and the
 * fallback to the global default keeps semantics correct after eviction.
 */
export function clearPermissionModesForConversation(conversationId: string): void {
  const cid = conversationId.trim()
  if (!cid) return
  permissionModeByConversation.delete(cid)
  diffPermissionModeByConversation.delete(cid)
  prePlanModeByConversation.delete(cid)
}

const PENDING_REQUEST_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

const pendingPermissionRequests = new Map<
  string,
  {
    resolve: (decision: PermissionDecision) => void
    conversationId: string
    timer: ReturnType<typeof setTimeout>
  }
>()

const pendingAskRequests = new Map<
  string,
  {
    conversationId: string
    resolve: (payload: {
      answers: Record<string, string>
      annotations?: AskQuestionAnnotations
      outcome: 'answered' | 'timeout' | 'aborted' | 'cancelled_external'
    }) => void
    timer: ReturnType<typeof setTimeout>
  }
>()

export async function requestPermission(params: {
  toolName: string
  description: string
  input: Record<string, unknown>
  isDestructive?: boolean
  signal?: AbortSignal
  diffPreview?: DiffPreview
}): Promise<PermissionDecision> {
  const { toolName, description, input, isDestructive = false, signal, diffPreview } = params

  if (signal?.aborted) {
    return { behavior: 'deny', reason: 'cancelled' }
  }

  return new Promise(resolve => {
    const requestId = nextRequestId('perm')

    const onAbort = () => {
      pendingPermissionRequests.delete(requestId)
      resolve({ behavior: 'deny', reason: 'cancelled' })
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    const conversationId = getAgentContext()?.streamConversationId ?? 'default'
    const timeoutTimer = setTimeout(() => {
      pendingPermissionRequests.delete(requestId)
      resolve({ behavior: 'deny', reason: 'cancelled' })
    }, PENDING_REQUEST_TIMEOUT_MS)

    pendingPermissionRequests.set(requestId, {
      conversationId,
      resolve: decision => {
        clearTimeout(timeoutTimer)
        if (signal) {
          signal.removeEventListener('abort', onAbort)
        }
        resolve(decision)
      },
      timer: timeoutTimer,
    })

    const shortPermissionId = attachPermissionRelay({
      requestId,
      toolName,
      description,
      input,
    })

    emit({
      type: 'permission_request',
      requestId,
      toolName,
      description,
      input,
      isDestructive,
      mode: getPermissionMode(),
      diffPreview,
      shortPermissionId,
      permissionRelayReplyHint: `(y|yes|n|no) ${shortPermissionId}`,
    })
  })
}

export function respondPermissionRequest(params: {
  requestId: string
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  /** Default `denied` when behavior is deny */
  reason?: 'cancelled' | 'denied'
}): boolean {
  const entry = pendingPermissionRequests.get(params.requestId)
  if (!entry) return false

  clearTimeout(entry.timer)
  pendingPermissionRequests.delete(params.requestId)
  entry.resolve({
    behavior: params.behavior,
    ...(params.behavior === 'deny' && {
      reason: params.reason ?? 'denied',
    }),
    ...(params.updatedInput && { updatedInput: params.updatedInput }),
  })
  return true
}

/**
 * P1-34: outcome marker so the tool layer can distinguish a real user reply
 * from a timeout / abort / cross-conversation cancel. Previously every
 * non-success path resolved as `{ answers: {} }`, which the tool then
 * formatted as `success: true` with empty answers — the model believed the
 * user had answered "nothing" and would happily proceed.
 */
export type AskUserQuestionOutcome =
  | 'answered'
  | 'timeout'
  | 'aborted'
  | 'cancelled_external'

export async function requestAskUserQuestion(params: {
  questions: AskQuestionItem[]
  metadata?: { source?: string }
  signal?: AbortSignal
}): Promise<{
  answers: Record<string, string>
  annotations?: AskQuestionAnnotations
  outcome: AskUserQuestionOutcome
}> {
  const { questions, metadata, signal } = params

  if (signal?.aborted) {
    return { answers: {}, outcome: 'aborted' }
  }

  return new Promise(resolve => {
    const requestId = nextRequestId('ask')

    const onAbort = () => {
      pendingAskRequests.delete(requestId)
      resolve({ answers: {}, outcome: 'aborted' })
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    const conversationIdAsk = getAgentContext()?.streamConversationId ?? 'default'
    const timeoutTimer = setTimeout(() => {
      pendingAskRequests.delete(requestId)
      resolve({ answers: {}, outcome: 'timeout' })
    }, PENDING_REQUEST_TIMEOUT_MS)

    pendingAskRequests.set(requestId, {
      conversationId: conversationIdAsk,
      resolve: payload => {
        clearTimeout(timeoutTimer)
        if (signal) {
          signal.removeEventListener('abort', onAbort)
        }
        resolve(payload)
      },
      timer: timeoutTimer,
    })

    const previewFormat = getAskUserQuestionPreviewFormat()
    emit({
      type: 'ask_user_question',
      requestId,
      questions,
      ...(metadata && { metadata }),
      ...(previewFormat && { previewFormat }),
    })

    fireElicitationHooksDeferred({
      request_id: requestId,
      conversation_id: conversationIdAsk,
      question_count: questions.length,
      ...(metadata && { metadata }),
    })
  })
}

export async function respondAskUserQuestion(params: {
  requestId: string
  answers: Record<string, string>
  annotations?: AskQuestionAnnotations
  /** Renderer-supplied: required for durable HITL when IPC has no ALS context. */
  conversationId?: string
}): Promise<boolean> {
  const entry = pendingAskRequests.get(params.requestId)
  if (entry) {
    clearTimeout(entry.timer)
    pendingAskRequests.delete(params.requestId)
    entry.resolve({
      answers: params.answers,
      ...(params.annotations && { annotations: params.annotations }),
      outcome: 'answered',
    })
    fireElicitationResultHooksDeferred({
      request_id: params.requestId,
      answer_keys: Object.keys(params.answers),
      has_annotations: Boolean(params.annotations && Object.keys(params.annotations).length > 0),
    })
    return true
  }

  // P2.1 follow-up — Durable HITL fallback.
  //
  // No in-memory pending entry: the original `requestAskUserQuestion` promise was already
  // thrown away because the kernel was paused via `InterruptForHITL`. The renderer's
  // dialog used `toolUseId` as the requestId, so route the answer through
  // `enqueueHumanResume`. The next time the AskUserQuestion tool re-executes (kernel
  // resumed by enqueue), it consumes the queued resume value and returns it as the tool
  // result without going through this function at all.
  //
  // G8 — the function is `async` and `awaits` the dynamic import so the return value
  // truly reflects whether the resume was enqueued (or not). Renderer IPC handlers are
  // already async; this change does not break their await pattern.
  //
  // When the user clicks Submit, the IPC handler invokes us outside any
  // agentic-loop ALS scope, so `getAgentContext()` may be undefined. Accept a
  // renderer-supplied conversationId as the durable-HITL fallback route.
  //
  // ALS-derived value is still preferred when present so background/in-loop
  // callers behave identically.
  const conversationId =
    getAgentContext()?.streamConversationId ||
    (typeof params.conversationId === 'string' && params.conversationId.trim()
      ? params.conversationId.trim()
      : undefined)
  if (!conversationId) return false
  try {
    const { enqueueHumanResume } = await import('../orchestration/inbox')
    const result = enqueueHumanResume(conversationId, params.requestId, {
      answers: params.answers,
      ...(params.annotations && { annotations: params.annotations }),
      outcome: 'answered',
    })
    if (!result.ok) return false
    fireElicitationResultHooksDeferred({
      request_id: params.requestId,
      answer_keys: Object.keys(params.answers),
      has_annotations: Boolean(
        params.annotations && Object.keys(params.annotations).length > 0,
      ),
    })
    return true
  } catch (e) {
    console.warn('[interactionState] HITL resume enqueue failed:', e)
    return false
  }
}

/**
 * External "drain on cancel" hooks. Modules that own their own
 * pending-Promise maps (e.g. the main-chat plan-approval bridge) register a
 * callback here so a single `cancelStream` / app shutdown drains every
 * pending wait, not just the ones {@link cancelPendingInteractionsForConversation}
 * knows about natively. Each hook should resolve its parked Promises
 * synchronously and free its timers. Throwing is tolerated (logged).
 *
 * Designed as a registry rather than a single setter so multiple modules
 * can opt in independently. Registration is one-way (no unregister) — bridges
 * live for the app lifetime, so we don't carry the unregister overhead.
 */
type ConversationCancelHook = (conversationId: string) => void
const conversationCancelHooks: ConversationCancelHook[] = []
const allCancelHooks: Array<() => void> = []

export function registerConversationCancelHook(hook: ConversationCancelHook): void {
  conversationCancelHooks.push(hook)
}

export function registerAllCancelHook(hook: () => void): void {
  allCancelHooks.push(hook)
}

/** Deny/clear pending UI only for tools that belong to this chat session (parallel-safe). */
export function cancelPendingInteractionsForConversation(conversationId: string): void {
  for (const [requestId, entry] of pendingPermissionRequests) {
    if (entry.conversationId !== conversationId) continue
    clearTimeout(entry.timer)
    pendingPermissionRequests.delete(requestId)
    entry.resolve({ behavior: 'deny', reason: 'cancelled' })
  }
  for (const [requestId, entry] of pendingAskRequests) {
    if (entry.conversationId !== conversationId) continue
    clearTimeout(entry.timer)
    pendingAskRequests.delete(requestId)
    entry.resolve({ answers: {}, outcome: 'cancelled_external' })
  }
  for (const hook of conversationCancelHooks) {
    try {
      hook(conversationId)
    } catch (e) {
      console.warn('[interactionState] conversation cancel hook threw:', e)
    }
  }
}

export function cancelAllPendingInteractions(): void {
  for (const [requestId, entry] of pendingPermissionRequests) {
    clearTimeout(entry.timer)
    pendingPermissionRequests.delete(requestId)
    entry.resolve({ behavior: 'deny', reason: 'cancelled' })
  }

  for (const [requestId, entry] of pendingAskRequests) {
    clearTimeout(entry.timer)
    pendingAskRequests.delete(requestId)
    entry.resolve({ answers: {}, outcome: 'cancelled_external' })
  }

  for (const hook of allCancelHooks) {
    try {
      hook()
    } catch (e) {
      console.warn('[interactionState] all-cancel hook threw:', e)
    }
  }
}
