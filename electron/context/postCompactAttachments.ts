/**
 * upstream §17.4 — Post-compact attachment generation.
 *
 * After compaction, parallel-generates multiple attachment types to restore
 * the model's awareness of current state:
 *
 * 1. File hints — paths recently seen in tool output (postCompactFileHints.ts)
 * 2. Skill attachments — re-inject invoked skills (invokedSkillsRegistry.ts)
 * 3. Plan file attachment — current plan/todo if one exists
 * 4. Deferred tool delta notification — changes in tool/MCP/agent availability
 * 5. Session memory snippet — inject session memory summary if available
 */

import fs from 'node:fs/promises'
import { estimateTextTokens } from './tokenCounter'
import {
  extractLikelyFilePathsFromMessages,
  buildPostCompactFileHintUserMessage,
} from './postCompactFileHints'
import { getRememberedFilePathsForConversation } from './filePathMemory'
import { getDiffTxStore } from '../diff/DiffTransactionStore'
import type { DiffTransaction } from '../diff/DiffTransactionTypes'
import { summarizeContentChange } from '../ai/changeSummary'
import {
  peekInvokedSkillRecordForAgent,
  renderActiveSkillRebuildBlock,
  takeInvokedSkillsPromptFragmentForAgent,
} from '../skills/invokedSkillsRegistry'
import {
  getSessionMemoryMarkdownPath,
  readSessionMemoryMarkdown,
} from '../session/sessionMemoryPaths'
import { getWorkspacePath } from '../tools/workspaceState'
import { asAgentId } from '../tools/ids'
import {
  hashFileContent,
  listReadReceiptsInCurrentScope,
  recordSelfMutationReadReceipt,
} from '../tools/readFileState'
import { SIDE_CHANNEL_KIND, type SideChannelKind } from '../constants/sideChannelKinds'

export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 5_000
export const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000

export interface PostCompactAttachmentOptions {
  messages: Array<Record<string, unknown>>
  conversationId?: string
  agentId?: string
  /** Active inline-skill session name — see {@link CompactOptions.activeSkillName}. */
  activeSkillName?: string
  planFilePath?: string
  deferredToolDelta?: string[]
}

export interface PostCompactAttachment {
  role: 'user'
  content: string
  _type: 'post_compact_attachment'
  _attachmentKind: string
  /**
   * Hints downstream pipeline that this user message is system-side context,
   * not a fresh user instruction. Picked up by `smooshSystemReminderSiblings`
   * (folding adjacent reminders) and any future consumer that wants to
   * distinguish synthetic context from real user turns.
   */
  _convertedFromSystem: true
  /** Typed kind for the side-channel dictionary — always {@link SIDE_CHANNEL_KIND.postCompactAttachment}. */
  _sideChannelKind: SideChannelKind
}

/**
 * P1-12 — flag the attachment as system-side context (via
 * `_convertedFromSystem`). We deliberately do NOT wrap the body in
 * `<system-reminder>`: the system prompt teaches models to treat
 * reminder-tag content as side-channel noise unrelated to surrounding
 * material, but `<restored-file>` bodies inside post-compact attachments
 * are authoritative and need to be usable as reference. Keep the body
 * plain and let the metadata flag drive pipeline behavior.
 */
function makeAttachment(kind: string, content: string): PostCompactAttachment {
  return {
    role: 'user',
    content,
    _type: 'post_compact_attachment',
    _attachmentKind: kind,
    _convertedFromSystem: true,
    _sideChannelKind: SIDE_CHANNEL_KIND.postCompactAttachment,
  }
}

/**
 * Max files we'll re-verify against disk after compaction.
 *
 * Audit fix C-3 (2026-05): raised 8 → 15. The previous cap left files
 * 9-N as hint-only entries (descriptor: `unchanged: /path` with no
 * body and no readId), which forced the model into extra
 * `read_file → edit_file` round-trips for any multi-file refactor
 * larger than 8 files. 15 covers typical refactor batches while still
 * being well under the total char budget when most files are small.
 */
const POST_COMPACT_MAX_REHYDRATE_FILES = 15
/**
 * Total character budget for **warmup** `<restored-file>` blocks post-compact.
 * Per-file cap is applied separately; this ensures a handful of large files
 * don't blow the whole turn's prompt budget. Tunable via
 * `POLE_POST_COMPACT_RESTORE_TOTAL_CHARS`.
 *
 * Audit fix C-3 (2026-05): raised 8000 → 16000 in lockstep with the
 * 8→15 file-count bump so the additional file slots actually have
 * headroom to carry content rather than degrading to hint-only.
 */
