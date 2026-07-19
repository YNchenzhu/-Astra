/**
 * IM bridge protocol — pure translation helpers (no Electron / no I/O).
 *
 * Kept dependency-free so it can be unit-tested in isolation and reused by
 * `imBridge.ts`. Converts the app's native `StreamEvent`s into the upstream
 * desktop-server `ServerMessage` shape the ported adapters understand, and
 * builds Anthropic-style content blocks from IM attachments.
 */

/** Minimal upstream attachment ref (mirrors adapters/common/ws-bridge.ts). */
export interface ImAttachmentRef {
  type: 'file' | 'image'
  name?: string
  path?: string
  data?: string
  mimeType?: string
}

/** upstream ServerMessage — `type` plus arbitrary fields. */
export type ImServerMessage = Record<string, unknown> & { type: string }

/** Minimal shape of an AskUserQuestion item (mirrors interactionState's). */
export interface ImAskQuestionItem {
  question?: string
  header?: string
  options?: Array<{ label?: string; description?: string }>
  multiSelect?: boolean
}

/** Stable answer key for one question (matches the model-facing format). */
function askQuestionKey(q: ImAskQuestionItem, index: number): string {
  return (q.header || q.question || `question_${index + 1}`).trim() || `question_${index + 1}`
}

/**
 * Render an AskUserQuestion into IM-friendly text so a phone/WeChat user can
 * answer it — the upstream adapter has no native AskUserQuestion UI, so we surface
 * it as a plain numbered prompt and route the user's reply back into the pending
 * request (see `imBridge`).
 */
export function formatAskQuestionText(questions: ImAskQuestionItem[]): string {
  const lines: string[] = ['🤔 需要你确认：', '']
  questions.forEach((q, qi) => {
    const title = (q.header || q.question || `问题 ${qi + 1}`).trim()
    if (questions.length > 1) lines.push(`【${qi + 1}】${title}`)
    else lines.push(title)
    if (q.header && q.question && q.header !== q.question) lines.push(q.question.trim())
    const opts = Array.isArray(q.options) ? q.options : []
    opts.forEach((o, oi) => {
      const label = (o.label || o.description || '').trim()
      if (label) lines.push(`  ${oi + 1}. ${label}`)
    })
    lines.push('')
  })
  lines.push(
    questions.length > 1
      ? '请逐行回复每个问题的选项编号或文字（一行一个）。'
      : '直接回复选项编号或文字即可。',
  )
  return lines.join('\n')
}

/**
 * Parse a free-text IM reply into an `answers` map keyed the same way the
 * AskUserQuestion tool result expects. Numeric replies select the matching
 * option's label; otherwise the raw text is used verbatim. For multi-question
 * asks, each non-empty line maps to a question in order.
 */
export function parseAskAnswers(
  questions: ImAskQuestionItem[],
  replyText: string,
): Record<string, string> {
  const reply = replyText.trim()
  const lines = reply.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const answers: Record<string, string> = {}
  questions.forEach((q, qi) => {
    const raw = (questions.length > 1 ? lines[qi] : reply) || lines[lines.length - 1] || reply
    const opts = Array.isArray(q.options) ? q.options : []
    let value = raw
    const n = Number.parseInt(raw, 10)
    if (String(n) === raw && n >= 1 && n <= opts.length) {
      value = (opts[n - 1].label || opts[n - 1].description || raw).trim()
    }
    answers[askQuestionKey(q, qi)] = value
  })
  return answers
}

/** Loopback detection (IPv4 / IPv6 / IPv4-mapped). */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false
  const a = addr.replace(/^::ffff:/, '')
  return a === '127.0.0.1' || a === '::1' || a === 'localhost'
}

/**
 * Map one native StreamEvent to zero or more upstream ServerMessages.
 *
 * Typing-indicator semantics on the adapter side (see
 * `adapters/wechat/index.ts#handleServerMessage`):
 *   - `status` thinking/tool_executing → start typing
 *   - `content_start` tool_use / `tool_use_complete` / `tool_result` → keep typing
 *   - `message_complete` / `error` / `permission_request` → stop typing
 * We therefore surface tool lifecycle + completion faithfully and additionally
 * let `imBridge` push a synthetic `status: thinking` at turn start so a
 * text-only reply still shows the indicator while the model is generating.
 */
export function translateStreamEventToServerMessages(
  ev: { type?: string } & Record<string, unknown>,
): ImServerMessage[] {
  const e = ev
  switch (ev.type) {
    case 'text_delta':
      return typeof e.text === 'string' && e.text
        ? [{ type: 'content_delta', text: e.text }]
        : []
    case 'tool_start': {
      const toolUse = e.toolUse as { name?: string } | undefined
      const toolName = toolUse?.name ?? (typeof e.toolName === 'string' ? e.toolName : undefined)
      return [
        { type: 'status', state: 'tool_executing', verb: toolName },
        { type: 'content_start', blockType: 'tool_use', toolName },
        { type: 'tool_use_complete', toolName },
      ]
    }
    case 'tool_result':
      return [{ type: 'status', state: 'thinking' }, { type: 'tool_result' }]
    case 'permission_request':
      return [{
        type: 'permission_request',
        requestId: e.requestId,
        toolName: e.toolName,
        input: e.input ?? {},
      }]
    case 'ask_user_question': {
      // The adapter has no AskUserQuestion UI, so surface the prompt as text and
      // stop the typing indicator — the agent is now paused waiting for a reply,
      // which `imBridge` routes back into `respondAskUserQuestion`.
      const questions = Array.isArray(e.questions) ? (e.questions as ImAskQuestionItem[]) : []
      if (questions.length === 0) return []
      return [
        { type: 'content_delta', text: formatAskQuestionText(questions) },
        { type: 'message_complete' },
      ]
    }
    case 'message_stop':
    case 'task_terminated':
      return [{ type: 'message_complete' }]
    case 'error':
      return [{ type: 'error', message: e.error ?? e.message ?? 'unknown error' }]
    default:
      return []
  }
}

/**
 * Build an Anthropic-style content payload from IM text + attachments.
 *
 * - Image attachments with inline base64 `data` become `image` blocks.
 * - File attachments (downloaded to disk by the adapter) are surfaced as a
 *   `# attached files` hint listing their absolute paths so the model can
 *   `read_file` them with its own tools — mirroring how `referencedFiles`
 *   works in the desktop chat.
 * - When there are no attachments the plain string is returned unchanged.
 */
export function buildImContentBlocks(
  text: string,
  attachments: ImAttachmentRef[],
): string | Array<Record<string, unknown>> {
  const images = attachments.filter((a) => a.type === 'image' && a.data)
  const files = attachments.filter((a) => a.type === 'file' && a.path)

  if (images.length === 0 && files.length === 0) return text

  const blocks: Array<Record<string, unknown>> = []

  let leadingText = text
  if (files.length > 0) {
    const fileLines = files
      .map((f) => `- ${f.name || f.path}: ${f.path}`)
      .join('\n')
    const hint = `# attached files\n${fileLines}`
    leadingText = leadingText ? `${leadingText}\n\n${hint}` : hint
  }

  if (leadingText) blocks.push({ type: 'text', text: leadingText })

  for (const img of images) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mimeType || 'image/png',
        data: img.data,
      },
    })
  }

  return blocks.length > 0 ? blocks : text
}
