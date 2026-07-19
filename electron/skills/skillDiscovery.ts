/**
 * Per-turn skill retrieval: TF-IDF + lexical scoring, injection helpers,
 * and the DiscoverSkills tool for explicit on-demand discovery.
 *
 * Embedding-based ranking is intentionally out of scope (no API keys / local model in this path).
 */

import { z } from 'zod'
import type { SkillDefinition } from './types'
import type { ToolResult } from '../tools/types'
import { buildTool } from '../tools/buildTool'
import { getAllSkills, getSkillsVersion } from './skillTool'
import { userMessageContentToPlainText } from '../utils/userMessageText'
import { SIDE_CHANNEL_KIND, wrapSideChannelBody } from '../constants/sideChannelKinds'
import { getAgentContext } from '../agents/agentContext'
import { getModelContextWindowTokens } from '../context/openClaudeParityConstants'
import {
  DISCOVERY_DOMINANCE_MEDIAN_RATIO,
  DISCOVERY_INJECTION_MIN_SCORE,
  DISCOVERY_PROMPT_PREVIEW_CHARS,
  DISCOVERY_TOP_K,
  getSkillCharBudget,
} from './discoveryBudget'

/**
 * Zod validator for the `DiscoverSkills` tool input. Mirrors the
 * `inputSchema` declaration below so the `initAgentTools — zInputSchema
 * coverage` audit test (`registryProductToolsZod.test.ts`) sees a wired
 * validator for this tool.
 *
 * Forgiving on field names (some models / IPC callers may send a stringified
 * number for `limit`), strict on `query` being present and non-empty.
 */
const discoverSkillsInputZod = z
  .object({
    query: z.string().min(1, 'query is required'),
    limit: z
      .preprocess((v) => {
        if (v === undefined || v === null || v === '') return undefined
        if (typeof v === 'number') return Number.isFinite(v) ? v : Number.NaN
        if (typeof v === 'string') {
          const t = v.trim()
          if (t === '') return undefined
          const n = Number(t)
          return Number.isFinite(n) ? n : Number.NaN
        }
        return Number.NaN
      }, z.number().int().min(1).max(20).optional())
      .optional(),
  })
  .passthrough()

/** ASCII “words” for TF-IDF (min length 2 after match). */
const ASCII_TOKEN_RE = /[a-z0-9][a-z0-9+.-]{1,}/gi
/** Han runs: unigrams + overlapping bigrams for Chinese queries/skills. */
const CJK_RUN_RE = /[\u4e00-\u9fff]+/g

/** Scale TF-IDF cosine to sit alongside lexical points (~0–25). */
const TFIDF_COSINE_SCALE = 28

export interface SkillDiscoveryOptions {
  /** Skills already surfaced or invoked this run — omitted from ranked results */
  excludeNames?: Set<string>
  /** Max skills to include in the block */
  topK?: number
  /** Hard cap on total characters of the inner markdown */
  maxChars?: number
  /** Max characters of each skill's prompt body preview */
  promptPreviewChars?: number
}

function addAsciiTokensToSet(set: Set<string>, lower: string): void {
  ASCII_TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ASCII_TOKEN_RE.exec(lower)) !== null) {
    const w = m[0]
    if (w.length >= 2) set.add(w)
  }
}

function addCjkTokensToSet(set: Set<string>, text: string): void {
  CJK_RUN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CJK_RUN_RE.exec(text)) !== null) {
    const seg = m[0]
    for (const ch of seg) {
      set.add(ch)
    }
    for (let i = 0; i < seg.length - 1; i++) {
      set.add(seg.slice(i, i + 2))
    }
  }
}

function normalizeWords(text: string): Set<string> {
  const set = new Set<string>()
  addAsciiTokensToSet(set, text.toLowerCase())
  addCjkTokensToSet(set, text)
  return set
}

export function normalizeSkillName(name: string): string {
  return name.replace(/^[/@]/, '').toLowerCase()
}

