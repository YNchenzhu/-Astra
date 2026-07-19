/**
 * Tests for the post-compact `<modified-files>` change ledger — direction 2 of
 * the "AI forgets what it edited" fix. Verifies that applied DiffTransactions
 * for THIS conversation's files surface as a cumulative change summary, and that
 * cross-conversation edits do not bleed in.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  __resetDiffTxStoreForTests,
  getDiffTxStore,
} from '../diff/DiffTransactionStore'
import type { DtBaseSnapshot, DtProposed } from '../diff/DiffTransactionTypes'
import { generatePostCompactAttachments } from './postCompactAttachments'

function applyEdit(filePath: string, before: string, after: string): void {
  const store = getDiffTxStore()
  const id = store.newId()
  const baseSnapshot: DtBaseSnapshot = {
    content: before,
    contentHash: 'hash-before',
    mtimeMs: 0,
    fileExisted: true,
    readId: 'read-1',
  }
  const proposed: DtProposed = {
    content: after,
    toolName: 'edit_file',
    toolUseId: `tu-${id}`,
  }
  store.create({ id, filePath, baseSnapshot, proposed })
  store.dispatch({ type: 'PermissionApproved', id })
  store.dispatch({ type: 'WriteStart', id })
  store.dispatch({
    type: 'WriteApplied',
    id,
    appliedContentHash: 'hash-after',
    appliedReadId: 'read-2',
  })
}

/** A message whose text mentions the file path so it lands in the allow-set. */
function messagesMentioning(path: string): Array<Record<string, unknown>> {
  return [{ role: 'assistant', content: `I edited \`${path}\` just now.` }]
}

describe('post-compact <modified-files> ledger', () => {
  beforeEach(() => {
    __resetDiffTxStoreForTests()
  })

  it('surfaces a cumulative change summary for an applied edit', async () => {
    applyEdit('/w/refund.ts', 'a\nb\nc', 'a\nB\nc\nd')
    const atts = await generatePostCompactAttachments({
      messages: messagesMentioning('/w/refund.ts'),
    })
    const mod = atts.find((a) => a._attachmentKind === 'modified_files')
    expect(mod).toBeTruthy()
    expect(mod!.content).toContain('<modified-files>')
    expect(mod!.content).toContain('/w/refund.ts')
    expect(mod!.content).toMatch(/\+\d+\/-\d+ lines/)
    expect(mod!.content).toContain('1 edit')
  })

  it('aggregates multiple edits to the same file with the earliest base and latest content', async () => {
    applyEdit('/w/a.ts', 'v1', 'v2')
    applyEdit('/w/a.ts', 'v2', 'v3-longer\nmore')
    const atts = await generatePostCompactAttachments({
      messages: messagesMentioning('/w/a.ts'),
    })
    const mod = atts.find((a) => a._attachmentKind === 'modified_files')
    expect(mod).toBeTruthy()
    expect(mod!.content).toContain('2 edits')
  })

  it('does NOT include files outside this conversation (no cross-conversation bleed)', async () => {
    applyEdit('/w/other.ts', 'x', 'y')
    const atts = await generatePostCompactAttachments({
      messages: messagesMentioning('/w/unrelated.ts'),
    })
    const mod = atts.find((a) => a._attachmentKind === 'modified_files')
    expect(mod).toBeUndefined()
  })

  it('returns no ledger when there are no applied edits', async () => {
    const atts = await generatePostCompactAttachments({
      messages: messagesMentioning('/w/refund.ts'),
    })
    expect(atts.find((a) => a._attachmentKind === 'modified_files')).toBeUndefined()
  })
})
