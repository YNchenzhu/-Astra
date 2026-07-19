/**
 * Bundle type system.
 *
 * A `Bundle` is an industry/domain-scoped "workspace configuration":
 * a set of agents + team templates + allowed tools/skills/MCP + layout
 * preference, packaged as a switchable unit. See Plan §4.5.10.1.
 *
 * Design invariants (Plan §6.5.7):
 *   - We reuse `AgentDefinition` from `../types` as the base shape —
 *     every AgentBundleEntry IS an AgentDefinition plus a few UI hints.
 *     Adding a `promptSections?` optional field is the ONLY extension
 *     to the prompt storage model; existing `getSystemPrompt()` agents
 *     remain fully compatible.
 *   - Bundle schema itself is additive-only. Future versions must not
 *     rename or delete fields; instead add new optional ones.
 *   - No runtime dependency on Electron / React — these types are
 *     shared between main and renderer.
 */

import type { AgentDefinition } from '../types'

// ─── Prompt structure ────────────────────────────────────────────────

/**
 * A labelled section of an agent's system prompt, kept separately so
 * the Workbench UI can show each piece in its own textarea with a
 * title and docstring. When the agent runs, sections are concatenated
 * in order (see `composeSystemPromptFromSections` in bundleSerialize).
 *
 * Built-in agents may initially supply `promptSections = undefined`
 * and keep using their original single-string prompt. The editor
 * offers a one-click "split by `##` headers" action that migrates
 * the blob into structured sections when the user wants to edit.
 */
export interface PromptSection {
  id: string
  /** Human-readable label shown in the Workbench editor header. */
  title: string
  /** Short explainer below the title (plain text, optional). */
  hint?: string
  /** Markdown / plain text body. */
  body: string
  /** Ordering key — lower renders first. */
  order: number
  /** When true, the section is part of the built-in template
   *  (e.g. "Role", "Strengths", "Guidelines") and cannot be deleted
   *  through the UI; only its body may be edited. */
  required?: boolean
}

/**
 * Canonical section ids for the built-in template. Keep in sync with
 * the split logic in bundleSerialize. Custom sections can use any
 * non-reserved id.
 */
export const BUILTIN_PROMPT_SECTION_IDS = [
  'role',
  'strengths',
  'guidelines',
  'constraints',
  'iteration_budget',
  'report_format',
] as const
export type BuiltinPromptSectionId = typeof BUILTIN_PROMPT_SECTION_IDS[number]

// ─── Agent entry inside a Bundle ─────────────────────────────────────

/**
 * An agent as stored inside a Bundle. Extends the universal
 * `AgentDefinition` with bundle-only UI hints and optional structured
 * prompt storage. When loaded into the running agent registry, only
 * the `AgentDefinition` subset is visible to the orchestration layer.
 */
export interface AgentBundleEntry extends AgentDefinition {
  /** User-facing display name shown in the Workbench and Persona
   *  selector. Falls back to `agentType` when absent. */
  displayName?: string

  /** Short capability tagline shown alongside `whenToUse`. Rendered
   *  in the agent list; deliberately terse (≤60 chars). */
  tagline?: string

  /** When true, this agent is the Bundle's "primary" — shown first in
   *  the persona selector and used as default on activation. Exactly
   *  one agent per Bundle should have this set; the loader normalises
   *  violations. */
  isPrimary?: boolean

  /** Lucide icon name or inline SVG/PNG data URI. */
  icon?: string

  /**
   * Structured prompt sections. When present, the running prompt is
   * composed from these (in `order`); when absent, callers fall back
   * to the built-in `getSystemPrompt()` blob — preserves compatibility
   * with `electron/agents/builtInAgents.ts`.
   */
  promptSections?: PromptSection[]

  /**
   * Raw system prompt string — used when this entry represents a
   * Bundle-level user-defined agent (i.e. no built-in `getSystemPrompt`
   * closure). Exactly one of `promptSections` / `systemPromptRaw` is
   * required for user-defined agents; built-ins may leave both empty.
   */
  systemPromptRaw?: string
}

// ─── Team templates ──────────────────────────────────────────────────

export type TeamCoordination =
  /** A single agent runs solo — the Bundle's default. */
  | 'solo'
  /** All members run concurrently, outputs merged in order of return. */
  | 'parallel'
  /** Members run in a pipeline; each stage receives the prior's output. */
  | 'sequential'
  /** Swarm with a multiplexer dispatching work between peers. */
  | 'swarm'
  /** One coordinator delegates to the others, ala `COORDINATOR_AGENT`. */
  | 'coordinator'