function skillCorpusText(s: SkillDefinition): string {
  // Skill-resource attention uplift (2026-07) — reference filenames +
  // bounded hints join the ranking corpus: a task mentioning a topic that
  // lives in a skill's references/ (not its SKILL.md prose) can now still
  // surface that skill. Bodies stay on disk (B2); hints are ≤120 chars.
  // Modular-router docs (`common/`, `modules/`) contribute the same way —
  // their CJK filenames ("05-项目难点分析及解决方案.md") are often the
  // best match for the user's actual request wording.
  const refSignal = [
    ...(s.references ?? []),
    ...Object.values(s.referenceHints ?? {}),
    ...(s.resourceDocs ?? []).flatMap((d) => [d.relPath, d.hint ?? '']),
  ].join('\n')
  return [
    s.name,
    s.description,
    s.whenToUse ?? '',
    s.argumentHint ?? '',
    refSignal,
    s.promptContent.slice(0, 3500),
  ].join('\n')
}

function addAsciiTokenCounts(counts: Map<string, number>, lower: string): void {
  ASCII_TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ASCII_TOKEN_RE.exec(lower)) !== null) {
    const w = m[0]
    if (w.length < 2) continue
    counts.set(w, (counts.get(w) || 0) + 1)
  }
}

function addCjkTokenCounts(counts: Map<string, number>, text: string): void {
  CJK_RUN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CJK_RUN_RE.exec(text)) !== null) {
    const seg = m[0]
    for (const ch of seg) {
      counts.set(ch, (counts.get(ch) || 0) + 1)
    }
    for (let i = 0; i < seg.length - 1; i++) {
      const bg = seg.slice(i, i + 2)
      counts.set(bg, (counts.get(bg) || 0) + 1)
    }
  }
}

function tokenizeToCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  addAsciiTokenCounts(counts, text.toLowerCase())
  addCjkTokenCounts(counts, text)
  return counts
}

/** For tests: distinct term keys extracted for ranking (ASCII + CJK unigram/bigram). */
export function discoveryQueryTermKeys(text: string): string[] {
  return [...tokenizeToCounts(text).keys()]
}

function computeIdf(docTermMaps: Map<string, number>[]): Map<string, number> {
  const N = Math.max(docTermMaps.length, 1)
  const df = new Map<string, number>()
  for (const doc of docTermMaps) {
    for (const term of doc.keys()) {
      df.set(term, (df.get(term) || 0) + 1)
    }
  }
  const idf = new Map<string, number>()
  for (const [term, d] of df) {
    idf.set(term, Math.log((N + 1) / (d + 1)) + 1)
  }
  return idf
}

function vecTfidf(termCounts: Map<string, number>, idf: Map<string, number>): Map<string, number> {
  const maxC = Math.max(...termCounts.values(), 1)
  const v = new Map<string, number>()
  for (const [term, c] of termCounts) {
    const tf = 0.5 + 0.5 * (c / maxC)
    const idfVal = idf.get(term) ?? 1
    v.set(term, tf * idfVal)
  }
  return v
}

function cosineSparse(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  for (const [t, av] of a) {
    const bv = b.get(t)
    if (bv !== undefined) dot += av * bv
  }
  let na = 0
  let nb = 0
  for (const v of a.values()) na += v * v
  for (const v of b.values()) nb += v * v
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom > 0 ? dot / denom : 0
}

/**
 * Lexical overlap score (substring + name match). Kept as a boost on top of TF-IDF.
 */
