/**
 * P0-2 — known-files context injection.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { runWithAgentContext, type AgentContext } from './agentContext'
import type { ProviderConfig } from '../ai/client'
import {
  clearAllReadFileState,
  recordSuccessfulRead,
} from '../tools/readFileState'
import {
  buildKnownFilesContextBlock,
  combineKnownFilesAndPrompt,
} from './subAgentKnownFilesContext'

const cfg: ProviderConfig = { id: 'anthropic', name: 't', apiKey: '' }

function ctx(agentId: string, conv?: string): AgentContext {
  return {
    config: cfg,
    model: 'm',
    systemPrompt: '',
    messages: [],
    signal: new AbortController().signal,
    agentId,
    streamConversationId: conv,
  }
}

describe('subAgentKnownFilesContext', () => {
  afterEach(() => {
    clearAllReadFileState()
    delete process.env.POLE_SUBAGENT_INHERIT_READ_RECEIPTS
  })

  it('returns empty when no conversation id provided', () => {
    expect(buildKnownFilesContextBlock({ conversationId: undefined })).toBe('')
    expect(buildKnownFilesContextBlock({ conversationId: '   ' })).toBe('')
  })

  it('returns empty when no receipts exist for the conversation', () => {
    expect(buildKnownFilesContextBlock({ conversationId: 'no-such-conv' })).toBe('')
  })

  it('lists receipts from parent + sibling agents in the same conversation', () => {
    const p1 = 'C:/tmp/known-1.txt'.replace(/\\/g, '/').toLowerCase()
    const p2 = 'C:/tmp/known-2.txt'.replace(/\\/g, '/').toLowerCase()

    runWithAgentContext(ctx('main', 'conv-known-1'), () => {
      recordSuccessfulRead('C:/tmp/known-1.txt'.replace(/\\/g, '/'), {
        mtimeMs: 1,
        isPartialView: false,
        fullFileContent: 'A',
        viewedContent: 'A',
        readOffset: 0,
        readLimit: 200,
      })
    })
    runWithAgentContext(ctx('agent-x', 'conv-known-1'), () => {
      recordSuccessfulRead('C:/tmp/known-2.txt'.replace(/\\/g, '/'), {
        mtimeMs: 2,
        isPartialView: true,
        viewedContent: 'B-window',
        readOffset: 100,
        readLimit: 50,
      })
    })

    const block = buildKnownFilesContextBlock({ conversationId: 'conv-known-1' })
    expect(block).toContain('<known-files-already-read>')
    expect(block).toContain('</known-files-already-read>')
    expect(block).toContain(p1)
    expect(block).toContain(p2)
    expect(block).toContain('full file')
    expect(block).toContain('partial')
    expect(block).toContain('parent chat')
    expect(block).toContain('sibling agent-x')
  })

  it('honors POLE_SUBAGENT_INHERIT_READ_RECEIPTS=0 opt-out', () => {
    runWithAgentContext(ctx('main', 'conv-opt-out'), () => {
      recordSuccessfulRead('C:/tmp/opt-out.txt'.replace(/\\/g, '/'), {
        mtimeMs: 1,
        isPartialView: false,
        fullFileContent: 'x',
        viewedContent: 'x',
        readOffset: 0,
        readLimit: 100,
      })
    })
    process.env.POLE_SUBAGENT_INHERIT_READ_RECEIPTS = '0'
    expect(buildKnownFilesContextBlock({ conversationId: 'conv-opt-out' })).toBe('')
  })

  it('excludes the current agent so a sub-agent does not see its own (empty) receipts', () => {
    const p = 'C:/tmp/exclude-self.txt'.replace(/\\/g, '/')
    runWithAgentContext(ctx('agent-only', 'conv-self'), () => {
      recordSuccessfulRead(p, {
        mtimeMs: 1,
        isPartialView: false,
        fullFileContent: 'x',
        viewedContent: 'x',
        readOffset: 0,
        readLimit: 100,
      })
    })
    expect(
      buildKnownFilesContextBlock({
        conversationId: 'conv-self',
        currentAgentId: 'agent-only',
      }),
    ).toBe('')
  })

  it('caps the listing and notes the elision count', () => {
    for (let i = 0; i < 8; i++) {
      runWithAgentContext(ctx('main', 'conv-cap'), () => {
        recordSuccessfulRead(`C:/tmp/cap-${i}.txt`.replace(/\\/g, '/'), {
          mtimeMs: i + 1,
          isPartialView: false,
          fullFileContent: String(i),
          viewedContent: String(i),
          readOffset: 0,
          readLimit: 100,
        })
      })
    }
    const block = buildKnownFilesContextBlock({
      conversationId: 'conv-cap',
      maxEntries: 3,
    })
    const entries = block.split('\n').filter((l) => l.startsWith('- ') && !l.includes('elided'))
    expect(entries).toHaveLength(3)
    expect(block).toContain('5 additional receipt(s) elided')
  })
})

describe('combineKnownFilesAndPrompt', () => {
  it('returns the prompt unchanged when block is empty', () => {
    expect(combineKnownFilesAndPrompt('', 'do thing')).toBe('do thing')
    expect(combineKnownFilesAndPrompt('   \n  ', 'do thing')).toBe('do thing')
  })

  it('joins block and prompt with a separator', () => {
    const out = combineKnownFilesAndPrompt('<x>info</x>', 'do thing')
    expect(out).toBe('<x>info</x>\n\n---\n\ndo thing')
  })
})
