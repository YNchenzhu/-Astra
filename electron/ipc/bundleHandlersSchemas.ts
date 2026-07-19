/**
 * Zod schemas for bundle IPC handlers.
 *
 * Sprint 2a surfaces only scalar agent fields in the UI. To prevent
 * smuggling complex fields (promptSections / agentHooks / tool arrays)
 * through this channel before Sprint 2b implements their editors, we
 * intentionally restrict the schema. A later Sprint will relax this
 * into a full AgentBundleEntry partial schema.
 *
 * String length caps are defensive — the IDs/names we persist are
 * small; an attacker-sized payload would bloat the JSON and stall
 * JSON.parse on subsequent loads.
 */

import { z } from 'zod'

export const MAX_SHORT = 512
export const MAX_LONG = 32_768

/**
 * Wrapper: allow `null` in addition to the original type and accept
 * absent keys. `null` is the wire-level "clear this field" sentinel —
 * the registry converts a null-valued key into a property delete on
 * the merged agent/team. See `workbenchDraftStore.computePatchToSend`
 * for why (Electron IPC drops `undefined` properties from objects).
 */
export const nullable = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional()

/** Schema for one PromptSection. Kept aligned with
 *  `PromptSection` in `electron/agents/bundles/types.ts`. */
export const promptSectionSchema = z.object({
  id: z.string().min(1).max(MAX_SHORT),
  title: z.string().max(MAX_SHORT),
  hint: z.string().max(MAX_LONG).optional(),
  body: z.string().max(MAX_LONG),
  order: z.number().finite(),
  required: z.boolean().optional(),
})

/** Schema for a bundle meta patch. All fields nullable (null sentinel
 *  = clear) except `id` which is rejected outright at the registry level. */
export const bundleMetaFieldsSchema = z
  .object({
    name: nullable(z.string().max(MAX_SHORT)),
    description: nullable(z.string().max(MAX_LONG)),
    icon: nullable(z.string().max(MAX_SHORT)),
    domain: nullable(z.string().max(MAX_SHORT)),
    author: nullable(z.string().max(MAX_SHORT)),
    version: nullable(z.string().max(MAX_SHORT)),
  })
  .strict()

/**
 * Top-level bundle patch — meta patch nested under `meta`, plus a few
 * bundle-root fields (initialContext / welcomeMessage). Capabilities &
 * layout are intentionally excluded until a dedicated Bundle-settings
 * UI lands (they carry schema complexity and rarely need editing
 * alongside plain meta fields).
 */
/** Sprint 9: layout schema. 5 种 LayoutType + 可选 options(侧栏/次面板
 *  等)。Zod enum 里的值与 `electron/agents/bundles/types.ts` 的
 *  LayoutType union 保持一一对应。 */
export const layoutConfigSchema = z.object({
  type: z.enum([
    'chat-centric',
    'document-centric',
    'data-centric',
    'dashboard',
    'code-workspace',
  ]),
  options: z
    .object({
      sidebar: z
        .enum(['files', 'outline', 'tags', 'datasets', 'projects', 'custom', 'none'])
        .optional(),
      secondaryPane: z.enum(['chat', 'preview', 'memory', 'none']).optional(),
      topBar: z.enum(['bundle-selector', 'agent-selector', 'breadcrumbs', 'none']).optional(),
      widgets: z.array(z.string().max(MAX_SHORT)).max(64).optional(),
    })
    .optional(),
})

export const permissionRuleSchema = z.object({
  id: z.string().max(MAX_SHORT).optional(),
  pattern: z.string().min(1).max(MAX_SHORT),
  mode: z.enum(['allow', 'ask', 'deny']),
  shellPattern: z.string().max(MAX_SHORT).optional(),
  pathPattern: z.string().max(MAX_SHORT).optional(),
})

export const capabilitiesPatchSchema = z
  .object({
    enabledTools: z.union([z.literal('*'), z.array(z.string().max(MAX_SHORT)).max(256)]),
    enabledSkills: z.array(z.string().max(MAX_SHORT)).max(256).optional(),
    enabledMcpServers: z.array(z.string().max(MAX_SHORT)).max(128).optional(),
    disallowedTools: z.array(z.string().max(MAX_SHORT)).max(256).optional(),
    permissionDefaultMode: z.enum(['allow', 'ask', 'deny']).optional(),
    permissionRules: z.array(permissionRuleSchema).max(128).optional(),
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
  })
  .partial()

export const bundlePatchSchema = z
  .object({
    meta: bundleMetaFieldsSchema.optional(),
    initialContext: nullable(z.string().max(MAX_LONG * 4)),
    welcomeMessage: nullable(z.string().max(MAX_LONG)),
    /** Sprint 9: 主界面布局类型 + 布局选项。 */
    layout: layoutConfigSchema.optional(),
    capabilities: capabilitiesPatchSchema.optional(),
  })
  .strict()

/** Schema for one TeamMember. Kept aligned with `TeamMember` in
 *  `electron/agents/bundles/types.ts`. */
