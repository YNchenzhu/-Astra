/**
 * Spill oversized tool_result text to disk (upstream-style) so the model sees a short preview.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { ToolResult } from '../tools/types'
import {
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  MAX_TOOL_RESULT_BYTES,
  MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
  SKILL_INSTRUCTIONS_BLOCK_CAP_CHARS,
  TOOL_RESULT_SPILL_PREVIEW_CHARS,
} from '../constants/toolLimits'
import { safeSliceCodeUnits, safeSliceTailCodeUnits } from '../utils/unicodeSanitize'
import { CHANGE_SUMMARY_MARKER_RE } from './changeSummary'

/** upstream report §4.4 §6 — default inline cap before spill to disk（与 {@link DEFAULT_MAX_RESULT_SIZE_CHARS} 同源） */
export const OPENCLAUDE_DEFAULT_INLINE_TOOL_RESULT_CHARS = DEFAULT_MAX_RESULT_SIZE_CHARS

/** upstream-style token budget estimate from inline char cap (~4 chars/token heuristic). */
export const OPENCLAUDE_MAX_TOOL_RESULT_TOKENS_ESTIMATE = Math.ceil(
  OPENCLAUDE_DEFAULT_INLINE_TOOL_RESULT_CHARS / 4,
)

const DEFAULT_MAX_CHARS = DEFAULT_MAX_RESULT_SIZE_CHARS
const PREVIEW_CHARS = TOOL_RESULT_SPILL_PREVIEW_CHARS

function resolveToolResultsSpillDir(): string {
  const override = process.env.ASTRA_TOOL_RESULTS_DIR?.trim()
  if (override) return path.resolve(override)
  try {
    // Lazy-load `electron` so this module stays importable from vitest
    // (where no Electron runtime is present) — static import would crash
    // on module evaluation and poison the whole test suite.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron')
    if (typeof app?.getPath === 'function') {
      return path.join(app.getPath('userData'), 'tool-results')
    }
  } catch {
    /* vitest / non-electron */
  }
  return path.join(os.tmpdir(), 'astra-tool-results')
}

/**
 * Best-effort cleanup of spilled tool-result files older than `maxAgeMs`.
 *
 * Safe to call repeatedly. `persistedResultPath` on `ToolResult` exists only
 * as a provenance breadcrumb — no runtime code re-reads these files — so
 * removing aged entries cannot break an in-flight loop. All fs errors are
 * swallowed; the cleanup must never throw into the agentic loop.
 *
 * Triggered every 50 iterations from `runAgenticLoop` to bound on-disk
 * accumulation during long-running sessions (see ECC `agenticLoop.ts`).
 */
export const TOOL_RESULTS_CLEANUP_DEFAULT_MAX_AGE_MS = 60 * 60 * 1000

export function cleanupOldToolResults(maxAgeMs: number = TOOL_RESULTS_CLEANUP_DEFAULT_MAX_AGE_MS): {
  removed: number
  errors: number
} {
  let removed = 0
  let errors = 0
  let dir: string
  try {
    dir = resolveToolResultsSpillDir()
  } catch {
    return { removed: 0, errors: 1 }
  }
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    // Directory may not exist yet (no spill has happened) — that's fine.
    return { removed: 0, errors: 0 }
  }
  const cutoff = Date.now() - maxAgeMs
  for (const entry of entries) {
    const filePath = path.join(dir, entry)
    try {
      const stat = fs.statSync(filePath)
      if (!stat.isFile()) continue
      if (stat.mtimeMs >= cutoff) continue
      fs.unlinkSync(filePath)
      removed++
    } catch {
      errors++
    }
  }
  return { removed, errors }
}

export type ToolResultBudgetOptions = {
  maxChars?: number
  toolUseId?: string
}

/**
 * 2026-07 uplift #13 — tool-aware spill-preview split.
 *
 * Command-style tools (shell / test / build runners) put the load-bearing
 * conclusion at the END of their output: the failing-test summary, the
 * compiler error list, the exit status. The legacy fixed 60/40
 * head-weighted split buried exactly that part in the spilled file. These
 * tools now get a 30/70 tail-weighted preview; everything else (file
 * reads, grep, web fetch) keeps the head-weighted default because their
 * head carries the identity breadcrumbs (`[readId: …]`, match headers).
 */
