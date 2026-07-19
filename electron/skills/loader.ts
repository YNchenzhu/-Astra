/**
 * Skill loader (IDE-compatible) — discovers and parses SKILL.md files from:
 *
 *   User-level (lowest merge priority — scanned first):
 *     1. {home}/.cursor/skills/<name>/SKILL.md
 *     2. {home}/.claude/skills/<name>/SKILL.md
 *     3. {userData}/skills/<name>/SKILL.md
 *
 *   Project-level (higher priority — overrides user):
 *     4. {workspace}/.cursor/skills/<name>/SKILL.md
 *     5. {workspace}/.agents/skills/<name>/SKILL.md
 *     6. {workspace}/.claude/skills/<name>/SKILL.md
 *     7. {workspace}/.claude/commands/<name>/SKILL.md (legacy)
 *
 * Each skill folder can contain:
 *   - SKILL.md (required) — YAML frontmatter + prompt template
 *   - hooks.json (optional) — Skill-scoped hook commands (see skillHookManifest.ts)
 *   - scripts/           — Executable scripts the skill references
 *   - references/        — Reference docs injected into skill context
 *   - assets/            — Static assets
 *
 * Supports YAML frontmatter parsing without external YAML library.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import ignore from 'ignore'
import { parse as parseYaml } from 'yaml'
import type { SkillDefinition, SkillSource } from './types'
import { loadHooksJsonFromSkillDir, mergeHookLists, parseHooksFromFrontmatterValue } from './skillHookManifest'
import { mergeSkillDefinitionsCRDT } from './skillMergeCRDT'
import { readSkillMarkdownFileSync } from './skillMarkdownIo'
import { sanitizeUntrustedText, summarizeFindings } from '../security/sanitizeUntrustedText'
import {
  MAX_HINTED_REFERENCES,
  MAX_RESOURCE_DOCS,
  REFERENCE_HINT_MAX_CHARS,
  REFERENCE_HINT_READ_BYTES,
} from './discoveryBudget'

const execFileAsync = promisify(execFile)

// ---------- Path pattern parsing (gitignore-style) ----------

/**
 * Split paths from frontmatter, handling comma-separated and brace patterns.
 */
function splitPathInFrontmatter(paths: unknown): string[] {
  if (!paths) return []
  const items: string[] = []
  if (Array.isArray(paths)) {
    items.push(...paths.map(String))
  } else if (typeof paths === 'string') {
    // Handle ["a", "b"] JSON-like string
    if (paths.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(paths)
        if (Array.isArray(parsed)) items.push(...parsed.map(String))
      } catch { /* fall through */ }
    }
    if (items.length === 0) {
      items.push(...paths.split(',').map(s => s.trim()).filter(Boolean))
    }
  }
  // Remove /** suffix and filter empty / match-all patterns
  return items
    .map(p => p.endsWith('/**') ? p.slice(0, -3) : p)
    .filter(p => p.length > 0 && p !== '**')
}

function parseSkillPathsFromRaw(raw: Record<string, unknown>): string[] | undefined {
  if (!raw['paths']) return undefined
  const patterns = splitPathInFrontmatter(raw['paths'])
  if (patterns.length === 0) return undefined
  return patterns
}

/** Parse named arguments from frontmatter `arguments` field */
function parseArgumentNames(raw: Record<string, unknown>): string[] | undefined {
  const args = raw['arguments']
  if (!args) return undefined
  if (Array.isArray(args)) return args.map(String).filter(Boolean)
  if (typeof args === 'string') return args.split(',').map(s => s.trim()).filter(Boolean)
  return undefined
}

// ---------- Frontmatter parsing ----------

const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n?/

interface ParsedFrontmatter {
  raw: Record<string, unknown>
  content: string
}

/**
 * Audit fix S-1 + G-2 (2026-05) — drop the hand-rolled flat-key YAML
 * parser. upstream parity (`utils/frontmatterParser.ts:130-175`): use a
 * real YAML library and, on parse failure, retry after quoting
 * problematic values so glob patterns like `**\/*.{ts,tsx}` and version
 * strings stop breaking. This also makes `metadata: {…}` and nested
 * `hooks: { PreToolUse: [...] }` first-class instead of silently
 * mis-parsed.
 *
 * `YAML_SPECIAL_CHARS` matches flow indicators (`{ } [ ] *`), the
 * comment indicator `#`, anchor/tag indicators (`& !`), the block-scalar
 * pair (`| >` only at line start are real triggers but we widen for
 * safety), and the `: ` mid-value sequence that YAML reads as a nested
 * mapping in compact mode. Bare `:` is left alone so `12:34` times and
 * `https://x` URLs stay unquoted.
 */
