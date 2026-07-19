/**
 * Shared Zod schemas for IPC args tuples.
 *
 * These validate the *shape* of what the renderer sends — they do not replace
 * the domain-level checks (path sandboxing, workspace trust, permission rules)
 * that still live inside the handler bodies. Schemas here aim to be
 * conservative (reject unknown shapes, bound sizes) without over-specifying
 * optional/nested payloads that the renderer evolves frequently.
 */

import { z } from 'zod'

// --- Common building blocks ---------------------------------------------------

const MAX_PATH_LEN = 10_000
const MAX_FILE_CONTENT_LEN = 32 * 1024 * 1024 // 32 MB — matches editor hard cap
const MAX_SEARCH_QUERY_LEN = 2_000
const MAX_AGENT_PAYLOAD = 2_000

/**
 * Renderer-supplied path string. We only enforce size + absence of NUL here;
 * the real sandboxing (`sanitizeFilePath` → `resolvePathForWorkspaceAccess`)
 * runs inside the handler body unchanged.
 */
export const filePathSchema = z
  .string()
  .min(1, 'path must be non-empty')
  .max(MAX_PATH_LEN, 'path too long')
  .refine((s) => !s.includes('\0'), 'path contains NUL')

/**
 * Plain-object guard that also blocks prototype pollution keys at the root.
 *
 * IMPORTANT: use `Object.prototype.hasOwnProperty.call` rather than the `in`
 * operator — `'constructor' in {}` and `'__proto__' in {}` are both true on
 * any plain object via the prototype chain, so the naive check rejects every
 * legitimate payload.
 */
const POLLUTION_KEYS = ['__proto__', 'constructor', 'prototype'] as const
export const plainObjectSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (o) => !POLLUTION_KEYS.some((k) => Object.prototype.hasOwnProperty.call(o, k)),
    'prototype pollution keys are not allowed at the root',
  )

// --- fs:* ---------------------------------------------------------------------

export const fsReadFileArgs = z.tuple([filePathSchema])
export const fsWriteFileArgs = z.tuple([
  filePathSchema,
  z
    .string()
    .max(MAX_FILE_CONTENT_LEN, 'content too large'),
])
export const fsFileTreeArgs = z.tuple([
  filePathSchema,
  z.number().int().min(1).max(32).optional(),
])
export const fsSearchArgs = z.tuple([
  z.object({
    dirPath: filePathSchema,
    query: z.string().max(MAX_SEARCH_QUERY_LEN),
    maxResults: z.number().int().min(1).max(10_000).optional(),
    maxMatchesPerFile: z.number().int().min(1).max(1_000).optional(),
  }),
])
export const fsStatArgs = z.tuple([filePathSchema])
export const fsExistsArgs = z.tuple([filePathSchema])
export const fsDeleteArgs = z.tuple([filePathSchema])
export const fsCreateDirArgs = z.tuple([filePathSchema])
export const fsRenameArgs = z.tuple([filePathSchema, filePathSchema])
export const fsCopyFileArgs = z.tuple([filePathSchema, filePathSchema])

// --- attachment:* ---------------------------------------------------------------
//
// 2026-07 富文件审计修复:此前 attachment handler 是仓库中仅存的
// 手写 `params as Record<string, unknown>` 形状检查,与其他 IPC 的
// validatedHandle + Zod 风格不一致。注意 ingest 的 path 故意不做
// workspace 沙箱 —— 拖入工作区外的文件是合法用户场景;真正的读取
// 仍发生在主进程 ingest 管线内(带 50MB 上限与格式解析约束)。

/** base64 载荷上限:50MB 二进制 ≈ 66.7MB base64,留少量余量。 */
const MAX_ATTACHMENT_BASE64_LEN = 70 * 1024 * 1024

