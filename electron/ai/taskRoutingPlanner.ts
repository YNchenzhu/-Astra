/**
 * Lightweight task router (supervisor-style hints, no extra LLM call).
 *
 * Mirrors common patterns from LangGraph-style supervisors (structured routing)
 * and planner–executor separation: we only inject guidance into the system prompt.
 */

export type TaskKind =
  | 'trivial_qa'
  | 'explore'
  | 'plan'
  | 'implement'
  | 'debug'
  | 'multi_stream'
  | 'verify'
  | 'mixed'
  | 'unknown'

export type SubagentRoutingHint =
  | 'Explore'
  | 'Plan'
  | 'general-purpose'
  | 'Debug'
  | 'Verification'
  | 'Coordinator'

export interface TaskRoutingPlan {
  taskKind: TaskKind
  /** If set, UI should ideally match this role for this turn (hint only). */
  recommendedSessionAgent: string | null
  /** When the model uses `Agent`, prefer this order of `subagent_type`. */
  suggestedSubagentSequence: Array<{ type: SubagentRoutingHint; reason: string }>
  workflowPhases: Array<{ phase: string; detail: string }>
  discourageNestedAgent: boolean
  /** After substantive edits, require verification evidence before "done". */
  requireVerificationBeforeDone: boolean
  notes: string[]
}

const RE_MULTI = /(\n\s*[-*•]\s+)|(\n\s*\d+[.)]\s+)|(\b同时\b)|(\band\b.{0,40}\band\b)|(\bthen\b.{0,40}\band\b)/i
const RE_TRIVIAL_Q =
  /^(what|who|when|why|how)\s+is\b|^define\b|^explain\b|^简述|^什么是|^解释一下|^请问|^what does\b/i
