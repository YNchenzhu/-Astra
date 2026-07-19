import { askUserQuestionInputZod } from './toolInputZod'
import { requestAskUserQuestion } from '../ai/interactionState'
import { getAgentContext } from '../agents/agentContext'
import {
  InterruptForHITL,
  canUseDurableHITL,
  tryConsumePendingHumanResume,
} from '../orchestration/hitl'
import { buildTool } from './buildTool'
import {
  ASK_USER_QUESTION_TOOL_CHIP_WIDTH,
  buildAskUserQuestionToolDescription,
  formatAskUserQuestionToolResultText,
  getAskUserQuestionPreviewFormat,
} from './askUserQuestionPrompt'

type AskQuestionOption = {
  label: string
  description: string
  preview?: string
}

type AskQuestionInput = {
  question: string
  header: string
  options: AskQuestionOption[]
  multiSelect?: boolean
}

/** upstream AskUserQuestion: 1–4 questions, 2–4 options each */
export const ASK_USER_QUESTION_MAX_QUESTIONS = 4
export const ASK_USER_QUESTION_MIN_OPTIONS = 2
export const ASK_USER_QUESTION_MAX_OPTIONS = 4

const QUESTION_ITEM_SCHEMA = {
  type: 'object',
  description:
    'One multiple-choice question. Question texts must be unique across the batch; option labels must be unique within the question.',
  required: ['header', 'question', 'options'],
  properties: {
    header: {
      type: 'string',
      description: `Very short label displayed as a chip/tag (max ${ASK_USER_QUESTION_TOOL_CHIP_WIDTH} chars). Examples: "Auth method", "Library", "Approach".`,
    },
    question: {
      type: 'string',
      description:
        'The complete question to ask the user. Should be clear, specific, and end with a question mark.',
    },
    multiSelect: {
      type: 'boolean',
      description:
        'If true, user may pick more than one option for this question (mutually non-exclusive choices).',
    },
    options: {
      type: 'array',
      minItems: ASK_USER_QUESTION_MIN_OPTIONS,
      maxItems: ASK_USER_QUESTION_MAX_OPTIONS,
      description: `The available choices (${ASK_USER_QUESTION_MIN_OPTIONS}–${ASK_USER_QUESTION_MAX_OPTIONS}). No "Other" option — the UI adds it. Previews: single-select only.`,
      items: {
        type: 'object',
        required: ['label', 'description'],
        properties: {
          label: {
            type: 'string',
            description: 'Concise display text (1–5 words) for the choice.',
          },
          description: {
            type: 'string',
            description: 'What this option means or what happens if chosen.',
          },
          preview: {
            type: 'string',
            description:
              'Optional focused preview (markdown or HTML fragment per app settings). Single-select only.',
          },
        },
      },
    },
  },
} as const

export function validateAskUserQuestionUniqueness(questions: AskQuestionInput[]): boolean {
  const texts = questions.map((q) => q.question)
  if (texts.length !== new Set(texts).size) return false
  for (const q of questions) {
    const labels = q.options.map((o) => o.label)
    if (labels.length !== new Set(labels).size) return false
  }
  return true
}

/** upstream-style HTML fragment guard when preview format is html */
export function validateHtmlPreview(preview: string | undefined): string | null {
  if (preview === undefined) return null
  if (/<\s*(html|body|!doctype)\b/i.test(preview)) {
    return 'preview must be an HTML fragment, not a full document (no <html>, <body>, or <!DOCTYPE>)'
  }
  if (/<\s*(script|style)\b/i.test(preview)) {
    return 'preview must not contain <script> or <style> tags. Use inline styles via the style attribute if needed.'
  }
  if (!/<[a-z][^>]*>/i.test(preview)) {
    return 'preview must contain HTML (preview format is set to "html"). Wrap content in a tag like <div> or <pre>.'
  }
  return null
}

function validateQuestions(raw: unknown): raw is AskQuestionInput[] {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > ASK_USER_QUESTION_MAX_QUESTIONS
  ) {
    return false
  }
  if (!validateAskUserQuestionUniqueness(raw)) return false
  return raw.every((q) => {
    if (!q || typeof q !== 'object') return false
    const item = q as Record<string, unknown>
    if (typeof item.question !== 'string' || !item.question.trim()) return false
    if (typeof item.header !== 'string' || !item.header.trim()) return false
    if (
      !Array.isArray(item.options) ||
      item.options.length < ASK_USER_QUESTION_MIN_OPTIONS ||
      item.options.length > ASK_USER_QUESTION_MAX_OPTIONS
    ) {
      return false
    }
    return item.options.every((opt) => {
      if (!opt || typeof opt !== 'object') return false
      const option = opt as Record<string, unknown>
      return (
        typeof option.label === 'string' &&
        option.label.trim().length > 0 &&
        typeof option.description === 'string' &&
        option.description.trim().length > 0
      )
    })
  })
}

function trimStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * Maps common model output shapes (missing descriptions, the IDE-style aliases, JSON strings)
 * into the strict shape required by the UI.
 */
export function normalizeAskUserQuestionsInput(input: Record<string, unknown>): AskQuestionInput[] | null {
  let raw: unknown = input.questions

  if (typeof raw === 'string') {
    const t = raw.trim()
    if (!t) return null
    try {
      raw = JSON.parse(t) as unknown
    } catch {
      return null
    }
  }

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const one = raw as Record<string, unknown>
    if (Array.isArray(one.options)) {
      raw = [one]
    } else {
      return null
    }
  }

  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > ASK_USER_QUESTION_MAX_QUESTIONS
  ) {
    return null
  }

  const out: AskQuestionInput[] = []

  for (const q of raw) {
    if (!q || typeof q !== 'object') return null
    const item = q as Record<string, unknown>

    const header =
      trimStr(item.header) ||
      trimStr(item.title) ||
      trimStr(item.name) ||
      trimStr(item.heading)
    const question =
      trimStr(item.question) ||
      trimStr(item.prompt) ||
      trimStr(item.text) ||
      trimStr(item.body) ||
      trimStr(item.message)

    if (!header || !question) return null

    const optsRaw = item.options
    if (!Array.isArray(optsRaw)) return null

    const options: AskQuestionOption[] = []
    for (const opt of optsRaw) {
      if (typeof opt === 'string') {
        const label = opt.trim()
        if (!label) return null
        options.push({ label, description: label })
        continue
      }
      if (!opt || typeof opt !== 'object') return null
      const o = opt as Record<string, unknown>
      const label =
        trimStr(o.label) || trimStr(o.value) || trimStr(o.id) || trimStr(o.title) || trimStr(o.name)
      let description =
        trimStr(o.description) || trimStr(o.detail) || trimStr(o.help) || trimStr(o.text)
      if (!label) return null
      if (!description) description = label
      const preview = trimStr(o.preview) || undefined
      options.push(preview ? { label, description, preview } : { label, description })
    }

    if (
      options.length < ASK_USER_QUESTION_MIN_OPTIONS ||
      options.length > ASK_USER_QUESTION_MAX_OPTIONS
    ) {
      return null
    }

    const multiSelect = item.multiSelect === true || item.multi_select === true
    out.push(multiSelect ? { header, question, options, multiSelect: true } : { header, question, options })
  }

  if (!validateAskUserQuestionUniqueness(out)) return null

  return out
}

