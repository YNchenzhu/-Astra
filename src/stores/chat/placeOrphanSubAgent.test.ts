/**
 * Pins the placement contract for orphan sub-agents (Skill fork, Debug/REPL
 * fork, ambient buddy spawn, etc.).
 *
 * Strategy A — `inserted-after-finished`: post-stream hook of a turn that
 *   just ended. Standalone bubble lands RIGHT AFTER that finished turn.
 * Strategy B — `merged-into-streaming`: orphan fires while the main turn
 *   is still in flight. SubAgentDisplay MERGES into the streaming bubble's
 *   `subAgents` array (no ghost bubble between the user msg and the
 *   not-yet-finished 星构Astra reply).
 * Strategy C — `appended-no-anchor`: no assistant bubble exists at all
 *   (brand-new conversation, first event is an orphan). Standalone bubble
 *   appended at the end.
 */
import { describe, it, expect } from 'vitest'
import { placeOrphanSubAgent } from './placeOrphanSubAgent'
import { findAssistantIndexWithSubAgent } from './sessionSlice'
import { asAgentId } from '../../types/ids'
import type { ChatMessage, SubAgentDisplay } from '../../types'

const NOW = 1700000000000

function makeSubAgent(id: string): SubAgentDisplay {
  return {
    agentId: asAgentId(id),
    agentType: 'Explore',
    description: 'kick off background work',
    status: 'running',
    toolUses: [],
  }
}

