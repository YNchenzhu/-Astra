/**
 * SkillTool — A Tool that lets the AI invoke named skills.
 *
 * IDE-compatible behavior:
 *   - Skills with disableModelInvocation=false are presented to the Agent
 *     as available context. The Agent decides when to use them automatically.
 *   - Skills with disableModelInvocation=true are manual-only (/ or @ trigger).
 *   - The tool can be called by the AI when it determines a skill is relevant,
 *     or when the user explicitly requests it via /skillName or @skillName.
 */

import type { ToolResult } from '../tools/types'
import { buildTool } from '../tools/buildTool'
import { skillToolInputZod } from '../tools/toolInputZod'
import type {
  SkillDefinition,
  SkillExecuteResult,
  SkillAgentContext,
  SkillInfo,
  SkillInvoker,
} from './types'
import { parseSkillEffort, type SkillEffort } from './skillEffort'
import { createSkillLoader, lintSkillDescriptionQuality } from './loader'
import { getBundledSkills } from './bundledSkills'
import { clearSkillHookRegistry, registerSkillHooks } from './skillHooks'
import { mergeSkillDefinitionsCRDT } from './skillMergeCRDT'
import { INVOKED_SKILL_CONTENT_MAX_CHARS } from './discoveryBudget'
import { SKILL_INSTRUCTIONS_BLOCK_CAP_CHARS } from '../constants/toolLimits'
import { getAgentContext } from '../agents/agentContext'
import { recordInvokedSkill } from './invokedSkillsRegistry'
import { asAgentId } from '../tools/ids'
import { fireInstructionsLoadedHooks } from '../tools/hooks/runtimeHookBridges'
import { getWorkspacePath } from '../tools/workspaceState'
import {
  hookWorkspaceCwd,
  runPostSkillUseHooksSafe,
  runPreSkillUsePhase,
} from '../ai/hookIntegration'

// ---------- Skill registry ----------

let loadedSkills: SkillDefinition[] = []
const skillLoader = createSkillLoader()

/**
 * Stage 9 — version counter for skill-derived prompt caches. Bumped on
 * every {@link initSkills} call (which re-discovers bundled + filesystem
 * skills and rebuilds {@link loadedSkills}). Consumers like
 * {@link getCompactSkillIndexPrompt} key their memo on this counter so
 * the cache is invalidated atomically with the skill set.
 */
let skillsVersion = 0
export function getSkillsVersion(): number {
  return skillsVersion
}

/**
 * Initialize skills: load bundled + filesystem skills.
 * Call once during app startup.
 */
export function initSkills(workspacePath?: string, userDataPath?: string): void {
  clearSkillHookRegistry()
  const bundled = getBundledSkills()
  const filesystem = skillLoader.loadAll(workspacePath, userDataPath)
  const bundledTagged = bundled.map((s, i) => ({ skill: s, ordinal: i }))
  const fsTagged = filesystem.map((s, i) => ({
    skill: s,
    ordinal: bundled.length + i,
  }))
  loadedSkills = mergeSkillDefinitionsCRDT([...bundledTagged, ...fsTagged])
  // Bump skill cache version so memoized derivatives recompute.
  skillsVersion++
  invalidateCompactSkillIndexCache()

  for (const s of loadedSkills) {
    if (s.hooks?.length) {
      registerSkillHooks(s.name, s.hooks, s.resolvedPath)
    }
  }

  // upstream parity (`loadSkillsDir.ts:798-800`) — log a count + bounded
  // breakdown instead of the full name list. A 50+ skill workspace was
  // dumping ~4-5KB per line and watcher abuse re-emitted that on every
  // disk touch, which made console output unreadable.
  const previewNames = loadedSkills.slice(0, 5).map((s) => s.name).join(', ')
  const overflow = loadedSkills.length > 5 ? `, …+${loadedSkills.length - 5}` : ''
  console.log(`[Skills] Loaded ${loadedSkills.length} skills (${previewNames}${overflow})`)

  // Skill-attention uplift (2026-07) — description quality lint. The
  // description is the only always-in-context surface a skill has; weak
  // ones lose the auto-invocation attention race silently. Warn (bounded,
  // same anti-spam rationale as the load log above) so authors find out
  // at load time instead of by observing missed invocations.
  const lintProblems: string[] = []
  for (const s of loadedSkills) {
    const problem = lintSkillDescriptionQuality(s)
    if (problem) lintProblems.push(`"${s.name}": ${problem}`)
  }
  if (lintProblems.length > 0) {
    const shown = lintProblems.slice(0, 5)
    const more = lintProblems.length > 5 ? ` (+${lintProblems.length - 5} more)` : ''
    console.warn(
      `[Skills] ${lintProblems.length} skill description(s) may rank poorly for auto-invocation${more}:\n  - ${shown.join('\n  - ')}`,
    )
  }

  fireInstructionsLoadedHooks(
    loadedSkills.map((s) => s.name),
    workspacePath?.trim() || getWorkspacePath()?.trim() || '',
  )
}