const YAML_SPECIAL_CHARS = /[{}[\]*&#!|>%@`]|: /

function quoteProblematicValues(frontmatterText: string): string {
  const lines = frontmatterText.split('\n')
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

function parseFrontmatter(markdown: string, sourcePath?: string): ParsedFrontmatter {
  const match = markdown.match(FRONTMATTER_REGEX)
  if (!match) {
    return { raw: {}, content: markdown }
  }
  const frontmatterText = match[1] || ''
  const content = markdown.slice(match[0].length)

  let raw = tryParseYamlObject(frontmatterText)
  if (!raw) {
    raw = tryParseYamlObject(quoteProblematicValues(frontmatterText))
  }
  if (!raw) {
    const where = sourcePath ? ` in ${sourcePath}` : ''
    console.warn(`[skills] Failed to parse YAML frontmatter${where} — using empty frontmatter`)
    return { raw: {}, content }
  }
  return { raw, content }
}

// ---------- Subdirectory loading ----------

/**
 * Self-audit fix B2 (2026-05) — list filenames in a skill subdirectory
 * WITHOUT reading their bodies. The previous `loadSubdirFiles` function
 * loaded every script/reference file's full content into a
 * `Record<string, string>` at skill-load time, costing hundreds of KB
 * resident per workspace and growing linearly with reference size. The
 * model never used the pre-loaded body — every code path that surfaced
 * references either listed names or pointed to the base directory.
 * upstream (loadSkillsDir.ts) also keeps references on disk only.
 *
 * Filters to the extension allowlist used by the previous loader so a
 * `references/` containing a stray binary doesn't surface as content
 * the model would try to read.
 */
function loadSubdirFilenames(subdirPath: string): string[] | undefined {
  let entries: string[]
  try {
    entries = fs.readdirSync(subdirPath)
  } catch {
    return undefined
  }

  const validExts = new Set(['.md', '.txt', '.js', '.ts', '.py', '.sh', '.json', '.bash', '.zsh'])
  const out: string[] = []
  for (const entry of entries) {
    const ext = path.extname(entry).toLowerCase()
    if (!validExts.has(ext)) continue

    const filePath = path.join(subdirPath, entry)
    try {
      const stat = fs.statSync(filePath)
      if (!stat.isFile()) continue
      out.push(entry)
    } catch {
      // skip unreadable entries
    }
  }

  return out.length > 0 ? out : undefined
}

/**
 * Skill-resource attention uplift (2026-07) — extract a one-line hint for
 * a reference file from its HEAD bytes only (never the full body — the B2
 * memory contract stands). Preference order:
 *
 *   1. First markdown heading (`# …`), stripped of the marker.
 *   2. First non-empty prose line that isn't frontmatter/fence noise.
 *
 * Pure — exported for tests.
 */
export function extractReferenceHint(head: string): string | undefined {
  const lines = head.split('\n')
  let firstProse: string | undefined
  let inFrontmatter = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (i === 0 && line === '---') {
      inFrontmatter = true
      continue
    }
    if (inFrontmatter) {
      if (line === '---') inFrontmatter = false
      continue
    }
    if (!line) continue
    if (line.startsWith('```')) continue
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    if (heading) {
      return clampHint(heading[1])
    }
    if (!firstProse) firstProse = line
  }
  return firstProse ? clampHint(firstProse) : undefined
}

function clampHint(text: string): string | undefined {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length <= REFERENCE_HINT_MAX_CHARS
    ? flat
    : `${flat.slice(0, REFERENCE_HINT_MAX_CHARS - 1)}…`
}

/**
 * Read bounded hints for reference files. Only the first
 * {@link REFERENCE_HINT_READ_BYTES} bytes of each file are read (an open +
 * small read per file — same I/O class as the `statSync` the filename
 * listing already pays), and only the first {@link MAX_HINTED_REFERENCES}
 * files are hinted.
 */
function loadReferenceHints(
  refsDir: string,
  filenames: string[] | undefined,
): Record<string, string> | undefined {
  if (!filenames?.length) return undefined
  const hints: Record<string, string> = {}
  let count = 0
  for (const fname of filenames) {
    if (count >= MAX_HINTED_REFERENCES) break
    const filePath = path.join(refsDir, fname)
    let fd: number | undefined
    try {
      fd = fs.openSync(filePath, 'r')
      const buf = Buffer.alloc(REFERENCE_HINT_READ_BYTES)
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0)
      const hint = extractReferenceHint(buf.toString('utf-8', 0, bytesRead))
      if (hint) {
        hints[fname] = hint
        count++
      }
    } catch {
      // Unreadable file — the filename still lists; it just has no hint.
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd)
        } catch {
          /* best-effort */
        }
      }
    }
  }
  return count > 0 ? hints : undefined
}