export const teamMemberSchema = z.object({
  agentType: z.string().min(1).max(MAX_SHORT),
  role: z.string().max(MAX_SHORT).optional(),
  parallelGroup: z.number().int().nonnegative().max(1024).optional(),
})

/**
 * Schema for the `patch` argument of `bundle:save-team`. Same
 * null-sentinel conventions as agent patches; `id` is always rejected
 * to prevent renaming (references would break).
 */
export const teamPatchSchema = z
  .object({
    name: nullable(z.string().max(MAX_SHORT)),
    description: nullable(z.string().max(MAX_LONG)),
    coordination: nullable(
      z.enum(['solo', 'parallel', 'sequential', 'swarm', 'coordinator']),
    ),
    members: nullable(z.array(teamMemberSchema).max(64)),
  })
  .strict()

/**
 * Schema for one `AgentHookSpec` entry (Sprint 2b.3).
 *
 * Kept intentionally permissive on `event` (free-form string rather
 * than a strict enum of `HOOK_EVENTS`) — legacy JSONs + future hook
 * events shipped by user plugins shouldn't be rejected just because
 * the renderer side hasn't caught up. The hook runner already tolerates
 * unknown events (silently no-ops). Caps are conservative.
 */
export const agentHookSchema = z.object({
  event: z.string().min(1).max(MAX_SHORT),
  matcher: z.string().max(MAX_SHORT),
  command: z.string().max(MAX_LONG),
  async: z.boolean().optional(),
  executionKind: z.enum(['command', 'prompt', 'agent', 'http']).optional(),
})

/**
 * Schema for the `patch` argument of `bundle:save-agent`.
 * Every value is wrapped in `nullable(...)` — see top of file for
 * why we accept `null` as an explicit "clear this field" sentinel.
 */
export const agentPatchSchema = z
  .object({
    displayName: nullable(z.string().max(MAX_SHORT)),
    tagline: nullable(z.string().max(MAX_SHORT)),
    capability: nullable(z.string().max(MAX_LONG)),
    whenToUse: nullable(z.string().max(MAX_LONG)),
    icon: nullable(z.string().max(MAX_SHORT)),
    color: nullable(z.string().max(MAX_SHORT)),
    isPrimary: nullable(z.boolean()),

    model: nullable(z.string().max(MAX_SHORT)),
    maxTurns: nullable(z.number().int().nonnegative().max(10_000)),
    maxTokenBudget: nullable(z.number().int().nonnegative().max(50_000_000)),
    timeout: nullable(z.number().int().nonnegative().max(24 * 60 * 60 * 1000)),
    thinkingBudgetTokens: nullable(z.number().int().nonnegative().max(1_000_000)),
    effort: nullable(z.enum(['low', 'medium', 'high', 'max'])),

    permissionMode: nullable(
      z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']),
    ),
    parentPolicy: nullable(z.enum(['inherit', 'restricted', 'isolated'])),
    isReadOnly: nullable(z.boolean()),
    omitClaudeMd: nullable(z.boolean()),
    memory: nullable(z.enum(['user', 'project', 'local'])),
    isolation: nullable(z.enum(['worktree', 'remote'])),
    background: nullable(z.boolean()),
    initialPrompt: nullable(z.string().max(MAX_LONG)),
    criticalReminder: nullable(z.string().max(MAX_LONG)),

    coordinatorPhase: nullable(
      z.enum(['research', 'synthesis', 'implementation', 'verification']),
    ),
    subagentToolProfile: nullable(
      z.enum(['default', 'async_agent', 'in_process_teammate']),
    ),
    orchestrationRole: nullable(
      z.enum(['solo', 'readonly-worker', 'writing-worker', 'coordinator', 'verifier']),
    ),

    // ── Sprint 2b.1: prompt override fields ──
    promptSections: nullable(z.array(promptSectionSchema).max(64)),
    systemPromptRaw: nullable(z.string().max(MAX_LONG * 4)),

    // ── Sprint 2b.2: capability whitelists ──
    // Each array item is a plain string. For `mcpServers` the
    // AgentBundleEntry type allows `AgentMcpServerRef = string |
    // {name, config?}`; we deliberately only accept names here —
    // inline config is an advanced feature we'll expose separately
    // in a future sprint (ties into the MCP savedconnection UI).
    tools: nullable(z.array(z.string().max(MAX_SHORT)).max(256)),
    disallowedTools: nullable(z.array(z.string().max(MAX_SHORT)).max(256)),
    skills: nullable(z.array(z.string().max(MAX_SHORT)).max(256)),
    mcpServers: nullable(z.array(z.string().max(MAX_SHORT)).max(128)),

    // ── Sprint 2b.3: per-agent hooks ──
    agentHooks: nullable(z.array(agentHookSchema).max(128)),

    // ── Sampling parameters ──
    temperature: nullable(z.number().min(0).max(2)),
    topP: nullable(z.number().min(0).max(1)),
  })
  .strict() // reject unknown keys so future additions are opt-in