const POST_COMPACT_RESTORE_TOTAL_CHARS = Math.max(
  0,
  Number(process.env.POLE_POST_COMPACT_RESTORE_TOTAL_CHARS ?? '16000'),
)
/**
 * Per-file char cap for warmup restoration — a single monster file can't
 * eat the whole budget.
 */
const POST_COMPACT_RESTORE_PER_FILE_CHARS = Math.max(
  0,
  Number(process.env.POLE_POST_COMPACT_RESTORE_PER_FILE_CHARS ?? '4000'),
)

/**
 * Max files listed in the `<modified-files>` change ledger and the total char
 * budget for that block. The list is cheap (one line per file) so these are
 * generous; a pathological refactor touching hundreds of files still can't
 * blow the prompt. Tunable via env.
 */
const POST_COMPACT_MAX_MODIFIED_FILES = Math.max(
  0,
  Number(process.env.POLE_POST_COMPACT_MAX_MODIFIED_FILES ?? '40'),
)
const POST_COMPACT_MODIFIED_FILES_TOTAL_CHARS = Math.max(
  0,
  Number(process.env.POLE_POST_COMPACT_MODIFIED_FILES_CHARS ?? '4000'),
)

type RehydrateKind = 'unchanged' | 'stale' | 'missing' | 'unknown'

interface RehydrateVerdict {
  kind: RehydrateKind
  descriptor: string
  /** Populated when kind==='unchanged' AND we have a full-view snapshot. */
  restorableBody?: string
  /** sha256 of the restorable body (for the attachment header). */
  restorableHash?: string
  /** True when the original read was a partial view — we refuse to restore. */
  isPartial?: boolean
}

/**
 * Verify on-disk status vs the last Read receipt and produce both a
 * human-readable descriptor AND (when the file is fully `unchanged` from
 * a full-view read) the exact body text ready to splice into a warmup
 * `<restored-file>` block.
 *
 * Returned `restorableBody` is ONLY populated when:
 *   - Disk mtime matches the recorded mtime (fast path) OR content hash
 *     matches after a re-read
 *   - The original read was NOT a partial view (we can't trust we have
 *     the full file otherwise)
 *   - A `contentSnapshot` is present in the read receipt
 */
async function verifyAndDescribeFile(
  absolutePath: string,
  record: {
    mtimeMs?: number
    readAt?: number
    isPartialView?: boolean
    contentHash?: string
    contentSnapshot?: string
    readId?: string
  },
): Promise<RehydrateVerdict> {
  // Surfacing the readId on `unchanged` lines closes the loop that audit
  // fix A-3 (readFileState.ts) promises: "the post-compact file-hints
  // block explicitly listed the file as `unchanged` and supplied a
  // readId". Read receipts live in-process and survive compaction, so the
  // readId is still valid — the model only lost sight of it when the
  // transcript was compacted. Printing it here lets the model pass it
  // straight back as `baseReadId` instead of re-reading.
  const rid = record.readId ? ` readId=${record.readId}` : ''
  try {
    const stat = await fs.stat(absolutePath)
    const recordedMtime = record.mtimeMs ?? 0
    // Fast path: mtime matches.
    if (recordedMtime && Math.abs(stat.mtimeMs - recordedMtime) < 2) {
      const partial = record.isPartialView ? ' (partial view)' : ''
      const h = record.contentHash ? ` hash=${record.contentHash}` : ''
      const canRestore =
        !record.isPartialView && typeof record.contentSnapshot === 'string'
      return {
        kind: 'unchanged',
        descriptor: `- unchanged: \`${absolutePath}\`${partial}${h}${rid}`,
        ...(canRestore
          ? {
              restorableBody: record.contentSnapshot,
              restorableHash: record.contentHash,
            }
          : {}),
        isPartial: record.isPartialView,
      }
    }
    // Content may have changed — re-hash to be sure.
    const body = await fs.readFile(absolutePath, 'utf8')
    const currentHash = hashFileContent(body)
    if (record.contentHash && currentHash === record.contentHash) {
      const canRestore = !record.isPartialView
      return {
        kind: 'unchanged',
        descriptor: `- unchanged: \`${absolutePath}\` (mtime touched, content matches)${rid}`,
        // If the original read was full-view, the body we just read IS the
        // authoritative restorable content (even if `contentSnapshot` was
        // evicted/missing).
        ...(canRestore ? { restorableBody: body, restorableHash: currentHash } : {}),
        isPartial: record.isPartialView,
      }
    }
    return {
      kind: 'stale',
      descriptor: `- stale: \`${absolutePath}\` — content changed since last read; Read again before editing`,
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT') {
      return { kind: 'missing', descriptor: `- missing: \`${absolutePath}\` (no longer on disk)` }
    }
    return {
      kind: 'unknown',
      descriptor: `- unknown: \`${absolutePath}\` (stat failed: ${code ?? 'error'})`,
    }
  }
}

