/**
 * P0-2 — "Known files already read" context block.
 *
 * Fresh sub-agents (Explore / Plan / general-purpose, non-fork) are spawned with a
 * single user message containing only the parent's `prompt`. They have no idea which
 * files the parent or sibling sub-agents already opened, so they re-Read them from
 * scratch. With cross-agent dedup (P0-1) the disk hit is avoided, but the model
 * still wastes a tool turn asking.
 *
 * This module produces a compact `<known-files-already-read>` block listing the
 * paths + readIds + view shape of receipts in the current conversation. The
 * sub-agent runner prepends it to the first user message so the model sees it
 * before deciding what to Read.
 *
 * Opt-out: `POLE_SUBAGENT_INHERIT_READ_RECEIPTS=0` skips injection entirely.
 */

import {
  listReadReceiptsForConversation,
  type ConversationReadReceipt,
} from '../tools/readFileState'

/** Hard cap on lines; very chatty conversations otherwise blow the entry message. */
const MAX_RECEIPTS = 40

export interface BuildKnownFilesBlockInput {
  conversationId: string | undefined
  /** Excluded so the agent doesn't see its own (still-empty) receipts. */
  currentAgentId?: string
  /** Cap entries; defaults to {@link MAX_RECEIPTS}. */
  maxEntries?: number
}

/**
 * Produce the markdown block to inject. Returns empty string when there is
 * nothing useful to inject (no conversation id, no receipts, opt-out env, etc.).
 */
export function buildKnownFilesContextBlock(input: BuildKnownFilesBlockInput): string {
  if (process.env.POLE_SUBAGENT_INHERIT_READ_RECEIPTS === '0') {
    return ''
  }
  const conv = input.conversationId?.trim()
  if (!conv) {
    return ''
  }

  const cap = input.maxEntries ?? MAX_RECEIPTS
  const all = listReadReceiptsForConversation(conv, {
    excludeAgentId: input.currentAgentId,
  })
  if (all.length === 0) {
    return ''
  }

  const limited = all.slice(0, cap)
  const lines: string[] = [
    '<known-files-already-read>',
    'Files below were already read in this conversation by the parent agent or sibling sub-agents.',
    'Calling read_file on the same path + window will return cached content (no disk re-read).',
    'Skip re-reading them unless you need a different range that is not covered.',
    '',
  ]
  for (const r of limited) {
    lines.push(formatReceiptLine(r))
  }
  if (all.length > cap) {
    lines.push(`- … (${all.length - cap} additional receipt(s) elided to bound prompt size)`)
  }
  lines.push('</known-files-already-read>')
  const block = lines.join('\n')
  return block
}

function formatReceiptLine(r: ConversationReadReceipt): string {
  const view = r.record.isPartialView
    ? `partial (offset ${r.record.readOffset ?? '?'}, limit ${r.record.readLimit ?? '?'})`
    : 'full file'
  const snipLen = r.record.contentSnapshot ? `${r.record.contentSnapshot.length} chars cached` : 'no snapshot'
  const idHint = r.record.readId ? `, readId=${r.record.readId}` : ''
  const by = r.agentId === 'main' ? 'parent chat' : `sibling ${r.agentId}`
  return `- ${r.resolvedPathKey} — ${view}, ${snipLen}, by ${by}${idHint}`
}

/**
 * Combine a known-files block with the sub-agent's task prompt into a single user
 * message body. Returns the prompt unchanged when the block is empty so we don't
 * add a stray separator.
 */
export function combineKnownFilesAndPrompt(block: string, prompt: string): string {
  if (!block.trim()) return prompt
  return `${block}\n\n---\n\n${prompt}`
}