export function scoreSkillRelevanceLexical(query: string, skill: SkillDefinition): number {
  const qWords = normalizeWords(query)
  if (qWords.size === 0) return 0

  const blob = [
    skill.name,
    skill.description,
    skill.whenToUse ?? '',
    skill.argumentHint ?? '',
    // Reference filenames + hints (2026-07) — same rationale as
    // `skillCorpusText`: resource topics count as relevance signal.
    ...(skill.references ?? []),
    ...Object.values(skill.referenceHints ?? {}),
    ...(skill.resourceDocs ?? []).flatMap((d) => [d.relPath, d.hint ?? '']),
    skill.promptContent.slice(0, 1200),
  ]
    .join('\n')
    .toLowerCase()

  let score = 0
  for (const w of qWords) {
    if (blob.includes(w)) score += 1
  }

  const n = normalizeSkillName(skill.name)
  if (query.toLowerCase().includes(n)) score += 6
  if (query.toLowerCase().includes(`/${n}`) || query.toLowerCase().includes(`@${n}`)) score += 4

  return score
}

function getAutoInvocationSkills(): SkillDefinition[] {
  return getAllSkills().filter(s => !s.disableModelInvocation)
}

/**
 * Audit fix S-3 (2026-05) — memoize the corpus + IDF against
 * `skillsVersion`. Previously every `rankAutoInvocationSkills` and
 * `rankSkillsForExplicitDiscover` call rebuilt N×bodies tokenization +
 * full-corpus IDF — costing ~10-50ms of main-process CPU per tool turn in
 * 50-skill workspaces. Now we rebuild only when `initSkills()` /
 * `notifyExternalSkillMutation` bumps the version (upstream analogue:
 * `commands.ts:clearCommandMemoizationCaches`).
 */
type TfidfContext = {
  docVecs: Map<string, number>[]
  nameToDocIndex: Map<string, number>
  idf: Map<string, number>
}

let cachedTfidf: { version: number; sigKey: string; ctx: TfidfContext } | null = null
/** Test-only counter, incremented every time the TF-IDF corpus is rebuilt. */
let tfidfRebuildCount = 0

/** @internal Tests use this to observe and reset the memo. */
export function _tfidfMemoState(): {
  cached: boolean
  version: number | null
  sigKey: string | null
  rebuildCount: number
} {
  return {
    cached: cachedTfidf !== null,
    version: cachedTfidf?.version ?? null,
    sigKey: cachedTfidf?.sigKey ?? null,
    rebuildCount: tfidfRebuildCount,
  }
}

/** @internal Drop the memo (and reset the rebuild counter). */
export function _resetTfidfMemoForTests(): void {
  cachedTfidf = null
  tfidfRebuildCount = 0
}

function computeTfidfContextFromSkills(allAuto: SkillDefinition[]): TfidfContext {
  tfidfRebuildCount++
  const corpusDocs = allAuto.map((s) => tokenizeToCounts(skillCorpusText(s)))
  const idf = computeIdf(corpusDocs)
  const docVecs = corpusDocs.map((c) => vecTfidf(c, idf))
  const nameToDocIndex = new Map<string, number>()
  for (let i = 0; i < allAuto.length; i++) {
    nameToDocIndex.set(normalizeSkillName(allAuto[i].name), i)
  }
  return { docVecs, nameToDocIndex, idf }
}

function buildTfidfContext(allAuto: SkillDefinition[]): {
  docVecs: Map<string, number>[]
  nameToDocIndex: Map<string, number>
  queryVec: (q: string) => Map<string, number>
} {
  // `sigKey` guards against the rare case where two callers race a different
  // `allAuto` set against the SAME `skillsVersion` (e.g. a transient filter
  // change). Built from sorted names so cost is O(N) per call; the real
  // T-IDF work behind it is skipped on cache hit.
  const sigKey = allAuto
    .map((s) => normalizeSkillName(s.name))
    .sort()
    .join('|')
  const version = getSkillsVersion()
  if (
    cachedTfidf &&
    cachedTfidf.version === version &&
    cachedTfidf.sigKey === sigKey
  ) {
    const { docVecs, nameToDocIndex, idf } = cachedTfidf.ctx
    return {
      docVecs,
      nameToDocIndex,
      queryVec: (q: string) => vecTfidf(tokenizeToCounts(q), idf),
    }
  }
  const ctx = computeTfidfContextFromSkills(allAuto)
  cachedTfidf = { version, sigKey, ctx }
  return {
    docVecs: ctx.docVecs,
    nameToDocIndex: ctx.nameToDocIndex,
    queryVec: (q: string) => vecTfidf(tokenizeToCounts(q), ctx.idf),
  }
}

