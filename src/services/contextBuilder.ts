import type { Attachment, ChatMessage } from '../types'
import type { RetrievedSnippet } from './semanticContext'
import { isAbsolutePath, joinWorkspaceRelative } from './pathUtils'

interface ReferencedFileContext {
  path: string
  content: string | null
}

/** Keys are section titles for `# key` lines inside <system-reminder> (snake_case, readable). */
export type ContextSectionMap = Record<string, string>

/**
 * Build structured workspace/editor context for the reminder message (not merged into user text).
 */
export function buildContext(
  activeFilePath: string | null,
  activeFileContent: string | null,
  openFiles: string[],
  workspaceRoot: string | null,
  referencedFiles: ReferencedFileContext[] = [],
  retrievedSnippets: RetrievedSnippet[] = [],
  editorDiagnosticsSummary: string | null = null,
): ContextSectionMap {
  const sections: ContextSectionMap = {}

  if (activeFilePath && activeFileContent) {
    const lines = activeFileContent.split('\n')
    const preview = lines.slice(0, 100).join('\n')
    const suffix = lines.length > 100 ? `\n\n... (${lines.length - 100} more lines)` : ''
    const abs =
      workspaceRoot && !isAbsolutePath(activeFilePath)
        ? joinWorkspaceRelative(workspaceRoot, activeFilePath)
        : activeFilePath
    const normAbs = abs.replace(/\\/g, '/')
    const pathLines =
      workspaceRoot && normAbs.replace(/\\/g, '/') !== activeFilePath.replace(/\\/g, '/')
        ? `Path (editor / relative): ${activeFilePath}\nPath (resolved absolute): ${normAbs}`
        : `Path: ${activeFilePath}`
    sections.active_file = `${pathLines}\n\n${preview}${suffix}`
  }

  if (openFiles.length > 0) {
    sections.open_files = openFiles.join('\n')
  }

  if (referencedFiles.length > 0) {
    const pathLines = referencedFiles.map((f) => {
      if (!workspaceRoot || isAbsolutePath(f.path)) return f.path
      const abs = joinWorkspaceRelative(workspaceRoot, f.path).replace(/\\/g, '/')
      return `${f.path} → ${abs}`
    })
    sections.referenced_paths = pathLines.join('\n')
    const contentParts: string[] = []
    for (const refFile of referencedFiles) {
      if (!refFile.content) continue
      const lines = refFile.content.split('\n')
      const preview = lines.slice(0, 120).join('\n')
      const suffix = lines.length > 120 ? `\n\n... (${lines.length - 120} more lines)` : ''
      contentParts.push(`--- ${refFile.path} ---\n${preview}${suffix}`)
    }
    if (contentParts.length > 0) {
      sections.referenced_files_detail = contentParts.join('\n\n')
    }
  }

  if (retrievedSnippets.length > 0) {
    sections.retrieved_snippets = retrievedSnippets
      .map((s) => `### ${s.relativePath} (${s.matchCount} matches)\n${s.lines}`)
      .join('\n\n')
  }

  if (workspaceRoot) {
    sections.workspace = workspaceRoot
  }

  if (editorDiagnosticsSummary?.trim()) {
    sections.editor_diagnostics = editorDiagnosticsSummary.trim()
  }

  return sections
}

/**
 * Format merged context sections as the first user message (upstream-style <system-reminder>).
 */
export function formatContextReminderMessage(sections: ContextSectionMap): string {
  const entries = Object.entries(sections).filter(([, v]) => typeof v === 'string' && v.trim())
  if (entries.length === 0) {
    return ''
  }

  const body = entries.map(([key, value]) => `# ${key}\n${value.trim()}`).join('\n\n')

  return `<system-reminder>
As you answer the user's questions, you can use the following context:

${body}

IMPORTANT: This context may or may not be relevant to your tasks. Do not respond to this reminder alone. Follow the explicit instructions in the user messages below unless this context is clearly needed.

CRITICAL: The conversation_history_summary section captures early messages that have been compressed. Statements like "I decided to fix Bug X" or "我会修复 Bug X" are PLANS that were stated, NOT confirmation that the work was completed. Always verify against the most recent tool results whether a task was actually executed.
</system-reminder>`
}

const COMPACT_WINDOW = 40

/**
 * Summarize early messages that would otherwise be discarded.
 * Pure text extraction — no LLM call. Produces a structured digest
 * covering user intents, AI decisions, files, and errors.
 */
