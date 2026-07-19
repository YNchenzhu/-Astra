/**
 * Integration tests for the shadow helpers that the agentic loop calls.
 *
 * We stay inside the main-process module boundary (no real Electron, no renderer): just
 * exercise the helpers against the singleton store and verify the observable event trail
 * matches what runAgenticToolUse is supposed to produce.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  __resetDiffTxStoreForTests,
  createDiffTransactionFromPreview,
  getDiffTxStore,
  shadowMarkPermissionApproved,
  shadowMarkPermissionRejected,
  shadowResolveToolResult,
} from './index'
import type { DtBroadcast } from './DiffTransactionTypes'

describe('shadow integration — observed lifecycle', () => {
  let events: DtBroadcast[]

  beforeEach(() => {
    __resetDiffTxStoreForTests()
    events = []
    getDiffTxStore().addListener((e) => events.push(e))
  })

  it('approve → apply path produces Created / Transitioned(Approved) / Transitioned(Writing) / Transitioned(Applied) / Closed', () => {
    const id = createDiffTransactionFromPreview({
      toolUseId: 'tu-1',
      toolName: 'edit_file',
      toolInput: { oldString: 'foo', newString: 'bar' },
      preview: { filePath: '/w/a.ts', originalContent: 'foo', modifiedContent: 'bar' },
      fileExisted: true,
      baseReadId: 'read-1',
    })
    expect(id).not.toBeNull()

    shadowMarkPermissionApproved(id, 'user clicked approve')
    shadowResolveToolResult(id, {
      success: true,
      postWriteContent: 'bar',
      postWriteReadId: 'read-2',
    })

    const types = events.map((e) => {
      if (e.type === 'Transitioned') return `Transitioned:${e.to}`
      return e.type
    })
    expect(types).toEqual([
      'Created',
      'Transitioned:Approved',
      'Transitioned:Writing',
      'Transitioned:Applied',
      'Closed',
    ])

    const final = getDiffTxStore().get(id!)!
    expect(final.state).toBe('Applied')
    expect(final.appliedContentHash?.startsWith('sha256:')).toBe(true)
    expect(final.appliedReadId).toBe('read-2')
  })

  it('reject path produces Created / Transitioned(Rejected) / Closed and stops there', () => {
    const id = createDiffTransactionFromPreview({
      toolUseId: 'tu-2',
      toolName: 'edit_file',
      toolInput: {},
      preview: { filePath: '/w/b.ts', originalContent: 'x', modifiedContent: 'y' },
      fileExisted: true,
      baseReadId: null,
    })!
    shadowMarkPermissionRejected(id, 'user clicked reject')
    const types = events.map((e) => (e.type === 'Transitioned' ? `Transitioned:${e.to}` : e.type))
    expect(types).toEqual(['Created', 'Transitioned:Rejected', 'Closed'])
  })

  it('fail path surfaces the structured error on the DT', () => {
    const id = createDiffTransactionFromPreview({
      toolUseId: 'tu-3',
      toolName: 'edit_file',
      toolInput: {},
      preview: { filePath: '/w/c.ts', originalContent: 'x', modifiedContent: 'y' },
      fileExisted: true,
      baseReadId: null,
    })!
    shadowMarkPermissionApproved(id)
    shadowResolveToolResult(id, {
      success: false,
      error: 'simulated: hash mismatch',
    })
    const final = getDiffTxStore().get(id)!
    expect(final.state).toBe('Failed')
    expect(final.error).toMatchObject({
      code: 'TOOL_CRASH',
      message: 'simulated: hash mismatch',
      recoverable: true,
    })
  })

  it('null toolUseId / empty filePath → null id; no store entry created', () => {
    const id = createDiffTransactionFromPreview({
      toolUseId: 'tu-empty',
      toolName: 'edit_file',
      toolInput: {},
      preview: { filePath: '', originalContent: 'x', modifiedContent: 'y' },
      fileExisted: false,
      baseReadId: null,
    })
    expect(id).toBeNull()
    expect(getDiffTxStore().size()).toBe(0)
  })

  it('preserves editParams for future rebase replay', () => {
    const id = createDiffTransactionFromPreview({
      toolUseId: 'tu-4',
      toolName: 'edit_file',
      toolInput: { oldString: 'A', newString: 'B', replaceAll: true },
      preview: { filePath: '/w/d.ts', originalContent: 'A A', modifiedContent: 'B B' },
      fileExisted: true,
      baseReadId: 'read-x',
    })!
    const dt = getDiffTxStore().get(id)!
    expect(dt.proposed.editParams).toEqual({ oldString: 'A', newString: 'B', replaceAll: true })
  })

  it('riskWarnings are forwarded to the DT when present on the preview', () => {
    const id = createDiffTransactionFromPreview({
      toolUseId: 'tu-5',
      toolName: 'edit_file',
      toolInput: {},
      preview: {
        filePath: '/w/e.ts',
        originalContent: 'content',
        modifiedContent: '',
        riskWarnings: ['full file deletion'],
      },
      fileExisted: true,
      baseReadId: null,
    })!
    const dt = getDiffTxStore().get(id)!
    expect(dt.riskWarnings).toEqual(['full file deletion'])
  })
})