export const attachmentIngestArgs = z.tuple([
  z.object({
    path: filePathSchema.optional(),
    name: z.string().max(1_024).optional(),
  }),
])
export const attachmentIngestBufferArgs = z.tuple([
  z.object({
    name: z.string().min(1).max(1_024),
    base64: z.string().min(1).max(MAX_ATTACHMENT_BASE64_LEN, 'attachment too large'),
  }),
])
export const attachmentCacheGetArgs = z.tuple([
  z.object({
    sha256: z.string().max(128),
    kind: z.string().max(64).optional(),
  }),
])
export const attachmentCacheStageImageArgs = z.tuple([
  z.object({
    base64: z.string().min(1).max(MAX_ATTACHMENT_BASE64_LEN, 'image too large'),
    mediaType: z.string().max(128).optional(),
  }),
])
export const fsShowItemArgs = z.tuple([filePathSchema])
export const fsOpenPathArgs = z.tuple([filePathSchema])
export const fsStartWatcherArgs = z.tuple([filePathSchema])
export const fsOpenDialogArgs = z.tuple([
  z
    .object({
      title: z.string().max(500).optional(),
      defaultPath: filePathSchema.optional(),
      properties: z.array(z.string().max(64)).max(16).optional(),
      filters: z
        .array(
          z.object({
            name: z.string().max(128),
            extensions: z.array(z.string().max(32)).max(64),
          }),
        )
        .max(32)
        .optional(),
    })
    .optional(),
])

// --- settings / agents --------------------------------------------------------

/**
 * `settings:set` accepts a *partial* merge patch — the renderer persists large
 * structured settings trees, so we cannot enforce a closed shape here without
 * duplicating the entire Settings type. We validate it's a plain object and
 * let `sanitizeSettingsMergePatch` continue to do the deep cleanup.
 */
export const settingsSetArgs = z.tuple([plainObjectSchema])

// --- memory:* (F3 audit fix) --------------------------------------------------

/**
 * A logical memory filename as the renderer / API sees it. Two flavours:
 *   - workspace-scoped:  `my-note.md`           (relative to `<ws>/.claude/memory/`)
 *   - user-scoped:       `user:foo.md`          (renderer-prefixed; resolved to bundleRoot)
 *   - memdir entries:    `memdir:<path>`        (READ-ONLY; service rejects writes)
 *
 * Hard-bounded length and freed of path-separator / traversal payloads so the
 * receiving `resolveDiskLocation` cannot be coaxed into stepping outside its
 * intended root. The `memdir:` form may legitimately carry path segments in the
 * suffix because it IS a path under `<workspace>/.claude/memdir/`; we still
 * reject NUL bytes and absolute / parent-traversal prefixes on the suffix.
 *
 * NOTE: we intentionally do NOT call any filesystem APIs here. The Zod layer
 * is shape-only; `service.deleteMemory` / `updateMemory` / `getMemory` still
 * resolve under their own roots which is the real sandbox.
 */
const MEMORY_FILENAME_MAX = 512
const USER_MEMORY_PREFIX = 'user:'
const MEMDIR_PREFIX = 'memdir:'

function looksLikeMemoryFilename(s: string): { ok: true } | { ok: false; reason: string } {
  if (s.length === 0) return { ok: false, reason: 'empty filename' }
  if (s.length > MEMORY_FILENAME_MAX) return { ok: false, reason: 'filename too long' }
  if (s.includes('\0')) return { ok: false, reason: 'filename contains NUL' }
  if (/^[A-Za-z]:[\\/]/.test(s)) return { ok: false, reason: 'absolute Windows path not allowed' }
  if (s.startsWith('/') || s.startsWith('\\')) return { ok: false, reason: 'absolute path not allowed' }

  // Strip the optional prefix BEFORE the traversal regex so payloads like
  // `memdir:../escape.md` and `user:../../etc/passwd` are correctly rejected.
  // The naïve "test on the raw string first" version missed those because
  // `..` was preceded by `:`, not by `/` or start-of-string.
  let body: string
  let allowSlashes = false
  if (s.startsWith(MEMDIR_PREFIX)) {
    body = s.slice(MEMDIR_PREFIX.length)
    if (body.length === 0) return { ok: false, reason: 'memdir suffix empty' }
    allowSlashes = true
  } else if (s.startsWith(USER_MEMORY_PREFIX)) {
    body = s.slice(USER_MEMORY_PREFIX.length)
  } else {
    body = s
  }

  if (/(^|[\\/])\.\.([\\/]|$)/.test(body)) {
    return { ok: false, reason: 'parent traversal not allowed' }
  }
  if (!allowSlashes && /[\\/]/.test(body)) {
    return { ok: false, reason: 'filename must be a single segment' }
  }
  return { ok: true }
}