/**
 * Wrap a restorable file body in a `<restored-file>` XML-ish block the model
 * can parse without re-calling Read. The `hash` attribute lets the model
 * verify the content was not fabricated; the `path` attribute is the
 * absolute path as seen at read time.
 */
function buildRestoredFileBlock(
  absolutePath: string,
  body: string,
  hash: string | undefined,
): string {
  const header = hash
    ? `<restored-file path="${absolutePath}" hash="${hash}">`
    : `<restored-file path="${absolutePath}">`
  return `${header}\n${body}\n</restored-file>`
}

async function createFileAttachment(
  messages: Array<Record<string, unknown>>,
  conversationId?: string,
): Promise<PostCompactAttachment | null> {
  // Live extraction from current `messages` (post-snip / post-microCompact).
  const livePaths = extractLikelyFilePathsFromMessages(messages)
  // Snapshot from filePathMemory — captures paths that were present in
  // earlier iterations but may have been snipped/microCompacted away
  // before we reached this attachment-build step (audit D3).
  const rememberedPaths = getRememberedFilePathsForConversation(conversationId)
  // Live wins display order; remembered fills in gaps.
  const seenForHints = new Set<string>()
  const hintedPaths: string[] = []
  for (const p of livePaths) {
    if (!seenForHints.has(p)) {
      seenForHints.add(p)
      hintedPaths.push(p)
    }
  }
  for (const p of rememberedPaths) {
    if (!seenForHints.has(p)) {
      seenForHints.add(p)
      hintedPaths.push(p)
    }
  }
  // Receipts carry absolute paths keyed by normalized string; join both
  // sources so we re-hydrate files we have read-state for even if the
  // hint extractor missed them, and emit plain hints for paths we only
  // know from tool output (no read receipt).
  const receipts = listReadReceiptsInCurrentScope()
  const receiptByPath = new Map<string, (typeof receipts)[number]['record']>()
  for (const r of receipts) receiptByPath.set(r.resolvedPathKey, r.record)

  const verifiedLines: string[] = []
  const restoredBlocks: string[] = []
  const hintOnly: string[] = []

  // Union while preserving order: hints first (most recent reference wins
  // the display slot) then receipts not already covered.
  const seen = new Set<string>()
  const candidateOrder: string[] = []
  for (const p of hintedPaths) {
    if (!seen.has(p)) {
      seen.add(p)
      candidateOrder.push(p)
    }
  }
  for (const r of receipts) {
    if (!seen.has(r.resolvedPathKey)) {
      seen.add(r.resolvedPathKey)
      candidateOrder.push(r.resolvedPathKey)
    }
  }

  let rehydrated = 0
  // Running budget for warmup `<restored-file>` blocks. Separate from the
  // descriptor lines — the status list is always cheap, restoration is what
  // can blow up.
  let restoreBudgetRemaining = POST_COMPACT_RESTORE_TOTAL_CHARS
  for (const p of candidateOrder) {
    const record = receiptByPath.get(p)
    if (record && rehydrated < POST_COMPACT_MAX_REHYDRATE_FILES) {
      const verdict = await verifyAndDescribeFile(p, record)
      verifiedLines.push(verdict.descriptor)
      rehydrated++

      // Warmup: when the file is unchanged and we have the full body within
      // per-file + total budget, splice the content back so the model
      // doesn't need to re-Read at all.
      if (
        verdict.kind === 'unchanged' &&
        verdict.restorableBody !== undefined &&
        verdict.restorableBody.length > 0 &&
        verdict.restorableBody.length <= POST_COMPACT_RESTORE_PER_FILE_CHARS &&
        verdict.restorableBody.length <= restoreBudgetRemaining
      ) {
        restoredBlocks.push(
          buildRestoredFileBlock(p, verdict.restorableBody, verdict.restorableHash),
        )
        restoreBudgetRemaining -= verdict.restorableBody.length
      }
    } else if (!record) {
      hintOnly.push(p)
    }
  }

  const sections: string[] = []
  if (verifiedLines.length > 0) {
    sections.push(
      '[Post-compact — files read during the conversation, with disk status re-verified. `unchanged` lines mean you may reference the prior content without re-reading, and the `readId=` shown there can be passed directly as `baseReadId` when editing that file; `stale` / `missing` require Read before edit.]',
    )
    sections.push(verifiedLines.join('\n'))
  }
  if (restoredBlocks.length > 0) {
    if (sections.length > 0) sections.push('')
    sections.push(
      '[Post-compact warmup — authoritative file contents for the unchanged entries above. You can reference these directly without calling Read again; the `hash` attribute matches the file state at your last Read.]',
    )
    sections.push(restoredBlocks.join('\n\n'))
  }
  const remainingHint = buildPostCompactFileHintUserMessage(hintOnly)
  if (remainingHint) {
    if (sections.length > 0) sections.push('')
    sections.push(remainingHint)
  }
  if (sections.length === 0) return null
  return makeAttachment('file_hints', sections.join('\n'))
}

