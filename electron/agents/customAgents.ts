/**
 * Custom agent loader — loads agents from Markdown and JSON files.
 *
 * Scans directories for agent definition files:
 * - `{workspace}/.claude/agents/*.md` — project-level agents
 * - `{userData}/agents/*.md` — user-level agents
 *
 * Markdown format:
 * ```markdown
 * ---
 * name: code-reviewer
 * description: Review code for quality
 * tools:
 *   - read_file
 *   - glob
 * model: inherit
 * mcpServers:
 *   - my-filesystem
 * hooks: '[{"event":"PreToolUse","matcher":"Read","command":"node ./scripts/agent-hook.js"}]'
 * ---
 * You are a code review specialist...
 * ```
 *
 * JSON format (`agents.json`): each value must satisfy {@link safeParseCustomAgentJsonRecord} / `agentJsonRecordZod`.
 * Invalid entries are **skipped** (with `console.warn`). Set `ASTRA_LEGACY_AGENT_JSON=1` to fall back to the
 * former loose parser when Zod rejects a record.
 *
 * ```json
 * {
 *   "code-reviewer": {
 *     "description": "...",
 *     "tools": ["read_file"],
 *     "prompt": "..."
 *   }
 * }
 * ```
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { normalizeToolsList } from './normalizeToolLists'
import { parseMcpServersFromUnknown } from './normalizeAgentMcpServers'
import type { CustomAgentDefinition } from './types'
import { parseAgentHooksField } from './agentHooksField'
import { safeParseCustomAgentJsonRecord } from './agentDefinitionSchema'
import { sanitizeUntrustedText, summarizeFindings } from '../security/sanitizeUntrustedText'

export { parseAgentHooksField } from './agentHooksField'

function envTruthy(v: string | undefined): boolean {
  if (!v) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes'
}

/**
 * When set (`1` / `true` / `yes`), {@link parseAgentFromJson} falls back to pre-Zod loose parsing if Zod fails.
 * Default: **strict Zod only** (invalid entries are skipped).
 */
export function isLegacyAgentJsonLoaderEnabled(): boolean {
  return envTruthy(process.env.ASTRA_LEGACY_AGENT_JSON)
}

function parseAgentFromJsonLegacy(
  name: string,
  definition: Record<string, unknown>,
): CustomAgentDefinition | null {
  const description = definition.description
  if (!description || typeof description !== 'string') return null

  const prompt = definition.prompt
  if (!prompt || typeof prompt !== 'string') return null

  const tools = normalizeToolsList(definition.tools)
  const disallowedTools = normalizeToolsList(definition.disallowedTools)

  const model = typeof definition.model === 'string' ? definition.model : 'inherit'
  const maxTurns = typeof definition.maxTurns === 'number' ? definition.maxTurns : undefined
  const timeout = typeof definition.timeout === 'number' ? definition.timeout : undefined
  const thinkingBudgetTokens =
    typeof definition.thinkingBudgetTokens === 'number' ? definition.thinkingBudgetTokens : undefined

  const mcpServers = parseMcpServersFromUnknown(definition.mcpServers)
  const hooksRaw = definition.hooks
  const agentHooks =
    typeof hooksRaw === 'string'
      ? parseAgentHooksField(hooksRaw)
      : Array.isArray(hooksRaw)
        ? parseAgentHooksField(JSON.stringify(hooksRaw))
        : undefined

  return {
    agentType: name,
    whenToUse: description,
    tools,
    disallowedTools,
    model,
    maxTurns,
    timeout,
    thinkingBudgetTokens,
    mcpServers,
    agentHooks,
    source: 'custom',
    getSystemPrompt: () => prompt,
  }
}

/**
 * snake_case / legacy YAML keys → {@link agentJsonRecordZod} 字段（upstream 报告 §2.2 frontmatter）。
 */
const AGENT_FRONTMATTER_KEY_ALIASES: Record<string, string> = {
  max_turns: 'maxTurns',
  disallowed_tools: 'disallowedTools',
  mcp_servers: 'mcpServers',
  thinking_budget_tokens: 'thinkingBudgetTokens',
  max_token_budget: 'maxTokenBudget',
  parent_policy: 'parentPolicy',
  coordinator_phase: 'coordinatorPhase',
  subagent_tool_profile: 'subagentToolProfile',
  orchestration_role: 'orchestrationRole',
  critical_reminder: 'criticalReminder',
  initial_prompt: 'initialPrompt',
  omit_claude_md: 'omitClaudeMd',
  is_read_only: 'isReadOnly',
  permission_mode: 'permissionMode',
  agent_hooks: 'hooks',
}