export function summarizeEarlyMessages(
  earlyMessages: ChatMessage[],
): string {
  if (earlyMessages.length === 0) return ''

  const userIntents: string[] = []
  const aiDecisions: string[] = []
  const filesReferenced = new Set<string>()
  const errorsEncountered: string[] = []

  for (const msg of earlyMessages) {
    const text = msg.content?.trim()
    if (msg.role === 'user' && msg.referencedFiles?.length) {
      for (const p of msg.referencedFiles) {
        filesReferenced.add(p)
      }
    }
    if (!text) continue

    if (msg.role === 'user') {
      const firstSentence = text.split(/[。\n.!？]/).filter(Boolean)[0]
      if (firstSentence && firstSentence.length > 5) {
        userIntents.push(firstSentence.slice(0, 150))
      }
    } else {
      const filePaths = text.match(/[\w./\\-]+\.\w{1,8}/g)
      if (filePaths) {
        for (const fp of filePaths.slice(0, 10)) {
          if (fp.includes('/') || fp.includes('\\')) {
            filesReferenced.add(fp)
          }
        }
      }

      const decisionPatterns = [
        /(?:我(?:建议|推荐|决定|选择|会|将))(.{10,80})/g,
        /(?:I (?:suggest|recommend|decided|chose|will))(.{10,80})/gi,
        /(?:方案|结论|总结|关键|重要)[:：]?\s*(.{10,80})/g,
      ]
      for (const pattern of decisionPatterns) {
        let match
        while ((match = pattern.exec(text)) !== null) {
          aiDecisions.push(match[0].slice(0, 120))
          if (aiDecisions.length >= 5) break
        }
      }

      const errorMatch = text.match(/(?:错误|error|failed|失败|异常|exception)[:：]?\s*(.{10,100})/gi)
      if (errorMatch) {
        for (const e of errorMatch.slice(0, 3)) {
          errorsEncountered.push(e.slice(0, 120))
        }
      }
    }
  }

  const sections: string[] = []
  sections.push(`[对话历史摘要 — 前 ${earlyMessages.length} 条消息]`)

  if (userIntents.length > 0) {
    const uniqueIntents = [...new Set(userIntents)].slice(0, 6)
    sections.push(`用户讨论的主题：\n${uniqueIntents.map((i) => `- ${i}`).join('\n')}`)
  }

  if (aiDecisions.length > 0) {
    const uniqueDecisions = [...new Set(aiDecisions)].slice(0, 5)
    sections.push(
      `AI 的计划/意图（注意：以下为早期消息中 AI 声明的计划，并非确认已完成的操作。请基于最近的工具执行结果判断实际完成状态）：\n${uniqueDecisions.map((d) => `- ${d}`).join('\n')}`,
    )
  }

  if (filesReferenced.size > 0) {
    const fileList = [...filesReferenced].slice(0, 15)
    sections.push(`涉及的文件：\n${fileList.map((f) => `- ${f}`).join('\n')}`)
  }

  if (errorsEncountered.length > 0) {
    sections.push(`遇到的问题：\n${errorsEncountered.map((e) => `- ${e}`).join('\n')}`)
  }

  return sections.join('\n\n')
}

/** One row for main-process agentic / provider APIs (string or Anthropic-style blocks). */
export type AgentApiMessage = {
  role: 'user' | 'assistant'
  content: string | Array<Record<string, unknown>>
}

/**
 * Expand a single chat row into API rows. Assistant messages with `blocks` become
 * assistant (text + tool_use) followed by user (tool_result[]) so follow-up turns
 * keep tool outputs (e.g. AskUserQuestion answers) in context.
 */
function normalizeImageMediaTypeForApi(mt: string): string {
  const m = (mt || 'image/png').toLowerCase()
  if (m === 'image/jpg') return 'image/jpeg'
  return m
}

/**
 * Escape attribute values for our `<historical-...>` XML-ish wrapper tags.
 * We only embed user-controlled strings (file path, attachment name) in
 * attributes, so the small set `& < > "` is enough — we never construct
 * full XHTML / HTML.
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Turns at which a historical user message's binary attachments (clipboard
 * images, PDF document blocks, scanned-PDF page images, Office inline
 * images) are stripped from the wire and replaced with a `<recall-pointer>`
 * text marker. The model can pull the bytes back via the
 * `recall_attachment` tool when it actually needs them.
 *
 * Why a hard threshold rather than a token-budget heuristic:
 *   - Predictable prompt-cache stability: once a turn crosses the threshold
 *     the strip is permanent; we don't oscillate.
 *   - Simple to reason about: "after 5 user turns, your old screenshots are
 *     no longer in context unless you recall them" is a clear contract.
 *
 * Tunable via `POLE_STRIP_BINARIES_AFTER_TURNS` env var (positive integer).
 * `0` or any non-positive value disables stripping entirely (P0
 * historical-marker behavior still applies). Test suites override via
 * `process.env` per case.
 *
 * `contextBuilder` is imported from BOTH the Electron main process (where
 * `process.env` exists) AND the renderer (Vite bundle, `nodeIntegration:
 * false`, `contextIsolation: true` — see `electron/window/mainWindow.ts`).
 * In the renderer, `process` is not a defined global, so a bare
 * `process.env.X` read throws `ReferenceError: process is not defined` and
 * propagates up the send-message chain
 * (`apiMessageBuilder` → `buildMessagesWithContext` → here), surfacing in
 * the UI as the alert "发送消息失败：process is not defined". The
 * `typeof process` guard keeps node/tests working while letting the
 * renderer fall through to the default threshold.
 */
function getStripBinariesAfterTurns(): number {
  // Renderer-safe `process.env` access. `tsconfig.app.json` doesn't load
  // `@types/node`, so a bare `process.env.X` read fails the typecheck;
  // routing through `globalThis` keeps the same runtime fall-through
  // (renderer → undefined → default threshold) without a type-only
  // declaration leak.
  const proc = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process
  const raw = proc?.env?.POLE_STRIP_BINARIES_AFTER_TURNS
  if (raw === undefined) return 5
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n)
}

/**
 * Build a `<recall-pointer>` text marker that replaces a stripped binary
 * attachment block. Carries enough metadata for the model to call
 * `recall_attachment` (sha256 + kind) and surface a human-readable name
 * back to the user if needed.
 */