const RE_EXPLORE = /(codebase|代码库|仓库|where\s+is|where\s+are|which\s+file|glob|grep|搜索|查找|定位|引用|调用链|how\s+does\b.{0,40}work|架构|目录结构)/i
const RE_PLAN = /(plan|design|architecture|方案|设计|规划|路线图|权衡|trade-?off|RFC|提案)/i
const RE_IMPL = /(implement|add\s+a?\s*feature|fix\s+the|refactor|实现|添加功能|修复|改动代码|写代码|加接口|迁移|upgrade|patch)/i
const RE_DEBUG = /(bug|crash|stack\s*trace|error:|exception|失败|不工作|broken|failing\s+test|regression|调试|报错)/i
const RE_VERIFY = /(verify|validation|ci|build|test\s+suite|npm\s+test|pytest|跑测|构建|lint|验收)/i
const RE_CODEISH = /(`[^`]+`|\.\w{2,4}\b|src\/|app\/|packages\/|\bfunction\s+\w+|\bclass\s+\w+|\bimport\s+|\bdef\s+\w+)/

function countBullets(s: string): number {
  return (s.match(/\n\s*[-*•]\s+/g) || []).length
}

/**
 * Derive a routing plan from the latest user text and current session agent.
 */
export function analyzeTaskRouting(
  lastUserText: string,
  ctx: { sessionAgentType: string; enableTools: boolean },
): TaskRoutingPlan {
  const raw = lastUserText.trim()
  const t = raw.slice(0, 12000)
  const session = (ctx.sessionAgentType || 'general-purpose').trim()
  const lower = t.toLowerCase()
  const short = t.length < 220 && t.split(/\s+/).length < 45
  const multi = RE_MULTI.test(t) || countBullets(t) >= 2

  const notes: string[] = []
  const suggestedSubagentSequence: TaskRoutingPlan['suggestedSubagentSequence'] = []
  const workflowPhases: TaskRoutingPlan['workflowPhases'] = []

  let taskKind: TaskKind = 'unknown'
  let recommendedSessionAgent: string | null = null
  let discourageNestedAgent = false
  let requireVerificationBeforeDone = false

  const hasExplore = RE_EXPLORE.test(t)
  const hasPlan = RE_PLAN.test(t)
  const hasImpl = RE_IMPL.test(t)
  const hasDebug = RE_DEBUG.test(t)
  const hasVerify = RE_VERIFY.test(t)
  const codeish = RE_CODEISH.test(t)
  const trivialQ =
    short &&
    !codeish &&
    !hasImpl &&
    !hasDebug &&
    (RE_TRIVIAL_Q.test(t.trim()) || /[？?]$/.test(t.trim()))

  if (!ctx.enableTools) {
    return {
      taskKind: 'unknown',
      recommendedSessionAgent: null,
      suggestedSubagentSequence: [],
      workflowPhases: [],
      discourageNestedAgent: false,
      requireVerificationBeforeDone: false,
      notes: ['Tools disabled; routing hints omitted.'],
    }
  }

  if (trivialQ) {
    taskKind = 'trivial_qa'
    discourageNestedAgent = true
    notes.push('Short Q&A style message without code paths — prefer answering directly.')
  }

  if (multi && !trivialQ) {
    taskKind = 'multi_stream'
    if (session !== 'Coordinator') {
      recommendedSessionAgent = 'Coordinator'
    }
    suggestedSubagentSequence.push(
      { type: 'Explore', reason: 'Parallel read-only reconnaissance on independent areas' },
      { type: 'general-purpose', reason: 'Targeted implementation per stream after scope is clear' },
      { type: 'Verification', reason: 'Objective checks before summarizing' },
    )
    workflowPhases.push(
      { phase: 'Decompose', detail: 'Split into independent work streams; avoid one mega-prompt per sub-agent.' },
      { phase: 'Delegate', detail: 'Use Agent tool with explicit subagent_type per stream.' },
      { phase: 'Synthesize', detail: 'Merge results; resolve conflicts before claiming done.' },
    )
    notes.push('Multiple items detected — coordinator-style fan-out is usually safer than one nested agent doing everything.')
  }

  if (hasDebug) {
    taskKind = taskKind === 'unknown' || taskKind === 'trivial_qa' ? 'debug' : 'mixed'
    if (session !== 'Debug' && session === 'general-purpose') {
      recommendedSessionAgent = 'Debug'
    }
    suggestedSubagentSequence.unshift({
      type: 'Debug',
      reason: 'Hypothesis → evidence → minimal fix',
    })
    workflowPhases.push({
      phase: 'Reproduce & evidence',
      detail: 'Capture logs, failing command, minimal repro before edits.',
    })
  }

  if (hasVerify && !hasImpl) {
    taskKind = taskKind === 'unknown' ? 'verify' : taskKind
    if (session !== 'Verification') {
      recommendedSessionAgent = 'Verification'
    }
    suggestedSubagentSequence.push({
      type: 'Verification',
      reason: 'User asked for checks / build / tests',
    })
  }

  if (hasExplore && !hasImpl) {
    taskKind = taskKind === 'unknown' ? 'explore' : taskKind
    if (session === 'general-purpose' && !hasDebug) {
      recommendedSessionAgent = 'Explore'
    }
    suggestedSubagentSequence.push({
      type: 'Explore',
      reason: 'Read-only navigation and search before any write',
    })
    workflowPhases.push({
      phase: 'Map',
      detail: 'Use Read / Glob / Grep; avoid writes until intent is clear.',
    })
  }

  if (hasPlan && !hasImpl) {
    taskKind = taskKind === 'unknown' ? 'plan' : taskKind
    if (session === 'general-purpose' && !hasDebug) {
      recommendedSessionAgent = 'Plan'
    }
    suggestedSubagentSequence.push({
      type: 'Plan',
      reason: 'Architecture / steps before touching implementation',
    })
  }

  if (hasImpl) {
    taskKind = taskKind === 'trivial_qa' ? 'implement' : taskKind === 'unknown' ? 'implement' : 'mixed'
    requireVerificationBeforeDone = true
    if (!suggestedSubagentSequence.some((x) => x.type === 'Explore') && hasExplore) {
      suggestedSubagentSequence.unshift({
        type: 'Explore',
        reason: 'Locate touchpoints and conventions',
      })
    }
    if (!suggestedSubagentSequence.some((x) => x.type === 'Plan') && (multi || lower.includes('refactor'))) {
      suggestedSubagentSequence.unshift({
        type: 'Plan',
        reason: 'Structure the change before editing many files',
      })
    }
    suggestedSubagentSequence.push({
      type: 'general-purpose',
      reason: 'Apply minimal edits aligned with repo patterns',
    })
    suggestedSubagentSequence.push({
      type: 'Verification',
      reason: 'Run build/tests or equivalent checks before declaring complete',
    })
    workflowPhases.push(
      { phase: 'Understand', detail: 'Read relevant files; do not edit blindly.' },
      { phase: 'Change', detail: 'Prefer small Edit steps; avoid drive-by refactors.' },
      {
        phase: 'Verify',
        detail:
          'MANDATORY: run Verification sub-agent or equivalent commands; attach pass/fail evidence in the final answer.',
      },
    )
    notes.push('Implementation intent — verification is required before claiming the task is finished.')
  }

  if (taskKind === 'unknown' && !trivialQ) {
    notes.push('No strong pattern matched — default to careful direct execution unless delegation clearly helps.')
  }

  // Dedupe sequence by type (keep first reason)
  const seen = new Set<string>()
  const deduped = suggestedSubagentSequence.filter((x) => {
    if (seen.has(x.type)) return false
    seen.add(x.type)
    return true
  })

  // Respect already-specialized session: drop wrong "switch agent" noise
  if (session === 'Coordinator') {
    recommendedSessionAgent = null
    notes.push('Coordinator session — keep delegating; routing below optimizes sub-agent choice, not session switch.')
  }
  if (session === 'Verification') {
    recommendedSessionAgent = null
    notes.push('Verification session — focus on objective checks; avoid unrelated implementation.')
  }
  if (session === 'Explore' || session === 'Plan' || session === 'Debug') {
    recommendedSessionAgent = null
  }

  return {
    taskKind,
    recommendedSessionAgent,
    suggestedSubagentSequence: deduped,
    workflowPhases,
    discourageNestedAgent,
    requireVerificationBeforeDone,
    notes,
  }
}

export function formatTaskRoutingSystemBlock(
  plan: TaskRoutingPlan,
  sessionAgentType: string,
  /**
   * Whether the active work package verifies via a code toolchain
   * (build / tests / typecheck / lint). Defaults to `true` to preserve the
   * historical coding-oriented wording for callers (and tests) that don't
   * pass it. When `false` the delivery gate keeps the universal
   * "verify before done" rule but drops code-specific commands — so a
   * writing / legal / general work package gets a domain-neutral gate
   * instead of being told to "run build/tests".
   */
  requireCodeVerification: boolean = true,
): string {
  if (plan.notes.length === 1 && plan.notes[0]?.startsWith('Tools disabled')) {
    return ''
  }

  const lines: string[] = [
    '# System task routing (supervisor hint)',
    '',
    'This section is **automatically generated** from the latest user message. Treat it as a **routing policy hint**: follow it when it matches user intent; if the user explicitly contradicts it, obey the user.',
    '',
    `**Current UI session agent**: \`${sessionAgentType}\``,
    `**Detected profile**: \`${plan.taskKind}\``,
    '',
  ]

  if (plan.recommendedSessionAgent) {
    lines.push(
      `**Suggested session agent (UI) for this kind of work**: \`${plan.recommendedSessionAgent}\` — switch when convenient; not mandatory if you can satisfy the task safely with current tools.`,
      '',
    )
  }

  if (plan.discourageNestedAgent) {
    lines.push(
      '**Anti-abuse (Agent tool)**',
      '- Do **not** call the `Agent` tool for this turn unless the user explicitly asked for a separate sub-agent or the task truly needs an isolated context window.',
      '- Prefer direct tools (Read / Grep / …) or a plain answer.',
      '',
    )
  }

  if (plan.suggestedSubagentSequence.length > 0) {
    lines.push('**When using `Agent`, prefer this `subagent_type` order**')
    plan.suggestedSubagentSequence.forEach((s, i) => {
      lines.push(`${i + 1}. **${s.type}** — ${s.reason}`)
    })
    lines.push('')
  }

  if (plan.workflowPhases.length > 0) {
    lines.push('**Suggested workflow**')
    plan.workflowPhases.forEach((w, i) => {
      lines.push(`${i + 1}. **${w.phase}**: ${w.detail}`)
    })
    lines.push('')
  }

  if (plan.requireVerificationBeforeDone) {
    if (requireCodeVerification) {
      lines.push(
        '**Delivery gate (verification before “done”)**',
        '- After **substantive** code or config changes, you **must not** tell the user the task is complete until you have **objective evidence** (tests, build, lint, or a **Verification** sub-agent run).',
        '- Invoke `Agent` with `subagent_type: "Verification"` (or run the same checks yourself if your tool set allows) and **summarize pass/fail** with command lines and key output lines.',
        '',
      )
    } else {
      lines.push(
        '**Delivery gate (verification before “done”)**',
        '- After **substantive** changes to the deliverable, you **must not** tell the user the work is complete until you have checked it against this work package’s own success criteria (e.g. its review pass, consistency / fact / tone checks, or a dedicated reviewer agent in this bundle).',
        '- State explicitly what you checked and what you observed. Do **not** use code-style build / test / lint commands unless this work package actually involves code.',
        '',
      )
    }
  }

  if (plan.notes.length > 0) {
    lines.push('**Notes**')
    plan.notes.forEach((n) => lines.push(`- ${n}`))
  }

  return lines.join('\n').trimEnd()
}