const TAIL_WEIGHTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'bash', 'Bash',
  'powershell', 'PowerShell',
  'shell', 'Shell',
])

const HEAD_WEIGHTED_SPLIT = { head: 0.6, tail: 0.4 } as const
const TAIL_WEIGHTED_SPLIT = { head: 0.3, tail: 0.7 } as const

/** Resolve the preview split for a tool. Exported for tests. */
export function spillPreviewSplitForTool(
  toolName: string,
): { head: number; tail: number } {
  return TAIL_WEIGHTED_TOOL_NAMES.has(toolName)
    ? TAIL_WEIGHTED_SPLIT
    : HEAD_WEIGHTED_SPLIT
}

export function applyToolResultSizeBudget(
  _toolName: string,
  result: ToolResult,
  options?: ToolResultBudgetOptions,
): ToolResult {
  if (!result.success) return result
  let text = result.output ?? ''
  if (text.length > MAX_TOOL_RESULT_BYTES) {
    // UTF-16-safe slice so we never leave a lone surrogate at the boundary
    // (would break strict serde_json parsers downstream — see unicodeSanitize.ts).
    text = safeSliceCodeUnits(text, MAX_TOOL_RESULT_BYTES)
    result = { ...result, output: text }
  }
  const max = options?.maxChars ?? DEFAULT_MAX_CHARS
  if (text.length <= max) return result

  const dir = resolveToolResultsSpillDir()
  fs.mkdirSync(dir, { recursive: true })
  const id = (options?.toolUseId || `${Date.now()}`).replace(/[^\w.-]+/g, '_')
  const filePath = path.join(dir, `${id}.txt`)

  // Idempotent persist (upstream parity, fileHistory.ts L162 — `flag: 'wx'`).
  //
  // `tool_use_id` is unique per invocation AND the spilled content is
  // deterministic for a given id (same tool call → same output text).
  // microcompact / message-replay paths in the agentic loop can ask us
  // to persist the SAME result multiple times during one session; using
  // `wx` (exclusive create) means the first call wins and subsequent
  // calls cheaply observe EEXIST and skip the write.
  //
  // Net effect: at most ONE disk write per (toolUseId, text), regardless
  // of how many turns replay through this code. Falling back through the
  // EEXIST branch is cheap (one statSync-equivalent syscall) and the
  // preview the model receives downstream is computed from `text` in
  // memory, not re-read from disk, so the on-disk file's age is
  // irrelevant to correctness.
  try {
    fs.writeFileSync(filePath, text, { encoding: 'utf-8', flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    /* already persisted for this toolUseId — skip re-write */
  }
  try {
    const metaPath = `${filePath}.meta.json`
    const charCount = text.length
    // Same `wx` idempotency for the sidecar. Re-spilling the same id
    // with the same content shouldn't churn metadata mtimes — that
    // would also poison any prompt-cache key derived from the sidecar
    // (none today, but the contract is the safer one).
    fs.writeFileSync(
      metaPath,
      JSON.stringify(
        {
          toolUseId: options?.toolUseId ?? null,
          toolName: _toolName,
          charCount,
          maxChars: max,
          estimatedTokensApprox: Math.ceil(charCount / 4),
          openClaudeMaxToolResultTokensEstimate: OPENCLAUDE_MAX_TOOL_RESULT_TOKENS_ESTIMATE,
          spilledAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { encoding: 'utf-8', flag: 'wx' },
    )
  } catch (e) {
    // EEXIST is the expected idempotent re-spill; anything else is the
    // pre-existing best-effort behaviour (we never block on metadata).
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      /* best-effort metadata for upstream-style tool result storage parity (§4.3 / §4.6) */
    }
  }
  // Use a head+tail preview so critical conclusions (often at the end) are
  // visible to the model, not buried in the spilled file. The split is
  // tool-aware (2026-07 uplift #13): command output puts its verdict at the
  // END (test summary, build errors, exit status), so shell tools get a
  // tail-weighted split; file reads keep the head-weighted default.
  const split = spillPreviewSplitForTool(_toolName)
  const headChars = Math.floor(PREVIEW_CHARS * split.head)
  const tailChars = Math.floor(PREVIEW_CHARS * split.tail)
  const preview =
    text.length <= PREVIEW_CHARS
      ? text
      : `${safeSliceCodeUnits(text, headChars)}\n\n…[${text.length - headChars - tailChars} chars omitted; full text in ${filePath}]…\n\n${safeSliceTailCodeUnits(text, tailChars)}`

  // For read_file results, extract readId and file range info from the
  // output so the model knows WHAT file was read and which lines, even
  // when the content body was truncated. This prevents the model from
  // re-reading with overlapping ranges to "get the missing middle."
  const readIdPrefix = extractReadIdPrefix(text)
  const toolNote = _toolName === 'read_file' && readIdPrefix
    ? `\n${readIdPrefix} — file content was truncated to head+tail preview above. The full content written to disk matches what you requested. Do NOT re-read with different offset/limit unless you need lines outside the preview range.`
    : ''

  return {
    ...result,
    output: `[Tool output too large (${text.length} chars); full text written to ${filePath}]${toolNote}\n\nPreview:\n${preview}`,
    persistedResultPath: filePath,
  }
}

/** Rough char count for message-level budgeting (future compact hook). */
export function estimateToolResultChars(result: ToolResult): number {
  let n = (result.output?.length ?? 0) + (result.error?.length ?? 0)
  if (result.contentBlocks) {
    for (const b of result.contentBlocks) {
      n += (b.base64?.length ?? 0) + (b.mediaType?.length ?? 0)
    }
  }
  return n
}

/**
 * Per-block cap for a single `tool_result.content`. When any individual
 * result exceeds this cap it is clamped **regardless of the global
 * {@link MAX_TOOL_RESULTS_PER_MESSAGE_CHARS} budget** — previously a single
 * 400k-char result could dominate the whole message budget on its own and
 * still reach the wire untouched (audit Bug 7).
 *
 * Chosen to match the inline `DEFAULT_MAX_RESULT_SIZE_CHARS` used at tool
 * execution time — anything that survived the tool-level spill but still
 * exceeds this cap in history is by definition stale / long-lived and
 * benefits from further summarisation.
 */
const DEFAULT_PER_BLOCK_CAP_CHARS = DEFAULT_MAX_RESULT_SIZE_CHARS

/**
 * Extract the readId prefix from a tool_result content string.
 * read_file results start with `[readId: xxxx] — REQUIRED:...`.
 * Preserving this prefix in truncated placeholders lets the model know
 * it already read this file, preventing re-read loops after compaction.
 */
function extractReadIdPrefix(content: string): string {
  const m = content.match(/^\[readId:\s*([^\]]+)\]/)
  return m ? m[0] : ''
}

/**
 * Extract the edit_file / multi_edit_file "what to do on the next edit"
 * guidance from a tool-result body so the history-budget clamp can preserve
 * it in the placeholder instead of wiping it.
 *
 * Mirrors {@link extractReadIdPrefix}'s role for read_file results. Without
 * it, an edit result swept by the global tool-result budget loses BOTH the
 * rotated readId AND the "next edit requires a fresh read_file" warning that
 * {@link import('../tools/readFileState').buildNextEditTrailer} appended — so
 * a later same-file edit edits blind (re-echoes a stale readId, or skips the
 * read it actually needed). Unlike the read_file prefix, this trailer lives
 * near the START of the (short) edit output but is NOT a `[readId:` prefix,
 * so the read_file extractor never matched it.
 *
 * Also preserves the `[change-summary: …]` breadcrumb (see
 * {@link import('./changeSummary').buildChangeSummaryTrailer}) so a later loop
 * still knows WHAT an earlier edit changed even after the body is compacted to
 * a placeholder — this is the "AI forgets what it edited" fix (2026-07).
 *
 * Returns a concise note (no surrounding parens) or '' when none of the
 * branches are present.
 */
export function extractEditNextHint(content: string): string {
  const parts: string[] = []
  // Refreshed branch: "readId for next edit: <id> — REQUIRED: …".
  const idMatch = content.match(/readId for next edit:\s*([^\s—)\]]+)/)
  if (idMatch) {
    parts.push(
      `readId for next edit: ${idMatch[1]} — pass as baseReadId on the next ` +
      `edit_file/multi_edit_file for this path; no re-read needed`,
    )
  } else if (content.includes('NEXT EDIT REQUIRES A FRESH read_file')) {
    // Null branch: the self-mutation receipt could not be refreshed → the next
    // edit on this path MUST re-read first.
    parts.push('NEXT EDIT REQUIRES A FRESH read_file before editing this path again')
  }
  // Change-summary breadcrumb: keep the one-line "+A/-R lines @ L.." so the
  // model retains what it changed even when the full result body is gone.
  const changeMatch = content.match(CHANGE_SUMMARY_MARKER_RE)
  if (changeMatch) {
    parts.push(`changed: ${changeMatch[1].trim()}`)
  }
  return parts.join('; ')
}