function buildRecallPointer(opts: {
  kind: string
  sha256?: string
  name: string
  turnDistance: number
  pageInfo?: string
}): string {
  const { kind, sha256, name, turnDistance, pageInfo } = opts
  const turnLabel =
    turnDistance === 1 ? '1 turn ago' : `${turnDistance} turns ago`
  const shaAttr = sha256 ? ` sha256="${escapeAttr(sha256)}"` : ''
  const pageAttr = pageInfo ? ` pages="${escapeAttr(pageInfo)}"` : ''
  const recallHint = sha256
    ? `Use the \`recall_attachment\` tool with sha256="${sha256}" and kind="${kind}" to retrieve the bytes if you need to inspect them.`
    : `These bytes were not cached and cannot be auto-recalled. Ask the user to re-attach if you need to inspect them.`
  return `<recall-pointer kind="${escapeAttr(kind)}" name="${escapeAttr(name)}"${shaAttr}${pageAttr} attached-turn-distance="${turnDistance}">
A ${kind} attached ${turnLabel} ("${name}") was removed from context to save tokens. ${recallHint}
</recall-pointer>`
}

/**
 * Build the per-message preamble that warns the model the attached content
 * is from an earlier turn and may be stale. Mirrors the
 * `<system-reminder>`-style markup convention used elsewhere — Anthropic
 * models are trained to treat these as host-injected metadata, not fresh
 * user instructions.
 */
function buildHistoricalAttachmentsNotice(opts: {
  turnDistance: number
  imageCount: number
  fileCount: number
  /** True when at least one binary was replaced with a `<recall-pointer>`. */
  hasStrippedBinaries: boolean
}): string {
  const { turnDistance, imageCount, fileCount, hasStrippedBinaries } = opts
  const turnLabel = turnDistance === 1 ? '1 turn ago' : `${turnDistance} turns ago`
  const counts: string[] = []
  if (imageCount > 0) counts.push(`${imageCount} image${imageCount === 1 ? '' : 's'}`)
  if (fileCount > 0) counts.push(`${fileCount} file${fileCount === 1 ? '' : 's'}`)
  const summary = counts.length > 0 ? counts.join(' + ') : 'attachments'
  const strippedNote = hasStrippedBinaries
    ? '\n- One or more binary attachments below have been replaced with `<recall-pointer>` markers to save tokens. Call the `recall_attachment` tool only if you actually need to inspect those bytes — do NOT recall reflexively when the user has not asked about them.'
    : ''
  return `<historical-attachments turn-distance="${turnDistance}">
The ${summary} attached below were sent ${turnLabel}, NOT in the current turn.
- They are HISTORICAL observations; do not assume they reflect the current state of the UI, files, or screen.
- For pasted file snapshots: the on-disk content may have changed since the paste. Prefer \`read_file\` on the path for current bytes before relying on this snapshot for edits.
- Reference these only if the user explicitly mentions them in this turn.${strippedNote}
</historical-attachments>`
}

/**
 * Wrap a file-attachment text preamble so the model can localize the
 * staleness signal to the exact content (vs. only seeing the per-message
 * notice above, which the model can lose track of after long tool loops).
 */
function wrapHistoricalFilePreamble(
  preamble: string,
  attPath: string,
  turnDistance: number,
): string {
  return `<historical-snapshot path="${escapeAttr(attPath)}" turn-distance="${turnDistance}">
${preamble}
</historical-snapshot>`
}

/**
 * Build a readable text preamble from a `type:'file'` attachment so the model
 * actually receives parsed document content (previously file attachments were
 * silently dropped — only images were serialized). Pages of scanned PDFs (no
 * extractable text) are surfaced later as `image` blocks by the caller.
 */
function renderFileAttachmentText(
  att: Extract<Attachment, { type: 'file' }>,
): string | null {
  if (att.status === 'processing' || att.status === 'error') return null
  const kindLabel = att.kind ? ` · ${att.kind}` : ''
  const pageLabel = att.pdf?.pageCount ? ` · ${att.pdf.pageCount} 页` : ''
  const sheetLabel = att.sheets?.length ? ` · ${att.sheets.length} 个工作表` : ''
  const header = `[附件] ${att.name}${kindLabel}${pageLabel}${sheetLabel}`

  const body = att.text?.content?.trim()
  if (body) {
    let truncNote = ''
    if (att.text?.truncated) {
      const orig = att.text?.originalChars ?? 0
      const kept = body.length
      truncNote = `\n\n[⚠️ 内容已截断 — 原始 ${orig.toLocaleString()} 字符,当前保留 ${kept.toLocaleString()} 字符.`
      if (att.sheets?.length) {
        const truncatedSheets = att.sheets
          .filter((s) => s.truncatedRows || s.truncatedCols)
          .map((s) => s.name)
        if (truncatedSheets.length > 0) {
          truncNote += ` 以下工作表被截断:${truncatedSheets.join(', ')}.`
        }
      }
      truncNote += ' 如需查看被省略的章节或工作表,请告诉我需要关注的内容.]'
    }
    // Surface ingestion notes (e.g. xlsx row/col truncation warnings) so the
    // model knows exact limits rather than guessing.
    const notes = att.notes?.length ? `\n\n[附件处理备注]\n${att.notes.map((n) => `- ${n}`).join('\n')}` : ''
    return `${header}\n\n${body}${truncNote}${notes}`
  }
  if (att.pageImages?.length) {
    return `${header}\n（无可提取文本，已附渲染后的页面图像供查看。）`
  }
  if (att.sheets?.length) {
    const summary = att.sheets
      .map((s) => `  - ${s.name}: ${s.rowCount} 行 × ${s.colCount} 列`)
      .join('\n')
    return `${header}\n工作表概览：\n${summary}`
  }
  return `${header}\n（文件已附加，但未能解析出文本内容。）`
}