/**
 * Modular-router skills (2026-07) — collect doc files from NON-standard
 * first-level subdirectories of the skill folder.
 *
 * Motivating shape (`bidding-writer-pro`):
 *
 *   bidding-writer-pro/
 *   ├── SKILL.md            — router: "before writing, Read common/00-…"
 *   ├── common/             — 6 global-rule docs (CJK filenames)
 *   └── modules/            — 10 per-chapter methodology docs
 *
 * The SKILL.md body references these by RELATIVE path and the standard
 * `references/` dir does not exist, so the reference-hint layer sees
 * nothing. Without this scan the resource manifest, the discovery corpus
 * and the reminder resource counts are all blind for this (common,
 * Claude-Code-ecosystem) skill shape.
 *
 * Rules:
 *   - Only FIRST-level subdirs, excluding the standard trio
 *     (`scripts/`, `references/`, `assets/`) and dot/underscore dirs.
 *   - Only doc extensions (.md / .txt) — router skills reference prose
 *     methodology docs; executables stay the job of `scripts/`.
 *   - Bounded: at most {@link MAX_RESOURCE_DOCS} files, one directory
 *     level deep (matching the flat layout of the motivating skills;
 *     deeper nesting still surfaces via the base-dir glob hint).
 *   - Bodies stay on disk (B2): only relPath + head-extracted hint.
 *   - Deterministic order: dirs and files sorted lexicographically, so
 *     numbered files (`00-…`, `08-…`) list in their intended sequence.
 */
const STANDARD_SKILL_SUBDIRS = new Set(['scripts', 'references', 'assets'])
const RESOURCE_DOC_EXTS = new Set(['.md', '.txt'])

function loadResourceDocs(
  skillDir: string,
): Array<{ relPath: string; hint?: string }> | undefined {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(skillDir, { withFileTypes: true })
  } catch {
    return undefined
  }

  const subdirs = entries
    .filter(
      (e) =>
        e.isDirectory() &&
        !STANDARD_SKILL_SUBDIRS.has(e.name.toLowerCase()) &&
        !e.name.startsWith('.') &&
        !e.name.startsWith('_'),
    )
    .map((e) => e.name)
    .sort()

  if (subdirs.length === 0) return undefined

  const docs: Array<{ relPath: string; hint?: string }> = []
  for (const sub of subdirs) {
    if (docs.length >= MAX_RESOURCE_DOCS) break
    const subPath = path.join(skillDir, sub)
    let files: string[]
    try {
      files = fs.readdirSync(subPath).sort()
    } catch {
      continue
    }
    for (const fname of files) {
      if (docs.length >= MAX_RESOURCE_DOCS) break
      if (!RESOURCE_DOC_EXTS.has(path.extname(fname).toLowerCase())) continue
      const filePath = path.join(subPath, fname)
      let fd: number | undefined
      try {
        const stat = fs.statSync(filePath)
        if (!stat.isFile()) continue
        const doc: { relPath: string; hint?: string } = {
          relPath: `${sub}/${fname}`,
        }
        fd = fs.openSync(filePath, 'r')
        const buf = Buffer.alloc(REFERENCE_HINT_READ_BYTES)
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0)
        const hint = extractReferenceHint(buf.toString('utf-8', 0, bytesRead))
        if (hint) doc.hint = hint
        docs.push(doc)
      } catch {
        // Unreadable entry — skip.
      } finally {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd)
          } catch {
            /* best-effort */
          }
        }
      }
    }
  }
  return docs.length > 0 ? docs : undefined
}

/**
 * Load asset file paths from the assets/ subdirectory.
 */
function loadAssetPaths(assetsDir: string): string[] | undefined {
  let entries: string[]
  try {
    entries = fs.readdirSync(assetsDir)
  } catch {
    return undefined
  }

  const assets: string[] = []
  for (const entry of entries) {
    const filePath = path.join(assetsDir, entry)
    try {
      const stat = fs.statSync(filePath)
      if (stat.isFile()) {
        assets.push(filePath)
      }
    } catch {
      // skip
    }
  }

  return assets.length > 0 ? assets : undefined
}

