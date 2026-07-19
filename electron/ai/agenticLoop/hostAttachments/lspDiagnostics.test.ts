/**
 * Unit tests for the `lsp_diagnostics` collector.
 *
 * Reads `DiagnosticsHub.getAllAuthoritative()` and formats a compressed
 * per-file summary capped to MAX_FILES_REPORTED / MAX_DIAGNOSTICS_PER_FILE.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetLspDiagnosticsHashCacheForTests,
  lspDiagnosticsCollector,
  MIN_REEMIT_GAP_ITERATIONS,
} from './lspDiagnostics'
import {
  expectPushMessageAction,
  makeAttachmentFixture,
} from './testFixtures'

const ORIGINAL_ENV = process.env.POLE_LSP_DIAGNOSTICS_ATTACHMENT

const getAgentContextMock = vi.fn()
const getAllAuthoritativeMock = vi.fn()

vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => getAgentContextMock(),
}))
vi.mock('../../../diagnostics/DiagnosticsHub', () => ({
  getDiagnosticsHub: () => ({
    getAllAuthoritative: () => getAllAuthoritativeMock(),
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  process.env.POLE_LSP_DIAGNOSTICS_ATTACHMENT = '1'
  getAgentContextMock.mockReturnValue({ agentId: 'main' })
  // Audit fix R4-M3 — clear the per-conversation hash dedup cache so
  // dedup state from a prior test does not leak into this one.
  __resetLspDiagnosticsHashCacheForTests()
})

afterEach(() => {
  if (ORIGINAL_ENV === undefined)
    delete process.env.POLE_LSP_DIAGNOSTICS_ATTACHMENT
  else process.env.POLE_LSP_DIAGNOSTICS_ATTACHMENT = ORIGINAL_ENV
})

function diag(
  severity: 1 | 2 | 3 | 4,
  line: number,
  message: string,
  source?: string,
) {
  return {
    range: { start: { line, character: 0 }, end: { line, character: 1 } },
    severity,
    message,
    source,
  }
}

describe('lspDiagnosticsCollector — gating', () => {
  it('runs at post_tool only', () => {
    expect(lspDiagnosticsCollector.callSites).toEqual(['post_tool'])
  })

  it('is enabled when env flag is unset (default-on)', async () => {
    delete process.env.POLE_LSP_DIAGNOSTICS_ATTACHMENT
    getAllAuthoritativeMock.mockReturnValue([
      { uri: 'file:///a.ts', diagnostics: [diag(1, 1, 'err')] },
    ])
    const result = await lspDiagnosticsCollector.run(makeAttachmentFixture({}))
    expect(result).not.toBeNull()
  })

  it('returns null when env flag is explicitly disabled (POLE_X=0)', async () => {
    process.env.POLE_LSP_DIAGNOSTICS_ATTACHMENT = '0'
    getAllAuthoritativeMock.mockReturnValue([
      { uri: 'file:///a.ts', diagnostics: [diag(1, 1, 'err')] },
    ])
    expect(
      await lspDiagnosticsCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
    // Hub never consulted when gate closes.
    expect(getAllAuthoritativeMock).not.toHaveBeenCalled()
  })

  it('returns null for sub-agents by default', async () => {
    getAgentContextMock.mockReturnValue({ agentId: 'sub' })
    expect(
      await lspDiagnosticsCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('emits for sub-agents when POLE_LSP_DIAGNOSTICS_SUBAGENT=1 (verify-depth uplift)', async () => {
    process.env.POLE_LSP_DIAGNOSTICS_SUBAGENT = '1'
    try {
      getAgentContextMock.mockReturnValue({ agentId: 'sub' })
      getAllAuthoritativeMock.mockReturnValue([
        { uri: 'file:///a.ts', diagnostics: [diag(1, 1, 'err')] },
      ])
      expect(
        await lspDiagnosticsCollector.run(makeAttachmentFixture({})),
      ).not.toBeNull()
    } finally {
      delete process.env.POLE_LSP_DIAGNOSTICS_SUBAGENT
    }
  })

  it('returns null when DiagnosticsHub throws (e.g. headless test rig)', async () => {
    getAllAuthoritativeMock.mockImplementation(() => {
      throw new Error('hub not init')
    })
    expect(
      await lspDiagnosticsCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('returns null when snapshot is empty', async () => {
    getAllAuthoritativeMock.mockReturnValue([])
    expect(
      await lspDiagnosticsCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('returns null when all files have zero diagnostics', async () => {
    getAllAuthoritativeMock.mockReturnValue([
      { uri: 'file:///a.ts', diagnostics: [] },
    ])
    expect(
      await lspDiagnosticsCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })
})

describe('lspDiagnosticsCollector — formatting', () => {
  it('formats severity labels and totals correctly', async () => {
    getAllAuthoritativeMock.mockReturnValue([
      {
        uri: 'file:///a.ts',
        diagnostics: [diag(1, 5, 'Cannot find name', 'ts'), diag(2, 10, 'unused var')],
      },
    ])
    const body = String(
      expectPushMessageAction(
        await lspDiagnosticsCollector.run(makeAttachmentFixture({})),
      ).message.content,
    )
    expect(body).toContain('1 error(s)')
    expect(body).toContain('1 warning(s)')
    expect(body).toContain('error 6:1')
    expect(body).toContain('warn 11:1')
    expect(body).toContain('[ts]')
    expect(body).toContain('Cannot find name')
  })

  it('caps to MAX_FILES_REPORTED with overflow note', async () => {
    const big = []
    for (let i = 0; i < 25; i++) {
      big.push({
        uri: `file:///f${i}.ts`,
        diagnostics: [diag(1, 0, 'err')],
      })
    }
    getAllAuthoritativeMock.mockReturnValue(big)
    const body = String(
      expectPushMessageAction(
        await lspDiagnosticsCollector.run(makeAttachmentFixture({})),
      ).message.content,
    )
    expect(body).toContain('more files')
  })

  it('caps per-file diagnostics with overflow note', async () => {
    const lots = []
    for (let i = 0; i < 10; i++) lots.push(diag(1, i, `err-${i}`))
    getAllAuthoritativeMock.mockReturnValue([
      { uri: 'file:///big.ts', diagnostics: lots },
    ])
    const body = String(
      expectPushMessageAction(
        await lspDiagnosticsCollector.run(makeAttachmentFixture({})),
      ).message.content,
    )
    expect(body).toContain('+5 more')
  })

  // Audit fix R4-M3 (2026-05) — per-conversation hash dedup so the
  // model doesn't see N identical "12 errors in foo.ts" blocks across
  // N silent post_tool boundaries in an unchanged session.
  it('R4-M3: skips emission when the rendered snapshot is identical to the previous emission', async () => {
    getAgentContextMock.mockReturnValue({
      agentId: 'main',
      streamConversationId: 'conv-dedup',
    })
    getAllAuthoritativeMock.mockReturnValue([
      { uri: 'file:///a.ts', diagnostics: [diag(1, 5, 'err')] },
    ])
    const first = await lspDiagnosticsCollector.run(makeAttachmentFixture({}))
    expect(first).not.toBeNull()
    const second = await lspDiagnosticsCollector.run(makeAttachmentFixture({}))
    expect(second).toBeNull()
  })

  it('R4-M3: emits again once the snapshot actually changes (new file, fixed error, etc.)', async () => {
    getAgentContextMock.mockReturnValue({
      agentId: 'main',
      streamConversationId: 'conv-dedup-2',
    })
    getAllAuthoritativeMock.mockReturnValue([
      { uri: 'file:///a.ts', diagnostics: [diag(1, 5, 'err')] },
    ])
    expect(
      await lspDiagnosticsCollector.run(makeAttachmentFixture({})),
    ).not.toBeNull()
    // A real change: new error in a different file.
    getAllAuthoritativeMock.mockReturnValue([
      { uri: 'file:///a.ts', diagnostics: [diag(1, 5, 'err')] },
      { uri: 'file:///b.ts', diagnostics: [diag(2, 9, 'warn-new')] },
    ])
    expect(
      await lspDiagnosticsCollector.run(makeAttachmentFixture({})),
    ).not.toBeNull()
  })

  it('R4-M3: dedup state is scoped per conversation (different conv → independent emission)', async () => {
    getAllAuthoritativeMock.mockReturnValue([
      { uri: 'file:///a.ts', diagnostics: [diag(1, 5, 'err')] },
    ])
    getAgentContextMock.mockReturnValue({
      agentId: 'main',
      streamConversationId: 'conv-A',
    })
    expect(
      await lspDiagnosticsCollector.run(makeAttachmentFixture({})),
    ).not.toBeNull()
    // Same snapshot, different conversation — must still emit.
    getAgentContextMock.mockReturnValue({
      agentId: 'main',
      streamConversationId: 'conv-B',
    })
    expect(
      await lspDiagnosticsCollector.run(makeAttachmentFixture({})),
    ).not.toBeNull()
  })

  // 2026-06 verify-depth uplift — cosmetic-churn throttle: body hash
  // changed but per-severity totals identical → rate-limit re-emission.
  it('churn throttle: suppresses a body change with identical totals inside the gap', async () => {
    getAgentContextMock.mockReturnValue({
      agentId: 'main',
      streamConversationId: 'conv-churn',
    })
    getAllAuthoritativeMock.mockReturnValue([
      { uri: 'file:///a.ts', diagnostics: [diag(1, 5, 'err')] },
    ])
    expect(
      await lspDiagnosticsCollector.run(makeAttachmentFixture({ iteration: 1 })),
    ).not.toBeNull()
    // Same single error, but it moved lines (body hash changes, totals don't).
    getAllAuthoritativeMock.mockReturnValue([
      { uri: 'file:///a.ts', diagnostics: [diag(1, 9, 'err')] },
    ])
    expect(
      await lspDiagnosticsCollector.run(makeAttachmentFixture({ iteration: 2 })),
    ).toBeNull()
    // Emits again once MIN_REEMIT_GAP_ITERATIONS has elapsed.
    expect(
      await lspDiagnosticsCollector.run(
        makeAttachmentFixture({ iteration: 1 + MIN_REEMIT_GAP_ITERATIONS }),
      ),
    ).not.toBeNull()
  })

  it('churn throttle: a genuine totals change bypasses the gap', async () => {
    getAgentContextMock.mockReturnValue({
      agentId: 'main',
      streamConversationId: 'conv-churn-2',
    })
    getAllAuthoritativeMock.mockReturnValue([
      { uri: 'file:///a.ts', diagnostics: [diag(1, 5, 'err')] },
    ])
    expect(
      await lspDiagnosticsCollector.run(makeAttachmentFixture({ iteration: 1 })),
    ).not.toBeNull()
    // A second error appears immediately — totals changed, must emit now.
    getAllAuthoritativeMock.mockReturnValue([
      { uri: 'file:///a.ts', diagnostics: [diag(1, 5, 'err'), diag(1, 7, 'err2')] },
    ])
    expect(
      await lspDiagnosticsCollector.run(makeAttachmentFixture({ iteration: 2 })),
    ).not.toBeNull()
  })

  it('reports totals to appendixReport', async () => {
    getAllAuthoritativeMock.mockReturnValue([
      { uri: 'file:///a.ts', diagnostics: [diag(1, 1, 'a'), diag(2, 2, 'b')] },
      { uri: 'file:///b.ts', diagnostics: [diag(3, 3, 'c')] },
    ])
    const ctx = makeAttachmentFixture({ iteration: 5 })
    await lspDiagnosticsCollector.run(ctx)
    expect(ctx.state.appendixReport).toHaveBeenCalledWith(
      'P2_Q_compaction_reminder',
      expect.objectContaining({
        kind: 'lsp_diagnostics',
        filesReported: 2,
        totalErrors: 1,
        totalWarnings: 1,
        totalInfo: 1,
      }),
    )
  })
})