/**
 * Build the parenthetical note appended to a clamp placeholder so the model
 * still sees the load-bearing breadcrumb of a truncated tool result:
 *   - read_file results keep their `[readId: …]` prefix.
 *   - edit_file / multi_edit_file results keep their next-edit readId /
 *     "must re-read" guidance (see {@link extractEditNextHint}).
 * Returns '' when there is nothing worth preserving.
 */
function buildClampPreservedNote(content: string): string {
  const readPrefix = extractReadIdPrefix(content)
  if (readPrefix) return ` (${readPrefix} — file already read, content compacted)`
  const editHint = extractEditNextHint(content)
  if (editHint) return ` (${editHint})`
  return ''
}

/**
 * Detects the Skill tool's inline payload (skill-adherence audit, 2026-06):
 * `Skill: <name>` first line + a `<skill-instructions>` envelope near the
 * top (see `formatInlineSkillInstructionsOutput` in `skillTool.ts`).
 *
 * Skill blocks carry the ACTIVE workflow directives for the current task —
 * clamping them to a `[tool_result truncated ...]` placeholder physically
 * deletes the instructions the model is supposed to keep following, which
 * was the root cause of "skill followed for 2-3 turns, then drift". They
 * are exempted from the oldest-first global-budget pass below, and the
 * per-block pass keeps the instruction HEAD instead of a bare placeholder.
 */
