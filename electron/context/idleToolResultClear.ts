/**
 * Idle-time tool result clearing (upstream §4.1.1 time-triggered path, simplified).
 * Replaces body of old tool_result blocks with a short placeholder; keeps the most recent N tool-result groups.
 *
 * upstream alignment (`services/compact/microCompact.ts#COMPACTABLE_TOOLS`):
 * only tools whose output is cheaply replayable / safely droppable are
 * considered for clearing. Anything not on the whitelist is left intact
 * even when it falls past the keep-recent window. This is strictly safer
 * than the previous "blacklist of protected tools, clear everything
 * else" approach: novel / domain-specific tools no longer have their
 * outputs silently disappear after idle gaps.
 */

import {
  SIDE_CHANNEL_KIND,
  detectSideChannelKindFromText,
} from '../constants/sideChannelKinds'
import { annotateNarrationForClearedEvidence } from './clearedEvidenceAnnotation'
import { extractEditNextHint } from '../ai/toolResultBudget'

const DEFAULT_PLACEHOLDER = '[Old tool result content cleared]'

/**
 * 2026-06 long-run hallucination fix — ledger TTL.
 *
 * The deterministic tool-batch ledger (`[Previous tool batch ledger —
 * host-generated]`, see `toolUseSummary.ts#formatDeterministicToolLedgerForInjection`)
 * is embedded as a `text` block in the SAME user message as the batch's
 * `tool_result` blocks. Before this fix, idle-clear replaced the
 * tool_result bodies (the evidence) with a placeholder but left the
 * ledger (the host-authored "-> success" claims) intact forever. The
 * resulting "evidence cleared, claims persist" asymmetry primes
 * long-run models to treat declarative completion text as the factual
 * record — one of the root causes of premature "全部修正完毕"-style
 * completion claims. Clearing the ledger together with its results
 * keeps claim and evidence on the same lifetime.
 */
function isToolBatchLedgerTextBlock(block: Record<string, unknown>): boolean {
  if (block.type !== 'text' || typeof block.text !== 'string') return false
  return (
    detectSideChannelKindFromText(block.text) === SIDE_CHANNEL_KIND.toolBatchLedger
  )
}

/**
 * upstream parity — `services/compact/microCompact.ts#COMPACTABLE_TOOLS`.
 * Whitelist of tool names whose `tool_result` content is safe to clear
 * after the idle window elapses:
 *
 *   - File system reads / searches: Read, Glob, Grep, list_files
 *   - Shell command output: Bash, PowerShell
 *   - Web fetches: WebSearch, WebFetch
 *   - Edit / Write: their output is "OK, file written" — replayable
 *     from current FS state on next access.
 *
 * Both PascalCase and snake_case variants are listed because the
 * codebase uses both conventions in different layers.
 */
const COMPACTABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  // file reads / searches
  'Read', 'read_file',
  'Glob', 'glob',
  'Grep', 'grep',
  'list_files',
  // shell
  'Bash', 'bash',
  'PowerShell', 'powershell',
  // web
  'WebSearch', 'web_search',
  'WebFetch', 'web_fetch',
  // edits
  'Edit', 'edit',
  'edit_file',
  'multi_edit_file',
  'Write', 'write',
  'write_file',
])

/**
 * P1-17 — Names of tools whose `tool_result` MUST NOT be silently cleared
 * even when they appear on the compactable whitelist.
 *
 * Mirrors the protection list in `compact.ts#PROTECTED_TOOL_NAMES_FROM_TRUNCATION`.
 * Read receipts feed `writeIntegrityGuard` (refuses Edit/Write unless the
 * file was previously Read in this turn). If the Read result is replaced
 * by `[Old tool result content cleared]`, subsequent Edits trip the guard
 * and the model loops re-Reading the same file. The original audit fixed
 * this in micro-compact but missed idle-clear; this list closes the gap.
 *
 * Effective clear-set = COMPACTABLE_TOOL_NAMES − PROTECTED — so even
 * though upstream clears Read, we keep it intact to preserve our
 * stricter write-integrity guard.
 */
const PROTECTED_TOOL_NAMES_FROM_IDLE_CLEAR: ReadonlySet<string> = new Set([
  'Read', 'read_file',
  'list_files',
  'Glob', 'glob',
])

/**
 * 2026-06 multi-turn degradation fix (root cause 5) — search tools whose
 * cleared results keep a one-line summary preview.
 *
 * Grep is compactable (its full match list can be huge) but NOT on the
 * protection list, so before this fix a cleared Grep result became a bare
 * placeholder: the model lost even the knowledge of WHAT was found and
 * tended to either re-run the identical search (→ repetition guard halt)
 * or confabulate the old findings. Keeping the head of the output (plus
 * total size) preserves the anchor at negligible token cost.
 */
const SUMMARY_PRESERVING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Grep', 'grep',
])

const CLEARED_SEARCH_PREVIEW_CHARS = 160

function buildClearedSearchSummary(content: string, placeholder: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  const head = flat.slice(0, CLEARED_SEARCH_PREVIEW_CHARS)
  const ellipsis = flat.length > CLEARED_SEARCH_PREVIEW_CHARS ? '…' : ''
  return `${placeholder} (search summary: ${head}${ellipsis} [${content.length} chars total])`
}

/**
 * Walk the messages once and collect tool_use id sets used by the
 * clearing logic below:
 *
 *   - `protectedIds`  — tool_use ids whose name is on the protection
 *                       list (Read/Glob/list_files). Their results are
 *                       NEVER cleared, even when idle.
 *   - `compactableIds` — tool_use ids whose name is on the whitelist.
 *                        Only these results are eligible for clearing
 *                        once they fall outside the keep-recent window.
 *
 * Tools that are on NEITHER list (e.g. TodoWrite, Agent, ExitPlanMode,
 * MCP tools, custom user tools) are left fully intact by idle-clear.
 * Their content may still be reclaimed by the heavier compact passes
 * (history_snip / micro / auto compact) when those are needed.
 */