/**
 * Get all loaded skills.
 */
export function getAllSkills(): SkillDefinition[] {
  return loadedSkills
}

/**
 * Find a skill by name (case-insensitive, strips leading / or @).
 */
export function findSkill(name: string): SkillDefinition | undefined {
  const normalized = name.replace(/^[/@]/, '').toLowerCase()
  return loadedSkills.find(s => s.name.toLowerCase() === normalized)
}

/**
 * Get lightweight skill info for the frontend popup.
 * Includes all user-invocable skills (for / and @ menus).
 */
export function getSkillInfoList(): SkillInfo[] {
  return loadedSkills
    .filter(s => s.userInvocable)
    .map(s => ({
      name: s.name,
      description: s.description,
      argumentHint: s.argumentHint,
      source: s.source,
      disableModelInvocation: s.disableModelInvocation,
    }))
}

/**
 * Get skill contexts for Agent auto-invocation.
 * Only includes skills where disableModelInvocation is false.
 * These are injected into the Agent's system prompt so it can decide
 * when to use them based on context.
 */
export function getAutoInvocationContexts(): SkillAgentContext[] {
  return loadedSkills
    .filter(s => !s.disableModelInvocation)
    .map(s => {
      const ctx: SkillAgentContext = {
        name: s.name,
        description: s.description,
        argumentHint: s.argumentHint,
        promptContent: s.promptContent,
        allowedTools: s.allowedTools,
        whenToUse: s.whenToUse,
      }
      // Self-audit fix B2 (2026-05) — only the filename list is
      // surfaced (no body content). The model can read_file on demand
      // against the skill's base directory.
      if (s.references && s.references.length > 0) {
        ctx.references = s.references
      }
      if (s.scripts && s.scripts.length > 0) {
        ctx.scripts = s.scripts
      }
      return ctx
    })
}

/**
 * Generate a formatted string of auto-invocation skill descriptions
 * for injection into the Agent's system prompt.
 */