export function applyAgentFrontmatterKeyAliases(map: Record<string, unknown>): Record<string, unknown> {
  const out = { ...map }
  for (const [snake, camel] of Object.entries(AGENT_FRONTMATTER_KEY_ALIASES)) {
    if (out[camel] === undefined && out[snake] !== undefined) {
      out[camel] = out[snake]
    }
    delete out[snake]
  }
  return out
}

/**
 * Parse a Markdown file into an agent definition.
 * Frontmatter + body 经 {@link safeParseCustomAgentJsonRecord} / `agentJsonRecordZod` 校验（AC-2.5）。
 */
export function parseAgentFromMarkdown(
  filePath: string,
  content: string
): CustomAgentDefinition | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!frontmatterMatch) return null

  const frontmatterStr = frontmatterMatch[1]
  const body = frontmatterMatch[2].trim()
  if (!body) return null

  const yamlMap = parseSimpleYaml(frontmatterStr)
  const m = applyAgentFrontmatterKeyAliases(yamlMap)
  const nameRaw = m.name
  const agentType = typeof nameRaw === 'string' ? nameRaw.trim() : ''
  if (!agentType) return null

  const { name: _drop, ...rest } = m
  const record: Record<string, unknown> = { ...rest, prompt: body }

  const z = safeParseCustomAgentJsonRecord(agentType, record)
  if (!z.ok) {
    console.warn(`[customAgents] ${filePath}: Zod rejected agent frontmatter — ${z.error}`)
    return null
  }

  return {
    ...z.def,
    filename: path.basename(filePath, '.md'),
  }
}

export type ParseAgentFromJsonOptions = {
  /** e.g. absolute path to `agents.json` (for logs). */
  jsonFilePath?: string
}

/**
 * Parse one entry from `agents.json`. **Zod-only by default**; set `ASTRA_LEGACY_AGENT_JSON=1` to allow
 * the former loose parser when Zod rejects the record.
 */
export function parseAgentFromJson(
  name: string,
  definition: Record<string, unknown>,
  options?: ParseAgentFromJsonOptions,
): CustomAgentDefinition | null {
  const zod = safeParseCustomAgentJsonRecord(name, definition)
  if (zod.ok) return zod.def

  const loc = options?.jsonFilePath ? `${options.jsonFilePath} → "${name}"` : `"${name}"`
  if (isLegacyAgentJsonLoaderEnabled()) {
    console.warn(
      `[customAgents] Zod rejected ${loc} — using legacy JSON parse (ASTRA_LEGACY_AGENT_JSON): ${zod.error}`,
    )
    return parseAgentFromJsonLegacy(name, definition)
  }

  console.warn(`[customAgents] Zod rejected ${loc} — entry skipped: ${zod.error}`)
  return null
}

/**
 * Load custom agents from a directory.
 * Supports both .md files and agents.json.
 */
export function loadCustomAgentsFromDir(dirPath: string): CustomAgentDefinition[] {
  const agents: CustomAgentDefinition[] = []

  if (!fs.existsSync(dirPath)) return agents

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isFile()) {
        const fullPath = path.join(dirPath, entry.name)

        if (entry.name.endsWith('.md')) {
          try {
            const raw = fs.readFileSync(fullPath, 'utf-8')
            // Custom agents in `.claude/agents/` and `.cursor/agents/` are
            // user / community supplied. Their markdown body becomes the
            // agent's system prompt verbatim — the prime target for hidden
            // Unicode prompt-injection (Tag chars, Bidi-reorder, ZW). Strip
            // the high-risk subset at the file-read boundary; YAML / Markdown
            // parsers downstream don't need those chars and never legitimately
            // produce them. See `electron/security/sanitizeUntrustedText.ts`.
            const sanitized = sanitizeUntrustedText(raw)
            if (sanitized.findings.length > 0) {
              console.warn(
                `[customAgents] Stripped ${sanitized.totalStripped} invisible Unicode char(s) from ${fullPath}: ${summarizeFindings(sanitized.findings)}`,
              )
            }
            const agent = parseAgentFromMarkdown(fullPath, sanitized.cleaned)
            if (agent) agents.push(agent)
          } catch {
            // Skip unreadable files
          }
        } else if (entry.name === 'agents.json') {
          try {
            const raw = fs.readFileSync(fullPath, 'utf-8')
            const sanitized = sanitizeUntrustedText(raw)
            if (sanitized.findings.length > 0) {
              console.warn(
                `[customAgents] Stripped ${sanitized.totalStripped} invisible Unicode char(s) from ${fullPath}: ${summarizeFindings(sanitized.findings)}`,
              )
            }
            const data = JSON.parse(sanitized.cleaned)
            for (const [name, def] of Object.entries(data)) {
              const agent = parseAgentFromJson(name, def as Record<string, unknown>, {
                jsonFilePath: fullPath,
              })
              if (agent) agents.push(agent)
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }
    }
  } catch {
    // Skip unreadable directories
  }

  return agents
}

