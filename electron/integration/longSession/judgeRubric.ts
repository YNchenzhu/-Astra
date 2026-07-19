/**
 * LLM-as-judge rubric for the 150-turn long-session integration test.
 *
 * The 150-turn harness (`../longSession.150turn.integration.test.ts`) drives a
 * scripted (mocked) model so the run is hermetic and deterministic. What a
 * *real* model never gets to do in that setup is "understand" — its replies are
 * pre-scripted. So the thing actually worth judging is **the context payload
 * the harness assembles and would feed to a real model on each turn** (the
 * "wire"): given that payload, could a competent model still reconstruct
 *
 *   1. what the user is asking RIGHT NOW,
 *   2. what has already been done,
 *   3. what the current state is,
 *   4. what should happen next,
 *
 * and is that signal corrupted by tool-routing noise, missing skill content, or
 * thinking-block interference?
 *
 * This module is the single source of truth for the scoring dimensions and the
 * judge prompt. It is imported by both the test (which emits per-round judge
 * packets) and the pluggable judge runner (`./runJudge.ts`), so the rubric the
 * packets are scored against can never drift from the rubric the test documents.
 *
 * The judge step is intentionally DECOUPLED from the test: the test only emits
 * artifacts (offline, no API key). Point `runJudge.ts` at a real model when you
 * want semantic scores.
 */

/** The seven observation dimensions the user asked to stress. */
export const JUDGE_DIMENSIONS = [
  {
    id: 'understands_current_user_message',
    zh: '对当前 user message 的理解',
    desc: 'Can the model tell, from this turn\'s payload, exactly what the user is asking for on THIS turn?',
  },
  {
    id: 'recalls_what_was_done',
    zh: '之前做了哪些（历史追溯）',
    desc: 'Is the record of prior work (edits made, tools run, decisions taken) still recoverable from the payload, including across compaction boundaries?',
  },
  {
    id: 'aware_of_current_state',
    zh: '现在是什么情况（当前状态）',
    desc: 'Is the current state of the task unambiguous — which phase, what is in-flight, what is blocked?',
  },
  {
    id: 'knows_next_step',
    zh: '准备要做什么（下一步规划）',
    desc: 'Does the payload give enough grounding for the model to choose a sound next action consistent with the standing goal and the latest correction?',
  },
  {
    id: 'tool_routing_sane',
    zh: '工具的正确命中',
    desc: 'Are tool_use/tool_result pairs intact and is the tool history coherent (no orphans, no obviously wrong tool for the stated intent)?',
  },
  {
    id: 'skill_content_loaded',
    zh: 'skill 的内容加载',
    desc: 'Is the active skill\'s instruction content present and intact in the payload (and re-injected after compaction)?',
  },
  {
    id: 'thinking_not_interfering',
    zh: 'thinking 的干扰',
    desc: 'Do thinking / redacted_thinking blocks stay out of the way — not leaking as user narration, not the last block of an assistant turn, not crowding out load-bearing facts?',
  },
  // 2026-07 uplift #3 — goal-drift dimension. Judges whether the work
  // direction visible in THIS turn's payload still serves the standing
  // goal (including mid-run corrections). Complements the host's
  // quantitative drift score (`hostSignals.driftScore`, when present).
  {
    id: 'goal_drift_contained',
    zh: '目标漂移抑制',
    desc: 'Comparing the original standing goal (and any mid-run corrections) against the work direction evident in this turn\'s payload: is the session still pointed at the goal, or has it drifted into unrelated side work the user never asked for?',
  },
] as const

export type JudgeDimensionId = (typeof JUDGE_DIMENSIONS)[number]['id']

/** One row the judge produces per round. */
export interface JudgeScore {
  round: number
  /** 0–5 per dimension (5 = no problem, 0 = severe failure). */
  scores: Record<JudgeDimensionId, number>
  /** Short free-text note explaining any score < 4. */
  notes: string
}

/**
 * What the harness writes to disk per round. The judge reads these; a human can
 * read them too. `wire` is the exact, ordered list of messages the model would
 * receive that turn (text / thinking preserved, tool_result bodies truncated to
 * keep packets readable — the judge scores narrative coherence, not raw bytes).
 */