/**
 * Standalone, PEEK-ONLY variant of the active-skill rebuild for compact
 * paths that do NOT run the full attachment matrix (session-memory compact
 * in `ContextManager.handleContext`). Consumes nothing: the registry's
 * metadata entries stay intact for the pre-model `<invoked-skills>`
 * injection, and the active entry stays rebuildable on later compacts.
 */
export function buildActiveSkillRebuildAttachment(
  agentId?: string,
  activeSkillName?: string,
): PostCompactAttachment | null {
  const active = activeSkillName?.trim()
  if (!active) return null
  const record = peekInvokedSkillRecordForAgent(
    agentId ? asAgentId(agentId) : undefined,
    active,
  )
  if (!record) return null
  const block = renderActiveSkillRebuildBlock(record)
  return block ? makeAttachment('skills', block) : null
}

function createSkillAttachment(
  agentId?: string,
  activeSkillName?: string,
): PostCompactAttachment | null {
  const aid = agentId ? asAgentId(agentId) : undefined
  const active = activeSkillName?.trim()

  // Codex-parity prefix rebuild (2026-07): while an inline skill session is
  // ACTIVE, its workflow text must survive compaction VERBATIM — a metadata
  // pointer ("re-read SKILL.md") is routinely ignored and the model resumes
  // from its (possibly wrong) memory of the rules. Rebuild the recorded body
  // and KEEP the registry entry so the next compact can rebuild it again.
  let rebuildBlock = ''
  if (active) {
    const record = peekInvokedSkillRecordForAgent(aid, active)
    if (record) rebuildBlock = renderActiveSkillRebuildBlock(record)
  }

  const frag = takeInvokedSkillsPromptFragmentForAgent(aid, {
    ...(active && rebuildBlock ? { keepSkillNames: [active] } : {}),
  })
  if (!frag && !rebuildBlock) return null
  if (!frag) return makeAttachment('skills', rebuildBlock)
  // The rebuild block rides OUTSIDE the metadata budget: its body is already
  // hard-capped at INVOKED_SKILL_CONTENT_MAX_CHARS by the registry, and
  // starving the active workflow text to fit a listing budget would defeat
  // the rebuild's purpose.
  const withRebuild = (metaFrag: string): string =>
    rebuildBlock ? `${rebuildBlock}\n\n${metaFrag}` : metaFrag

  const est = estimateTextTokens(frag)
  if (est > POST_COMPACT_SKILLS_TOKEN_BUDGET) {
    // Truncation is XML-aware: the fragment is wrapped in `<invoked-skills>…
    // </invoked-skills>`; a naive char-level slice could drop the closing
    // tag and leave the model with an unbalanced envelope (which then folds
    // unrelated downstream content into the listing). Snap to the last
    // newline first so we don't cut a list item mid-text, then re-emit the
    // closing tag if the slice swallowed it.
    const sliced = frag.slice(0, POST_COMPACT_SKILLS_TOKEN_BUDGET * 4)
    const lastNewline = sliced.lastIndexOf('\n')
    const safe = lastNewline > 0 ? sliced.slice(0, lastNewline) : sliced
    const hasOpen = safe.includes('<invoked-skills>')
    const hasClose = safe.includes('</invoked-skills>')
    const closer = hasOpen && !hasClose ? '\n</invoked-skills>' : ''
    const truncated = `${safe}\n[skills truncated]${closer}`
    return makeAttachment('skills', withRebuild(truncated))
  }
  return makeAttachment('skills', withRebuild(frag))
}