export const memoryFilenameSchema = z
  .string()
  .superRefine((s, ctx) => {
    const r = looksLikeMemoryFilename(s)
    if (!r.ok) {
      ctx.addIssue({
        code: 'custom',
        message: `memory filename rejected: ${r.reason}`,
      })
    }
  })

const MEMORY_TYPE_ENUM = z.enum(['user', 'feedback', 'project', 'reference'])
const MEMORY_SCOPE_ENUM = z.enum(['session', 'project', 'user'])

// Tag list size bounded so a malicious payload can't push the YAML serializer
// into rendering megabyte-scale frontmatter.
const memoryTagsSchema = z
  .array(z.string().min(1).max(64))
  .max(64)
  .optional()

// Description / name length budgets follow the existing UI cap (256 chars).
const MEMORY_NAME_MAX = 256
const MEMORY_DESC_MAX = 1024
// Per-entry content cap: the consolidation pass already compresses anything
// over 3000 chars (autoConsolidate.MAX_CONTENT_LENGTH), so 256KB here is a
// "no reasonable single memory exceeds this" guard against renderer
// misbehaviour, not a tight semantic bound.
const MEMORY_CONTENT_MAX = 256 * 1024

const memoryCreateParamsSchema = z
  .object({
    name: z.string().min(1).max(MEMORY_NAME_MAX),
    description: z.string().max(MEMORY_DESC_MAX),
    type: MEMORY_TYPE_ENUM,
    content: z.string().max(MEMORY_CONTENT_MAX),
    scope: MEMORY_SCOPE_ENUM.optional(),
    enabled: z.boolean().optional(),
    tags: memoryTagsSchema,
  })
  .strict()

// Update accepts the filename PLUS any subset of the create fields. `.strict()`
// rejects unknown keys so a typo doesn't silently no-op.
const memoryUpdateParamsSchema = z
  .object({
    filename: memoryFilenameSchema,
    name: z.string().min(1).max(MEMORY_NAME_MAX).optional(),
    description: z.string().max(MEMORY_DESC_MAX).optional(),
    type: MEMORY_TYPE_ENUM.optional(),
    content: z.string().max(MEMORY_CONTENT_MAX).optional(),
    scope: MEMORY_SCOPE_ENUM.optional(),
    enabled: z.boolean().optional(),
    tags: memoryTagsSchema,
  })
  .strict()

// User message for recall is multimodal (string OR Anthropic-style content
// blocks). We accept either shape and let `userMessageContentToPlainText`
// downstream handle the conversion. The unknown branch is bounded so a payload
// can't be megabytes of nested junk: it MUST be either a string ≤ 2MB or an
// array ≤ 256 blocks of plain objects.
const RECALL_TEXT_MAX = 2 * 1024 * 1024
const recallUserMessageSchema: z.ZodType<unknown> = z.union([
  z.string().max(RECALL_TEXT_MAX),
  z.array(z.unknown()).max(256),
  z.null(),
])