function scoreSkillCombined(
  query: string,
  skill: SkillDefinition,
  docVecs: Map<string, number>[],
  nameToDocIndex: Map<string, number>,
  qv: Map<string, number>,
): number {
  const idx = nameToDocIndex.get(normalizeSkillName(skill.name)) ?? -1
  const cos = idx >= 0 ? cosineSparse(qv, docVecs[idx]) : 0
  const lex = scoreSkillRelevanceLexical(query, skill)
  return cos * TFIDF_COSINE_SCALE + lex
}

// Audit fix S-4 (2026-05) — minimum score threshold lives in
// `discoveryBudget.ts` as `DISCOVERY_INJECTION_MIN_SCORE` so it can be
// audited alongside char budgets and topK in one place.

/**
 * @internal Calibration/test hook — score every auto-invocation skill
 * against `query` with the SAME combined formula used by automatic
 * injection (`rankAutoInvocationSkills`), returning the score breakdown
 * instead of the filtered/sorted skill list. Used to audit where
 * `DISCOVERY_INJECTION_MIN_SCORE` sits relative to real corpora.
 */
export function _scoreSkillsForCalibration(
  query: string,
): Array<{ name: string; score: number; cos: number; lex: number }> {
  const allAuto = getAutoInvocationSkills()
  if (allAuto.length === 0) return []
  const { docVecs, nameToDocIndex, queryVec } = buildTfidfContext(allAuto)
  const qv = queryVec(query)
  return allAuto
    .map((skill) => {
      const idx = nameToDocIndex.get(normalizeSkillName(skill.name)) ?? -1
      const cos = idx >= 0 ? cosineSparse(qv, docVecs[idx]) : 0
      const lex = scoreSkillRelevanceLexical(query, skill)
      return {
        name: normalizeSkillName(skill.name),
        score: cos * TFIDF_COSINE_SCALE + lex,
        cos,
        lex,
      }
    })
    .sort((a, b) => b.score - a.score)
}

function rankAutoInvocationSkills(
  query: string,
  exclude: Set<string>,
  topK: number,
): SkillDefinition[] {
  const allAuto = getAutoInvocationSkills()
  if (allAuto.length === 0) return []

  const eligible = allAuto.filter(s => !exclude.has(normalizeSkillName(s.name)))
  if (eligible.length === 0) return []

  const { docVecs, nameToDocIndex, queryVec } = buildTfidfContext(allAuto)
  const qv = queryVec(query)

  const scoredAll = eligible.map(skill => ({
    skill,
    score: scoreSkillCombined(query, skill, docVecs, nameToDocIndex, qv),
  }))

  // Dominance gate (calibrated 2026-07, see discoveryBudget.ts): inject a
  // skill only when it clearly stands out from the pack. Flat profiles
  // (typical for pure-code tasks, where CJK common-character overlap lifts
  // every doc-heavy skill evenly) inject nothing, leaving retrieval to the
  // explicit DiscoverSkills tool. The ratio only kicks in when there are
  // enough positive-scoring candidates to form a meaningful "pack" —
  // otherwise a lone matching skill would be gated against its own median.
  const DOMINANCE_MIN_CANDIDATES = 5
  const positives = scoredAll
    .map(({ score }) => score)
    .filter((s) => s > 0)
    .sort((a, b) => a - b)
  const lowerMedian =
    positives.length >= DOMINANCE_MIN_CANDIDATES
      ? positives[Math.floor((positives.length - 1) / 2)]
      : 0
  const gate = Math.max(
    DISCOVERY_INJECTION_MIN_SCORE,
    lowerMedian * DISCOVERY_DOMINANCE_MEDIAN_RATIO,
  )

  const scored = scoredAll
    .filter(({ score }) => score >= gate)
    .sort((a, b) => b.score - a.score)

  const out: SkillDefinition[] = []
  const seen = new Set<string>()
  for (const { skill } of scored) {
    const key = normalizeSkillName(skill.name)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(skill)
    if (out.length >= topK) break
  }
  return out
}