async function createPlanAttachment(planPath?: string): Promise<PostCompactAttachment | null> {
  if (!planPath) return null
  try {
    const content = await fs.readFile(planPath, 'utf8')
    const trimmed = content.trim()
    if (!trimmed) return null
    const est = estimateTextTokens(trimmed)
    const budgeted = est > 5_000 ? trimmed.slice(0, 20_000) + '\n[plan truncated]' : trimmed
    return makeAttachment(
      'plan',
      `[Post-compact — active plan file (${planPath})]\n\n${budgeted}`,
    )
  } catch {
    return null
  }
}

function createDeferredToolDeltaAttachment(
  deltas?: string[],
): PostCompactAttachment | null {
  if (!deltas || deltas.length === 0) return null
  const body = deltas.map((d) => `- ${d}`).join('\n')
  return makeAttachment(
    'deferred_tool_delta',
    `[Post-compact — tool/MCP/agent availability changes since last compaction]\n${body}`,
  )
}

async function createSessionMemorySnippet(
  conversationId?: string,
): Promise<PostCompactAttachment | null> {
  const cid = conversationId?.trim()
  if (!cid) return null
  const raw = await readSessionMemoryMarkdown(cid, getWorkspacePath())
  if (raw === null) return null
  try {
    const trimmed = raw.trim()
    if (!trimmed || estimateTextTokens(trimmed) < 100) return null
    const maxChars = 12_000 * 4
    const budgeted = trimmed.length > maxChars
      ? trimmed.slice(0, maxChars) + '\n[session memory truncated]'
      : trimmed
    // Audit fix C-5 (2026-05) — register a read receipt for the
    // session-memory file so a subsequent `edit_file` on it doesn't
    // get rejected by the read-before-write gate. The snippet body
    // IS what the model just saw; without a receipt the gate would
    // require the model to re-call `read_file` purely to satisfy the
    // gate even though the bytes are right there in this attachment.
    // Best-effort: if the path can't be statted or written to the
    // receipt store, we still surface the snippet — the worst case
    // is the model re-reads, which is the pre-fix behaviour.
    //
    // Self-audit fix R2-M (2026-05) — pass `raw` (un-trimmed), not
    // `trimmed`. The receipt's `contentHash` is compared against the
    // disk file's actual bytes by `writeIntegrityGuard`. If we hash
    // `trimmed` but disk has the original (with leading / trailing
    // whitespace or a BOM), the hashes mismatch and the edit gate
    // rejects the edit — the exact loop this fix was meant to prevent.
    try {
      const memPath = getSessionMemoryMarkdownPath(cid, getWorkspacePath())
      recordSelfMutationReadReceipt(memPath, raw)
    } catch (e) {
      console.warn('[postCompactAttachments] session-memory read-receipt skipped:', e)
    }
    return makeAttachment(
      'session_memory',
      `[Post-compact — session memory notes]\n\n${budgeted}`,
    )
  } catch {
    return null
  }
}

/**
 * `<modified-files>` change ledger — the "AI forgets what it edited" fix
 * (2026-07), direction 2.
 *
 * A mutation tool_result carries no diff, and micro-compact truncates the
 * (already diff-less) result a few iterations later — so after a compaction the
 * model can lose track of what it changed earlier in the run. The
 * DiffTransaction store already holds the authoritative before/after content of
 * every applied write (P1 shadow mode), it just never fed the model. Here we
 * read the store, compute a per-file cumulative change summary, and inject it
 * so post-compact turns retain "what has been modified this session".
 *
 * Scoping: DiffTransactions are process-wide (not conversation-keyed), so we
 * intersect the applied set with this conversation's known file paths (live
 * message paths ∪ filePathMemory). This filters out edits to files this
 * conversation never touched. When we have no path signal we return null rather
 * than risk showing unrelated files. KNOWN LIMITATION: if two conversations in
 * the same process edit the SAME path, that file's summary may conflate both
 * (the store has no conversation key). Acceptable for a non-authoritative
 * breadcrumb — the header tells the model to Read before relying on it. Threading
 * a conversationId through the DT store would remove this, but is out of scope.
 *
 * Non-authoritative: the summary is a breadcrumb, not the current file bytes.
 * The header tells the model to Read before editing if it needs exact content.
 */