/**
 * Plan Phase 2.B — 判断一条 assistant 消息是否"实质为空"（content、blocks、
 * toolUses 都没有可送给模型的内容）。用于 fallback tombstone 决策：被 streaming
 * fallback 抛弃的消息壳上有 `_streamFallbackTombstone` 标记 + 三个字段全空；
 * 但 fallback 成功后非流式响应会重新追加 blocks，这时消息已经不再"实质为空"，
 * 应该正常回灌而不是丢弃。
 *
 * 注意 content === '' 也算空（fallback reset 把它清成了 ''）。
 */
function isMessageEffectivelyEmpty(message: ChatMessage): boolean {
  if (typeof message.content === 'string' && message.content.trim().length > 0) return false
  if (Array.isArray(message.blocks) && message.blocks.length > 0) return false
  if (Array.isArray(message.toolUses) && message.toolUses.length > 0) return false
  return true
}

/**
 * @param options.turnDistance How many user turns back this message is from
 *   the current send. `0` (default) = current turn, no historical-staleness
 *   wrapping. `>= 1` = N turns ago; we wrap attachments with
 *   `<historical-attachments>` notice + `<historical-snapshot>` per file
 *   so the model treats the bytes as past observations rather than live
 *   state. See `buildHistoricalAttachmentsNotice` for the rationale and
 *   the system-prompt section that teaches the model how to read the
 *   markup.
 */