/**
 * Explicit tool ranking: always returns up to `topK` skills, sorted by relevance
 * (no injection threshold). Empty query lists skills alphabetically by name.
 */
export function rankSkillsForExplicitDiscover(query: string, topK: number): SkillDefinition[] {
  const allAuto = getAutoInvocationSkills()
  if (allAuto.length === 0) return []

  const k = Math.max(1, Math.min(20, topK))
  const q = query.trim()

  if (!q) {
    return [...allAuto].sort((a, b) => a.name.localeCompare(b.name)).slice(0, k)
  }

  const { docVecs, nameToDocIndex, queryVec } = buildTfidfContext(allAuto)
  const qv = queryVec(q)

  const scored = allAuto.map(skill => ({
    skill,
    score: scoreSkillCombined(q, skill, docVecs, nameToDocIndex, qv),
  }))
  scored.sort((a, b) => b.score - a.score)

  return scored.slice(0, k).map(x => x.skill)
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max).trim()}…`
}

/**
 * Build markdown for top skills (detailed enough to act on this turn).
 */
export function formatRankedSkillsBlock(
  skills: SkillDefinition[],
  maxChars: number,
  promptPreviewChars: number,
): string {
  if (skills.length === 0) return ''

  const lines: string[] = [
    '## Skills relevant to your current task',
    '',
    'Prefer invoking these with the **Skill** tool when they fit the next step.',
    '',
  ]

  let used = lines.join('\n').length

  for (const s of skills) {
    const chunk: string[] = []
    chunk.push(`### /${s.name}`)
    chunk.push(s.description)
    if (s.whenToUse) chunk.push(`When to use: ${s.whenToUse}`)
    if (s.argumentHint) chunk.push(`Arguments: ${s.argumentHint}`)
    const preview = truncate(s.promptContent.replace(/\s+/g, ' ').trim(), promptPreviewChars)
    if (preview) chunk.push(`Workflow (excerpt): ${preview}`)
    chunk.push('')

    const piece = chunk.join('\n')
    if (used + piece.length > maxChars) break
    lines.push(piece)
    used += piece.length
  }

  return lines.join('\n').trimEnd()
}

/** Compact list for DiscoverSkills tool output */
export function formatDiscoverSkillsToolOutput(skills: SkillDefinition[], query: string): string {
  if (skills.length === 0) {
    return 'No auto-invocation skills are loaded. Check workspace skill directories or bundled skills.'
  }
  const header = query.trim()
    ? `Top ${skills.length} skill(s) for query: "${query.trim().slice(0, 200)}${query.length > 200 ? '…' : ''}"`
    : `Loaded skills (${skills.length}, alphabetical — provide a query for ranked results)`

  const lines = [header, '', 'Use the **Skill** tool with the skill name to run a workflow.', '']
  for (const s of skills) {
    const hint = s.argumentHint ? ` args: ${s.argumentHint}` : ''
    const wt = s.whenToUse ? ` (${s.whenToUse.slice(0, 80)})` : ''
    lines.push(`- **/${s.name}** — ${s.description}${hint}${wt}`)
  }
  return lines.join('\n')
}

/**
 * Build a query string from recent conversation + optional this-round hints.
 */