export const askUserQuestionTool = buildTool({
  name: 'AskUserQuestion',
  zInputSchema: askUserQuestionInputZod,
  description: buildAskUserQuestionToolDescription(),
  searchHint: 'prompt the user with a multiple-choice question',
  inputSchema: [
    {
      name: 'questions',
      type: 'array',
      description: `1–${ASK_USER_QUESTION_MAX_QUESTIONS} questions; each with header, question, and ${ASK_USER_QUESTION_MIN_OPTIONS}–${ASK_USER_QUESTION_MAX_OPTIONS} options (label + description). Question texts must be unique; option labels unique per question.`,
      required: true,
      items: QUESTION_ITEM_SCHEMA as unknown as Record<string, unknown>,
    },
    {
      name: 'answers',
      type: 'object',
      description:
        'Optional: filled by the client after the user responds. Do not supply when calling the tool from the model.',
      required: false,
    },
    {
      name: 'annotations',
      type: 'object',
      description:
        'Optional per-question notes from the user (e.g. preview selection). Keyed by question text.',
      required: false,
    },
    {
      name: 'metadata',
      type: 'object',
      description: 'Optional metadata (e.g. { source: string }) for analytics or routing.',
      required: false,
    },
  ],
  isReadOnly: true,
  isConcurrencySafe: true,
  validateInput: async (input) => {
    const record = input as Record<string, unknown>
    const normalized = normalizeAskUserQuestionsInput(record)
    if (!normalized || !validateQuestions(normalized)) {
      return {
        valid: false,
        message:
          `Invalid questions: need 1-${ASK_USER_QUESTION_MAX_QUESTIONS} questions, each with unique question text, header, and ${ASK_USER_QUESTION_MIN_OPTIONS}-${ASK_USER_QUESTION_MAX_OPTIONS} options with unique labels (label + description).`,
      }
    }
    if (getAskUserQuestionPreviewFormat() === 'html') {
      for (const q of normalized) {
        for (const opt of q.options) {
          const err = validateHtmlPreview(opt.preview)
          if (err) {
            return {
              valid: false,
              message: `Option "${opt.label}" in question "${q.question}": ${err}`,
            }
          }
        }
      }
    }
    return { valid: true }
  },
  async call(input, ctx) {
    const record = input as Record<string, unknown>
    const normalized = normalizeAskUserQuestionsInput(record)
    const questions = normalized && validateQuestions(normalized) ? normalized : null
    const metadata = record.metadata

    if (!questions) {
      return {
        success: false,
        error:
          `Invalid questions format. Expected 1-${ASK_USER_QUESTION_MAX_QUESTIONS} questions with unique question texts; each needs header/question and ${ASK_USER_QUESTION_MIN_OPTIONS}-${ASK_USER_QUESTION_MAX_OPTIONS} unique option labels (description may match label).`,
      }
    }

    // P2.1 — Durable HITL path (flag-gated, default OFF).
    //
    // Flow:
    //   1. If a `pending_human_resume` is already queued for this tool_use_id, consume it
    //      and return the prior answer (covers post-restart resume).
    //   2. Otherwise, throw `InterruptForHITL` so the orchestration runtime persists kernel
    //      state and exits cleanly. The renderer sees the question via the phase event,
    //      collects the user's answer, calls `enqueueHumanResume`, and the kernel resumes
    //      on its next turn — this tool call runs again, hits step 1, returns the value.
    //
    // G1 — `canUseDurableHITL` is stricter than `isDurableHITLEnabled`: it also requires
    // a conversation id AND a currently-registered kernel. Without those the throw would
    // leak (toolExec can't pick up the pending entry → kernel can't be aborted → the
    // model retries the tool → infinite throw loop). When the gate fails we fall through
    // to the legacy IPC-await path, which works regardless of kernel registration.
    //
    // Flag OFF or gate fails: legacy in-process await (preserved verbatim below).
    const agentCtx = getAgentContext()
    const conversationId = agentCtx?.streamConversationId
    const toolUseId = ctx?.toolUseId
    // The default-on durable HITL path currently pauses by aborting the kernel.
    // The kernel is then unregistered before the user can answer
    // (`enqueueHumanResume -> no_kernel`), so submitted answers are dropped.
    // Keep AskUserQuestion on the legacy in-memory await path unless explicitly
    // opted in while the durable resume lifecycle is finished.
    const askDurableOptIn =
      process.env.POLE_ASK_USER_QUESTION_DURABLE_HITL?.trim().toLowerCase() === '1'
    const durableEnabled = askDurableOptIn && canUseDurableHITL(conversationId)
    if (durableEnabled) {
      const resumed = tryConsumePendingHumanResume(conversationId, toolUseId)
      if (resumed.resumed) {
        const v = resumed.value
        if (v && typeof v === 'object' && 'answers' in (v as Record<string, unknown>)) {
          const r = v as { answers: unknown; annotations?: unknown }
          return {
            success: true,
            output: formatAskUserQuestionToolResultText({
              // Cast: the renderer always sends string answers (single-select) or
              // newline-joined strings (multi-select handled upstream); the formatter
              // expects `Record<string, string>`.
              answers: r.answers as Record<string, string>,
              ...(r.annotations
                ? {
                    annotations: r.annotations as Record<
                      string,
                      { preview?: string; notes?: string }
                    >,
                  }
                : {}),
            }),
          }
        }
        // Resume value wasn't shaped like an answer payload — treat as user cancel.
        return {
          success: false,
          error: 'AskUserQuestion resumed with malformed value',
        }
      }
      // No queued resume → ask the orchestration runtime to pause.
      throw new InterruptForHITL(toolUseId ?? '<unknown>', { questions, metadata })
    }

    // P0-6: forward the running agent's abort signal so Stop / parent abort
    // unblocks the awaiting model loop instead of leaving the tool resolved
    // only on the renderer's reply or the long pending-request timeout.
    const ctxSignal = agentCtx?.signal

    const result = await requestAskUserQuestion({
      questions,
      ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? { metadata: metadata as { source?: string } }
        : {}),
      ...(ctxSignal ? { signal: ctxSignal } : {}),
    })

    if (ctxSignal?.aborted) {
      return {
        success: false,
        error: 'AskUserQuestion aborted',
      }
    }

    // P1-34: branch on the outcome marker so timeouts / external cancels
    // surface as `success: false` instead of an empty `success: true`. The
    // model previously treated those resolutions as "user explicitly
    // answered nothing" and would invent a downstream action; now it sees
    // an explicit failure and can decide to retry or stop.
    if (result.outcome === 'timeout') {
      return {
        success: false,
        error: 'AskUserQuestion timed out — the user did not respond within the pending-request window.',
      }
    }
    if (result.outcome === 'aborted') {
      return {
        success: false,
        error: 'AskUserQuestion aborted',
      }
    }
    if (result.outcome === 'cancelled_external') {
      return {
        success: false,
        error: 'AskUserQuestion cancelled — pending interactions for this conversation were dropped (e.g., session was reset).',
      }
    }

    const output = formatAskUserQuestionToolResultText({
      answers: result.answers,
      ...(result.annotations ? { annotations: result.annotations } : {}),
    })

    return {
      success: true,
      output,
    }
  },
})