export function chatMessageToAgentApiRows(
  message: ChatMessage,
  options?: { turnDistance?: number },
): AgentApiMessage[] {
  // Plan Phase 2.B — fallback tombstone：streaming 被 Anthropic 529 中断、
  // mainStreamRouter 已经把空壳消息打了标记。这种"消息壳还在但内容已经清空"
  // 的 assistant 消息绝对不能被回灌给模型：
  //   - 半截 thinking 已经在 reset 时清掉了
  //   - 空 content 数组会被 normalizeMessagesForAPI#ensureNonEmptyAssistantContent
  //     替换成 [{type:'text',text:'...'}]
  //   - 模型在 history 里看到一条 "..." assistant 回复 → 学着模仿这种空白响应
  // 直接整条丢弃 — 等同于 upstream `query.ts:713-728` 的 tombstone 协议。
  //
  // 修订：fallback 成功后，非流式响应会通过 emitAnthropicNonStreamMessageAsStreamCallbacks
  // 重新往同一条消息追加内容（thinking_block_complete / text_delta 等）。tombstone
  // 标记保留，但已经有真实内容了 — 这时不应丢弃。判定逻辑：只有当 message 仍然
  // 空（content + blocks + toolUses 全无内容）时才整条丢弃；fallback 已经成功
  // 写入新内容时正常回灌。
  if (message._streamFallbackTombstone === true && isMessageEffectivelyEmpty(message)) {
    return []
  }
  const turnDistance = Math.max(0, Math.floor(options?.turnDistance ?? 0))
  const isHistorical = turnDistance > 0

  if (message.role === 'user') {
    const atts = message.attachments || []
    const imageAtts = atts.filter(
      (a): a is Extract<Attachment, { type: 'image' }> => a.type === 'image',
    )
    const fileAtts = atts.filter(
      (a): a is Extract<Attachment, { type: 'file' }> => a.type === 'file',
    )

    // Per-message inline annotation for `@`-referenced files. Without this,
    // path-only references live ONLY in the prepended `<system-reminder>`,
    // which models reliably treat as ambient context and ignore when the
    // user's text uses vague pronouns ("这个呢") and the conversation history
    // contains other file context. Embedding the file list inside the user
    // turn itself anchors pronoun resolution and forces the agent to act on
    // the path (call `read_file`) instead of asking "which file did you mean?".
    const refFiles = message.referencedFiles ?? []
    const refSuffix =
      refFiles.length > 0
        ? (() => {
            const turnLabel = isHistorical
              ? `attached ${turnDistance === 1 ? '1 turn ago' : `${turnDistance} turns ago`}`
              : 'attached in this turn — call `read_file` if you need their contents'
            const list = refFiles.map((p) => `- ${p}`).join('\n')
            return `\n\n[user-referenced files (${turnLabel}):\n${list}\n]`
          })()
        : ''

    // File attachments → text preamble + provider-native sidecar blocks.
    //
    // For each `type:'file'` attachment we may emit up to FOUR block types:
    //
    //   1. **Text preamble** (`renderFileAttachmentText`) — merged into the
    //      leading `text` block with the user's typed message. Includes the
    //      extracted content when available (`text.content`).
    //   2. **PDF `document` block** — when `pdf.base64` is present, the
    //      bytes are sent as a native Anthropic `type:'document'` block so
    //      Claude can render the PDF natively (tables, figures, vector text).
    //      Downstream transformers downgrade this for non-Anthropic wires
    //      (`claudeToOpenAI.ts` → text notice; `claudeToGemini.ts` → inlineData).
    //   3. **Page `image` blocks** — for scanned PDFs where `text.content` is
    //      empty. These carry the pdftoppm / pdfjs-canvas rasters so vision
    //      models can actually SEE the pages. (Ingest leaves `text` unset
    //      when it populates `pageImages`; see `electron/attachments/index.ts`.)
    //   4. **Office `inlineImages`** — docx/pptx/xlsx inline pictures. The
    //      text body may contain `astra:docx-image:<hash>` placeholders
    //      that only make sense once these companion image blocks ride along.
    //
    // Without this fan-out, `type:'file'` attachments silently lose binary
    // content (scanned PDFs appeared blank to the model, embedded images in
    // docs were invisible, small PDFs were text-only even for Claude which
    // natively supports the document block).
    // P2 — strip heavy binaries (image / PDF document / page-image /
    // inline-image blocks) once a user message is far enough back in the
    // transcript that keeping its bytes around no longer earns its token
    // cost. The text preamble + `<historical-snapshot>` wrapper still
    // ship; only the byte-bearing blocks are replaced with a
    // `<recall-pointer>` text marker carrying enough metadata
    // (`sha256` + `kind`) for the model to invoke `recall_attachment` on
    // demand. Threshold is governed by `getStripBinariesAfterTurns()`.
    const stripThreshold = getStripBinariesAfterTurns()
    const shouldStripBinaries =
      isHistorical && stripThreshold > 0 && turnDistance >= stripThreshold

    const fileTextBlocks: string[] = []
    const filePageImages: Array<{ base64: string; mediaType: string }> = []
    const fileInlineImages: Array<{ base64: string; mediaType: string }> = []
    const fileDocuments: Array<{ name: string; base64: string }> = []
    /** Per-attachment recall pointer text blocks (one per stripped attachment). */
    const recallPointerBlocks: string[] = []
    let strippedBinaryCount = 0
    for (const f of fileAtts) {
      const preamble = renderFileAttachmentText(f)
      if (preamble) {
        // Wrap each file's preamble in `<historical-snapshot>` for messages
        // older than the current turn so the model can localize the
        // staleness signal to the actual snapshot text. The aggregate
        // `<historical-attachments>` notice (prepended further down) tells
        // the model the convention; this per-file wrapper lets it see the
        // signal exactly where it might otherwise confuse a paste-time
        // snapshot for current disk state.
        fileTextBlocks.push(
          isHistorical ? wrapHistoricalFilePreamble(preamble, f.path, turnDistance) : preamble,
        )
      }

      const hasPdfBytes = !!(f.pdf?.base64 && f.status === 'ready')
      const hasPageImages = !!(f.pageImages && f.pageImages.length > 0)
      const hasInlineImages = !!(f.inlineImages && f.inlineImages.length > 0)
      const hasBinary = hasPdfBytes || hasPageImages || hasInlineImages

      if (shouldStripBinaries && hasBinary) {
        // Single pointer per file, regardless of how many binary blocks
        // it would have emitted. Page count surfaces as `pages="N"` so
        // the model knows the recall payload size before fetching.
        const pageInfo = hasPageImages
          ? `${f.pageImages!.length} page${f.pageImages!.length === 1 ? '' : 's'}`
          : undefined
        recallPointerBlocks.push(
          buildRecallPointer({
            kind: f.kind || 'unknown',
            sha256: f.sha256,
            name: f.name,
            turnDistance,
            pageInfo,
          }),
        )
        strippedBinaryCount++
        continue
      }

      // Small PDFs → native document block for Claude; transformers downgrade.
      if (hasPdfBytes) {
        fileDocuments.push({ name: f.name, base64: f.pdf!.base64! })
      }

      // Scanned PDF pages. Ingest populates `pageImages` only when the text
      // layer was unusable and removes the `text` field, so we don't need a
      // `!text.content` guard anymore — presence of `pageImages` is itself
      // the signal that the bytes ARE the primary content.
      if (hasPageImages) {
        for (const pi of f.pageImages!) {
          filePageImages.push({ base64: pi.base64, mediaType: pi.mediaType })
        }
      }

      // Office doc embedded images (docx / pptx ingest emits these).
      if (hasInlineImages) {
        for (const img of f.inlineImages!) {
          fileInlineImages.push({ base64: img.base64, mediaType: img.mediaType })
        }
      }
    }

    // Direct user-pasted images: same strip rule applies, one pointer per
    // image when the threshold is crossed. Ordering preserved so the
    // model still sees pointers in clipboard-paste order.
    const keptImageAtts: typeof imageAtts = []
    for (const att of imageAtts) {
      if (shouldStripBinaries) {
        recallPointerBlocks.push(
          buildRecallPointer({
            kind: 'image',
            sha256: att.sha256,
            name: att.name,
            turnDistance,
          }),
        )
        strippedBinaryCount++
        continue
      }
      keptImageAtts.push(att)
    }

    if (
      keptImageAtts.length === 0 &&
      fileTextBlocks.length === 0 &&
      filePageImages.length === 0 &&
      fileInlineImages.length === 0 &&
      fileDocuments.length === 0 &&
      recallPointerBlocks.length === 0
    ) {
      return [{ role: 'user', content: (message.content ?? '') + refSuffix }]
    }

    const parts: Array<Record<string, unknown>> = []
    const userText = (message.content ?? '').trim()
    const preamble = fileTextBlocks.join('\n\n---\n\n')
    // Aggregate per-message notice that EVERY block below comes from an
    // earlier turn. Counts include direct image attachments + scanned PDF
    // page images + Office inline images so the model knows the full
    // historical surface area of this user message — even if some of
    // those bytes have been stripped to recall pointers below, the
    // aggregate count reflects the original attach.
    const historicalNotice =
      isHistorical
        ? buildHistoricalAttachmentsNotice({
            turnDistance,
            imageCount: imageAtts.length + filePageImages.length + fileInlineImages.length,
            fileCount: fileAtts.length,
            hasStrippedBinaries: strippedBinaryCount > 0,
          })
        : ''
    // Recall pointers ride alongside the notice/preamble in the leading
    // text block: keeps token overhead minimal (one extra block instead
    // of one per pointer) while still giving the model the metadata it
    // needs to invoke `recall_attachment`.
    const recallText = recallPointerBlocks.join('\n\n')
    const combinedText = [historicalNotice, preamble, recallText, userText + refSuffix]
      .filter((s) => s.length > 0)
      .join('\n\n---\n\n')
    if (combinedText) {
      parts.push({ type: 'text', text: combinedText })
    }
    // PDF document blocks first: Anthropic's parser expects documents to
    // appear before same-file images/text when both are present.
    for (const doc of fileDocuments) {
      parts.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: doc.base64,
        },
        // Surface the file name so mixed-batch payloads are easier to debug.
        title: doc.name,
      })
    }
    // Iterate the post-strip kept set: when `shouldStripBinaries` was true,
    // the corresponding pointer was already added to the leading text block
    // and the original image bytes are intentionally NOT re-emitted here.
    for (const att of keptImageAtts) {
      const mediaType = normalizeImageMediaTypeForApi(att.mediaType)
      parts.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: att.base64,
        },
      })
    }
    for (const pi of filePageImages) {
      parts.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: normalizeImageMediaTypeForApi(pi.mediaType),
          data: pi.base64,
        },
      })
    }
    for (const inl of fileInlineImages) {
      parts.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: normalizeImageMediaTypeForApi(inl.mediaType),
          data: inl.base64,
        },
      })
    }
    if (parts.length === 1 && parts[0]!.type === 'text') {
      return [{ role: 'user', content: (parts[0] as { text: string }).text }]
    }
    return [{ role: 'user', content: parts }]
  }

  const blocks = message.blocks
  if (!blocks || blocks.length === 0) {
    return [{ role: 'assistant', content: message.content ?? '' }]
  }

  // ── 2026-06 multi-turn degradation fix (root cause 1+2) ──
  //
  // The renderer accumulates ONE assistant ChatMessage per user turn, with
  // every iteration's thinking / text / tool_use blocks appended in stream
  // order. The previous rebuild collapsed all of that into a single
  // assistant row + a single user(tool_results) row, which destroyed the
  // think→act→observe causal order: the model saw "I called N tools AND
  // declared completion in one message; all evidence arrived afterwards".
  // Over ~13-18 rounds this taught the model to (a) narrate results before
  // calling tools and (b) claim completion without evidence.
  //
  // New shape: the block sequence is segmented back into per-iteration
  // rows. A segment ends when a tool_use run is followed by a non-tool
  // block (= the next iteration started after results came back):
  //
  //   [th1, tx1, tu1, th2, tu2, tu3, txF]
  //     → assistant [th1, tu1]        (tx1 stripped — see below)
  //     → user      [result(tu1)]
  //     → assistant [th2, tu2, tu3]
  //     → user      [result(tu2), result(tu3)]
  //     → assistant [txF]             (final narration keeps its text)
  //
  // Pre-tool text stripping mirrors the in-turn persistence rule in
  // `electron/ai/agenticLoopBuilders.ts#buildToolUseAssistantContent`
  // (POLE_STRIP_PRE_TOOL_TEXT, default ON): segments that contain
  // tool_use drop their text blocks so the cross-turn rebuild can no
  // longer resurrect the "[text, tool_use]" self-reinforcing pattern the
  // in-turn fix removed. The renderer keeps displaying the text — only
  // the API history is shaped.
  interface IterationSegment {
    parts: Array<Record<string, unknown>>
    results: Array<Record<string, unknown>>
    hasToolUse: boolean
  }
  const segments: IterationSegment[] = []
  let seg: IterationSegment = { parts: [], results: [], hasToolUse: false }
  let inToolRun = false
  const flushSegment = () => {
    if (seg.parts.length > 0 || seg.results.length > 0) segments.push(seg)
    seg = { parts: [], results: [], hasToolUse: false }
    inToolRun = false
  }
  const boundaryBeforeNonToolBlock = () => {
    // A non-tool block arriving AFTER a tool_use run means the model saw
    // the results and started a new iteration — close the segment.
    if (inToolRun) flushSegment()
  }

  for (const b of blocks) {
    if (b.type === 'text') {
      boundaryBeforeNonToolBlock()
      const t = b.text?.trim()
      if (t) seg.parts.push({ type: 'text', text: b.text })
      continue
    }
    if (b.type === 'thinking') {
      // Emit the Anthropic-Messages-style thinking block so providers that
      // require transcript replay (Anthropic native, DeepSeek Anthropic-compat)
      // keep seeing a consistent chain-of-thought across turns.
      //
      // Historical behavior was to drop these unconditionally, which caused
      // DeepSeek's Anthropic-compat endpoint to return `HTTP 400
      // "content[].thinking in the thinking mode must be passed back to the
      // API"` starting at turn 3+ whenever a prior-turn assistant had both
      // a `thinking` block and a `tool_use` block: within a single turn the
      // main process (`agenticLoop.ts`) already echoes thinking into
      // `assistantContent`, but the next user turn rebuilds `apiMessages`
      // from the renderer's `ChatMessage[]` via this function — so historical
      // thinking blocks needed a path out.
      //
      // DeepSeek's spec tolerates thinking blocks from turns that had no
      // tool_use (it just ignores them), and Anthropic's transcript pipeline
      // (`electron/context/anthropicThinkingTranscript.ts`) strips historical
      // thinking when the current request has thinking disabled — so
      // emitting unconditionally is the conservative choice that keeps both
      // providers happy without needing per-provider conditionals here.
      //
      // The block is currently emitted without `signature`. Capturing the
      // signature end-to-end (main-process stream event → `ChatBlock` field
      // → wire) is a separate, larger change and not required for the DeepSeek
      // fix that motivated this commit. When a signature IS present on the
      // block (`b.signature`), it passes through untouched so the future
      // plumbing PR doesn't need to re-touch this function.
      const text = b.text ?? ''
      if (!text.trim()) continue
      boundaryBeforeNonToolBlock()
      const thinkingBlock: Record<string, unknown> = {
        type: 'thinking',
        thinking: text,
      }
      if (typeof b.signature === 'string' && b.signature.length > 0) {
        thinkingBlock.signature = b.signature
      }
      seg.parts.push(thinkingBlock)
      continue
    }
    if (b.type === 'redacted_thinking') {
      // Plan Phase 4 — Anthropic 加密 chain-of-thought 必须原样回灌：
      // 服务端会根据这条 data 检查 trajectory 连续性，缺一块就拒签
      // (Anthropic native 报 "thinking blocks must appear exactly as
      // provided" 类错误)。注意不能像 thinking 那样按 .trim() 长度判空
      // —— `data` 是 base64-ish 加密串，永远 truthy；只检查 typeof + 长度。
      if (typeof b.data !== 'string' || b.data.length === 0) continue
      boundaryBeforeNonToolBlock()
      seg.parts.push({ type: 'redacted_thinking', data: b.data })
      continue
    }
    if (b.type === 'ask_user_question') {
      continue
    }
    if (b.type === 'image') {
      continue
    }
    if (b.type === 'tool_use') {
      // Dropping running tool_use blocks entirely (old behavior) left the
      // assistant row without its `tool_use` block AND left no `tool_result`
      // for it — on reconnect/retry the model either repeated the call or
      // silently assumed it had executed. Emit a placeholder error result
      // instead so the Anthropic API pairing (`tool_use`↔`tool_result`) is
      // always complete for replay.
      inToolRun = true
      seg.hasToolUse = true
      seg.parts.push({
        type: 'tool_use',
        id: b.id,
        name: b.name,
        input: b.input,
      })
      let payload: string
      let isError = false
      if (b.status === 'running') {
        payload = '[Tool call was interrupted before completing — treat as failed/unknown.]'
        isError = true
      } else if (b.status === 'stopped') {
        // 2026-07 interruption-protocol fix — `stopped` is the terminal
        // status `sendSlice.cancelMessage` stamps on a running tool when
        // the user presses Stop. Pre-fix this fell through to the
        // catch-all below, which tells the model to treat the call as a
        // "benign no-op" — exactly wrong for a user abort: the model
        // must neither assume it ran nor silently retry it. Mirror the
        // main-process synthetic tool_result wording (`queryTermination.
        // yieldMissingToolResultBlocks`) so both transports agree.
        payload =
          '[Tool execution was interrupted by user — the result is unavailable. ' +
          'Do not assume it completed; wait for the user before redoing this action.]'
        isError = true
      } else if (typeof b.result === 'string' && b.result.length > 0) {
        payload = b.result
      } else if (b.error) {
        payload = `Error: ${b.error}`
        isError = true
      } else if (b.status === 'completed') {
        payload = 'Tool completed with no output.'
      } else {
        // Catch-all for tool_use blocks persisted with a non-running,
        // non-completed status but no explicit `error` / `result` text.
        // Originally produced "[Tool ended with status: error]"; the load-path
        // heal (`healPoisonedToolUseBlocks`) now backfills these on hydration,
        // so reaching this branch in practice means a block slipped past the
        // heal (e.g. created mid-session through a yet-uncovered path). We
        // intentionally mark it `is_error: false` so the model doesn't
        // perceive a tool failure and start retrying — the previous tool
        // result is simply gone; the safe move is to continue.
        payload =
          'Tool call result is missing from the persisted transcript (no detail captured). ' +
          'Treat this prior tool call as a benign no-op and continue with the user’s next instruction.'
        isError = false
      }
      seg.results.push({
        type: 'tool_result',
        tool_use_id: b.id,
        content: payload,
        ...(isError ? { is_error: true } : {}),
      })
    }
  }
  flushSegment()

  const stripPreToolText = isCrossTurnPreToolTextStripEnabled()
  const rows: AgentApiMessage[] = []
  for (const s of segments) {
    // Mirror of the in-turn POLE_STRIP_PRE_TOOL_TEXT rule: tool-bearing
    // segments do not persist their narration text. Thinking /
    // redacted_thinking / tool_use blocks always survive. Text-only
    // segments (the final completion narration, plain replies) keep
    // their text — that IS the model's reply.
    const parts =
      s.hasToolUse && stripPreToolText
        ? s.parts.filter((p) => p.type !== 'text')
        : s.parts
    if (parts.length > 0) {
      rows.push({ role: 'assistant', content: parts })
    }
    if (s.results.length > 0) {
      rows.push({ role: 'user', content: s.results })
    }
  }

  if (rows.length === 0 && message.content?.trim()) {
    return withInterruptionMarker(
      [{ role: 'assistant', content: message.content }],
      message,
    )
  }
  return withInterruptionMarker(
    rows.length > 0 ? rows : [{ role: 'assistant', content: message.content ?? '' }],
    message,
  )
}