export function isSkillInstructionsBlock(content: string): boolean {
  if (!content.startsWith('Skill: ')) return false
  return content.slice(0, 800).includes('<skill-instructions')
}

export interface ClampToolResultsOptions {
  /** Global per-message total char budget. Defaults to {@link MAX_TOOL_RESULTS_PER_MESSAGE_CHARS}. */
  maxTotalChars?: number
  /** Per-tool_result upper bound before forced summarisation. Defaults to {@link DEFAULT_PER_BLOCK_CAP_CHARS}. */
  perBlockCapChars?: number
  /**
   * Per-block cap for `<skill-instructions>` blocks specifically. Skill
   * bodies are ACTIVE workflow directives, not data — clamping them at the
   * generic 50k {@link DEFAULT_PER_BLOCK_CAP_CHARS} amputated the tail of
   * any SKILL.md the Skill tool let ride whole (its inline cap is 120k).
   * Defaults to {@link SKILL_INSTRUCTIONS_BLOCK_CAP_CHARS}, shared with
   * `skillTool.maxResultChars` so the two never drift.
   */
  skillBlockCapChars?: number
  /**
   * 2026-07 uplift #10 — relevance-weighted eviction. Lowercased path-like
   * terms from the CURRENTLY OPEN work items (see
   * `electron/context/activeTaskRelevance.ts`). When non-empty, the
   * global-budget sweep (pass 2) evicts blocks whose content mentions NONE
   * of these terms first (oldest-first within each group), so tool results
   * tied to the active task survive the longest. Empty / omitted ⇒ legacy
   * pure oldest-first order. Per-block caps (pass 1) are unaffected.
   * Kill-switch: `POLE_CLAMP_RELEVANCE=0`.
   */
  relevanceTerms?: string[]
}

/** How much of a block's head is scanned for relevance terms. Paths and
 *  readId breadcrumbs live near the top of tool outputs; scanning the
 *  whole of a 50k block per term would be wasted work. */
