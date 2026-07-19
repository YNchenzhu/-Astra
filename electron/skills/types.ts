/**
 * Skill system type definitions (IDE-compatible).
 *
 * Skills can be:
 *   - Auto-invoked by the Agent (default) — Agent sees skill descriptions
 *     and decides when they're relevant based on context.
 *   - Manual-only (disable-model-invocation: true) — Only triggered via
 *     /skillName or @skillName by the user.
 *
 * Directory layout (per skill):
 *   SKILL.md          — Required. YAML frontmatter + prompt body.
 *   hooks.json        — Optional. Declarative lifecycle hooks (see skillHookManifest.ts).
 *   scripts/          — Optional. Executable scripts the skill can reference.
 *   references/       — Optional. Reference docs injected into skill context.
 *   assets/           — Optional. Static assets the skill can use.
 */

import type { HookEvent, HookExecutionKind } from '../tools/hooks/types'

/** Where the skill was loaded from */
export type SkillSource = 'bundled' | 'project' | 'user'

/** How the skill executes */
export type SkillContext = 'inline' | 'fork'

/**
 * A fully resolved skill definition ready for execution.
 * Created by the loader from SKILL.md files or by bundledSkills directly.
 */
export interface SkillDefinition {
  /** Unique skill name (e.g. "commit", "review-pr"). Must match parent folder name for file-based skills. */
  name: string
  /** Human-readable description shown in UI and to AI for auto-invocation decisions */
  description: string
  /** Where this skill was loaded from */
  source: SkillSource
  /** Whether the user can invoke this via / or @ (default true) */
  userInvocable: boolean
  /**
   * If false (default), the Agent can automatically decide to use this skill
   * based on context. If true, the skill is only triggered by explicit user
   * invocation (/skillName or @skillName).
   */
  disableModelInvocation: boolean
  /** Execution mode: inline = inject prompt into current context, fork = run in sub-agent */
  context: SkillContext
  /** Restrict which tools the skill's AI can use */
  allowedTools?: string[]
  /** Override the model used for this skill */
  model?: string
  /** Override the effort level */
  effort?: string
  /** Hint text for arguments, e.g. "<message>" */
  argumentHint?: string
  /** The resolved file path (for deduplication) */
  resolvedPath?: string
  /**
   * Which of the seven filesystem scan roots produced this skill (1–7, see loader).
   * Bundled skills omit this.
   */
  originSlot?: number
  /** Top-level YAML frontmatter keys declared in SKILL.md (for SAFE_SKILL_PROPERTIES gate). */
  frontmatterKeys?: string[]
  /** The prompt template body with $ARGUMENTS placeholders */
  promptContent: string
  /** Optional: license information */
  license?: string
  /** Optional: compatibility string (e.g. "upstream >= 1.0") */
  compatibility?: string
  /** Optional: arbitrary metadata from frontmatter */
  metadata?: Record<string, unknown>
  /**
   * Gitignore-style path patterns for conditional activation.
   * Skills with paths are stored and only activated when a matching file is operated on.
   */
  paths?: string[]
  /**
   * Detailed auto-invocation trigger description (used by skillDiscovery for ranking).
   */
  whenToUse?: string
  /** Skill version string from frontmatter */
  version?: string
  /** Named argument definitions for ${arg_name} substitution */
  argumentNames?: string[]
  /**
   * Filenames present in the `scripts/` subdirectory (no body content).
   *
   * Self-audit fix B2 (2026-05) — we used to slurp every script's body
   * into a `Record<string, string>` at load time, which kept hundreds of
   * KB resident per workspace. upstream never pre-loads bodies; the model
   * uses `read_file` / `glob` against `${CLAUDE_SKILL_DIR}/scripts` when
   * it needs them. We surface the filename list so the model still
   * knows what's available without paying the RAM cost.
   */
  scripts?: string[]
  /**
   * Filenames present in the `references/` subdirectory (no body content).
   * See `scripts` for the rationale.
   */
  references?: string[]
  /**
   * Skill-resource attention uplift (2026-07) — bounded one-line hint per
   * reference file (first heading / first prose line, ≤
   * `REFERENCE_HINT_MAX_CHARS`). The bare filename list gave the model no
   * signal about WHAT a reference contains, so it rarely chose to read
   * one; the hint restores selection signal WITHOUT violating the B2
   * "bodies stay on disk" contract. Keyed by filename; files whose head
   * yields no usable text are absent.
   */
  referenceHints?: Record<string, string>
  /**
   * Modular-router skills (2026-07) — doc files (.md/.txt) found in
   * NON-standard first-level subdirectories (e.g. `common/`, `modules/`
   * in bidding-writer-pro-style skills that route via relative paths in
   * the SKILL.md body instead of using `references/`). `relPath` is
   * forward-slash relative to the skill base directory
   * (`common/00-xxx.md`); `hint` follows the same head-extraction rules
   * as {@link referenceHints}. Bodies stay on disk (B2 contract). Capped
   * at `MAX_RESOURCE_DOCS`; absent when the skill has no such subdirs.
   */
  resourceDocs?: Array<{ relPath: string; hint?: string }>
  /** Asset file paths from assets/ subdirectory */
  assets?: string[]
  /**
   * Lifecycle hooks for this skill (from hooks.json and/or frontmatter `hooks` JSON).
   * Registered at load time into the skill hook registry; merged into the global hook engine.
   */
  hooks?: SkillHookSpec[]
}