/**
 * 2026-07 interruption-protocol fix — when the user pressed Stop on this
 * assistant turn (`interruptedByUser`, stamped by `sendSlice.cancelMessage`),
 * append an explicit `[User interrupted…]` user row after the turn's API
 * rows. cc-haha parity (`INTERRUPT_MESSAGE` / `INTERRUPT_MESSAGE_FOR_TOOL_USE`
 * in its `utils/messages.ts`): without this marker the next turn's model
 * sees a truncated assistant reply that reads as deliberate and complete —
 * it then continues from a half-finished thought or re-narrates the cut-off
 * plan as done. The wording matches the main-process helper
 * (`electron/ai/queryTermination.ts#createUserInterruptionMessage`) so both
 * transports speak the same protocol. `mergeAdjacentUserMessages` may fold
 * this row into the following user turn / tool_result row — that is fine,
 * the marker text survives as a leading block.
 */
function withInterruptionMarker(
  rows: AgentApiMessage[],
  message: ChatMessage,
): AgentApiMessage[] {
  if (message.interruptedByUser !== true) return rows
  const hadStoppedTool =
    Array.isArray(message.blocks) &&
    message.blocks.some((b) => b.type === 'tool_use' && b.status === 'stopped')
  const marker = hadStoppedTool
    ? '[User interrupted during tool execution.]'
    : '[User interrupted during model response.]'
  return [...rows, { role: 'user', content: marker }]
}