// memory:recall-for-prompt-ai accepts EITHER a bare userMessage OR an object
// `{ userMessage, alreadySurfaced?: string[] }`. The handler's back-compat
// branch handles both shapes — schema mirrors that.
//
// Audit fix A6: `alreadySurfaced[]` elements now flow through the full
// `memoryFilenameSchema` rather than just a length cap. The values are
// keys used for dedup only (string equality), so a malformed value
// couldn't escape the sandbox, but tightening this here means a callsite
// confusion (e.g. "I accidentally shipped a file PATH instead of a
// filename") fails loudly instead of producing a silent never-matches
// dedup set.
const recallForPromptAiPayloadSchema = z.union([
  recallUserMessageSchema,
  z
    .object({
      userMessage: recallUserMessageSchema.optional(),
      alreadySurfaced: z.array(memoryFilenameSchema).max(1024).optional(),
    })
    .strict(),
])

// `memory:set-workspace` — null means "no workspace", string means an
// absolute path. We deliberately do NOT enforce `path.isAbsolute` here
// because the service layer already calls `validateMemoryPath`; the schema
// only kills obvious nonsense (NUL bytes, > 10K length).
const workspacePathArgSchema = z.union([
  z.null(),
  z
    .string()
    .max(MAX_PATH_LEN)
    .refine((s) => !s.includes('\0'), 'workspace path contains NUL'),
])

export const memoryListArgs = z.tuple([])
export const memoryGetArgs = z.tuple([memoryFilenameSchema])
export const memoryCreateArgs = z.tuple([memoryCreateParamsSchema])
export const memoryUpdateArgs = z.tuple([memoryUpdateParamsSchema])
export const memoryDeleteArgs = z.tuple([memoryFilenameSchema])
export const memorySetWorkspaceArgs = z.tuple([workspacePathArgSchema])
export const memoryRecallArgs = z.tuple([recallUserMessageSchema])
export const memoryRecallAiArgs = z.tuple([recallForPromptAiPayloadSchema])
export const memoryScanMemdirArgs = z.tuple([])
export const memoryTeamSyncArgs = z.tuple([])
export const memoryLastRecalledArgs = z.tuple([])
export const memoryToggleEnabledArgs = z.tuple([
  z
    .object({
      filename: memoryFilenameSchema,
      enabled: z.boolean(),
    })
    .strict(),
])
export const memoryGetSystemPromptSectionArgs = z.tuple([z.boolean()])
export const memoryValidateDirectoryArgs = z.tuple([
  z.string().max(MAX_PATH_LEN).refine((s) => !s.includes('\0'), 'path contains NUL'),
])
export const memoryResetRecallStateArgs = z.tuple([])
export const memoryDrainExtractionsArgs = z.tuple([])

/**
 * `agents:sync-custom` receives a payload the renderer has already shaped via
 * `CustomAgent[]`. We enforce array-ness + an upper bound; the existing
 * `parseRendererCustomAgentsPayload` performs the per-agent validation.
 */
export const agentsSyncCustomArgs = z.tuple([
  z.array(z.unknown()).max(MAX_AGENT_PAYLOAD),
])

// --- agents panel disk management --------------------------------------------
//
// The Agents Settings panel drives these endpoints. Shape-only validation
// here; the handler body still asserts the path falls inside a known scope
// directory before touching disk.

export const agentsListAllArgs = z.tuple([])

/** Phase 3 Sprint 3.1a: query the runtime registry for all in-flight
 *  agents (main chat + sub-agents + async-agents). No args. */
export const agentsListActiveArgs = z.tuple([])

/** Phase 3 Sprint 3.1a: abort a running agent by its registry id. */
export const agentsAbortActiveArgs = z.tuple([
  z.object({
    agentId: z.string().min(1).max(512),
  }),
])

/**
 * Stage 2.1 — cooperatively pause an in-flight orchestration kernel. Keyed
 * on `conversationId` (mirroring `orchestration:*` channels) because the
 * kernel registry is keyed on it. Pause is observed at the next iteration
 * boundary; in-flight tool execution and streaming are NOT interrupted
 * (use abort-active for hard stop).
 */
export const agentsPauseActiveArgs = z.tuple([
  z.object({
    conversationId: z.string().min(1).max(512),
  }),
])

/** Stage 2.1 — resume a previously paused orchestration kernel by conversationId. */
export const agentsResumeActiveArgs = z.tuple([
  z.object({
    conversationId: z.string().min(1).max(512),
  }),
])