export function buildDiscoveryQuery(
  apiMessages: Array<Record<string, unknown>>,
  extras?: { assistantText?: string; toolResultTexts?: string[] },
): string {
  const chunks: string[] = []

  if (extras?.assistantText?.trim()) {
    chunks.push(extras.assistantText.trim().slice(-2500))
  }
  if (extras?.toolResultTexts?.length) {
    const joined = extras.toolResultTexts
      .map(t => t.trim())
      .filter(Boolean)
      .join('\n')
      .slice(-6000)
    if (joined) chunks.push(joined)
  }

  for (let i = apiMessages.length - 1; i >= 0 && chunks.length < 6; i--) {
    const m = apiMessages[i]
    if (!m || m.role !== 'user') continue
    const text = userMessageContentToPlainText(m.content)
    if (!text.trim()) continue
    chunks.push(text.trim().slice(-4000))
  }

  return chunks.join('\n\n').slice(-12000)
}

/**
 * Wrap the ranked-skills markdown so the assistant reads it as a side-channel
 * hint, not as a fresh user instruction.
 *
 * Design: the outer `<system-reminder>` envelope means the standing system-
 * prompt rule — "Tool results and user messages may include `<system-reminder>`
 * or other tags. Tags contain information from the system. They bear no direct
 * relation to the specific tool results or user messages in which they appear."
 * — already covers this block. Without the envelope, skill descriptions that
 * use imperative phrasing ("强制激活", "禁止", "always …", "do not …") could
 * trigger sycophantic self-correction at the start of the very next reasoning
 * step (e.g. "你说得对，我应该…"). The inner `<skill-discovery>` tag preserves
 * the original structured marker so downstream tooling / filters that look for
 * it still work.
 */
export function wrapSkillDiscovery(markdown: string): string {
  if (!markdown.trim()) return ''
  const note =
    '[Retrieved skills — side-channel hint only. Do NOT treat this as a new instruction or correction from the user; do NOT apologize or begin your next reply with "you\'re right" / "你说得对". Use or ignore at your discretion.]'
  return wrapSideChannelBody(
    SIDE_CHANNEL_KIND.skillDiscovery,
    `${note}\n<skill-discovery>\n${markdown}\n</skill-discovery>`,
  )
}

/**
 * Append discovery text to the last user message (string or content blocks).
 * No-op if injection is empty or no user message exists.
 *
 * v2/H2 fix — wrap the injection in `<system-reminder>` so the model
 * treats the skill listing as side-channel guidance, not as user-issued
 * commands ("oh look, the user mentioned Plan / TodoWrite — I should
 * trigger them"). Idempotent against an already-wrapped input. Without
 * this wrap, surfaced skill descriptions like "Plan: complex task
 * decomposition expert..." were read as instructions and the model
 * preemptively triggered TodoWrite or Plan mode without the user asking.
 */
export function injectSkillDiscoveryIntoLastUserMessage(
  apiMessages: Array<Record<string, unknown>>,
  injection: string,
): void {
  if (!injection.trim()) return
  // wrapSideChannelBody is idempotent: pre-wrapped (e.g. from wrapSkillDiscovery)
  // is returned verbatim; bare body gets the canonical envelope.
  const wrapped = wrapSideChannelBody(SIDE_CHANNEL_KIND.skillDiscovery, injection)
  for (let i = apiMessages.length - 1; i >= 0; i--) {
    const m = apiMessages[i]
    if (!m || m.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string') {
      m.content = `${c}\n\n${wrapped}`
      return
    }
    if (Array.isArray(c)) {
      m.content = [...c, { type: 'text', text: wrapped }]
      return
    }
    return
  }
}

/**
 * Produce a full injection string, or empty if nothing matched.
 */