/**
 * Cross-turn mirror of `buildToolUseAssistantContent`'s
 * POLE_STRIP_PRE_TOOL_TEXT gate (default ON; set `=0` to keep the
 * legacy "text rides with tool_use" history shape). Renderer-safe
 * `process.env` access — same pattern as {@link getStripBinariesAfterTurns}.
 */
function isCrossTurnPreToolTextStripEnabled(): boolean {
  const proc = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process
  return proc?.env?.POLE_STRIP_PRE_TOOL_TEXT !== '0'
}

function contentToBlocks(content: string | Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : []
  }
  return content
}

function normalizeUserContent(blocks: Array<Record<string, unknown>>): string | Array<Record<string, unknown>> {
  if (blocks.length === 0) return ''
  if (blocks.length === 1 && blocks[0].type === 'text' && typeof blocks[0].text === 'string') {
    return blocks[0].text as string
  }
  return blocks
}

/** Merge consecutive user turns (e.g. tool_result row + next chat user text) into one user message. */
export function mergeAdjacentUserMessages(rows: AgentApiMessage[]): AgentApiMessage[] {
  const out: AgentApiMessage[] = []
  for (const row of rows) {
    if (row.role === 'user' && out.length > 0 && out[out.length - 1].role === 'user') {
      const prev = out[out.length - 1]
      const merged = [...contentToBlocks(prev.content), ...contentToBlocks(row.content)]
      out[out.length - 1] = { role: 'user', content: normalizeUserContent(merged) }
    } else {
      out.push(row)
    }
  }
  return out
}

