/**
 * Bundle JSON serialization: load, validate, normalize, compose prompts.
 *
 * Responsibilities:
 *   - Read a Bundle JSON file from disk, returning `{ ok, bundle }` or
 *     `{ ok: false, error }`. Never throws on malformed input.
 *   - Fill in sensible defaults for optional fields so downstream code
 *     can assume the normalized shape (tools/skills/mcp arrays present,
 *     `defaultAgent` resolvable, etc.).
 *   - Compose an agent's runtime system prompt from `promptSections` or
 *     `systemPromptRaw`, preserving backward compatibility with
 *     `BuiltInAgentDefinition.getSystemPrompt()`.
 *
 * Deliberately decoupled from Electron / filesystem helpers so this
 * module stays unit-testable. Disk IO is limited to `loadBundleFromFile`
 * which does the bare `fs.readFileSync` call; all validation is pure.
 */

import fs from 'node:fs'
import type {
  AgentBundleEntry,
  Bundle,
  BundleCapabilities,
  BundleExecutionPolicy,
  BundleMetadata,
  BundleSource,
  BundleVerificationPolicy,
  LayoutConfig,
  PromptSection,
  TeamTemplate,
  TeamTrigger,
} from './types'
import { isBundleLike } from './types'
import {
  sanitizeUntrustedText,
  summarizeFindings,
} from '../../security/sanitizeUntrustedText'

// ─── Loading ─────────────────────────────────────────────────────────

export interface LoadBundleOk {
  ok: true
  bundle: Bundle
  /** Absolute path the bundle was read from (for round-trip save). */
  source: string
}

export interface LoadBundleErr {
  ok: false
  source: string
  error: string
}

export type LoadBundleResult = LoadBundleOk | LoadBundleErr

export function loadBundleFromFile(filePath: string, sourceTier: BundleSource): LoadBundleResult {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch (e) {
    return {
      ok: false,
      source: filePath,
      error: `Failed to read bundle file: ${(e as Error).message}`,
    }
  }
  return parseBundle(raw, filePath, sourceTier)
}

/**
 * Parse + validate + normalize a bundle JSON string. Pure function.
 * Callers can use this to deserialize from imports (clipboard, drag-drop)
 * without hitting disk.
 */
export function parseBundle(
  raw: string,
  source: string,
  sourceTier: BundleSource,
): LoadBundleResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, source, error: `Invalid JSON: ${(e as Error).message}` }
  }

  if (!isBundleLike(parsed)) {
    return {
      ok: false,
      source,
      error: 'Bundle shape is invalid (missing meta / agents / teams / capabilities / layout / defaultAgent)',
    }
  }

  const normalized = normalizeBundle(parsed as Bundle, sourceTier)
  const valid = validateBundleSemantics(normalized)
  if (valid !== null) {
    return { ok: false, source, error: valid }
  }
  return { ok: true, bundle: normalized, source }
}

// ─── Normalization ───────────────────────────────────────────────────

function normalizeMeta(meta: BundleMetadata, sourceTier: BundleSource): BundleMetadata {
  const now = Date.now()
  return {
    id: String(meta.id).trim(),
    name: String(meta.name ?? meta.id).trim(),
    description: String(meta.description ?? '').trim(),
    icon: meta.icon,
    domain: meta.domain,
    author: meta.author,
    version: typeof meta.version === 'string' && meta.version.trim() ? meta.version : '0.0.0',
    createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : now,
    updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : now,
    // Caller's explicit `source` wins only when it names a writable tier;
    // preset JSONs on disk must never claim to be `user` or `project`.
    source: sourceTier,
  }
}