export function getAutoInvocationPrompt(): string {
  const contexts = getAutoInvocationContexts()
  if (contexts.length === 0) return ''

  const lines: string[] = [
    '# Available Skills',
    '',
    'The following skills are available and can be automatically invoked when relevant to the user\'s request.',
    'To invoke a skill, use the Skill tool with the skill name.',
    '',
  ]

  for (const ctx of contexts) {
    lines.push(`## /${ctx.name}`)
    lines.push(ctx.description)
    if (ctx.whenToUse) {
      lines.push(`When to use: ${ctx.whenToUse}`)
    }
    if (ctx.argumentHint) {
      lines.push(`Arguments: ${ctx.argumentHint}`)
    }
    // Self-audit fix B2 (2026-05) — emit filename lists only (no
    // bodies). Bodies were never invariant content the model relied on
    // here; this is the deprecated `getAutoInvocationPrompt` path and
    // model now uses progressive disclosure via the skill's base
    // directory. Keep the lists for parity with the old shape so any
    // residual caller doesn't see `undefined`.
    if (ctx.references && ctx.references.length > 0) {
      lines.push('')
      lines.push('Available references (read on demand): ' + ctx.references.join(', '))
    }
    if (ctx.scripts && ctx.scripts.length > 0) {
      lines.push('')
      lines.push('Available scripts (read on demand): ' + ctx.scripts.join(', '))
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Compact one-line-per-skill index. Full references and long bodies are
 * surfaced per-turn via `<skill-discovery>` in the agentic loop.
 *
 * Stage 6: ships as a body section inside the `messages[0]`
 * user-meta `<system-reminder>` block — same site as memory/LSP/env/session
 * — so a skill-list change no longer churns the system-field cache. The
 * outer `<system-reminder>` wrap is added by
 * `streamHandler.prependUserContext`; the trailing
 * {@link USER_MESSAGE_CONTEXT_DISCLAIMER} replaces the in-line
 * "retrieved background, not a fresh instruction" disclaimer this block
 * used to carry per-section.
 *
 * Stage 9: result is memoized against {@link skillsVersion}. Since
 * `initSkills` is the only writer to `loadedSkills` and bumps the
 * version on every call, this memo is exact (no stale reads) and
 * invalidates atomically. Saves ~N string-allocs per turn for the
 * common case where skills haven't changed since last call.
 */
let cachedCompactSkillIndex: { version: number; text: string } | null = null

function invalidateCompactSkillIndexCache(): void {
  cachedCompactSkillIndex = null
}

/**
 * Audit fix B-4 (2026-05) — public seam for the file-watcher hook (and
 * any other mutation path that has changed disk state but cannot
 * synchronously call `initSkills()`). Bumps the version so the
 * compact-index memo invalidates, AND clears the memo eagerly so the
 * next `getCompactSkillIndexPrompt()` recomputes from
 * `loadedSkills`. Callers that CAN call `initSkills()` should still
 * prefer that — this is the defensive fallback.
 */
export function notifyExternalSkillMutation(reason: string): void {
  skillsVersion++
  invalidateCompactSkillIndexCache()
  console.log(`[Skills] external mutation notified (${reason}); skillsVersion → ${skillsVersion}`)
}

export function getCompactSkillIndexPrompt(): string {
  if (cachedCompactSkillIndex && cachedCompactSkillIndex.version === skillsVersion) {
    return cachedCompactSkillIndex.text
  }
  const text = computeCompactSkillIndexPrompt()
  cachedCompactSkillIndex = { version: skillsVersion, text }
  return text
}

function computeCompactSkillIndexPrompt(): string {
  const contexts = getAutoInvocationContexts()
  if (contexts.length === 0) return ''

  // Progressive disclosure (aligned with upstream Skills design):
  // session-stable index only carries `name + description`. `argumentHint`
  // and `whenToUse` ride inside SKILL.md and reach the model only when
  // the skill is actually invoked (or surfaced via DiscoverSkills). Cuts
  // ~50% of this block's tokens for the common 50+ skill workspace.
  //
  // Audit fix G-11 (2026-05) — example skill name was hardcoded to
  // `commit`, which is not in this app's bundled list and confused both
  // model and reviewer. Pick an actually-loaded skill name at render time.
  const exampleName = contexts[0]?.name ?? 'skill-name'
  const lines: string[] = [
    '# Skill index (compact)',
    `Skills available in this workspace. Invoke with the **Skill** tool by name (e.g. \`${exampleName}\`); full SKILL.md body loads at invocation time.`,
    'For task-pivot lookups or to inspect a skill\'s workflow before running it, call **DiscoverSkills** with a short query.',
    '',
  ]

  for (const ctx of contexts) {
    // Audit fix B-3 (2026-05) — skip skills whose YAML frontmatter
    // lacks a description. Previously these surfaced as
    // `- **/my-skill** — ` (empty trailing), which the model parsed
    // as a real invocable skill and tried to call on name similarity
    // alone. The skill loader already warns when frontmatter parsing
    // fails; this is the renderer-side gate so malformed entries
    // never make it into the index even if loader warnings are
    // silenced in production logs.
    const desc = (ctx.description ?? '').trim()
    if (!desc) {
      console.warn(
        `[skills/index] Skipping "${ctx.name}" — empty description in compact index. ` +
          `Check SKILL.md frontmatter for a non-empty \`description:\` field.`,
      )
      continue
    }
    lines.push(`- **/${ctx.name}** — ${desc}`)
  }

  return lines.join('\n')
}

/**
 * Skill-resource attention uplift (2026-07) — render the skill's bundled
 * resources (references / scripts / assets) as a structured manifest with
 * FULL absolute paths and per-reference content hints.
 *
 * Why this replaces the old trailing "Available references (read on
 * demand): a.md, b.md" line:
 *
 *   1. Bare filenames forced the model to synthesize
 *      `base + '/references/' + name` itself — every synthesis step is an
 *      attention leak, and a wrong join means a failed read_file and a
 *      silent fallback to guessing the content.
 *   2. No content signal meant references lost the "should I read this?"
 *      decision almost every time (same failure mode the compact skill
 *      index solved for skill selection — description beats bare name).
 *   3. `scripts/` and `assets/` were not surfaced at all on the inline
 *      path, so skills shipping executable helpers saw the model
 *      re-implement them from the SKILL.md prose.
 *
 * Bodies still stay on disk (B2 contract): the manifest carries paths +
 * one-line hints only. Exported for tests.
 */
export function buildSkillResourceManifest(skill: SkillDefinition): string {
  const base = skill.resolvedPath?.trim()
  if (!base) return ''
  const dir = process.platform === 'win32' ? base.replace(/\\/g, '/') : base

  const refNames = skill.references ?? []
  const scriptNames = skill.scripts ?? []
  const assetPaths = skill.assets ?? []
  const resourceDocs = skill.resourceDocs ?? []
  if (
    refNames.length === 0 &&
    scriptNames.length === 0 &&
    assetPaths.length === 0 &&
    resourceDocs.length === 0
  ) {
    return ''
  }

  const lines: string[] = [`<skill-resources skill="${skill.name}">`]
  lines.push(
    'This skill ships bundled resources. They are PART OF the skill\'s instructions, kept on disk to save context:',
  )
  if (refNames.length > 0) {
    lines.push('', 'References — when a workflow step relies on one of these documents, read_file it BEFORE executing that step; do not act on a reference you have not read:')
    for (const name of refNames) {
      const hint = skill.referenceHints?.[name]
      lines.push(`- ${dir}/references/${name}${hint ? ` — ${hint}` : ''}`)
    }
  }
  // Modular-router skills (2026-07) — docs living in non-standard subdirs
  // (`common/`, `modules/`, …) that the SKILL.md body references by
  // RELATIVE path. Absolute paths here close the gap between "the body
  // says Read common/00-x.md" and a correct read_file call.
  if (resourceDocs.length > 0) {
    lines.push('', 'Instruction documents (referenced by relative path in the skill body above — resolve them against these absolute paths; when the body says to read one, read_file it at the required point, do not paraphrase it from memory):')
    for (const doc of resourceDocs) {
      lines.push(`- ${dir}/${doc.relPath}${doc.hint ? ` — ${doc.hint}` : ''}`)
    }
  }
  if (scriptNames.length > 0) {
    lines.push('', 'Scripts — prefer running these over re-implementing their logic from the prose above; read the script first if its usage is unclear:')
    for (const name of scriptNames) {
      lines.push(`- ${dir}/scripts/${name}`)
    }
  }
  if (assetPaths.length > 0) {
    lines.push('', 'Assets (templates / static files used in output):')
    for (const p of assetPaths) {
      const normalized = process.platform === 'win32' ? p.replace(/\\/g, '/') : p
      lines.push(`- ${normalized}`)
    }
  }
  lines.push('</skill-resources>')
  return lines.join('\n')
}

export interface ExecuteSkillOptions {
  /** `model` = Skill tool / agent; `user` = / or @ menu (allows disable-model-invocation skills). */
  invoker?: SkillInvoker
}

function buildInlineSkillSession(skill: SkillDefinition): {
  skillName: string
  allowedTools?: string[]
  model?: string
  effort?: SkillEffort
} {
  const session: {
    skillName: string
    allowedTools?: string[]
    model?: string
    effort?: SkillEffort
  } = { skillName: skill.name }
  if (skill.allowedTools && skill.allowedTools.length > 0) {
    session.allowedTools = skill.allowedTools
  }
  if (skill.model?.trim()) {
    session.model = skill.model.trim()
  }
  const effort = parseSkillEffort(skill.effort)
  if (effort) session.effort = effort
  return session
}

/**
 * Execute a skill by name.
 * Inline: expands prompt; fork: runs an isolated `runAgenticLoop` when agent context exists.
 */
export async function executeSkill(
  skillName: string,
  args?: string,
  options?: ExecuteSkillOptions,
): Promise<SkillExecuteResult> {
  const invoker: SkillInvoker = options?.invoker ?? 'user'
  const skill = findSkill(skillName)
  if (!skill) {
    const available = loadedSkills.map(s => s.name).join(', ')
    return {
      success: false,
      error: `Unknown skill: "${skillName}". Available: ${available}`,
      context: 'inline',
    }
  }

  if (invoker === 'model' && skill.disableModelInvocation) {
    return {
      success: false,
      error:
        `Skill "${skill.name}" is manual-only (disable-model-invocation). ` +
        'The user must invoke it via / or @ in the input; do not use the Skill tool.',
      context: 'inline',
    }
  }

  const argumentsStr = args || ''
  const cwd = hookWorkspaceCwd()
  const hookPayload: Record<string, unknown> = {
    skill: skill.name,
    args: argumentsStr,
    context: skill.context,
    invoker,
  }

  const pre = await runPreSkillUsePhase(skill.name, hookPayload, cwd)
  if (pre.blocked) {
    await runPostSkillUseHooksSafe(
      skill.name,
      hookPayload,
      cwd,
      false,
      pre.reason ?? 'PreSkillUse blocked',
    )
    return {
      success: false,
      error: pre.reason ?? 'Blocked by PreSkillUse hook.',
      context: 'inline',
    }
  }

  // Audit fix G-8 (2026-05) — previously this site loaded every
  // `references/` file fully and concatenated their bodies into the
  // expandedPrompt. A 100KB reference (perfectly plausible for a doc
  // bundle) then rode through the prompt + the Skill tool's tool_result
  // every invocation, easily blowing the context window. upstream's
  // approach (`loadSkillsDir.ts:345-354`) is progressive disclosure: the
  // expanded prompt advertises the skill's base directory and the model
  // is expected to read_file / glob into it on demand. We adopt the same
  // pattern. Reference filenames are still hinted so the model knows what
  // exists without having to glob first.
  let promptTemplate = skill.promptContent
  if (skill.resolvedPath) {
    const baseDir =
      process.platform === 'win32'
        ? skill.resolvedPath.replace(/\\/g, '/')
        : skill.resolvedPath
    promptTemplate = `Base directory for this skill: ${baseDir}\n(Use read_file / glob to access scripts/, references/, and assets/ under this directory on demand — they are NOT pre-loaded.)\n\n${promptTemplate}`
    // Self-audit fix B2 (2026-05) — reference/script BODIES stay on disk.
    // Skill-resource attention uplift (2026-07): the old trailing
    // "Available references (read on demand): a.md, b.md" line is replaced
    // by a structured manifest with full paths + bounded content hints —
    // see `buildSkillResourceManifest` for the rationale. It sits at the
    // TAIL of the body (recency position inside the tool_result), so the
    // resource pointers are the freshest thing the model reads before its
    // first workflow step.
    const manifest = buildSkillResourceManifest(skill)
    if (manifest) {
      promptTemplate += `\n\n${manifest}`
    }
  }

  const expandedPrompt = skillLoader.substituteArguments(promptTemplate, argumentsStr, skill.resolvedPath)

  if (skill.context === 'fork') {
    const { runSkillFork } = await import('./skillForkRunner')
    const forkRes = await runSkillFork({
      skillDisplayName: skill.name,
      expandedPrompt,
      allowedTools: skill.allowedTools,
      model: skill.model,
      effort: parseSkillEffort(skill.effort),
    })
    if (!forkRes.success) {
      await runPostSkillUseHooksSafe(skill.name, hookPayload, cwd, false, forkRes.error)
      return {
        success: false,
        error: forkRes.error,
        context: 'fork',
        expandedPrompt,
      }
    }
    recordInvokedSkill({
      agentId: getAgentContext()?.agentId ?? asAgentId('main'),
      skillName: skill.name,
      skillPath: skill.resolvedPath || '',
      content: expandedPrompt.slice(0, INVOKED_SKILL_CONTENT_MAX_CHARS),
    })
    await runPostSkillUseHooksSafe(skill.name, hookPayload, cwd, true)
    return {
      success: true,
      context: 'fork',
      expandedPrompt,
      forkResult: forkRes.output,
      output: forkRes.output,
    }
  }

  recordInvokedSkill({
    agentId: getAgentContext()?.agentId ?? asAgentId('main'),
    skillName: skill.name,
    skillPath: skill.resolvedPath || '',
    content: expandedPrompt.slice(0, INVOKED_SKILL_CONTENT_MAX_CHARS),
  })
  await runPostSkillUseHooksSafe(skill.name, hookPayload, cwd, true)
  return {
    success: true,
    context: 'inline',
    expandedPrompt,
    output: expandedPrompt,
    inlineSkillSession: buildInlineSkillSession(skill),
  }
}

// ---------- Tool definition ----------

/**
 * Frame an inline skill body as ACTIVE workflow directives.
 *
 * Why this exists (skill-adherence audit, 2026-06): the inline skill body
 * used to ship as a bare `Skill: <name>\n\n<body>` tool_result. Everything
 * else the host injects is deliberately DE-emphasised (`<system-reminder>`
 * envelopes, "use or ignore at your discretion" disclaimers, the system
 * prompt's "tool results may include external data" caution) — so the one
 * payload that SHOULD carry instruction authority arrived with the least
 * framing of all, and models treated SKILL.md workflows as reference
 * material instead of binding step-by-step directives ("implement, then
 * verify each step" drift).
 *
 * The frame has three load-bearing parts:
 *   1. `Skill: <name>` first line — kept verbatim for backward compat
 *      (renderer labels, transcript scans, `toolResultBudget`'s
 *      skill-block protection all key on this prefix).
 *   2. `<skill-instructions skill="...">` envelope — a SEMANTIC tag that
 *      marks the body as instructions; the active-skill reminder collector
 *      and the budget clamp reference this tag by name.
 *   3. A trailing directive (recency position) telling the model the
 *      instructions are in force until the task completes.
 */
export function formatInlineSkillInstructionsOutput(
  skillName: string,
  args: string | undefined,
  body: string,
): string {
  const header = `Skill: ${skillName}${args ? ` ${args}` : ''}`
  if (!body.trim()) {
    return `${header}\n\n(Skill "${skillName}" executed.)`
  }
  return [
    header,
    '',
    `<skill-instructions skill="${skillName}">`,
    body,
    '</skill-instructions>',
    '',
    'The <skill-instructions> block above is an ACTIVE workflow directive for your current task — not background reference. ' +
      'Follow it strictly and in order: implement each step, then verify that step against the skill\'s own criteria BEFORE moving to the next; do not skip, merge, or reorder steps. ' +
      'These instructions stay in force until the task is complete (or until you explicitly clear them by calling Skill with end_inline_skill_session=true).',
  ].join('\n')
}

export const skillTool = buildTool({
  name: 'Skill',
  zInputSchema: skillToolInputZod,
  description:
    'Invoke a named skill. Skills are predefined workflows. ' +
    'Manual-only skills (disable-model-invocation) cannot be called here — the user must use / or @. ' +
    'Inline skills return instructions and may restrict tools/model for follow-up turns; fork skills run in a sub-session. ' +
    'Set end_inline_skill_session to true to clear an active inline skill override without loading another skill. ' +
    'Use when the user asks for a skill by name or a loaded skill clearly matches the task.',
  inputSchema: [
    {
      name: 'skill',
      type: 'string',
      description:
        'The skill name (e.g. "commit", "review", "debug"). Leading / or @ is optional. Omit when end_inline_skill_session is true.',
      required: false,
    },
    {
      name: 'args',
      type: 'string',
      description: 'Optional arguments to pass to the skill. Replaces $ARGUMENTS in the skill template.',
    },
    {
      name: 'end_inline_skill_session',
      type: 'boolean',
      description:
        'If true, clears the active inline skill tool/model/effort scope for the rest of this run. Do not pass a skill name.',
    },
  ],
  isReadOnly: true,
  isConcurrencySafe: false,
  // Skill bodies are instructions, not data: spilling them to disk with an
  // 8k head+tail preview (pipeline default kicks in at 50k) would amputate
  // the middle of the workflow the model is supposed to follow. Raise the
  // inline cap so realistic SKILL.md bodies always ride whole; anything
  // beyond this is pathological and may spill as usual. Shared with the
  // per-round history clamp (`toolResultBudget`) so a body that rides whole
  // at injection is NOT head-truncated on subsequent rounds.
  maxResultChars: SKILL_INSTRUCTIONS_BLOCK_CAP_CHARS,
  async call(input, _ctx): Promise<ToolResult> {
    if (input.end_inline_skill_session === true) {
      return {
        success: true,
        output:
          'Inline skill session cleared: full tool list and default model apply to subsequent turns in this conversation.',
        clearInlineSkillSession: true,
      }
    }

    const skillName = String(input.skill || '')
    const args = input.args ? String(input.args) : undefined

    if (!skillName.trim()) {
      return { success: false, error: 'Skill name is required (unless end_inline_skill_session is true).' }
    }

    const result = await executeSkill(skillName, args, { invoker: 'model' })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    if (result.context === 'fork') {
      return {
        success: true,
        output:
          result.forkResult ||
          result.output ||
          `Skill "${skillName}" (fork) completed.`,
      }
    }

    return {
      success: true,
      output: formatInlineSkillInstructionsOutput(
        skillName,
        args,
        result.expandedPrompt || '',
      ),
      inlineSkillSession: result.inlineSkillSession,
    }
  },
})