/**
 * Build API messages: optional leading <system-reminder> user message (workspace + history),
 * then recent conversation turns. User's latest message stays clean (not prefixed).
 */
export function buildMessagesWithContext(
  messages: ChatMessage[],
  contextSections: ContextSectionMap,
  maxHistoryMessages: number = COMPACT_WINDOW,
  existingCompactSummary?: string,
): AgentApiMessage[] {
  // Defense-in-depth: even though `apiMessageBuilder.buildMainChatApiMessagesForSend`
  // already strips boundary markers, callers outside that entry point
  // (e.g. test fixtures, future callers) must not leak `compact_boundary`
  // ChatMessage rows into API conversion. Filter once here so the slice /
  // summarize / flatMap pipeline below cannot see them.
  messages = messages.filter((m) => m.kind !== 'compact_boundary')
  const mergedSections: ContextSectionMap = { ...contextSections }

  if (messages.length > maxHistoryMessages) {
    const earlyMessages = messages.slice(0, messages.length - maxHistoryMessages)
    const localSummary = summarizeEarlyMessages(earlyMessages)
    const parts: string[] = []
    if (existingCompactSummary?.trim()) {
      parts.push(existingCompactSummary.trim())
    }
    if (localSummary.trim()) {
      parts.push(localSummary.trim())
    }
    if (parts.length > 0) {
      mergedSections.conversation_history_summary = parts.join('\n\n')
    }
  }

  const recentMessages = messages.slice(-maxHistoryMessages)
  const reminderText = formatContextReminderMessage(mergedSections)

  // Compute per-message historical-attachment turn distance, counting USER
  // messages from the end. The latest user message is the "current turn"
  // (distance 0); the one before it is 1 turn ago; etc. Assistant messages
  // share the distance of the user message they belong to (no observable
  // difference because we only wrap user-message attachments).
  //
  // Why this matters: pasted images/files persist verbatim across every
  // turn (Anthropic vision spec) — the model has no native signal for
  // "this screenshot is from 3 turns ago, not the live UI". Without the
  // wrapper notice, the model can confidently re-narrate stale image
  // content and confabulate "the fix didn't work" stories from old
  // attachments. See the system-prompt section that teaches the model
  // how to read `<historical-attachments>` / `<historical-snapshot>`.
  const turnDistanceByIndex = new Map<number, number>()
  let currentDistance = 0
  for (let i = recentMessages.length - 1; i >= 0; i--) {
    if (recentMessages[i].role === 'user') {
      turnDistanceByIndex.set(i, currentDistance)
      currentDistance++
    }
  }

  const core = mergeAdjacentUserMessages(
    recentMessages.flatMap((m, idx) =>
      chatMessageToAgentApiRows(m, { turnDistance: turnDistanceByIndex.get(idx) ?? 0 }),
    ),
  )

  if (reminderText) {
    return [{ role: 'user' as const, content: reminderText }, ...core]
  }

  return core
}