/** Matcher for when a skill hook runs (optional). */
export interface SkillHookMatcher {
  workspacePattern?: string
  /** Glob-style: * matches any substring; compared to CLAUDE_TOOL_NAME */
  toolPattern?: string
}

/**
 * Declarative hook: `command` runs in the skill directory (like hooks.json).
 * Programmatic: `handler` only for bundled / in-code definitions.
 */
export interface SkillHookSpec {
  event: HookEvent | string
  matcher?: SkillHookMatcher
  command?: string
  handler?: (ctx: SkillHookContext) => Promise<SkillHookDecision | null>
  async?: boolean
  asyncRewake?: boolean
  timeoutMs?: number
  /** upstream §9.2 — `http` treats `command` as URL. */
  executionKind?: HookExecutionKind
}

/** Context passed to programmatic skill hooks and used to build env for command hooks. */
export interface SkillHookContext {
  skillName: string
  skillContext: 'inline' | 'fork'
  argumentsStr: string
  cwd?: string
  toolName?: string
  toolInput?: Record<string, unknown>
}

/** Result from a programmatic hook handler (mapped to HookResponse in the engine). */
export interface SkillHookDecision {
  continue?: boolean
  reason?: string
  permissionDecision?: 'allow' | 'deny' | 'ask'
  decision?: 'allow' | 'deny' | 'ask'
  updatedInput?: Record<string, unknown>
  preventContinuation?: boolean
  additionalContext?: string
  systemMessage?: string
}

/** Lightweight info sent to the renderer for the slash-command / @ popup */
export interface SkillInfo {
  name: string
  description: string
  argumentHint?: string
  source: SkillSource
  /** Whether this skill requires explicit user invocation */
  disableModelInvocation: boolean
}

/** Result returned when executing a skill */
export interface SkillExecuteResult {
  success: boolean
  output?: string
  error?: string
  /** For inline mode: the expanded prompt to inject */
  expandedPrompt?: string
  /** For fork mode: the sub-agent's final result */
  forkResult?: string
  /** Execution context used */
  context: SkillContext
  /**
   * Inline only: applied by the agentic loop for subsequent iterations (allowedTools + model).
   */
  inlineSkillSession?: {
    /** Set when a Skill tool run opens an inline session — used for skill-scoped PreToolUse hooks */
    skillName?: string
    allowedTools?: string[]
    model?: string
    effort?: 'low' | 'medium' | 'high' | 'max'
  }
}

export type SkillInvoker = 'model' | 'user'

/**
 * Skill context snippet injected into the Agent's system prompt
 * for auto-invocation. Only includes skills where disableModelInvocation is false.
 */
export interface SkillAgentContext {
  name: string
  description: string
  argumentHint?: string
  /** Full prompt template with $ARGUMENTS placeholders */
  promptContent: string
  /** Available tools */
  allowedTools?: string[]
  /** Reference filenames (read on demand via read_file, see B2 in types.ts). */
  references?: string[]
  /** Script filenames (read on demand via read_file). */
  scripts?: string[]
  /** Auto-invocation trigger description */
  whenToUse?: string
}
