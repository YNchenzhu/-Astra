/**
 * Compact fact ledger — deterministic tool-execution ground truth for
 * the auto-compact summarizer (GAP 2, 2026-06 long-run hallucination
 * audit).
 *
 * ## The laundering problem this closes
 *
 * The post-compact boundary message frames the LLM summary as "the
 * authoritative record of what was already done — do NOT re-do work
 * that's already listed". If the assistant's prose in the pre-compact
 * window contained an UNVERIFIED completion claim ("全部修正完毕"
 * written before/without the matching tool calls), the summarizer has
 * no way to tell claim from fact: the hallucination gets compressed
 * into the authoritative record and persists for the rest of the
 * session. State-contamination research calls this *laundering* —
 * "intervention must occur before contaminated content is compressed
 * into persistent memory" (arXiv 2605.16746).
 *
 * ## The mechanism
 *
 * Before the compact LLM call, the host COUNTS every tool_use /
 * tool_result pair in the window being summarized and renders the
 * totals (plus per-mutating-tool target paths) as a
 * `<host-verified-tool-facts>` block appended to the summarizer's
 * input. The block is pure arithmetic over the transcript — no LLM, no
 * semantic judgement — and the compact prompt instructs the summarizer
 * to record any prose claim WITHOUT a matching counted success as
 * "claimed but NOT verified", never as completed work.
 */

type Msg = Record<string, unknown>
type Block = Record<string, unknown>

export const HOST_VERIFIED_TOOL_FACTS_OPEN_TAG = '<host-verified-tool-facts>'
export const HOST_VERIFIED_TOOL_FACTS_CLOSE_TAG = '</host-verified-tool-facts>'

/**
 * Tools whose successful execution mutates workspace / machine state.
 * For these we additionally list the distinct targets (file paths or
 * command previews) so the summarizer can verify per-file claims, not
 * just totals. Both naming conventions are listed (see
 * `idleToolResultClear.ts#COMPACTABLE_TOOL_NAMES` for precedent).
 */
const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Edit', 'edit', 'edit_file',
  'multi_edit_file', 'MultiEdit',
  'Write', 'write', 'write_file',
  'NotebookEdit', 'notebook_edit',
  'Bash', 'bash',
  'PowerShell', 'powershell',
])

/** Input fields that identify a mutating call's target, checked in order. */
const TARGET_INPUT_KEYS = [
  'file_path',
  'filePath',
  'path',
  'target_file',
  'notebook_path',
  'command',
] as const

/** Cap listed targets per tool per status so the ledger stays bounded. */
export const MAX_TARGETS_PER_STATUS = 20
const MAX_TARGET_CHARS = 120

type ResultStatus = 'success' | 'error' | 'missing'

interface ToolTally {
  success: number
  error: number
  missing: number
  /** Distinct targets by status — only populated for mutating tools. */
  targets: Record<ResultStatus, string[]>
}

function extractTarget(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  for (const key of TARGET_INPUT_KEYS) {
    const v = (input as Record<string, unknown>)[key]
    if (typeof v === 'string' && v.trim()) {
      const flat = v.replace(/\s+/g, ' ').trim()
      return flat.length > MAX_TARGET_CHARS
        ? `${flat.slice(0, MAX_TARGET_CHARS - 1)}…`
        : flat
    }
  }
  return null
}

/**
 * Mirrors `toolUseSummary.ts#toolResultLooksFailed`: `is_error: true`
 * OR string content starting with "Error:". Content cleared to a
 * placeholder by idle-clear / micro-compact keeps its `is_error` flag
 * (the clear passes spread the block), so cleared errors still count
 * as errors here.
 */
function resultStatusOf(result: Block | undefined): ResultStatus {
  if (!result) return 'missing'
  if (result.is_error === true) return 'error'
  const c = result.content
  if (typeof c === 'string' && c.trimStart().startsWith('Error:')) return 'error'
  return 'success'
}

/**
 * Count every tool_use / tool_result pair in `messages`. Exported for
 * tests; production callers use {@link buildCompactToolFactLedger}.
 */