// ---------- Skill loading ----------

/**
 * Load all skills from a directory of skill subdirectories.
 * Expected structure: baseDir/<skillName>/SKILL.md
 *
 * Validates that the frontmatter `name` matches the parent folder name
 * (lowercase with hyphens). If it doesn't match, uses the folder name.
 */
function canonicalSkillResolvedPath(dirPath: string): string {
  try {
    const native = (
      fs as unknown as { realpathSync: { native?: (p: string) => string } }
    ).realpathSync.native
    if (typeof native === 'function') {
      return native(dirPath)
    }
    return fs.realpathSync(dirPath)
  } catch {
    return path.resolve(dirPath)
  }
}

export function loadSkillsFromDir(
  baseDir: string,
  source: SkillSource,
  originSlot?: number,
): SkillDefinition[] {
  const skills: SkillDefinition[] = []

  let entries: string[]
  try {
    entries = fs.readdirSync(baseDir)
  } catch {
    return skills
  }

  for (const entry of entries) {
    const skillDir = path.join(baseDir, entry)
    const skillFile = path.join(skillDir, 'SKILL.md')

    let stat: fs.Stats
    try {
      stat = fs.statSync(skillDir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue

    // Audit fix G-4 (2026-05) — previously a "legacy single-.md" fallback
    // tried to re-stat `path.join(baseDir, entry)` here, but the outer
    // `!stat.isDirectory() continue` already filtered non-dirs above, so
    // the fallback was unreachable. Removed.
    let content: string
    const contentOrigin = skillFile
    try {
      content = readSkillMarkdownFileSync(skillFile)
    } catch {
      continue
    }

    // Security: SKILL.md is fed verbatim into model context as the skill's
    // description / body. A malicious skill bundle (especially an imported
    // one) can hide Tag-Unicode or Bidi-control prompt-injection payloads
    // that the human reviewer never sees. Strip the high-risk subset and
    // warn loudly when anything is found so the user knows their bundle
    // was tampered. See `electron/security/sanitizeUntrustedText.ts`.
    const sanitized = sanitizeUntrustedText(content)
    if (sanitized.findings.length > 0) {
      console.warn(
        `[skills] Stripped ${sanitized.totalStripped} invisible Unicode char(s) from ${contentOrigin}: ${summarizeFindings(sanitized.findings)}`,
      )
      content = sanitized.cleaned
    }

    const skill = parseSkillFile(content, entry, source, skillDir, originSlot)
    if (skill) {
      // Load subdirectories
      const scriptsDir = path.join(skillDir, 'scripts')
      const refsDir = path.join(skillDir, 'references')
      const assetsDir = path.join(skillDir, 'assets')

      skill.scripts = loadSubdirFilenames(scriptsDir)
      skill.references = loadSubdirFilenames(refsDir)
      skill.referenceHints = loadReferenceHints(refsDir, skill.references)
      skill.assets = loadAssetPaths(assetsDir)
      skill.resourceDocs = loadResourceDocs(skillDir)

      const fileHooks = loadHooksJsonFromSkillDir(skillDir)
      const mergedHooks = mergeHookLists(skill.hooks ?? [], fileHooks)
      skill.hooks = mergedHooks.length > 0 ? mergedHooks : undefined

      skills.push(skill)
    }
  }

  return skills
}

/**
 * Self-audit fix B1 (2026-05) — coerce frontmatter values that are
 * SUPPOSED to be strings into real strings before the loader hands them
 * off downstream. The `yaml` library happily returns numbers for
 * `version: 1.5`, booleans for `model: true`, and `null` for `key:`
 * with no value. The IDE's `SkillDefinition` declares these as `string |
 * undefined`, so the old `raw[...] as string` cast was a runtime type
 * lie that crashed code paths like `skill.version.split('.')`.
 *
 * upstream parity: `coerceDescriptionToString` in
 * `utils/frontmatterParser.ts`. We make it a single helper used for
 * every nominally-string field (name, description, model, effort,
 * argument-hint, when_to_use, version, license, compatibility, context,
 * agent).
 *
 * Rules:
 *   - undefined / null / empty string → undefined
 *   - string → trimmed string (empty becomes undefined)
 *   - number / boolean → String(value), then trimmed (so `1.5` → "1.5",
 *     `true` → "true"). Caller decides whether that's semantically right
 *     for the field; the type promise is honored.
 *   - Object / array → undefined + warn (would only happen if a user
 *     wrote `description: { foo: bar }` which is malformed).
 */
function coerceFrontmatterString(value: unknown, fieldName?: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (fieldName) {
    console.warn(
      `[skills] frontmatter \`${fieldName}\` expected a string scalar but got ${typeof value} — ignoring.`,
    )
  }
  return undefined
}

/**
 * Skill-attention uplift (2026-07) — description quality lint.
 *
 * The `name + description` pair is the ONLY part of a skill that stays
 * resident in context (compact index) and competes for the model's
 * attention every turn; the body loads only after invocation. All three
 * reference implementations (Claude Code / Cursor / Codex docs) converge
 * on the same authoring rule: description = capability statement + an
 * explicit "Use when …" trigger enumeration. Descriptions missing the
 * trigger half rank poorly in both the model's semantic match and our
 * TF-IDF discovery.
 *
 * Returns a human-readable problem string, or `null` when the
 * description passes. Lint-only: never blocks loading. Exported for
 * tests.
 */
export function lintSkillDescriptionQuality(skill: {
  description: string
  whenToUse?: string
  disableModelInvocation: boolean
}): string | null {
  // Manual-only skills are never auto-matched — description quality
  // doesn't gate their invocation.
  if (skill.disableModelInvocation) return null
  const desc = skill.description.trim()
  if (desc.length < 40) {
    return `description is very short (${desc.length} chars) — the model matches tasks against it; state the capability AND when to use the skill`
  }
  // A separate `when_to_use` frontmatter field satisfies the trigger half.
  if (skill.whenToUse?.trim()) return null
  const hasTriggerPhrase =
    /\buse (?:this (?:skill )?)?when\b|\bactivates? (?:for|when)\b|\btrigger(?:s|ed)? (?:for|when|场景)?\b|适用(?:于|场景)|触发(?:场景|条件)|当用户|当需要|用于/i.test(
      desc,
    )
  if (!hasTriggerPhrase) {
    return 'description has no trigger scenarios — add a "Use when …" / "适用于…" clause (or a `when_to_use` frontmatter field) listing the requests that should activate this skill'
  }
  return null
}

function parseSkillFile(
  markdown: string,
  dirName: string,
  source: SkillSource,
  resolvedPath: string,
  originSlot?: number,
): SkillDefinition | null {
  const { raw, content } = parseFrontmatter(markdown, resolvedPath)
  const frontmatterKeys = Object.keys(raw)

  // Validate: folder name should be lowercase with hyphens
  const normalizedDirName = dirName.replace(/\.md$/, '').toLowerCase()

  // Name from frontmatter or directory name. Frontmatter name must match folder.
  // Audit fix G-1 (2026-05) — when the two diverge we used to silently use
  // the folder name. Authors then wondered why `/their-name` didn't match
  // SKILL.md `name: their-name`. Warn loudly so the mismatch is fixable.
  const frontmatterName = coerceFrontmatterString(raw['name'], 'name')
  let name: string
  if (frontmatterName) {
    if (frontmatterName.toLowerCase() === normalizedDirName) {
      name = frontmatterName
    } else {
      console.warn(
        `[skills] frontmatter name "${frontmatterName}" does not match folder "${normalizedDirName}" at ${resolvedPath}. Using folder name; rename one of them to silence this warning.`,
      )
      name = normalizedDirName
    }
  } else {
    name = normalizedDirName
  }

  const description =
    coerceFrontmatterString(raw['description'], 'description') ||
    extractFirstParagraph(content)
  if (!description) return null

  // Parse disable-model-invocation (default: false = auto-invocation enabled)
  const disableModelInvocation = raw['disable-model-invocation'] === true

  // Parse metadata if present
  const metadata: Record<string, unknown> | undefined =
    raw['metadata'] && typeof raw['metadata'] === 'object' && !Array.isArray(raw['metadata'])
      ? (raw['metadata'] as Record<string, unknown>)
      : undefined

  const fmHooks = parseHooksFromFrontmatterValue(raw['hooks'])
  const paths = parseSkillPathsFromRaw(raw)
  const argumentNames = parseArgumentNames(raw)

  const contextRaw = coerceFrontmatterString(raw['context'], 'context')
  const context: 'inline' | 'fork' =
    contextRaw === 'fork' ? 'fork' : 'inline'

  return {
    name,
    description,
    source,
    ...(originSlot !== undefined ? { originSlot } : {}),
    frontmatterKeys,
    userInvocable: raw['user-invocable'] !== false,
    disableModelInvocation,
    context,
    allowedTools: parseStringArray(raw['allowed-tools']),
    model: coerceFrontmatterString(raw['model'], 'model'),
    effort: coerceFrontmatterString(raw['effort'], 'effort'),
    argumentHint: coerceFrontmatterString(raw['argument-hint'], 'argument-hint'),
    argumentNames,
    resolvedPath: path.resolve(resolvedPath),
    promptContent: content.trim(),
    license: coerceFrontmatterString(raw['license'], 'license'),
    compatibility: coerceFrontmatterString(raw['compatibility'], 'compatibility'),
    metadata,
    paths,
    whenToUse: coerceFrontmatterString(raw['when_to_use'], 'when_to_use'),
    version: coerceFrontmatterString(raw['version'], 'version'),
    hooks: fmHooks.length > 0 ? fmHooks : undefined,
  }
}

function extractFirstParagraph(text: string): string {
  const lines = text.split('\n')
  const paragraph: string[] = []
  for (const line of lines) {
    if (line.trim() === '') {
      if (paragraph.length > 0) break
      continue
    }
    // Skip markdown headings for description
    if (line.startsWith('#') && paragraph.length === 0) continue
    paragraph.push(line.trim())
  }
  return paragraph.join(' ').slice(0, 200)
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!value) return undefined
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') {
    // Handle JSON-like array string: ["a", "b"]
    if (value.startsWith('[')) {
      try {
        const parsed = JSON.parse(value)
        if (Array.isArray(parsed)) return parsed.map(String)
      } catch {
        // fallback: split by comma
      }
    }
    return value.split(',').map(s => s.trim())
  }
  return undefined
}