/**
 * Stage 2.2 — orchestration kernel checkpoint / persistence IPC. All keyed on
 * `conversationId` because the kernel registry is keyed on it (`activeKernelRegistry`).
 * Renderer resolves conversationId from the active chat session.
 */
export const orchestrationSnapshotArgs = z.tuple([
  z.object({
    conversationId: z.string().min(1).max(512),
    tag: z.string().min(1).max(200),
  }),
])

export const orchestrationRewindArgs = z.tuple([
  z.object({
    conversationId: z.string().min(1).max(512),
    checkpointId: z.string().min(1).max(200),
  }),
])

export const orchestrationListCheckpointsArgs = z.tuple([
  z.object({
    conversationId: z.string().min(1).max(512),
  }),
])

export const orchestrationPersistArgs = z.tuple([
  z.object({
    conversationId: z.string().min(1).max(512),
  }),
])

/**
 * Audit §3.2 wire-up — branch-tree variants of the checkpoint listing IPC.
 * `orchestration:list-checkpoint-tree` returns the topologically-ordered
 * tree walk (branch roots → descendants depth-first); the renderer's
 * branch picker UI consumes it.
 */
export const orchestrationListCheckpointTreeArgs = z.tuple([
  z.object({
    conversationId: z.string().min(1).max(512),
  }),
])

/**
 * Audit §3.2 wire-up — read a single checkpoint without mutating history.
 * Used by "fork from checkpoint" flows so the renderer can preview a
 * checkpoint's state before deciding to seed a sibling kernel.
 */
export const orchestrationPeekCheckpointArgs = z.tuple([
  z.object({
    conversationId: z.string().min(1).max(512),
    checkpointId: z.string().min(1).max(200),
  }),
])

/**
 * Audit §3.2 wire-up — return the current branch head id (the result of
 * the most recent `snapshot()` or `rewind()`). Lets the renderer
 * highlight "you are here" in the branch tree.
 */
export const orchestrationBranchHeadArgs = z.tuple([
  z.object({
    conversationId: z.string().min(1).max(512),
  }),
])

const agentScopeEnum = z.enum(['user-global', 'user-app', 'project', 'extra'])

/** `agents:save-to-disk` — nested shape matching AgentsPanel.handleSaveCustom. */
export const agentsSaveToDiskArgs = z.tuple([
  z.object({
    scope: agentScopeEnum,
    extraDirIndex: z.number().int().min(0).max(1_024).optional(),
    agent: z.object({
      agentType: z.string().min(1).max(256),
      description: z.string().max(10_000).optional(),
      capability: z.string().max(10_000).optional(),
      tools: z.array(z.string().max(256)).max(256).optional(),
      disallowedTools: z.array(z.string().max(256)).max(256).optional(),
      model: z.string().max(256).optional(),
      prompt: z.string().min(1).max(1_000_000),
      maxTurns: z.number().int().positive().max(10_000).optional(),
      timeout: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
      thinkingBudgetTokens: z.number().int().positive().max(1_000_000).optional(),
    }),
  }),
])

export const agentsDeleteFromDiskArgs = z.tuple([filePathSchema])

export const agentsSetDisabledArgs = z.tuple([
  z.array(z.string().max(256)).max(MAX_AGENT_PAYLOAD),
])

export const agentsSetExtraDirsArgs = z.tuple([
  z.array(filePathSchema).max(64),
])

export const agentsPickDirectoryArgs = z.tuple([
  z.string().max(500).optional(),
])

// --- ai:send-message & friends ------------------------------------------------

/**
 * `ai:send-message` has a large optional surface (see `SendMessageParams`).
 * A strict closed schema here would fight every feature flag; instead we
 * validate the tight invariants (messages shape, providerId shape) and leave
 * the rest as `z.unknown()` passthrough — downstream code already narrows via
 * TypeScript typing at `handleSendMessage`.
 */