function normalizeCapabilities(cap: Partial<BundleCapabilities> | undefined): BundleCapabilities {
  const enabledTools = cap?.enabledTools
  const permissionDefaultMode =
    cap?.permissionDefaultMode === 'allow' ||
    cap?.permissionDefaultMode === 'ask' ||
    cap?.permissionDefaultMode === 'deny'
      ? cap.permissionDefaultMode
      : undefined
  const permissionRules = Array.isArray(cap?.permissionRules)
    ? (cap!.permissionRules as unknown[])
        .filter(
          (r): r is { pattern: string; mode: 'allow' | 'ask' | 'deny'; id?: string; shellPattern?: string; pathPattern?: string } =>
            r != null &&
            typeof r === 'object' &&
            typeof (r as Record<string, unknown>).pattern === 'string' &&
            ['allow', 'ask', 'deny'].includes((r as Record<string, unknown>).mode as string),
        )
        .map((r, idx) => ({
          id: typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `bundle-rule-${idx}`,
          pattern: r.pattern.trim(),
          mode: r.mode,
          ...(typeof r.shellPattern === 'string' && r.shellPattern.trim()
            ? { shellPattern: r.shellPattern.trim() }
            : {}),
          ...(typeof r.pathPattern === 'string' && r.pathPattern.trim()
            ? { pathPattern: r.pathPattern.trim() }
            : {}),
        }))
    : undefined
  return {
    enabledTools:
      enabledTools === '*' || enabledTools === undefined
        ? '*'
        : Array.isArray(enabledTools)
          ? enabledTools.filter((s) => typeof s === 'string' && s.length > 0)
          : '*',
    enabledSkills: Array.isArray(cap?.enabledSkills)
      ? (cap!.enabledSkills as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
    enabledMcpServers: Array.isArray(cap?.enabledMcpServers)
      ? (cap!.enabledMcpServers as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
    disallowedTools: Array.isArray(cap?.disallowedTools)
      ? (cap!.disallowedTools as unknown[]).filter((s): s is string => typeof s === 'string')
      : undefined,
    ...(permissionDefaultMode ? { permissionDefaultMode } : {}),
    ...(permissionRules ? { permissionRules } : {}),
    ...(typeof cap?.temperature === 'number' && Number.isFinite(cap.temperature)
      ? { temperature: Math.max(0, Math.min(2, cap.temperature)) }
      : {}),
    ...(typeof cap?.topP === 'number' && Number.isFinite(cap.topP)
      ? { topP: Math.max(0, Math.min(1, cap.topP)) }
      : {}),
  }
}

/**
 * Defensive normalization of the optional, additive {@link BundleExecutionPolicy}.
 * Returns `undefined` when absent or unparseable so downstream code can treat
 * "no policy" identically to a legacy bundle (host falls back to id-based
 * behaviour). Never throws on malformed input.
 */
function normalizeExecutionPolicy(
  input: BundleExecutionPolicy | undefined,
): BundleExecutionPolicy | undefined {
  if (!input || typeof input !== 'object') return undefined
  const out: BundleExecutionPolicy = {}

  const v = (input as { verification?: unknown }).verification as
    | Record<string, unknown>
    | undefined
  if (v && typeof v === 'object' && typeof v.kind === 'string') {
    let verification: BundleVerificationPolicy | undefined
    switch (v.kind) {
      case 'code':
        verification = { kind: 'code' }
        break
      case 'none':
        verification = { kind: 'none' }
        break
      case 'self-review': {
        const checklist = Array.isArray(v.checklist)
          ? (v.checklist as unknown[]).filter(
              (s): s is string => typeof s === 'string' && s.trim().length > 0,
            )
          : undefined
        verification =
          checklist && checklist.length > 0
            ? { kind: 'self-review', checklist }
            : { kind: 'self-review' }
        break
      }
      case 'delegate': {
        const agentType =
          typeof v.agentType === 'string' && v.agentType.trim().length > 0
            ? v.agentType.trim()
            : undefined
        // A delegate policy without a target agent is meaningless — drop it
        // so the host falls back rather than referencing a phantom agent.
        if (agentType) verification = { kind: 'delegate', agentType }
        break
      }
      default:
        verification = undefined
    }
    if (verification) out.verification = verification
  }

  const g = (input as { stepGranularity?: unknown }).stepGranularity
  if (g === 'fine' || g === 'coarse' || g === 'model-decides') {
    out.stepGranularity = g
  }

  return out.verification || out.stepGranularity ? out : undefined
}

function normalizeLayout(layout: LayoutConfig | undefined): LayoutConfig {
  if (!layout || typeof layout !== 'object') {
    return { type: 'chat-centric' }
  }
  return {
    type: layout.type ?? 'chat-centric',
    options: layout.options,
  }
}

/**
 * Strip hidden-Unicode prompt-injection payloads from a single LLM-bound
 * string. Accumulates findings into the shared bucket so the caller can
 * emit one summary line per import (avoid `console.warn`-spam per field).
 */
function sanitizeLlmFacingString(
  s: string,
  bucket: { totalStripped: number; findings: ReturnType<typeof sanitizeUntrustedText>['findings'] },
): string {
  if (typeof s !== 'string' || s.length === 0) return s
  const r = sanitizeUntrustedText(s)
  if (r.totalStripped === 0) return s
  bucket.totalStripped += r.totalStripped
  for (const f of r.findings) {
    const existing = bucket.findings.find((e) => e.category === f.category)
    if (existing) {
      existing.count += f.count
      for (const cp of f.codepoints) {
        if (!existing.codepoints.includes(cp) && existing.codepoints.length < 4) {
          existing.codepoints.push(cp)
        }
      }
    } else {
      bucket.findings.push({ ...f, codepoints: f.codepoints.slice() })
    }
  }
  return r.cleaned
}

function normalizePromptSections(
  sections: PromptSection[] | undefined,
  bucket: { totalStripped: number; findings: ReturnType<typeof sanitizeUntrustedText>['findings'] },
): PromptSection[] | undefined {
  if (!Array.isArray(sections) || sections.length === 0) return undefined
  return sections
    .filter((s): s is PromptSection => !!s && typeof s === 'object' && typeof s.id === 'string' && typeof s.body === 'string')
    .map((s, idx) => ({
      id: s.id,
      title: sanitizeLlmFacingString(typeof s.title === 'string' ? s.title : s.id, bucket),
      hint: typeof s.hint === 'string' ? sanitizeLlmFacingString(s.hint, bucket) : undefined,
      body: sanitizeLlmFacingString(s.body, bucket),
      order: typeof s.order === 'number' && Number.isFinite(s.order) ? s.order : idx,
      required: s.required === true,
    }))
    .sort((a, b) => a.order - b.order)
}

function normalizeAgent(
  agent: AgentBundleEntry,
  bucket: { totalStripped: number; findings: ReturnType<typeof sanitizeUntrustedText>['findings'] },
): AgentBundleEntry {
  return {
    ...agent,
    agentType: String(agent.agentType),
    whenToUse: sanitizeLlmFacingString(
      typeof agent.whenToUse === 'string' ? agent.whenToUse : '',
      bucket,
    ),
    displayName: typeof agent.displayName === 'string' ? agent.displayName : undefined,
    tagline: typeof agent.tagline === 'string' ? agent.tagline : undefined,
    isPrimary: agent.isPrimary === true,
    icon: typeof agent.icon === 'string' ? agent.icon : undefined,
    promptSections: normalizePromptSections(agent.promptSections, bucket),
    systemPromptRaw:
      typeof agent.systemPromptRaw === 'string'
        ? sanitizeLlmFacingString(agent.systemPromptRaw, bucket)
        : undefined,
    temperature:
      typeof agent.temperature === 'number' && Number.isFinite(agent.temperature)
        ? Math.max(0, Math.min(2, agent.temperature))
        : undefined,
    topP:
      typeof agent.topP === 'number' && Number.isFinite(agent.topP)
        ? Math.max(0, Math.min(1, agent.topP))
        : undefined,
  }
}

/** Defensive: only retain entries whose strings / numbers parse cleanly.
 *  Empty / all-undefined triggers are dropped so the matcher never has to
 *  guess between "absent" and "blank-but-present". */
function normalizeTriggers(input: unknown): TeamTrigger[] | undefined {
  if (!Array.isArray(input)) return undefined
  const cleaned: TeamTrigger[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const t: TeamTrigger = {}
    const stringArray = (v: unknown): string[] | undefined => {
      if (!Array.isArray(v)) return undefined
      const out = v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      return out.length > 0 ? out : undefined
    }
    const kw = stringArray(r.keywords)
    if (kw) t.keywords = kw
    const all = stringArray(r.allKeywords)
    if (all) t.allKeywords = all
    const re = stringArray(r.regex)
    if (re) t.regex = re
    const ex = stringArray(r.excludeKeywords)
    if (ex) t.excludeKeywords = ex
    if (typeof r.minConfidence === 'number' && Number.isFinite(r.minConfidence)) {
      t.minConfidence = r.minConfidence
    }
    // Skip purely-empty trigger objects so they don't sneak through as "any-match".
    if (
      t.keywords ||
      t.allKeywords ||
      t.regex ||
      t.excludeKeywords ||
      t.minConfidence !== undefined
    ) {
      cleaned.push(t)
    }
  }
  return cleaned.length > 0 ? cleaned : undefined
}

function normalizeTeam(team: TeamTemplate): TeamTemplate {
  const triggers = normalizeTriggers((team as { triggers?: unknown }).triggers)
  return {
    id: String(team.id),
    name: typeof team.name === 'string' ? team.name : String(team.id),
    description: typeof team.description === 'string' ? team.description : '',
    coordination: team.coordination ?? 'solo',
    members: Array.isArray(team.members)
      ? team.members
          .filter((m) => m && typeof m === 'object' && typeof m.agentType === 'string')
          .map((m) => ({
            agentType: String(m.agentType),
            role: typeof m.role === 'string' ? m.role : undefined,
            parallelGroup: typeof m.parallelGroup === 'number' ? m.parallelGroup : undefined,
          }))
      : [],
    ...(triggers ? { triggers } : {}),
  }
}

export function normalizeBundle(bundle: Bundle, sourceTier: BundleSource): Bundle {
  // Accumulate hidden-Unicode findings across every agent's prompt fields so
  // we emit ONE summary line per import rather than per agent / per field.
  const sanitizeBucket: {
    totalStripped: number
    findings: ReturnType<typeof sanitizeUntrustedText>['findings']
  } = { totalStripped: 0, findings: [] }
  const agents = (bundle.agents ?? []).map((a) => normalizeAgent(a, sanitizeBucket))
  if (sanitizeBucket.totalStripped > 0) {
    const id = bundle.meta?.id ?? '(unknown-id)'
    console.warn(
      `[bundle] Stripped ${sanitizeBucket.totalStripped} invisible Unicode char(s) from bundle "${id}": ${summarizeFindings(sanitizeBucket.findings)}`,
    )
  }
  // Guarantee exactly one primary, fallback to first agent or defaultAgent.
  const primaries = agents.filter((a) => a.isPrimary)
  if (primaries.length === 0 && agents.length > 0) {
    const preferredType = typeof bundle.defaultAgent === 'string' ? bundle.defaultAgent : agents[0].agentType
    const target = agents.find((a) => a.agentType === preferredType) ?? agents[0]
    target.isPrimary = true
  } else if (primaries.length > 1) {
    // Keep the first, demote the rest — deterministic.
    for (let i = 1; i < primaries.length; i++) primaries[i].isPrimary = false
  }

  const defaultAgent =
    typeof bundle.defaultAgent === 'string' && agents.some((a) => a.agentType === bundle.defaultAgent)
      ? bundle.defaultAgent
      : (agents.find((a) => a.isPrimary)?.agentType ?? agents[0]?.agentType ?? '')

  return {
    meta: normalizeMeta(bundle.meta, sourceTier),
    agents,
    teams: (bundle.teams ?? []).map(normalizeTeam),
    defaultAgent,
    capabilities: normalizeCapabilities(bundle.capabilities),
    ...(normalizeExecutionPolicy(bundle.executionPolicy)
      ? { executionPolicy: normalizeExecutionPolicy(bundle.executionPolicy) }
      : {}),
    layout: normalizeLayout(bundle.layout),
    initialContext: typeof bundle.initialContext === 'string' ? bundle.initialContext : undefined,
    welcomeMessage: typeof bundle.welcomeMessage === 'string' ? bundle.welcomeMessage : undefined,
  }
}

// ─── Semantic validation ─────────────────────────────────────────────

/** Returns a human-readable error message, or `null` when valid. */
export function validateBundleSemantics(bundle: Bundle): string | null {
  if (!bundle.meta.id || bundle.meta.id.trim().length === 0) {
    return 'Bundle meta.id must be a non-empty string'
  }
  if (bundle.agents.length === 0) {
    return `Bundle "${bundle.meta.id}" has no agents`
  }
  // defaultAgent must reference an existing agent.
  if (!bundle.agents.some((a) => a.agentType === bundle.defaultAgent)) {
    return `Bundle "${bundle.meta.id}" defaultAgent "${bundle.defaultAgent}" does not match any agent`
  }
  // Agent types must be unique within a bundle (otherwise registry merge
  // becomes ambiguous).
  const seen = new Set<string>()
  for (const a of bundle.agents) {
    if (seen.has(a.agentType)) {
      return `Bundle "${bundle.meta.id}" has duplicate agentType "${a.agentType}"`
    }
    seen.add(a.agentType)
  }
  // Team members must reference existing agents.
  for (const team of bundle.teams) {
    for (const member of team.members) {
      if (!seen.has(member.agentType)) {
        return `Bundle "${bundle.meta.id}" team "${team.id}" references unknown agent "${member.agentType}"`
      }
    }
  }
  return null
}

// ─── Prompt composition ──────────────────────────────────────────────

/**
 * Render an agent's runtime system prompt. Resolution order:
 *   1. `promptSections` (sorted by order; concatenated with double
 *      newlines between sections, `## <title>` headers for non-body-
 *      only renders).
 *   2. `systemPromptRaw` if present.
 *   3. Fallback `getSystemPrompt()` closure when the entry is a
 *      built-in agent (caller passes the function).
 *   4. Empty string.
 *
 * The built-in closure is accepted via param rather than imported so
 * this module stays cycle-free with `builtInAgents.ts`.
 */
export function composeSystemPrompt(
  agent: AgentBundleEntry,
  builtInFallback?: () => string,
): string {
  if (agent.promptSections && agent.promptSections.length > 0) {
    return agent.promptSections
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((s) => (s.title && s.title.trim().length > 0 ? `## ${s.title}\n\n${s.body}` : s.body))
      .join('\n\n')
      .trim()
  }
  if (typeof agent.systemPromptRaw === 'string' && agent.systemPromptRaw.trim().length > 0) {
    return agent.systemPromptRaw
  }
  if (builtInFallback) {
    try {
      return builtInFallback()
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * Migration helper — split a legacy single-string prompt into structured
 * sections by `## <title>` markdown headers. When no headers are found,
 * the whole string becomes a single "role" section. Used by the
 * Workbench "make editable" action.
 */
export function splitPromptIntoSections(raw: string): PromptSection[] {
  const text = raw.trim()
  if (text.length === 0) return []
  // Split on lines that start with `## ` (not `### ` or deeper).
  const lines = text.split(/\r?\n/)
  const sections: PromptSection[] = []
  let currentTitle: string | null = null
  let currentBody: string[] = []

  const flush = () => {
    const body = currentBody.join('\n').trim()
    if (currentTitle === null && body.length === 0) return
    const order = sections.length
    const id = currentTitle
      ? currentTitle
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
      : 'role'
    sections.push({
      id: id || `section_${order}`,
      title: currentTitle ?? 'Role',
      body,
      order,
    })
  }

  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m) {
      flush()
      currentTitle = m[1]
      currentBody = []
      continue
    }
    currentBody.push(line)
  }
  flush()
  return sections
}