export function tallyToolExecutions(
  messages: ReadonlyArray<Msg>,
): Map<string, ToolTally> {
  const resultsById = new Map<string, Block>()
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (const block of msg.content as Block[]) {
      if (block.type !== 'tool_result') continue
      const id = block.tool_use_id
      if (typeof id === 'string' && id) resultsById.set(id, block)
    }
  }

  const tallies = new Map<string, ToolTally>()
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const block of msg.content as Block[]) {
      if (block.type !== 'tool_use') continue
      const name = typeof block.name === 'string' && block.name ? block.name : '(unknown tool)'
      const id = typeof block.id === 'string' ? block.id : ''
      const status = resultStatusOf(id ? resultsById.get(id) : undefined)

      let tally = tallies.get(name)
      if (!tally) {
        tally = {
          success: 0,
          error: 0,
          missing: 0,
          targets: { success: [], error: [], missing: [] },
        }
        tallies.set(name, tally)
      }
      tally[status] += 1

      if (MUTATING_TOOL_NAMES.has(name)) {
        const target = extractTarget(block.input)
        if (target) {
          const list = tally.targets[status]
          if (!list.includes(target) && list.length < MAX_TARGETS_PER_STATUS) {
            list.push(target)
          }
        }
      }
    }
  }
  return tallies
}

function renderTallyLine(name: string, tally: ToolTally): string[] {
  const parts: string[] = []
  if (tally.success > 0) parts.push(`${tally.success} success`)
  if (tally.error > 0) parts.push(`${tally.error} error`)
  if (tally.missing > 0) parts.push(`${tally.missing} missing result`)
  const lines = [`- ${name}: ${parts.join(', ')}`]
  for (const status of ['success', 'error'] as const) {
    const targets = tally.targets[status]
    if (targets.length > 0) {
      lines.push(`  - ${status} targets: ${targets.join('; ')}`)
    }
  }
  return lines
}

/**
 * Render the `<host-verified-tool-facts>` block for the messages being
 * summarized. Returns `''` when the window contains no tool_use at all
 * (nothing to verify against — the caller omits the block).
 *
 * IMPORTANT: the rendered text must never contain the compact-body
 * marker sequence `\n\n---\n` — `autoCompact`'s prompt-too-long retry
 * slices on the FIRST occurrence of that marker and would otherwise
 * cut the ledger in half. The line-based format below cannot produce
 * it (no line consists solely of `---`).
 */
export function buildCompactToolFactLedger(
  messages: ReadonlyArray<Msg>,
): string {
  const tallies = tallyToolExecutions(messages)
  if (tallies.size === 0) return ''

  let totalCalls = 0
  let totalSuccess = 0
  let totalError = 0
  let totalMissing = 0
  let mutatingSuccess = 0
  for (const [name, t] of tallies) {
    totalCalls += t.success + t.error + t.missing
    totalSuccess += t.success
    totalError += t.error
    totalMissing += t.missing
    if (MUTATING_TOOL_NAMES.has(name)) mutatingSuccess += t.success
  }

  const mutating: string[] = []
  const readOnly: string[] = []
  // Deterministic order — sorted by tool name so the ledger is stable
  // across runs on the same transcript.
  for (const name of [...tallies.keys()].sort((a, b) => a.localeCompare(b))) {
    const lines = renderTallyLine(name, tallies.get(name)!)
    if (MUTATING_TOOL_NAMES.has(name)) mutating.push(...lines)
    else readOnly.push(...lines)
  }

  const lines: string[] = [
    HOST_VERIFIED_TOOL_FACTS_OPEN_TAG,
    '[Host-verified tool execution facts — deterministic, counted from the transcript]',
    'The host counted every tool_use/tool_result pair in the window you are summarizing. These counts are ground truth and OVERRIDE any assistant narrative. If the assistant prose claims an edit / write / run / create that is NOT reflected below as a counted success, record it as "claimed but NOT verified by tool results" — never as completed work.',
    '',
    `Totals: ${totalCalls} tool call(s) — ${totalSuccess} success, ${totalError} error, ${totalMissing} missing result. Mutating successes: ${mutatingSuccess}.`,
  ]
  if (mutating.length > 0) {
    lines.push('Mutating calls (state-changing — verify completion claims against these):')
    lines.push(...mutating)
  } else {
    lines.push('Mutating calls: NONE — any completion claim about edits/writes/runs in this window is unverified.')
  }
  if (readOnly.length > 0) {
    lines.push('Read-only / other calls:')
    lines.push(...readOnly)
  }
  lines.push(HOST_VERIFIED_TOOL_FACTS_CLOSE_TAG)
  return lines.join('\n')
}