export interface TeamMember {
  /** References `AgentBundleEntry.agentType` of a bundle agent. */
  agentType: string
  /**
   * Free-form role label shown in UI (e.g. 'coordinator', 'reviewer',
   * 'worker'). Also available to prompt templates as `{{role}}`.
   */
  role?: string
  /**
   * Sequential-mode only: stage index. Members within the same stage
   * run in parallel; higher stages wait for lower ones to finish.
   */
  parallelGroup?: number
}

/**
 * Optional explicit trigger rule for a `TeamTemplate`. When present, the
 * `teamTriggerMatcher` evaluates these rules **before** the implicit
 * token-overlap heuristic — they are the bundle author's authoritative
 * statement of "when does this template apply".
 *
 * A template may declare multiple trigger rules; the matcher takes the
 * highest-scoring one.
 *
 * Field semantics (all optional, all combined per-rule with AND semantics):
 *   - `keywords`: ANY of these strings appearing in the user message
 *     contributes a hit per match. Case-insensitive substring match.
 *   - `allKeywords`: ALL of these strings must appear, otherwise the rule
 *     scores 0 even if other fields match. Useful for "only when both X
 *     and Y are mentioned".
 *   - `regex`: ANY of these regular expressions matches the user message.
 *     Strings; compiled with `i` flag. Invalid patterns are silently
 *     skipped (logged once at compile).
 *   - `excludeKeywords`: ANY of these strings appearing in the user
 *     message vetoes the rule (score forced to 0). Useful for narrow
 *     scoping ("about contracts, but NOT about contract management").
 *   - `minConfidence`: minimum total score required for this rule to be
 *     considered a hit. Defaults to 1 (any positive score wins).
 */
export interface TeamTrigger {
  keywords?: string[]
  allKeywords?: string[]
  regex?: string[]
  excludeKeywords?: string[]
  minConfidence?: number
}

export interface TeamTemplate {
  id: string
  name: string
  description: string
  coordination: TeamCoordination
  members: TeamMember[]
  /**
   * Optional bundle-author-provided rules for when this template should
   * be auto-suggested to the LLM. When omitted, the matcher falls back to
   * an implicit token-overlap heuristic over `id`/`name`/`description`/
   * member roles. See {@link TeamTrigger}.
   */
  triggers?: TeamTrigger[]
}

// ─── Layout configuration ────────────────────────────────────────────

export type LayoutType =
  | 'chat-centric'
  | 'document-centric'
  | 'data-centric'
  | 'dashboard'
  /**
   * Special: preserves the legacy IDE shell (Explorer + Monaco + Terminal
   * + right ChatPanel) for the `code-dev` bundle. This is the only
   * layout that directly reuses the pre-Bundle UI, making the Code
   * Bundle bit-for-bit equivalent to the pre-refactor app (§6.5.1).
   */
  | 'code-workspace'

export interface LayoutOptions {
  /** Which sidebar content to render. */
  sidebar?: 'files' | 'outline' | 'tags' | 'datasets' | 'projects' | 'custom' | 'none'
  /** Which secondary pane to render (right / bottom depending on layout). */
  secondaryPane?: 'chat' | 'preview' | 'memory' | 'none'
  /** Which top-bar content to include. */
  topBar?: 'bundle-selector' | 'agent-selector' | 'breadcrumbs' | 'none'
  /** Free-form hints consumed by specific layouts (e.g. dashboard widget ids). */
  widgets?: string[]
}

export interface LayoutConfig {
  type: LayoutType
  options?: LayoutOptions
}

// ─── Bundle root ─────────────────────────────────────────────────────

export type BundleSource = 'preset' | 'user' | 'project' | 'imported'

export interface BundleMetadata {
  id: string
  name: string
  description: string
  icon?: string
  /** Industry tag shown in the Bundle gallery (e.g. "编程", "法律", "医疗"). */
  domain?: string
  author?: string
  /** Semver string — used by the import/export flow to reject
   *  incompatible future versions. Missing is treated as '0.0.0'. */
  version: string
  createdAt: number
  updatedAt: number
  source: BundleSource
}