const RELEVANCE_SCAN_HEAD_CHARS = 2_000

function isClampRelevanceEnabled(): boolean {
  const raw = process.env.POLE_CLAMP_RELEVANCE?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
}

function contentMentionsAnyTerm(
  content: string,
  terms: ReadonlyArray<string>,
): boolean {
  const head = content.slice(0, RELEVANCE_SCAN_HEAD_CHARS).toLowerCase()
  for (const term of terms) {
    if (head.includes(term)) return true
  }
  return false
}

/**
 * If total `tool_result` string content in the transcript exceeds
 * {@link ClampToolResultsOptions.maxTotalChars}, OR if any single block
 * exceeds {@link ClampToolResultsOptions.perBlockCapChars}, replace the
 * offending bodies with a short placeholder.
 *
 * Overload kept for callers that pass a plain number.
 */
export function clampToolResultsInMessages(
  messages: Array<Record<string, unknown>>,
  options?: number | ClampToolResultsOptions,
): Array<Record<string, unknown>> {
  const opts: ClampToolResultsOptions =
    typeof options === 'number'
      ? { maxTotalChars: options }
      : options ?? {}
  const maxTotalChars = opts.maxTotalChars ?? MAX_TOOL_RESULTS_PER_MESSAGE_CHARS
  const perBlockCapChars = opts.perBlockCapChars ?? DEFAULT_PER_BLOCK_CAP_CHARS
  const skillBlockCapChars = opts.skillBlockCapChars ?? SKILL_INSTRUCTIONS_BLOCK_CAP_CHARS
  const relevanceTerms =
    isClampRelevanceEnabled() && opts.relevanceTerms && opts.relevanceTerms.length > 0
      ? opts.relevanceTerms
      : []

  // Skill blocks get the higher skill cap; everything else the generic cap.
  // Single source so the offender gate and Pass 1 agree per block.
  const capFor = (isSkill: boolean): number =>
    isSkill ? skillBlockCapChars : perBlockCapChars

  let total = 0
  const blocks: {
    msgIdx: number
    blockIdx: number
    len: number
    isSkill: boolean
    relevant: boolean
  }[] = []
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    const arr = msg.content as Record<string, unknown>[]
    for (let bi = 0; bi < arr.length; bi++) {
      const b = arr[bi]
      if (b.type === 'tool_result' && typeof b.content === 'string') {
        const len = b.content.length
        total += len
        blocks.push({
          msgIdx: mi,
          blockIdx: bi,
          len,
          isSkill: isSkillInstructionsBlock(b.content),
          relevant:
            relevanceTerms.length > 0 &&
            contentMentionsAnyTerm(b.content, relevanceTerms),
        })
      }
    }
  }

  const overshoot = Math.max(0, total - maxTotalChars)
  const hasPerBlockOffender = blocks.some((b) => b.len > capFor(b.isSkill))
  if (overshoot === 0 && !hasPerBlockOffender) return messages

  const out = messages.map((m) => ({ ...m }))
  let remainingOverGlobal = overshoot
  // Audit fix A-6 (2026-05) — track per-user-message truncation count
  // so we can append a single aggregated summary block at the end of
  // each affected user turn. The per-block placeholders above stay,
  // but they're buried mid-array and easy for the model to miss; the
  // aggregate gives it a session-level signal to budget re-reads.
  const truncatedCountByMsgIdx = new Map<number, number>()
  const bumpTruncated = (msgIdx: number): void => {
    truncatedCountByMsgIdx.set(msgIdx, (truncatedCountByMsgIdx.get(msgIdx) ?? 0) + 1)
  }

  // Pass 1: clamp any single block that exceeds the per-block cap — this
  // runs unconditionally, so one rogue tool result can't silently camp
  // under the total cap.
  for (const ref of blocks) {
    const cap = capFor(ref.isSkill)
    if (ref.len <= cap) continue
    const msg = out[ref.msgIdx]
    const arr = [...(msg.content as Record<string, unknown>[])]
    const b = arr[ref.blockIdx]
    if (b.type !== 'tool_result' || typeof b.content !== 'string') continue
    // Skill-instructions blocks: keep the HEAD (workflow steps live at the
    // top) instead of replacing the whole body with a placeholder, and
    // point the model back at SKILL.md for the missing tail. The head is
    // sliced at the SKILL cap (120k) — aligned with `skillTool.maxResultChars`
    // so a body that rode whole at injection is not amputated on later rounds.
    // The head includes the `Base directory for this skill:` line emitted by
    // `executeSkill`, so the re-read path is always recoverable.
    if (isSkillInstructionsBlock(b.content)) {
      const kept = safeSliceCodeUnits(b.content, cap)
      arr[ref.blockIdx] = {
        ...b,
        content:
          `${kept}\n[skill instructions truncated at per-block cap ${cap} (was ${ref.len} chars) — ` +
          're-read SKILL.md under the skill base directory above if later steps are missing]',
      }
      remainingOverGlobal -= Math.max(0, ref.len - kept.length)
      out[ref.msgIdx] = { ...msg, content: arr }
      bumpTruncated(ref.msgIdx)
      // Mark so pass 2 skips.
      ref.len = 0
      continue
    }
    const prefixNote = buildClampPreservedNote(b.content)
    arr[ref.blockIdx] = {
      ...b,
      content: `[tool_result truncated — single block was ${ref.len} chars > per-block cap ${perBlockCapChars}${prefixNote}]`,
    }
    remainingOverGlobal -= Math.max(0, ref.len - 48)
    out[ref.msgIdx] = { ...msg, content: arr }
    bumpTruncated(ref.msgIdx)
    // Mark so pass 2 skips.
    ref.len = 0
  }

  // Pass 2: if global budget is still exceeded, clamp additional blocks.
  // Eviction order (2026-07 uplift #10): blocks NOT mentioning any active-
  // task relevance term go first (oldest-first within the group); blocks
  // tied to the open work items go last, so the model keeps the results it
  // is actively working against. With no relevance terms this reduces to
  // the legacy pure oldest-first order (stable partition of one group).
  const evictionOrder =
    relevanceTerms.length > 0
      ? [...blocks.filter((b) => !b.relevant), ...blocks.filter((b) => b.relevant)]
      : blocks
  for (const ref of evictionOrder) {
    if (remainingOverGlobal <= 0) break
    if (ref.len === 0) continue
    const msg = out[ref.msgIdx]
    const arr = [...(msg.content as Record<string, unknown>[])]
    const b = arr[ref.blockIdx]
    if (b.type !== 'tool_result' || typeof b.content !== 'string') continue
    // Skill-instructions blocks are exempt from the oldest-first sweep:
    // skills are typically invoked EARLY in a session, which made their
    // workflow text the very first victim of this pass — physically
    // deleting the directives the model is still expected to follow.
    // Surrounding read/grep/bash results absorb the budget instead.
    if (isSkillInstructionsBlock(b.content)) continue
    const len = b.content.length
    // Preserve the load-bearing breadcrumb so the model still knows it
    // already read a read_file path, or what the next edit on this path
    // needs (rotated readId / must-re-read), even after compaction.
    const prefixNote = buildClampPreservedNote(b.content)
    arr[ref.blockIdx] = {
      ...b,
      content: `[tool_result truncated for context budget — was ${len} chars${prefixNote}]`,
    }
    remainingOverGlobal -= Math.max(0, len - 48)
    out[ref.msgIdx] = { ...msg, content: arr }
    bumpTruncated(ref.msgIdx)
  }

  // Audit fix A-6 — append a single summary block per affected user
  // message so the model gets a global "N tool results truncated"
  // signal instead of having to scan every inline placeholder.
  for (const [msgIdx, count] of truncatedCountByMsgIdx) {
    if (count <= 0) continue
    const msg = out[msgIdx]
    if (!Array.isArray(msg.content)) continue
    const arr = [...(msg.content as Record<string, unknown>[])]
    arr.push({
      type: 'text',
      text: `[tool result budget — ${count} tool result${
        count === 1 ? '' : 's'
      } in this turn were truncated to placeholders; re-call the relevant tool if you need the exact bytes]`,
    })
    out[msgIdx] = { ...msg, content: arr }
  }
  return out
}