// ---------- Public API ----------

export interface SkillLoader {
  /** Load all skills (bundled + user + project) */
  loadAll(workspacePath?: string, userDataPath?: string): SkillDefinition[]
  /** Substitute $ARGUMENTS in prompt content */
  substituteArguments(promptContent: string, args: string, skillRootDir?: string): string
}

// --- Dynamic skill discovery state ---

const dynamicSkillDirs = new Set<string>()
const dynamicSkills = new Map<string, SkillDefinition>()

// --- Conditional skills (path-filtered) ---

const conditionalSkills = new Map<string, SkillDefinition>()
const activatedConditionalSkillNames = new Set<string>()

/**
 * Discovers skill directories by walking up from file paths to cwd.
 * Skips gitignored directories to prevent node_modules/pkg/.claude/skills from loading.
 */
export async function discoverSkillDirsForPaths(
  filePaths: string[],
  cwd: string,
): Promise<string[]> {
  const resolvedCwd = cwd.endsWith(path.sep) ? cwd.slice(0, -1) : cwd
  const newDirs: string[] = []

  for (const filePath of filePaths) {
    let currentDir = path.dirname(filePath)

    // Walk up to cwd but NOT including cwd itself
    while (currentDir.startsWith(resolvedCwd + path.sep)) {
      const skillDir = path.join(currentDir, '.claude', 'skills')

      // Skip if already checked (hit or miss) — avoids repeated stat on non-existent dirs
      if (!dynamicSkillDirs.has(skillDir)) {
        // Self-audit fix C4 (2026-05) — previously we marked the dir
        // as "checked" BEFORE the stat + gitignore probe completed.
        // If `isPathGitignored` ever threw an unexpected error (or the
        // future code path between mark and push threw), the dir would
        // be poison-marked: never re-visited, never pushed. The fix is
        // a `finally` block that performs the mark unconditionally
        // AFTER the probe completes (success / gitignored / stat-miss /
        // unexpected throw — all four outcomes are stat-cache hits and
        // legitimately should suppress re-stat).
        try {
          try {
            fs.statSync(skillDir)
            // Check if containing dir is gitignored — blocks node_modules skills
            if (await isPathGitignored(currentDir, resolvedCwd)) {
              continue
            }
            newDirs.push(skillDir)
          } catch {
            // Directory doesn't exist — record the absence below
          }
        } finally {
          dynamicSkillDirs.add(skillDir)
        }
      }

      const parent = path.dirname(currentDir)
      if (parent === currentDir) break
      currentDir = parent
    }
  }

  return newDirs.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)
}