export interface JudgePacket {
  round: number
  phase: string
  /** The verbatim user instruction issued this round (the "current message"). */
  userInstructionThisRound: string
  /** Context-management action the real tier logic took this round. */
  compactAction: string
  /** Tool names the scripted assistant emitted this round. */
  toolsUsedThisRound: string[]
  /** Skill names recorded as active/invoked at this round. */
  activeSkills: string[]
  /** Count of thinking + redacted_thinking blocks present on the wire this round. */
  thinkingBlockCount: number
  /** The ordered wire payload (what the model receives). */
  wire: Array<{ role: string; blocks: Array<{ type: string; text?: string; toolUseId?: string; name?: string }> }>
  /**
   * 2026-07 uplift #3 — deterministic host-side control-loop signals for
   * this round, so the judge (and dashboards) can correlate semantic
   * scores with what the guards actually observed. All optional: the
   * hermetic harness fills what its simulation exercises; production
   * telemetry fills the rest.
   */
  hostSignals?: {
    /** Cosine(objective, recent activity) from the drift monitor; null = not measured. */
    driftScore?: number | null
    /** Repetition-guard halts observed this round. */
    repetitionHalts?: number
    /** Host-attachment collectors shed by the injection budget this round. */
    injectionSheds?: number
    /** Plan-step budget escalations (soft nudges + hard fails) this round. */
    planStepBudgetEvents?: number
  }
}

export const JUDGE_SYSTEM_PROMPT = `You are a strict evaluator auditing the CONTEXT PAYLOAD an AI coding agent
would receive on a single turn of a very long (150-turn) session. You are NOT
judging any model's answer — you are judging whether the payload itself carries
enough coherent, uncorrupted signal for a competent model to act correctly.

For each turn you are given:
  - the user's instruction THIS turn,
  - the host's context-management action,
  - the tools the agent used,
  - the active skills,
  - and the full ordered "wire" (the messages the model receives).

Score each of these dimensions from 0 (severe problem) to 5 (no problem):
${JUDGE_DIMENSIONS.map((d) => `  - ${d.id}: ${d.desc}`).join('\n')}

Be skeptical. A high score means: from THIS payload alone, the four questions
(what is asked now / what was done / current state / next step) are answerable,
tools are coherent, the active skill body is present, and thinking blocks are not
interfering. Penalize forgotten standing goals, dropped mid-run corrections,
orphaned tool results, missing skill bodies, and thinking that crowds out facts.

Respond with ONE JSON object per turn:
{"round": <n>, "scores": {"understands_current_user_message": <0-5>, ...all seven...}, "notes": "<why any score < 4>"}`

/** Build the per-round user message handed to the judge model. */
export function buildJudgeUserMessage(packet: JudgePacket): string {
  return [
    `# Turn ${packet.round} (phase: ${packet.phase})`,
    ``,
    `## User instruction THIS turn`,
    packet.userInstructionThisRound,
    ``,
    `## Host context action: ${packet.compactAction}`,
    `## Tools used this turn: ${packet.toolsUsedThisRound.join(', ') || '(none)'}`,
    `## Active skills: ${packet.activeSkills.join(', ') || '(none)'}`,
    `## Thinking blocks on wire: ${packet.thinkingBlockCount}`,
    ...(packet.hostSignals
      ? [
          `## Host control-loop signals: ` +
            `driftScore=${packet.hostSignals.driftScore ?? 'n/a'}, ` +
            `repetitionHalts=${packet.hostSignals.repetitionHalts ?? 0}, ` +
            `injectionSheds=${packet.hostSignals.injectionSheds ?? 0}, ` +
            `planStepBudgetEvents=${packet.hostSignals.planStepBudgetEvents ?? 0}`,
        ]
      : []),
    ``,
    `## Wire payload (what the model receives, in order)`,
    '```json',
    JSON.stringify(packet.wire, null, 1),
    '```',
    ``,
    `Score this turn now as a single JSON object.`,
  ].join('\n')
}