export const aiSendMessageArgs = z.tuple([
  z
    .object({
      messages: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']),
            content: z.union([z.string(), z.unknown()]),
          }),
        )
        .max(20_000),
      model: z.string().max(256).optional(),
      maxTokens: z.number().int().positive().max(10_000_000).optional(),
      systemPrompt: z.string().optional(),
      workspacePath: filePathSchema.optional(),
      providerId: z.string().max(64).optional(),
      apiKey: z.string().max(10_000).optional(),
      baseUrl: z.string().max(2_000).optional(),
      anthropicThinkingCapability: z.enum(['auto', 'supported', 'unsupported']).optional(),
      awsRegion: z.string().max(64).optional(),
      projectId: z.string().max(256).optional(),
      outputStyle: z.enum(['default', 'concise', 'explanatory']).optional(),
      language: z.string().max(32).optional(),
      enableTools: z.boolean().optional(),
      conversationId: z.string().max(512).optional(),
      fastMode: z.boolean().optional(),
      effortLevel: z.string().max(32).optional(),
      autoTaskRouting: z.boolean().optional(),
    })
    .passthrough(),
])

export const aiCancelArgs = z.tuple([z.string().max(512).optional()])
export const aiStopTaskArgs = z.tuple([z.string().max(512)])
export const aiRetryTaskArgs = z.tuple([z.string().max(512)])

// M2 (2026-07 会话审计监控) — REAL user text typed while a main stream is
// in flight, routed to the kernel inbox as instruction-level mid-turn
// input (`kernel_user_input` side-channel kind). Text-only by design:
// attachment-bearing sends stay on the renderer's local replay queue.
export const aiEnqueueMidTurnInputArgs = z.tuple([
  z.object({
    conversationId: z.string().min(1).max(512),
    text: z.string().min(1).max(64 * 1024),
  }),
])

// --- ai:respond-* / ai:permission-* / ai:set-diff-permission-mode ------------
//
// BUG-I4: these five handlers used `ipcMain.handle` directly with no shape
// validation. A renderer compromise (or a misbehaving extension hooking the
// preload) could feed in arbitrary nested objects, prototype-pollution keys,
// or oversize strings and trigger main-process behavior the handler bodies
// were never designed to defend against. Schemas below stay conservative
// (size caps, closed enums, plain-object guard) without duplicating the
// downstream domain checks (`respondPermissionRequest` etc.).

export const aiRespondPermissionRequestArgs = z.tuple([
  z.object({
    requestId: z.string().min(1).max(512),
    behavior: z.enum(['allow', 'deny']),
    updatedInput: plainObjectSchema.optional(),
  }),
])

export const aiTeamPermissionReplyArgs = z.tuple([
  z.object({
    teamRequestId: z.string().min(1).max(512),
    behavior: z.enum(['allow', 'deny']),
    updatedInput: plainObjectSchema.optional(),
  }),
])

export const aiPermissionRelayReplyArgs = z.tuple([z.string().max(64 * 1024)])

export const aiSetDiffPermissionModeArgs = z.tuple([
  z.enum(['default', 'bypassPermissions']),
  z.string().min(1).max(512).optional(),
])

export const aiRespondAskUserQuestionArgs = z.tuple([
  z.object({
    requestId: z.string().min(1).max(512),
    answers: z.record(z.string().max(512), z.string().max(64 * 1024)),
    annotations: z
      .record(
        z.string().max(512),
        z.object({
          preview: z.string().max(64 * 1024).optional(),
          notes: z.string().max(64 * 1024).optional(),
        }),
      )
      .optional(),
    // Renderer-supplied conversationId so the durable-HITL inbox enqueue can
    // route the answer when the IPC handler has no ALS context. Required for
    // any HITL-resumable AskUserQuestion (since the original `await` Promise
    // was torn down with the kernel pause). Legacy in-memory-promise dialogs
    // ignore this — they still find their pending entry by requestId.
    conversationId: z.string().min(1).max(512).optional(),
  }),
])