export interface BundleCapabilities {
  /** Tool name whitelist, or `'*'` for all registered tools. */
  enabledTools: string[] | '*'
  /** Skill ids that will be preloaded for agents in this bundle. */
  enabledSkills: string[]
  /** MCP server names that will be connected while this bundle is active. */
  enabledMcpServers: string[]
  /** Explicit deny — highest priority. */
  disallowedTools?: string[]
  /**
   * Bundle-level default permission mode for tool calls.
   * Overrides the global settings default for all agents in this bundle.
   */
  permissionDefaultMode?: 'allow' | 'ask' | 'deny'
  /**
   * Bundle-level permission rules (pattern → allow/ask/deny).
   * Applied on top of agent-level rules; first matching rule wins.
   */
  permissionRules?: Array<{
    id: string
    pattern: string
    mode: 'allow' | 'ask' | 'deny'
    shellPattern?: string
    pathPattern?: string
  }>
  /** Bundle-level default sampling temperature. Agents may override. */
  temperature?: number
  /** Bundle-level default nucleus sampling top-p. Agents may override. */
  topP?: number
}

// ─── Execution policy (domain-neutral granularity / verification) ────

/**
 * What "verifying a unit of work" means for THIS work package. The host
 * verification gate and the task-routing delivery gate consume this so the
 * "verify before you claim done" discipline applies to every bundle —
 * coding, writing, legal, etc. — instead of being hard-wired to the
 * `code-dev` bundle.
 *
 *   - `code`        — build / tests / typecheck / lint (the code-dev default).
 *   - `none`        — no host-enforced verification (model self-governs via
 *                     its own prompt). The historical default for non-coding.
 *   - `self-review` — the agent must re-read / check its own output against an
 *                     optional checklist before declaring done (e.g. tone /
 *                     consistency / fact pass for writing).
 *   - `delegate`    — verification is delegated to a named reviewer agent that
 *                     exists in this bundle's `agents` (e.g. a "Reviewer").
 */
export type BundleVerificationPolicy =
  | { kind: 'code' }
  | { kind: 'none' }
  | { kind: 'self-review'; checklist?: string[] }
  | { kind: 'delegate'; agentType: string }

/**
 * Optional, additive per-bundle execution policy. Absent on every legacy
 * bundle — the host falls back to the historical id-based behaviour when it
 * is missing, so adding this field changes nothing until a bundle opts in.
 */
export interface BundleExecutionPolicy {
  /** How this work package verifies a finished unit of work. */
  verification?: BundleVerificationPolicy
  /**
   * Desired execution granularity hint for the host step driver.
   * `model-decides` (default) preserves today's "model owns step size".
   * `fine` asks the host to drive smaller, one-step-at-a-time progress;
   * `coarse` lets the model batch larger units.
   */
  stepGranularity?: 'fine' | 'coarse' | 'model-decides'
}

export interface Bundle {
  // Metadata
  meta: BundleMetadata

  // Agents and teams
  agents: AgentBundleEntry[]
  teams: TeamTemplate[]
  /** `agentType` of the bundle's default agent. Must reference an entry in `agents`. */
  defaultAgent: string

  // Capability surface
  capabilities: BundleCapabilities

  /**
   * Optional execution policy (verification semantics + granularity hint).
   * Additive: when omitted the host uses behaviour-preserving fallbacks.
   */
  executionPolicy?: BundleExecutionPolicy

  // UI
  layout: LayoutConfig

  // Runtime hints
  /** Injected as system context on activation — use for industry
   *  background ("You are operating inside a legal-compliance workspace."). */
  initialContext?: string
  /** Displayed on first entry to this bundle; plain text. */
  welcomeMessage?: string
}

// ─── Runtime helpers ─────────────────────────────────────────────────

/** Narrow type guard for runtime validation after JSON.parse. */
export function isBundleLike(value: unknown): value is Bundle {
  if (!value || typeof value !== 'object') return false
  const b = value as Partial<Bundle>
  return (
    !!b.meta &&
    typeof b.meta === 'object' &&
    typeof (b.meta as BundleMetadata).id === 'string' &&
    Array.isArray(b.agents) &&
    Array.isArray(b.teams) &&
    typeof b.defaultAgent === 'string' &&
    !!b.capabilities &&
    !!b.layout
  )
}

/** Canonical Bundle id for the preset code-dev bundle. Used across
 *  main.ts / IPC handlers / migration code; centralised here to
 *  avoid string typos. */
export const CODE_DEV_BUNDLE_ID = 'code-dev' as const