/**
 * Loads skills from discovered directories (deeper paths take precedence).
 */
export function addSkillDirectories(dirs: string[]): SkillDefinition[] {
  if (dirs.length === 0) return []

  const newlyAdded: SkillDefinition[] = []

  // Load in reverse order (shallower first) so deeper paths override
  for (let i = dirs.length - 1; i >= 0; i--) {
    const skills = loadSkillsFromDir(dirs[i]!, 'project')
    for (const skill of skills) {
      dynamicSkills.set(skill.name, skill)
      newlyAdded.push(skill)
    }
  }

  // Separate conditional vs unconditional
  const unconditional: SkillDefinition[] = []
  for (const skill of newlyAdded) {
    if (skill.paths && skill.paths.length > 0 && !activatedConditionalSkillNames.has(skill.name)) {
      conditionalSkills.set(skill.name, skill)
    } else {
      unconditional.push(skill)
    }
  }

  return unconditional
}

/**
 * Activates conditional skills whose path patterns match the given file paths.
 */
export function activateConditionalSkillsForPaths(
  filePaths: string[],
  cwd: string,
): string[] {
  if (conditionalSkills.size === 0) return []

  const activated: string[] = []

  for (const [name, skill] of conditionalSkills) {
    if (!skill.paths || skill.paths.length === 0) continue

    const skillIgnore = ignore().add(skill.paths)
    for (const filePath of filePaths) {
      const relativePath = path.isAbsolute(filePath)
        ? path.relative(cwd, filePath)
        : filePath

      if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) continue

      if (skillIgnore.ignores(relativePath)) {
        dynamicSkills.set(name, skill)
        conditionalSkills.delete(name)
        activatedConditionalSkillNames.add(name)
        activated.push(name)
        break
      }
    }
  }

  return activated
}