// --- ai:run-teammate / ai:cancel-teammate -------------------------------------
//
// Independent IPC channels for the in-process teammate runner. We keep them
// separate from `ai:send-message` so the teammate's stream events route to
// `ai:teammate-stream-event` and never touch the main chat's
// `activeMainStream` registry. See {@link teammateRunner}.

export const aiRunTeammateArgs = z.tuple([
  z
    .object({
      runId: z.string().max(256).optional(),
      taskId: z.string().max(512).optional(),
      prompt: z.string().min(1).max(2_000_000),
      model: z.string().max(256),
      systemPrompt: z.string().max(2_000_000).optional(),
      maxIterations: z.number().int().positive().max(200).optional(),
      maxTokens: z.number().int().positive().max(10_000_000).optional(),
      agentId: z.string().max(256).optional(),
      parentSessionId: z.string().max(512).optional(),
      // History is bounded loosely — same envelope as ai:send-message's
      // `messages` so renderer clients can pass through prior conversation.
      history: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']),
            content: z.union([z.string(), z.unknown()]),
          }),
        )
        .max(20_000)
        .optional(),
      // Provider config — main process merges with disk settings.
      providerId: z.string().max(64).optional(),
      apiKey: z.string().max(10_000).optional(),
      baseUrl: z.string().max(2_000).optional(),
      awsRegion: z.string().max(64).optional(),
      projectId: z.string().max(256).optional(),
      // P0-2 follow-up: renderer-teammate plan-approval delegation.
      // When `planModeRequired` is true, the run boots in `plan` mode
      // and `ExitPlanMode` routes approval to `leaderConversationId`
      // via `team_plan_approval_request` stream events. Both must be
      // present together; main process validates the pairing.
      planModeRequired: z.boolean().optional(),
      leaderConversationId: z.string().max(512).optional(),
      // Team Active Loop (PR-2): identity needed to emit
      // `idle_notification` envelopes at turn-end. All four are
      // optional and only take effect when POLE_TEAM_ACTIVE_LOOP=1
      // and `teamName` + `leadAgentId` are both present.
      teamName: z.string().max(256).optional(),
      leadAgentId: z.string().max(256).optional(),
      teammateName: z.string().max(256).optional(),
      teammateAgentType: z.string().max(256).optional(),
    })
    .passthrough(),
])

export const aiCancelTeammateArgs = z.tuple([z.string().min(1).max(256)])

/**
 * P0-2 follow-up: renderer-side approval card resolves a pending
 * `team_plan_approval_request` by calling this IPC. The handler unblocks
 * the worker's `awaitChatLeaderPlanApproval` Promise via the shared
 * `pendingTeamLeaderPlanApproval` map (same resolver used by the team
 * mailbox path, so a single IPC closes both delivery modes).
 */
export const aiRespondTeamPlanApprovalArgs = z.tuple([
  z.object({
    requestId: z.string().min(1).max(256),
    approve: z.boolean(),
    detail: z.string().max(8_000).optional(),
  }),
])

/**
 * Main-chat plan-approval card (the IDE `create_plan`-style tri-state gate).
 * Distinct from `aiRespondTeamPlanApprovalArgs` because the outcome is
 * three-valued, not boolean: `cancelled` aborts the entire turn, `rejected`
 * keeps the model in plan mode for a revision, `accepted` proceeds.
 */
export const aiRespondPlanApprovalArgs = z.tuple([
  z.object({
    requestId: z.string().min(1).max(256),
    outcome: z.enum(['accepted', 'rejected', 'cancelled']),
    detail: z.string().max(8_000).optional(),
  }),
])

// --- hooks --------------------------------------------------------------------

export const hooksFirePayloadArgs = z.tuple([plainObjectSchema.optional()])

// --- terminal:* ---------------------------------------------------------------
//
// Terminal commands spawn real processes — every single handler here is a
// high-risk surface. Zod enforces shape; the existing `validateTerminalExec`
// / workspace sandbox still runs inside the handler body.