/**
 * Project-level agent directories scanned, in precedence order (later entries
 * override earlier ones when two files declare the same `agentType`).
 *
 * The primary `.claude/agents/` layout matches upstream. We
 * additionally scan `.cursor/agents/` for the IDE ecosystem parity — many
 * community agents ship as the IDE "custom agents" files, and users frequently
 * port them to our runtime. Keeping both paths on the scan list means users
 * don't have to duplicate or symlink files.
 *
 * @see https://code.claude.com/docs/en/agent-sdk/subagents#creating-subagents
 * @see https://cursor.com/blog/agent-best-practices
 */
export const PROJECT_AGENT_DIR_RELATIVE_PATHS: readonly string[] = Object.freeze([
  path.join('.claude', 'agents'),
  path.join('.cursor', 'agents'),
])

/** Project + optional `.agents` storage (upstream project-level). */
export function loadProjectScopedAgents(
  workspacePath?: string,
  agentStoragePath?: string,
  userDataPath?: string,
): CustomAgentDefinition[] {
  const agents: CustomAgentDefinition[] = []
  if (workspacePath) {
    for (const rel of PROJECT_AGENT_DIR_RELATIVE_PATHS) {
      agents.push(...loadCustomAgentsFromDir(path.join(workspacePath, rel)))
    }
  }
  if (agentStoragePath && agentStoragePath !== userDataPath) {
    agents.push(...loadCustomAgentsFromDir(path.join(agentStoragePath, '.agents')))
  }
  return agents
}

/** User-level `userData/agents` (upstream ~/.claude-style global agents dir in this product). */
export function loadUserScopedAgents(userDataPath?: string): CustomAgentDefinition[] {
  if (!userDataPath) return []
  return loadCustomAgentsFromDir(path.join(userDataPath, 'agents'))
}

/**
 * Flat list for callers that do not use layered merge (project + storage + user in scan order).
 * @deprecated Prefer {@link loadUserScopedAgents} + {@link loadProjectScopedAgents} with {@link mergeLayeredAgentDefinitions}.
 */
export function loadAllCustomAgents(
  workspacePath?: string,
  userDataPath?: string,
  agentStoragePath?: string,
): CustomAgentDefinition[] {
  return [
    ...loadProjectScopedAgents(workspacePath, agentStoragePath, userDataPath),
    ...loadUserScopedAgents(userDataPath),
  ]
}

// ========== YAML frontmatter parsing ==========

/**
 * Self-audit fix D2 (2026-05) — replace the hand-rolled `parseSimpleYaml`
 * with the `yaml` library, mirroring the same swap we did for the skill
 * loader (loader.ts). Reasons the old parser was a liability:
 *   - silent failure on glob patterns containing `{ }` (e.g. paths /
 *     description with `*.{ts,tsx}` mid-value);
 *   - dropped `description: |` block scalars when followed immediately
 *     by another `key:` (regression that broke `flutter-go-reviewer.md`
 *     — pinned by existing tests);
 *   - couldn't handle nested objects, which a future agent definition
 *     might legitimately want.
 *
 * `quoteProblematicValues` mirrors upstream's `frontmatterParser.ts`
 * fallback: when the first parse fails (e.g. an author writes
 * `description: Use src/*.{ts,tsx}` without quotes), we re-attempt with
 * problematic scalars wrapped in double quotes. Idempotent on already
 * quoted lines.
 */

const YAML_SPECIAL_CHARS = /[{}[\]*&#!|>%@`]|: /

function quoteProblematicValues(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  for (const line of lines) {
    const m = line.match(/^([a-zA-Z_-]+):\s+(.+)$/)
    if (!m) {
      out.push(line)
      continue
    }
    const key = m[1]
    const value = m[2]
    if (!key || !value) {
      out.push(line)
      continue
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      out.push(line)
      continue
    }
    if (YAML_SPECIAL_CHARS.test(value)) {
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      out.push(`${key}: "${escaped}"`)
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

function tryParseYamlObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = parseYaml(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* caller decides whether to retry */
  }
  return null
}

function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const direct = tryParseYamlObject(yaml)
  if (direct) return direct
  const retry = tryParseYamlObject(quoteProblematicValues(yaml))
  if (retry) return retry
  // Both passes failed — return empty so downstream Zod check produces
  // a clean rejection rather than crashing on `undefined.trim()`.
  console.warn('[customAgents] Failed to parse YAML frontmatter — using empty record')
  return {}
}