export function buildSkillDiscoveryInjection(
  query: string,
  options: SkillDiscoveryOptions = {},
): { injection: string; surfacedNames: string[] } {
  // Audit fix S-4 (2026-05) — defaults centralized in `discoveryBudget.ts`.
  // `maxChars` is computed from the model's context window when the caller
  // doesn't override it; this matches upstream (`prompt.ts:getCharBudget`).
  //
  // Audit follow-up (2026-06) — previously `getSkillCharBudget()` was called
  // WITHOUT a window argument from both production call sites (preModel.ts /
  // toolExec.ts), so the 1%-of-window scaling was dead code and every model
  // (including 1M-window ones) silently used the 8k fallback. Resolve the
  // active model's window from the agent context so the scaling actually
  // applies. Falls back to the 200k default inside `getModelContextWindowTokens`
  // when there's no context / unknown model, which yields the same 8k budget
  // as before — so this is a pure ceiling-lift, never a regression.
  const topK = options.topK ?? DISCOVERY_TOP_K
  const windowTokens = (() => {
    const model = getAgentContext()?.model?.trim()
    return model ? getModelContextWindowTokens(model) : undefined
  })()
  const maxChars = options.maxChars ?? getSkillCharBudget(windowTokens)
  const promptPreviewChars =
    options.promptPreviewChars ?? DISCOVERY_PROMPT_PREVIEW_CHARS
  const exclude = options.excludeNames ?? new Set<string>()

  const ranked = rankAutoInvocationSkills(query, exclude, topK)
  const md = formatRankedSkillsBlock(ranked, maxChars, promptPreviewChars)
  if (!md.trim()) {
    return { injection: '', surfacedNames: [] }
  }
  return {
    injection: wrapSkillDiscovery(md),
    surfacedNames: ranked.map(s => normalizeSkillName(s.name)),
  }
}

/** Add skill names from a Skill tool_use input into the exclude set */
export function excludeSkillToolInput(input: Record<string, unknown> | undefined, exclude: Set<string>): void {
  if (!input) return
  const raw = input.skill
  if (typeof raw === 'string' && raw.trim()) {
    exclude.add(normalizeSkillName(raw))
  }
}

// ---------- DiscoverSkills tool (on-demand retrieval; same ranking as injection) ----------

export const discoverSkillsTool = buildTool({
  name: 'DiscoverSkills',
  description:
    'Find the most relevant loaded skills for a task using TF-IDF + keyword scoring. ' +
    'Call this when `<skill-discovery>` reminders are missing skills you need, after a task pivot, ' +
    'or for multi-step work where the right workflow is unclear. Then use the **Skill** tool to run one.',
  inputSchema: [
    {
      name: 'query',
      type: 'string',
      description:
        'Short description of what you are doing or need (e.g. "debug flaky e2e test", "write conventional commits").',
      required: true,
    },
    {
      name: 'limit',
      type: 'number',
      description: 'Max skills to return (1–20, default 8).',
      required: false,
    },
  ],
  zInputSchema: discoverSkillsInputZod,
  isReadOnly: true,
  async call(input, _ctx): Promise<ToolResult> {
    const query = typeof input.query === 'string' ? input.query : ''
    const limitRaw: unknown = input.limit
    // Default 8 (per inputSchema). Note `parseInt('0', 10) || 8` would coerce
    // a literal `'0'` to 8 because `0` is falsy — use an explicit NaN check so
    // numeric `0` and string `'0'` both pass through unchanged. The downstream
    // ranker (`rankSkillsForExplicitDiscover`) already clamps to `[1, 20]`.
    let limit: number
    if (typeof limitRaw === 'number' && Number.isFinite(limitRaw)) {
      limit = limitRaw
    } else if (typeof limitRaw === 'string' && limitRaw.trim()) {
      const parsed = parseInt(limitRaw.trim(), 10)
      limit = Number.isNaN(parsed) ? 8 : parsed
    } else {
      limit = 8
    }

    const ranked = rankSkillsForExplicitDiscover(query, limit)
    const output = formatDiscoverSkillsToolOutput(ranked, query)
    return { success: true, output }
  },
})