function createModifiedFilesAttachment(
  messages: Array<Record<string, unknown>>,
  conversationId?: string,
): PostCompactAttachment | null {
  if (POST_COMPACT_MAX_MODIFIED_FILES === 0) return null

  // Build this conversation's file-path allow-set (normalized for matching).
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
  const conversationPaths = new Set<string>()
  for (const p of extractLikelyFilePathsFromMessages(messages)) conversationPaths.add(norm(p))
  for (const p of getRememberedFilePathsForConversation(conversationId)) conversationPaths.add(norm(p))
  if (conversationPaths.size === 0) return null

  let allTransactions: DiffTransaction[]
  try {
    allTransactions = getDiffTxStore().snapshot()
  } catch {
    return null
  }

  // Group applied DTs per file, preserving chronological order.
  interface FileGroup {
    displayPath: string
    firstBase: string
    lastProposed: string
    firstCreatedAt: number
    lastCreatedAt: number
    editCount: number
  }
  const groups = new Map<string, FileGroup>()
  for (const dt of allTransactions) {
    if (dt.state !== 'Applied') continue
    const key = norm(dt.filePath)
    if (!conversationPaths.has(key)) continue
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, {
        displayPath: dt.filePath,
        firstBase: dt.baseSnapshot.content,
        lastProposed: dt.proposed.content,
        firstCreatedAt: dt.createdAt,
        lastCreatedAt: dt.createdAt,
        editCount: 1,
      })
      continue
    }
    existing.editCount++
    if (dt.createdAt < existing.firstCreatedAt) {
      existing.firstCreatedAt = dt.createdAt
      existing.firstBase = dt.baseSnapshot.content
    }
    if (dt.createdAt >= existing.lastCreatedAt) {
      existing.lastCreatedAt = dt.createdAt
      existing.lastProposed = dt.proposed.content
    }
  }
  if (groups.size === 0) return null

  // Most-recently-touched files first — they matter most to the next step.
  const ordered = [...groups.values()].sort((a, b) => b.lastCreatedAt - a.lastCreatedAt)

  const lines: string[] = []
  let budget = POST_COMPACT_MODIFIED_FILES_TOTAL_CHARS
  let shown = 0
  for (const g of ordered) {
    if (shown >= POST_COMPACT_MAX_MODIFIED_FILES) break
    const summary = summarizeContentChange(g.firstBase, g.lastProposed)
    const editNote = g.editCount === 1 ? '1 edit' : `${g.editCount} edits`
    const line = summary
      ? `- \`${g.displayPath}\`: ${summary} (${editNote})`
      : `- \`${g.displayPath}\`: modified (${editNote})`
    if (line.length > budget) break
    lines.push(line)
    budget -= line.length
    shown++
  }
  if (lines.length === 0) return null

  const omitted = groups.size - lines.length
  const omittedNote = omitted > 0 ? `\n- …and ${omitted} more modified file(s)` : ''
  const body =
    '<modified-files>\n' +
    '[Post-compact — files this session has ALREADY modified, with cumulative line-level change summaries reconstructed from the diff ledger. This is a breadcrumb of what you changed, NOT the current file contents; Read a file before editing it again if you need exact bytes.]\n' +
    lines.join('\n') +
    omittedNote +
    '\n</modified-files>'
  return makeAttachment('modified_files', body)
}

/**
 * Generate all post-compact attachments in parallel.
 * Returns user-role messages to be injected after the compact boundary marker.
 */
export async function generatePostCompactAttachments(
  options: PostCompactAttachmentOptions,
): Promise<PostCompactAttachment[]> {
  const [fileAtt, planAtt, memAtt] = await Promise.all([
    createFileAttachment(options.messages, options.conversationId),
    createPlanAttachment(options.planFilePath),
    createSessionMemorySnippet(options.conversationId),
  ])

  const skillAtt = createSkillAttachment(options.agentId, options.activeSkillName)
  const toolDeltaAtt = createDeferredToolDeltaAttachment(options.deferredToolDelta)
  const modifiedFilesAtt = createModifiedFilesAttachment(
    options.messages,
    options.conversationId,
  )

  const attachments: PostCompactAttachment[] = []
  if (fileAtt) attachments.push(fileAtt)
  if (modifiedFilesAtt) attachments.push(modifiedFilesAtt)
  if (skillAtt) attachments.push(skillAtt)
  if (planAtt) attachments.push(planAtt)
  if (toolDeltaAtt) attachments.push(toolDeltaAtt)
  if (memAtt) attachments.push(memAtt)
  return attachments
}
