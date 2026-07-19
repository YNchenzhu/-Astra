export interface TranscriptRound {
  roundIndex: number
  userMessage?: string
  assistantContent: Array<Record<string, unknown>>
  toolResultBlocks?: Array<Record<string, unknown>>
}

export interface StateCheckpoint {
  afterRound: number
  apiMessageCount: number
  syntheticErrorCount: number
  thinkingBlockCount: number
  orphanedThinkingRemoved: number
}

export interface TranscriptFixture {
  rounds: TranscriptRound[]
}

/**
 * Builds a clean 18-round transcript where every round has:
 *   user → assistant(thinking + tool_use + text) → user(tool_result)
 */
export function buildClean18RoundTranscript(): TranscriptFixture {
  const rounds: TranscriptRound[] = []
  for (let i = 1; i <= 18; i++) {
    rounds.push({
      roundIndex: i,
      userMessage: `round ${i}: perform task item ${i}`,
      assistantContent: [
        { type: 'thinking', thinking: `round-${i}-reasoning `.repeat(Math.ceil((300 + i * 50) / 20)) },
        { type: 'tool_use', id: `read_${i}`, name: 'Read', input: { file_path: `file_${i}.ts` } },
        { type: 'text', text: `Reading file_${i}.ts` },
      ],
      toolResultBlocks: [
        { type: 'tool_result', tool_use_id: `read_${i}`, content: `content of file ${i}`, is_error: false },
      ],
    })
  }
  return { rounds }
}

/**
 * Build an 18-round transcript where rounds 13 and 16-18 have
 * thinking blocks but NO tool_use (simulating completion in thinking).
 */
export function buildDegradingTranscript(): TranscriptFixture {
  const rounds: TranscriptRound[] = []
  for (let i = 1; i <= 18; i++) {
    const isDegraded = i === 13 || i >= 16
    rounds.push({
      roundIndex: i,
      userMessage: `round ${i}: ${isDegraded ? 'continue the task' : 'perform task item ' + i}`,
      assistantContent: isDegraded
        ? [
            { type: 'thinking', thinking: `已完成所有修改，文件已更新，测试通过。`.repeat(3) },
            { type: 'text', text: i >= 16 ? '任务已完成。' : '所有修改已应用。' },
          ]
        : [
            { type: 'thinking', thinking: `round-${i}-reasoning `.repeat(Math.ceil((300 + i * 50) / 20)) },
            { type: 'tool_use', id: `read_${i}`, name: 'Read', input: { file_path: `file_${i}.ts` } },
            { type: 'text', text: `Reading file_${i}.ts` },
          ],
      toolResultBlocks: isDegraded
        ? undefined
        : [
            { type: 'tool_result', tool_use_id: `read_${i}`, content: `content of file ${i}`, is_error: false },
          ],
    })
  }
  return { rounds }
}

/**
 * Convert TranscriptFixture to flat message array for API normalization.
 */
export function toApiMessages(fixture: TranscriptFixture): Array<Record<string, unknown>> {
  const msgs: Array<Record<string, unknown>> = []
  for (const round of fixture.rounds) {
    if (round.userMessage) {
      msgs.push({ role: 'user', content: [{ type: 'text', text: round.userMessage }] })
    }
    msgs.push({ role: 'assistant', content: round.assistantContent })
    if (round.toolResultBlocks) {
      msgs.push({ role: 'user', content: round.toolResultBlocks })
    }
  }
  return msgs
}

/**
 * Count synthetic error blocks in a message array.
 */
export function countSyntheticErrors(msgs: Array<Record<string, unknown>>): number {
  let count = 0
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content as Array<Record<string, unknown>>) {
      if (
        b.type === 'tool_result' &&
        typeof b.content === 'string' &&
        b.content.includes('synthetic')
      ) {
        count++
      }
    }
  }
  return count
}

/**
 * Count thinking blocks in a message array.
 */
export function countThinkingBlocks(msgs: Array<Record<string, unknown>>): number {
  let count = 0
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content as Array<Record<string, unknown>>) {
      if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        count++
      }
    }
  }
  return count
}