function buildToolUseIdSets(
  messages: Array<Record<string, unknown>>,
): { protectedIds: Set<string>; compactableIds: Set<string>; summaryIds: Set<string> } {
  const protectedIds = new Set<string>()
  const compactableIds = new Set<string>()
  const summaryIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block.type !== 'tool_use') continue
      const name = String(block.name ?? '')
      const id = String(block.id ?? '')
      if (!id) continue
      if (PROTECTED_TOOL_NAMES_FROM_IDLE_CLEAR.has(name)) {
        protectedIds.add(id)
      }
      if (COMPACTABLE_TOOL_NAMES.has(name)) {
        compactableIds.add(id)
      }
      if (SUMMARY_PRESERVING_TOOL_NAMES.has(name)) {
        summaryIds.add(id)
      }
    }
  }
  return { protectedIds, compactableIds, summaryIds }
}

/**
 * Extract the readId prefix from a tool_result content string.
 * Preserved in placeholders so the model knows it already read the file.
 */
function extractReadIdPrefix(content: unknown): string {
  if (typeof content !== 'string') return ''
  const m = content.match(/^\[readId:\s*([^\]]+)\]/)
  return m ? m[0] : ''
}

/**
 * Walks from the end of the transcript; keeps the last `keepRecentGroups` user messages that contain tool_result,
 * and replaces string tool_result bodies in older groups with `placeholder`.
 */
/**
 * Default number of recent tool-result groups to keep intact.
 * Raised from 5 → 8 to reduce the chance that a multi-turn task
 * (e.g. "核对 13 项产品") loses intermediate results and re-executes.
 */
export const DEFAULT_KEEP_RECENT_GROUPS = 8

export function clearCompletedToolResultsExceptRecent(
  messages: Array<Record<string, unknown>>,
  keepRecentGroups: number = DEFAULT_KEEP_RECENT_GROUPS,
  placeholder: string = DEFAULT_PLACEHOLDER,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = messages.map((msg) => {
    if (!Array.isArray(msg.content)) return { ...msg }
    return {
      ...msg,
      content: (msg.content as Record<string, unknown>[]).map((b) => ({ ...b })),
    }
  })

  // Whitelist (compactable) + blacklist (protected). See doc above
  // `buildToolUseIdSets`. Effective clear-set = compactable − protected.
  const { protectedIds, compactableIds, summaryIds } = buildToolUseIdSets(messages)

  let toolResultGroups = 0
  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i]
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    const blocks = msg.content as Record<string, unknown>[]
    const hasToolResults = blocks.some((b) => b.type === 'tool_result')
    if (!hasToolResults) continue

    toolResultGroups++
    if (toolResultGroups > keepRecentGroups) {
      // Ledger TTL — drop the embedded tool-batch ledger text block when
      // its sibling tool_results fall outside the keep-recent window.
      const withoutLedger = blocks.filter((b) => !isToolBatchLedgerTextBlock(b))
      let clearedAny = withoutLedger.length !== blocks.length
      const cleared = withoutLedger.map((block) => {
        if (block.type !== 'tool_result') return block
        const tuId = String(block.tool_use_id ?? '')
        // Skip clearing if either:
        //   - the source tool is on the protection list (Read/Glob/…),
        //   - the source tool is NOT on the compactable whitelist
        //     (unknown / novel / custom tools — be conservative).
        if (!tuId) return block
        if (protectedIds.has(tuId)) return block
        if (!compactableIds.has(tuId)) return block
        // Idempotency: anything already starting with the placeholder
        // (bare, readId-noted, or search-summary form) is left alone.
        if (
          typeof block.content === 'string' &&
          !block.content.startsWith(placeholder)
        ) {
          clearedAny = true
          const readId = extractReadIdPrefix(block.content)
          // Preserve the load-bearing breadcrumb: read_file results keep
          // their `[readId:…]` prefix; edit_file / multi_edit_file results
          // keep their next-edit guidance (rotated readId / must-re-read)
          // so a later same-file edit isn't left blind after idle-clear.
          // Without this, edit results became a bare placeholder and the
          // model lost the readId it was told to reuse.
          const editHint = readId ? '' : extractEditNextHint(block.content)
          const note = readId
            ? ` ${readId} (file already read)`
            : editHint
              ? ` (${editHint})`
              : ''
          // Root cause 5 — search tools keep a one-line summary so the
          // model retains WHAT was found without the full match list.
          if (summaryIds.has(tuId)) {
            return { ...block, content: buildClearedSearchSummary(block.content, placeholder) }
          }
          return { ...block, content: `${placeholder}${note}` }
        }
        // Structured content-block array form (modern tool outputs with
        // text + image / document blocks). Before this fix the array
        // branch was silently skipped and arbitrarily-large multimodal
        // results stayed live forever (audit Bug 8).
        if (Array.isArray(block.content) && block.content.length > 0) {
          clearedAny = true
          return { ...block, content: placeholder }
        }
        return block
      })
      result[i] = { ...msg, content: cleared }
      // Root cause 3 — symmetric claim downgrade: the narration that
      // describes this (now-cleared) evidence gets a host note so the
      // model stops reading it as verified fact. Idempotent; no-op when
      // the turn produced no narration text.
      if (clearedAny) {
        annotateNarrationForClearedEvidence(result, i)
      }
    }
  }

  return result
}