/**
 * Clear dynamic skill state (for testing / workspace reload).
 */
export function clearDynamicSkills(): void {
  dynamicSkillDirs.clear()
  dynamicSkills.clear()
  conditionalSkills.clear()
  activatedConditionalSkillNames.clear()
}

/** Get all dynamically loaded skills */
export function getDynamicSkills(): SkillDefinition[] {
  return Array.from(dynamicSkills.values())
}

/**
 * Gitignore check helper — async (upstream parity, `git/gitignore.ts:23-37`).
 *
 * Audit fix S-1 (2026-05) — previously `execFileSync` with a 3-second
 * timeout. In a workspace with many candidate `.claude/skills` parents
 * (or a slow `git` startup on Windows), every miss froze the main
 * process for up to 3s. Now non-blocking; callers that already returned
 * a Promise (`discoverSkillDirsForPaths`) simply `await` it.
 */
async function isPathGitignored(dirPath: string, cwd: string): Promise<boolean> {
  try {
    const relPath = path.relative(cwd, dirPath)
    if (!relPath || relPath.startsWith('..')) return false
    await execFileAsync('git', ['check-ignore', dirPath], { cwd, timeout: 3000 })
    return true
  } catch {
    return false
  }
}

export function createSkillLoader(): SkillLoader {
  return {
    loadAll(workspacePath, userDataPath) {
      const tagged: Array<{ skill: SkillDefinition; ordinal: number }> = []
      const seenPaths = new Set<string>()
      let ordinal = 0

      const addSkills = (skills: SkillDefinition[]) => {
        for (const skill of skills) {
          const key = skill.resolvedPath ? canonicalSkillResolvedPath(skill.resolvedPath) : ''
          if (key && seenPaths.has(key)) continue
          if (key) seenPaths.add(key)
          tagged.push({ skill, ordinal: ordinal++ })
        }
      }

      const homeDir = os.homedir()

      // Slots 1–3: user-level (lowest merge priority)
      const cursorUserDir = path.join(homeDir, '.cursor', 'skills')
      addSkills(loadSkillsFromDir(cursorUserDir, 'user', 1))

      const claudeUserDir = path.join(homeDir, '.claude', 'skills')
      addSkills(loadSkillsFromDir(claudeUserDir, 'user', 2))

      if (userDataPath) {
        const appUserDir = path.join(userDataPath, 'skills')
        addSkills(loadSkillsFromDir(appUserDir, 'user', 3))
      }

      // Slots 4–7: project-level (overrides user)
      if (workspacePath) {
        const cursorProjectDir = path.join(workspacePath, '.cursor', 'skills')
        addSkills(loadSkillsFromDir(cursorProjectDir, 'project', 4))

        const agentsProjectDir = path.join(workspacePath, '.agents', 'skills')
        addSkills(loadSkillsFromDir(agentsProjectDir, 'project', 5))

        const claudeProjectDir = path.join(workspacePath, '.claude', 'skills')
        addSkills(loadSkillsFromDir(claudeProjectDir, 'project', 6))

        const legacyDir = path.join(workspacePath, '.claude', 'commands')
        addSkills(loadSkillsFromDir(legacyDir, 'project', 7))
      }

      const merged = mergeSkillDefinitionsCRDT(tagged)

      // Separate conditional skills (with paths) from unconditional
      const unconditional: SkillDefinition[] = []
      for (const skill of merged) {
        if (skill.paths && skill.paths.length > 0 && !activatedConditionalSkillNames.has(skill.name)) {
          conditionalSkills.set(skill.name, skill)
        } else {
          unconditional.push(skill)
        }
      }

      return unconditional
    },

    substituteArguments(promptContent: string, args: string, skillRootDir?: string) {
      let result = promptContent

      // Replace $ARGUMENTS with full argument string
      result = result.replace(/\$ARGUMENTS/g, args)

      // Replace $ARGUMENTS[0], $ARGUMENTS[1], etc.
      const argParts = args.split(/\s+/)
      result = result.replace(/\$ARGUMENTS\[(\d+)\]/g, (_match: string, idx: string) => {
        return argParts[Number(idx)] || ''
      })

      // Replace $0, $1, etc.
      result = result.replace(/\$(\d+)/g, (_match: string, idx: string) => {
        return argParts[Number(idx)] || ''
      })

      // Replace ${CLAUDE_SKILL_DIR} with the skill's own directory
      if (skillRootDir) {
        const dir = process.platform === 'win32' ? skillRootDir.replace(/\\/g, '/') : skillRootDir
        result = result.replace(/\$\{CLAUDE_SKILL_DIR\}/g, dir)
      }

      // Replace ${CLAUDE_SESSION_ID} (from bootstrap state if available).
      // `bootstrap/state` is require()'d lazily so this loader can run
      // in unit tests that never boot the electron process.
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getSessionId } = require('../bootstrap/state')
        const sessionId = getSessionId()
        if (sessionId) {
          result = result.replace(/\$\{CLAUDE_SESSION_ID\}/g, sessionId)
        }
      } catch {
        // bootstrap/state not available
      }

      return result
    },
  }
}