const sessionIdSchema = z.number().int().nonnegative().max(1_000_000)
const terminalCommandSchema = z.string().min(1).max(100_000)
const ptyDataSchema = z
  .string()
  .max(5 * 1024 * 1024, 'terminal payload too large')

export const terminalCreateArgs = z.tuple([
  filePathSchema.optional(),
])
export const terminalWriteArgs = z.tuple([sessionIdSchema, ptyDataSchema])
export const terminalResizeArgs = z.tuple([
  sessionIdSchema,
  z.number().int().min(1).max(10_000),
  z.number().int().min(1).max(10_000),
])
export const terminalCloseArgs = z.tuple([sessionIdSchema])
export const terminalExecArgs = z.tuple([
  terminalCommandSchema,
  filePathSchema.optional(),
])

// --- git:* --------------------------------------------------------------------
//
// All git handlers take `workspaceRoot` first; every write op validates paths
// internally via `safeRelPath`. Zod asserts shape only.

const gitWorkspaceRootSchema = filePathSchema

/** `git:add` accepts either the literal strings or a path array. */
const gitPathsOrModeSchema = z.union([
  z.literal('all'),
  z.literal('tracked'),
  z.array(filePathSchema).max(50_000),
])

const gitPathsArraySchema = z.array(filePathSchema).max(50_000)

export const gitStatusArgs = z.tuple([gitWorkspaceRootSchema])
export const gitInitArgs = z.tuple([gitWorkspaceRootSchema])
export const gitAddArgs = z.tuple([
  gitWorkspaceRootSchema,
  gitPathsOrModeSchema.optional(),
])
export const gitUnstageArgs = z.tuple([
  gitWorkspaceRootSchema,
  gitPathsArraySchema,
])
export const gitCommitArgs = z.tuple([
  gitWorkspaceRootSchema,
  z.string().max(65_536),
])
export const gitCommitFilesArgs = z.tuple([
  gitWorkspaceRootSchema,
  z.string().min(4).max(128),
])
export const gitLogArgs = z.tuple([
  gitWorkspaceRootSchema,
  z.number().int().positive().max(10_000).optional(),
])
export const gitGetIdentityArgs = z.tuple([gitWorkspaceRootSchema])
export const gitSetIdentityArgs = z.tuple([
  gitWorkspaceRootSchema,
  z.string().min(1).max(512),
  z.string().min(1).max(512),
  z.enum(['global', 'local']),
])
export const gitCheckoutCommitPathsArgs = z.tuple([
  gitWorkspaceRootSchema,
  z.string().min(4).max(128),
  gitPathsArraySchema,
])
export const gitRestoreArgs = z.tuple([
  gitWorkspaceRootSchema,
  gitPathsArraySchema,
  z.enum(['worktree', 'head', 'untracked']),
])

// --- mcp:* --------------------------------------------------------------------
//
// MCP `connect` / `save-configs` boot subprocesses — Zod enforces only the
// outermost shape (object / array). The existing `sanitizeMcpConfig` still
// runs inside the handler to check `command` / `args` / `env` deeply.

const mcpServerNameSchema = z.string().min(1).max(256)

export const mcpPresetsArgs = z.tuple([
  filePathSchema.nullable().optional(),
])
export const mcpReconnectAllArgs = z.tuple([
  filePathSchema.nullable().optional(),
])
export const mcpReconnectArgs = z.tuple([
  mcpServerNameSchema,
  filePathSchema.nullable().optional(),
])
export const mcpDisconnectArgs = z.tuple([
  mcpServerNameSchema,
  z.boolean().optional(),
])
export const mcpHealthCheckArgs = z.tuple([mcpServerNameSchema])
export const mcpListResourcesArgs = z.tuple([mcpServerNameSchema])
export const mcpConnectArgs = z.tuple([z.unknown()])
export const mcpSaveConfigsArgs = z.tuple([
  z.array(z.unknown()).max(10_000),
])