describe('placeOrphanSubAgent', () => {
  it('strategy A — inserts standalone right after the most recent FINISHED assistant turn', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: NOW - 5000 },
      { id: 'a1', role: 'assistant', content: 'done', timestamp: NOW - 4000 },
      { id: 'u2', role: 'user', content: 'next?', timestamp: NOW - 1000 },
    ]
    const sa = makeSubAgent('sa-A')
    const out = placeOrphanSubAgent(messages, sa, 'subagent-msg-sa-A', NOW)

    expect(out.placement).toBe('inserted-after-finished')
    expect(out.messages.length).toBe(4)
    expect(out.messages[0]!.id).toBe('u1')
    expect(out.messages[1]!.id).toBe('a1')
    expect(out.messages[2]!.id).toBe('subagent-msg-sa-A')
    expect(out.messages[2]!.role).toBe('assistant')
    expect(out.messages[2]!.subAgents?.[0]!.agentId).toBe(asAgentId('sa-A'))
    expect(out.messages[3]!.id).toBe('u2')
  })

  it('strategy B — merges into the streaming assistant\'s subAgents (no ghost bubble)', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'do the test', timestamp: NOW - 1000 },
      {
        id: 'a-streaming',
        role: 'assistant',
        content: '',
        timestamp: NOW - 500,
        isStreaming: true,
      },
    ]
    const sa = makeSubAgent('sa-B')
    const out = placeOrphanSubAgent(messages, sa, 'subagent-msg-sa-B', NOW)

    expect(out.placement).toBe('merged-into-streaming')
    // Length unchanged — no standalone bubble was added.
    expect(out.messages.length).toBe(2)
    expect(out.messages[0]!.id).toBe('u1')
    expect(out.messages[1]!.id).toBe('a-streaming')
    expect(out.messages[1]!.subAgents).toEqual([sa])
    // The streaming bubble is still the streaming bubble.
    expect(out.messages[1]!.isStreaming).toBe(true)
  })

  it('strategy B — preserves any sub-agents already on the streaming bubble', () => {
    const existing: SubAgentDisplay = {
      agentId: asAgentId('sa-prev'),
      agentType: 'Plan',
      description: 'earlier task',
      status: 'completed',
      toolUses: [],
    }
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'go', timestamp: NOW - 1000 },
      {
        id: 'a-streaming',
        role: 'assistant',
        content: 'thinking...',
        timestamp: NOW - 500,
        isStreaming: true,
        subAgents: [existing],
      },
    ]
    const sa = makeSubAgent('sa-new')
    const out = placeOrphanSubAgent(messages, sa, 'subagent-msg-sa-new', NOW)

    expect(out.placement).toBe('merged-into-streaming')
    expect(out.messages[1]!.subAgents).toHaveLength(2)
    expect(out.messages[1]!.subAgents?.[0]!.agentId).toBe(asAgentId('sa-prev'))
    expect(out.messages[1]!.subAgents?.[1]!.agentId).toBe(asAgentId('sa-new'))
  })

  it('strategy A wins over B when BOTH a finished and a streaming bubble exist', () => {
    // Scenario: previous turn finished, new turn is streaming. A post-stream
    // hook of the FINISHED turn dispatched the orphan — strategy A applies,
    // landing the orphan between that finished turn and the new user msg /
    // streaming bubble.
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'do A', timestamp: NOW - 5000 },
      { id: 'a1', role: 'assistant', content: 'A done', timestamp: NOW - 4500 },
      { id: 'u2', role: 'user', content: 'do B', timestamp: NOW - 1000 },
      {
        id: 'a2',
        role: 'assistant',
        content: '',
        timestamp: NOW - 500,
        isStreaming: true,
      },
    ]
    const sa = makeSubAgent('sa-mixed')
    const out = placeOrphanSubAgent(messages, sa, 'subagent-msg-sa-mixed', NOW)

    expect(out.placement).toBe('inserted-after-finished')
    expect(out.messages.length).toBe(5)
    expect(out.messages.map((m) => m.id)).toEqual([
      'u1',
      'a1',
      'subagent-msg-sa-mixed',
      'u2',
      'a2',
    ])
  })

  it('strategy C — appends standalone when no assistant bubble exists at all', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'first ever msg', timestamp: NOW - 100 },
    ]
    const sa = makeSubAgent('sa-C')
    const out = placeOrphanSubAgent(messages, sa, 'subagent-msg-sa-C', NOW)

    expect(out.placement).toBe('appended-no-anchor')
    expect(out.messages.length).toBe(2)
    expect(out.messages[1]!.id).toBe('subagent-msg-sa-C')
    expect(out.messages[1]!.subAgents?.[0]!.agentId).toBe(asAgentId('sa-C'))
  })

  it('strategy A — skips `subagent-msg-*` siblings when finding the anchor', () => {
    // Confirms that a prior standalone orphan bubble does NOT count as the
    // "trigger turn" anchor — we walk past it to find the real assistant
    // turn underneath. Otherwise a chain of orphans would stack adjacent
    // to themselves instead of trailing the actual trigger.
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', timestamp: NOW - 5000 },
      { id: 'a1', role: 'assistant', content: 'ok', timestamp: NOW - 4500 },
      {
        id: 'subagent-msg-sa-old',
        role: 'assistant',
        content: '',
        timestamp: NOW - 4000,
        subAgents: [makeSubAgent('sa-old')],
      },
    ]
    const sa = makeSubAgent('sa-new')
    const out = placeOrphanSubAgent(messages, sa, 'subagent-msg-sa-new', NOW)

    expect(out.placement).toBe('inserted-after-finished')
    // Lands right after `a1`, BEFORE the pre-existing standalone — keeps
    // the trigger-then-orphans ordering stable.
    expect(out.messages.map((m) => m.id)).toEqual([
      'u1',
      'a1',
      'subagent-msg-sa-new',
      'subagent-msg-sa-old',
    ])
  })

  it('integration: subagent_text-style event on a MERGED orphan locates the host bubble and grows output', () => {
    // Simulates the dispatch path used by subAgentStreamRouter.ts for the
    // `subagent_text` event AFTER strategy B placed the orphan into a
    // streaming bubble: it calls `findAssistantIndexWithSubAgent` to locate
    // the host, then maps the message's `subAgents` to update `output`.
    // If our merge silently broke that lookup (wrong shape, mistaken id,
    // missing reference) the streamed sub-agent text would land nowhere.
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'go', timestamp: NOW - 1000 },
      {
        id: 'a-streaming',
        role: 'assistant',
        content: 'main reply...',
        timestamp: NOW - 500,
        isStreaming: true,
      },
    ]
    const sa = makeSubAgent('sa-text')
    const afterPlace = placeOrphanSubAgent(messages, sa, 'subagent-msg-sa-text', NOW)
    expect(afterPlace.placement).toBe('merged-into-streaming')

    // Subsequent subagent_text — locate + patch like the router does.
    const idx = findAssistantIndexWithSubAgent(afterPlace.messages, asAgentId('sa-text'))
    expect(idx).toBe(1)
    const next = afterPlace.messages.map((row, i) =>
      i !== idx
        ? row
        : {
            ...row,
            subAgents: (row.subAgents ?? []).map((s) =>
              s.agentId === asAgentId('sa-text')
                ? { ...s, output: (s.output ?? '') + 'hello from sub-agent' }
                : s,
            ),
          },
    )
    expect(next[1]!.subAgents?.[0]!.output).toBe('hello from sub-agent')
    // Main bubble identity preserved (not duplicated, not split).
    expect(next[1]!.id).toBe('a-streaming')
    expect(next[1]!.content).toBe('main reply...')
  })

  it('integration: subagent_complete-style event on a MERGED orphan flips status', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'go', timestamp: NOW - 1000 },
      {
        id: 'a-streaming',
        role: 'assistant',
        content: '',
        timestamp: NOW - 500,
        isStreaming: true,
      },
    ]
    const sa = makeSubAgent('sa-done')
    const afterPlace = placeOrphanSubAgent(messages, sa, 'subagent-msg-sa-done', NOW)
    expect(afterPlace.placement).toBe('merged-into-streaming')

    const idx = findAssistantIndexWithSubAgent(afterPlace.messages, asAgentId('sa-done'))
    expect(idx).toBe(1)
    const completed = afterPlace.messages.map((row, i) =>
      i !== idx
        ? row
        : {
            ...row,
            subAgents: (row.subAgents ?? []).map((s) =>
              s.agentId === asAgentId('sa-done')
                ? ({
                    ...s,
                    status: 'completed' as const,
                    output: 'final',
                    totalDurationMs: 1234,
                    totalTokens: 100,
                  })
                : s,
            ),
          },
    )
    const saAfter = completed[1]!.subAgents?.[0]
    expect(saAfter?.status).toBe('completed')
    expect(saAfter?.output).toBe('final')
    expect(saAfter?.totalDurationMs).toBe(1234)
    expect(saAfter?.totalTokens).toBe(100)
  })

  it('integration: after main bubble finishes streaming, a NEW orphan goes through strategy A (standalone after the now-finished bubble that holds the merged orphan)', () => {
    // Stage 1: orphan merges into streaming bubble.
    let messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'go', timestamp: NOW - 2000 },
      {
        id: 'a',
        role: 'assistant',
        content: '',
        timestamp: NOW - 1500,
        isStreaming: true,
      },
    ]
    const sa1 = makeSubAgent('sa-1')
    const stage1 = placeOrphanSubAgent(messages, sa1, 'subagent-msg-sa-1', NOW - 1000)
    expect(stage1.placement).toBe('merged-into-streaming')
    messages = stage1.messages

    // Stage 2: main bubble finishes (isStreaming flips false). The merged
    // orphan stays in its subAgents.
    messages = messages.map((m) =>
      m.id === 'a' ? { ...m, isStreaming: false, content: 'done' } : m,
    )
    expect(messages[1]!.subAgents).toEqual([sa1])

    // Stage 3: a SECOND orphan fires. Strategy A should pick the now-
    // finished bubble as anchor and slot a standalone bubble AFTER it.
    // This must NOT misfire as strategy B (no streaming bubble left).
    const sa2 = makeSubAgent('sa-2')
    const stage2 = placeOrphanSubAgent(messages, sa2, 'subagent-msg-sa-2', NOW)
    expect(stage2.placement).toBe('inserted-after-finished')
    expect(stage2.messages.map((m) => m.id)).toEqual([
      'u1',
      'a',
      'subagent-msg-sa-2',
    ])
    // The first sub-agent still lives inside the finished bubble.
    expect(stage2.messages[1]!.subAgents).toEqual([sa1])
    expect(stage2.messages[2]!.subAgents).toEqual([sa2])
  })

  it('returns a NEW messages array (does not mutate the input)', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'go', timestamp: NOW - 1000 },
      {
        id: 'a',
        role: 'assistant',
        content: '',
        timestamp: NOW,
        isStreaming: true,
      },
    ]
    const original = JSON.parse(JSON.stringify(messages))
    const sa = makeSubAgent('sa-immut')
    placeOrphanSubAgent(messages, sa, 'subagent-msg-sa-immut', NOW)
    expect(messages).toEqual(original)
  })
})
