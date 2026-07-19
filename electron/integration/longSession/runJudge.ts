/**
 * Pluggable LLM-as-judge runner for the 150-turn long-session packets.
 *
 * The 150-turn integration test (`../longSession.150turn.integration.test.ts`)
 * is hermetic and offline — it drives a mocked model and only EMITS per-round
 * judge packets (`judge-input.jsonl`). This runner is the OPTIONAL, decoupled
 * step that actually scores those packets with a real model when you have an
 * endpoint. With no provider/key it falls back to the same deterministic
 * heuristic the test reports, so it always produces a report.
 *
 * Usage:
 *   npx tsx electron/integration/longSession/runJudge.ts \
 *     --packets /tmp/pole-longsession-150-XXXX/packets/judge-input.jsonl \
 *     [--provider anthropic --model <256K-model> --api-key $KEY] \
 *     [--out report.md] [--concurrency 4]
 *
 * Output: a markdown report with per-dimension averages, the worst rounds, and
 * every note the judge attached to a sub-4 score.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  JUDGE_DIMENSIONS,
  JUDGE_SYSTEM_PROMPT,
  buildJudgeUserMessage,
  type JudgeDimensionId,
  type JudgePacket,
  type JudgeScore,
} from './judgeRubric'

interface Args {
  packets: string
  provider?: string
  model?: string
  apiKey?: string
  out?: string
  concurrency: number
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const packets = get('--packets')
  if (!packets) throw new Error('--packets <path to judge-input.jsonl> is required')
  return {
    packets,
    provider: get('--provider'),
    model: get('--model'),
    apiKey: get('--api-key') ?? process.env.JUDGE_API_KEY,
    out: get('--out'),
    concurrency: Number(get('--concurrency') ?? '4') || 4,
  }
}

function readPackets(p: string): JudgePacket[] {
  return fs
    .readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JudgePacket)
}

const ZERO = (): Record<JudgeDimensionId, number> =>
  Object.fromEntries(JUDGE_DIMENSIONS.map((d) => [d.id, 0])) as Record<JudgeDimensionId, number>

/**
 * Deterministic offline scorer — mirrors the test's heuristic
 * (`longSession.150turn.integration.test.ts#heuristicScore`). Skill presence is
 * detected from the wire payload (registry peek `activeSkills` empties after the
 * first compaction re-injects it, so it is only a secondary signal), and skill
 * is scored auto-compact-aware: only `auto_compact` rounds must carry the skill.
 */
function heuristicScore(packet: JudgePacket): JudgeScore {
  const wireText = packet.wire.flatMap((m) => m.blocks.map((b) => b.text ?? '')).join('\n')
  const userVisible = wireText.includes(packet.userInstructionThisRound.slice(0, 24))
  const skillPresent =
    packet.activeSkills.length > 0 ||
    wireText.includes('<invoked-skills>') ||
    wireText.includes('skill-instructions') ||
    wireText.includes('idempotency-checklist')
  const autoCompacted = packet.compactAction === 'auto_compact'
  const thinkingNotLast = !packet.wire.some(
    (m) => m.role === 'assistant' && m.blocks.length > 0 && m.blocks[m.blocks.length - 1].type === 'thinking',
  )
  const scores = ZERO()
  scores.understands_current_user_message = userVisible ? 5 : 2
  scores.recalls_what_was_done = 5
  scores.aware_of_current_state = userVisible ? 5 : 3
  scores.knows_next_step = 5
  scores.tool_routing_sane = 5
  scores.skill_content_loaded = skillPresent ? 5 : autoCompacted ? 0 : 4
  scores.thinking_not_interfering = thinkingNotLast ? 5 : 1
  // 2026-07 uplift #3 — goal-drift dimension. Prefer the host's
  // quantitative drift score when the packet carries one; fall back to
  // "is the standing goal text still visible on the wire".
  const drift = packet.hostSignals?.driftScore
  scores.goal_drift_contained =
    typeof drift === 'number' ? (drift >= 0.25 ? 5 : 2) : userVisible ? 5 : 3
  return { round: packet.round, scores, notes: 'heuristic (no LLM judge configured)' }
}

/**
 * Call a real model to score one packet. Imports the project's own streaming
 * client lazily so the offline path has zero Electron/main dependencies.
 */
async function llmScore(packet: JudgePacket, args: Args): Promise<JudgeScore> {
  const { streamText } = await import('../../ai/client')
  let text = ''
  await new Promise<void>((resolve, reject) => {
    void streamText(
      { id: args.provider!, name: args.provider!, apiKey: args.apiKey! } as never,
      {
        model: args.model!,
        system: JUDGE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildJudgeUserMessage(packet) }],
        maxTokens: 1024,
      } as never,
      {
        onTextDelta: (t: string) => {
          text += t
        },
        onMessageEnd: () => resolve(),
        onError: (e: string) => reject(new Error(e)),
      } as never,
      new AbortController().signal,
    ).catch(reject)
  })
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`judge returned no JSON for round ${packet.round}: ${text.slice(0, 200)}`)
  const parsed = JSON.parse(match[0]) as { scores?: Partial<Record<JudgeDimensionId, number>>; notes?: string }
  const scores = ZERO()
  for (const d of JUDGE_DIMENSIONS) scores[d.id] = Number(parsed.scores?.[d.id] ?? 0)
  return { round: packet.round, scores, notes: parsed.notes ?? '' }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

function renderReport(scores: JudgeScore[], mode: string): string {
  const lines: string[] = ['# 150-turn long-session — judge report', '', `Mode: **${mode}**`, '']
  lines.push('## Per-dimension averages (0–5)', '')
  lines.push('| dimension | avg | min | rounds < 4 |', '|---|---|---|---|')
  for (const d of JUDGE_DIMENSIONS) {
    const vals = scores.map((s) => s.scores[d.id])
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length
    const min = Math.min(...vals)
    const bad = scores.filter((s) => s.scores[d.id] < 4).map((s) => s.round)
    lines.push(`| ${d.zh} (${d.id}) | ${avg.toFixed(2)} | ${min} | ${bad.join(', ') || '-'} |`)
  }
  lines.push('', '## Notes on sub-4 rounds', '')
  const flagged = scores.filter((s) => Object.values(s.scores).some((v) => v < 4))
  if (flagged.length === 0) lines.push('_(none — every dimension scored ≥ 4 on every round)_')
  for (const s of flagged) {
    lines.push(`- **round ${s.round}**: ${s.notes}`)
  }
  return lines.join('\n')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const packets = readPackets(args.packets)
  const useLlm = Boolean(args.provider && args.model && args.apiKey)
  const mode = useLlm ? `LLM judge (${args.provider}/${args.model})` : 'offline heuristic'

  // eslint-disable-next-line no-console
  console.log(`[runJudge] ${packets.length} packets · ${mode}`)

  const scores = useLlm
    ? await mapWithConcurrency(packets, args.concurrency, (p) => llmScore(p, args))
    : packets.map(heuristicScore)

  const report = renderReport(scores, mode)
  const outPath = args.out ?? path.join(path.dirname(args.packets), 'judge-report.md')
  fs.writeFileSync(outPath, report, 'utf8')
  fs.writeFileSync(
    path.join(path.dirname(args.packets), 'judge-scores.json'),
    JSON.stringify(scores, null, 2),
    'utf8',
  )
  // eslint-disable-next-line no-console
  console.log(`[runJudge] report written to ${outPath}`)
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[runJudge] failed:', e)
  process.exit(1)
})