// ---------- Skill file change detection (hot-reload) ----------

let skillWatcherInitialized = false

/**
 * Initialize file watching for skill directories.
 *
 * When skill files change, the dynamic-skills cache is cleared and the
 * caller-supplied `onReload` callback runs so the visible skill registry
 * (`loadedSkills` in skillTool.ts) is rebuilt. Without `onReload`, edits
 * to SKILL.md only invalidated the loader's internal cache; the user-
 * facing list stayed stale until workspace switch or app restart
 * (BUG-SK2).
 *
 * The callback is debounced because some editors emit a flurry of
 * change events while saving (write-temp + rename), which would
 * otherwise trigger 5–10 reloads per save.
 */
export async function initSkillWatcher(
  workspacePath: string,
  onReload?: () => void,
): Promise<void> {
  if (skillWatcherInitialized) return
  skillWatcherInitialized = true

  try {
    const { initialize, subscribe, dispose } = await import('./skillChangeDetector')
    await initialize(workspacePath)

    let pending: ReturnType<typeof setTimeout> | null = null
    subscribe(() => {
      clearDynamicSkills()
      // Audit fix B-4 (2026-05) — always invalidate the compact-index
      // memo + bump skillsVersion when the watcher fires, even if no
      // onReload callback is wired. Previously the cache could stay
      // valid against a `loadedSkills` set that was already stale,
      // because `skillsVersion` only changed inside `initSkills()`.
      // Lazy import avoids a cycle through skillTool.ts at module
      // init time (skillTool.ts imports from loader.ts via its own
      // helper paths).
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const tool = require('./skillTool') as typeof import('./skillTool')
        tool.notifyExternalSkillMutation('watcher-changed')
      } catch (err) {
        console.warn('[skill-loader] notifyExternalSkillMutation failed:', err)
      }
      if (!onReload) return
      if (pending) clearTimeout(pending)
      pending = setTimeout(() => {
        pending = null
        try {
          onReload()
        } catch (err) {
          console.warn('[skill-loader] reload callback failed:', err)
        }
      }, 250)
    })

    process.on('exit', () => {
      dispose().catch((err) => {
        console.warn('[skill-loader] watcher dispose failed:', err)
      })
    })
  } catch (err) {
    console.warn('[skill-loader] Failed to initialize skill watcher:', err)
  }
}