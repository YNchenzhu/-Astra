import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  chatMessageToAgentApiRows,
  mergeAdjacentUserMessages,
} from './contextBuilder'
import type { ChatMessage } from '../types'

// `tsconfig.app.json` excludes `@types/node`, but this test runs under
// vitest (node) and pokes `process.env` to drive the binary-strip
// threshold. A narrow ambient declaration is enough to satisfy tsc
// without pulling node globals into the renderer build.
declare const process: { env: Record<string, string | undefined> }

describe('chatMessageToAgentApiRows', () => {
  it('serializes AskUserQuestion tool result for follow-up context', () => {
    const answersJson = JSON.stringify({
      questions: [{ header: 'Q1', question: '?' }],
      answers: { Q1: '选项A' },
    })
    const rows = chatMessageToAgentApiRows({
      id: 'a1',
      role: 'assistant',
      content: '请选择',
      timestamp: 1,
      blocks: [
        { type: 'text', text: '请选择' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'AskUserQuestion',
          input: { questions: [] },
          status: 'completed',
          result: answersJson,
        },
      ],
    })
    expect(rows).toHaveLength(2)
    expect(rows[0].role).toBe('assistant')
    expect(rows[1].role).toBe('user')
    const tr = rows[1].content
    expect(Array.isArray(tr)).toBe(true)
    const first = (tr as Array<Record<string, unknown>>)[0]
    expect(first.type).toBe('tool_result')
    expect(first.tool_use_id).toBe('toolu_1')
    expect(first.content).toBe(answersJson)
  })

  it('merges tool_result user row with following user text', () => {
    const merged = mergeAdjacentUserMessages([
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'x', content: '{}' }],
      },
      { role: 'user', content: 'next instruction' },
    ])
    expect(merged).toHaveLength(2)
    expect(merged[1].role).toBe('user')
    const c = merged[1].content
    expect(Array.isArray(c)).toBe(true)
    expect((c as unknown[]).length).toBe(2)
  })

  // ─── Attachment serialization coverage (bug-fix regression guard) ───

  function buildUserMessageWithAttachments(
    attachments: NonNullable<ChatMessage['attachments']>,
    userText = '请分析附件',
  ): ChatMessage {
    return {
      id: 'u1',
      role: 'user',
      content: userText,
      timestamp: 1,
      attachments,
    }
  }

  function contentParts(
    rows: ReturnType<typeof chatMessageToAgentApiRows>,
  ): Array<Record<string, unknown>> {
    expect(rows).toHaveLength(1)
    const c = rows[0].content
    expect(Array.isArray(c)).toBe(true)
    return c as Array<Record<string, unknown>>
  }

  it('emits a `document` block for a PDF attachment with inline base64', () => {
    const rows = chatMessageToAgentApiRows(
      buildUserMessageWithAttachments([
        {
          type: 'file',
          name: 'contract.pdf',
          path: '/tmp/contract.pdf',
          size: 100,
          kind: 'pdf',
          mimeType: 'application/pdf',
          sha256: 'abc',
          status: 'ready',
          pdf: {
            base64: 'PDFBYTESBASE64',
            pageCount: 3,
            sizeBytes: 100,
            oversized: false,
          },
          text: { content: '合同全文 ...', truncated: false, originalChars: 10 },
        },
      ]),
    )
    const parts = contentParts(rows)
    // Expect: [text preamble+user, document block]
    expect(parts.length).toBeGreaterThanOrEqual(2)
    const doc = parts.find((p) => p.type === 'document')
    expect(doc).toBeTruthy()
    expect((doc as { source: { media_type: string; data: string } }).source.media_type).toBe(
      'application/pdf',
    )
    expect((doc as { source: { data: string } }).source.data).toBe('PDFBYTESBASE64')
    // And the text preamble still carries extracted text so downgrade providers
    // (OpenAI chat) have a textual fallback.
    const text = parts.find((p) => p.type === 'text')
    expect(text).toBeTruthy()
    expect(String((text as { text: string }).text)).toContain('合同全文')
  })

  it('does NOT emit a `document` block for an oversized PDF with no inline base64', () => {
    const rows = chatMessageToAgentApiRows(
      buildUserMessageWithAttachments([
        {
          type: 'file',
          name: 'huge.pdf',
          path: '/tmp/huge.pdf',
          size: 50_000_000,
          kind: 'pdf',
          mimeType: 'application/pdf',
          sha256: 'big',
          status: 'ready',
          pdf: { pageCount: 500, sizeBytes: 50_000_000, oversized: true },
          text: { content: '长文本 ...', truncated: true, originalChars: 5_000_000 },
        },
      ]),
    )
    expect(rows).toHaveLength(1)
    const content = rows[0].content
    // With text-only output, the builder collapses to a single string.
    if (typeof content === 'string') {
      expect(content).toContain('长文本')
      expect(content).not.toMatch(/type.{0,4}document/i)
    } else {
      // Defensive: if a future change re-emits as parts, verify no doc block.
      expect(
        (content as Array<Record<string, unknown>>).find((p) => p.type === 'document'),
      ).toBeUndefined()
    }
  })

  it('emits `image` blocks for scanned-PDF pageImages when text.content is unset', () => {
    // Per `electron/attachments/index.ts`, ingest deletes `text` when a
    // scanned PDF has pageImages. This test guards the contextBuilder side
    // of that contract: pageImages should become image blocks (not silently
    // dropped like before the bug fix).
    const rows = chatMessageToAgentApiRows(
      buildUserMessageWithAttachments([
        {
          type: 'file',
          name: 'scan.pdf',
          path: '/tmp/scan.pdf',
          size: 500,
          kind: 'pdf',
          mimeType: 'application/pdf',
          sha256: 'scan1',
          status: 'ready',
          // `text` deliberately left undefined — mirrors ingest behavior
          // when `looksLikeScannedText` returned true.
          pageImages: [
            { page: 1, base64: 'PAGE1JPG', mediaType: 'image/jpeg', source: 'pdftoppm' },
            { page: 2, base64: 'PAGE2JPG', mediaType: 'image/jpeg', source: 'pdftoppm' },
          ],
        },
      ]),
    )
    const parts = contentParts(rows)
    const images = parts.filter((p) => p.type === 'image')
    expect(images).toHaveLength(2)
    const p1 = images[0] as { source: { data: string; media_type: string } }
    expect(p1.source.data).toBe('PAGE1JPG')
    expect(p1.source.media_type).toBe('image/jpeg')
  })

  it('still emits pageImages when text.content IS present (no false negative guard)', () => {
    // Post-fix: the guard `!f.text?.content` was removed. Even if (hypothetically)
    // an ingest left both pageImages AND text.content populated, page images
    // must still reach the model — we do NOT want to silently drop them.
    const rows = chatMessageToAgentApiRows(
      buildUserMessageWithAttachments([
        {
          type: 'file',
          name: 'hybrid.pdf',
          path: '/tmp/hybrid.pdf',
          size: 500,
          kind: 'pdf',
          mimeType: 'application/pdf',
          sha256: 'h1',
          status: 'ready',
          text: { content: 'some extracted text', truncated: false, originalChars: 18 },
          pageImages: [
            { page: 1, base64: 'HYBRID1', mediaType: 'image/png', source: 'pdfjs-canvas' },
          ],
        },
      ]),
    )
    const parts = contentParts(rows)
    expect(parts.filter((p) => p.type === 'image')).toHaveLength(1)
  })

  it('emits `image` blocks for Office inlineImages (docx embedded pictures)', () => {
    const rows = chatMessageToAgentApiRows(
      buildUserMessageWithAttachments([
        {
          type: 'file',
          name: 'report.docx',
          path: '/tmp/report.docx',
          size: 2_000,
          kind: 'docx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sha256: 'docx1',
          status: 'ready',
          text: {
            content: '# 报告\n\n正文开始 ![fig](astra:docx-image:abc)',
            truncated: false,
            originalChars: 100,
          },
          inlineImages: [
            { base64: 'DOCX_IMG_1', mediaType: 'image/png' },
            { base64: 'DOCX_IMG_2', mediaType: 'image/jpeg', altText: '图二' },
          ],
        },
      ]),
    )
    const parts = contentParts(rows)
    const images = parts.filter((p) => p.type === 'image')
    expect(images).toHaveLength(2)
    const img2 = images[1] as { source: { data: string; media_type: string } }
    expect(img2.source.data).toBe('DOCX_IMG_2')
    expect(img2.source.media_type).toBe('image/jpeg')
  })

  it('direct pasted-image attachments remain first-class (regression guard)', () => {
    const rows = chatMessageToAgentApiRows(
      buildUserMessageWithAttachments([
        {
          type: 'image',
          name: 'clipboard.png',
          base64: 'PASTE_PNG',
          mediaType: 'image/png',
          size: 42,
        },
      ]),
    )
    const parts = contentParts(rows)
    expect(parts.filter((p) => p.type === 'image')).toHaveLength(1)
    const img = parts.find((p) => p.type === 'image') as {
      source: { data: string; media_type: string }
    }
    expect(img.source.data).toBe('PASTE_PNG')
  })

  it('normalizes image/jpg → image/jpeg in media_type (API compat)', () => {
    const rows = chatMessageToAgentApiRows(
      buildUserMessageWithAttachments([
        {
          type: 'image',
          name: 'photo.jpg',
          base64: 'JPG_BYTES',
          mediaType: 'image/jpg',
          size: 30,
        },
      ]),
    )
    const parts = contentParts(rows)
    const img = parts.find((p) => p.type === 'image') as {
      source: { media_type: string }
    }
    expect(img.source.media_type).toBe('image/jpeg')
  })

  it('drops in-flight (status=processing) file attachments from the text preamble', () => {
    const rows = chatMessageToAgentApiRows(
      buildUserMessageWithAttachments(
        [
          {
            type: 'file',
            name: 'busy.pdf',
            path: 'pending:/tmp/busy.pdf:xyz',
            size: 123,
            status: 'processing',
          },
        ],
        'hello',
      ),
    )
    // No text preamble means the row degenerates to a single-string content.
    expect(rows).toHaveLength(1)
    expect(typeof rows[0].content).toBe('string')
    expect(rows[0].content).toBe('hello')
  })

  it('emits mixed content (document + image + text preamble) for a multi-attachment turn', () => {
    const rows = chatMessageToAgentApiRows(
      buildUserMessageWithAttachments([
        {
          type: 'file',
          name: 'spec.pdf',
          path: '/tmp/spec.pdf',
          size: 1_000,
          kind: 'pdf',
          mimeType: 'application/pdf',
          sha256: 'spec',
          status: 'ready',
          pdf: { base64: 'PDF_BYTES', pageCount: 1, sizeBytes: 1_000, oversized: false },
          text: { content: '规格文档', truncated: false, originalChars: 4 },
        },
        {
          type: 'image',
          name: 'demo.png',
          base64: 'PNG_BYTES',
          mediaType: 'image/png',
          size: 500,
        },
      ]),
    )
    const parts = contentParts(rows)
    const hasText = parts.some((p) => p.type === 'text')
    const hasDoc = parts.some((p) => p.type === 'document')
    const hasImage = parts.some((p) => p.type === 'image')
    expect(hasText).toBe(true)
    expect(hasDoc).toBe(true)
    expect(hasImage).toBe(true)
    // Ordering: text preamble should come first (model needs framing),
    // then documents, then direct images. This matches Anthropic's
    // recommendation to keep sibling documents adjacent to their
    // text references.
    const textIdx = parts.findIndex((p) => p.type === 'text')
    const docIdx = parts.findIndex((p) => p.type === 'document')
    const imgIdx = parts.findIndex((p) => p.type === 'image')
    expect(textIdx).toBeLessThan(docIdx)
    expect(docIdx).toBeLessThan(imgIdx)
  })

  // ─── Thinking transcript replay (DeepSeek 3rd-turn 400 regression guard) ───

  it('re-emits assistant thinking blocks so DeepSeek / Anthropic see the chain-of-thought on later turns', () => {
    // DeepSeek's Anthropic-compat gateway returns HTTP 400
    // `"content[].thinking in the thinking mode must be passed back to the
    // API"` starting at turn 3+ when an earlier-turn assistant had BOTH a
    // thinking block and a tool_use block but the thinking block was dropped
    // from the history. Pre-fix, `chatMessageToAgentApiRows` unconditionally
    // dropped every thinking block. Regression guard: verify the block
    // re-appears in the assistant row ahead of the tool_use.
    const rows = chatMessageToAgentApiRows({
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      blocks: [
        { type: 'thinking', text: '用户问天气。需要先拿今天的日期再查。' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'get_date',
          input: {},
          status: 'completed',
          result: '2026-04-19',
        },
      ],
    })
    const assistant = rows.find((r) => r.role === 'assistant')
    expect(assistant).toBeDefined()
    const parts = assistant!.content as Array<Record<string, unknown>>
    expect(Array.isArray(parts)).toBe(true)
    const thinkingBlock = parts.find((p) => p.type === 'thinking')
    expect(thinkingBlock).toBeDefined()
    // Anthropic wire field name is `thinking`, not `text` — must match the
    // shape the provider expects verbatim.
    expect((thinkingBlock as { thinking: string }).thinking).toBe(
      '用户问天气。需要先拿今天的日期再查。',
    )
    const toolUseIdx = parts.findIndex((p) => p.type === 'tool_use')
    const thinkingIdx = parts.findIndex((p) => p.type === 'thinking')
    // Thinking must precede tool_use for replay to be semantically valid.
    expect(thinkingIdx).toBeLessThan(toolUseIdx)
  })

  it('forwards a captured thinking signature when present (Anthropic / DeepSeek transcript replay)', () => {
    const rows = chatMessageToAgentApiRows({
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      blocks: [
        {
          type: 'thinking',
          text: '思考过程',
          signature: 'sig-abc-123',
        },
        { type: 'text', text: '答案来了' },
      ],
    })
    const parts = (rows[0].content as Array<Record<string, unknown>>)
    const thinkingBlock = parts.find((p) => p.type === 'thinking') as {
      type: 'thinking'
      thinking: string
      signature?: string
    }
    expect(thinkingBlock.thinking).toBe('思考过程')
    expect(thinkingBlock.signature).toBe('sig-abc-123')
  })

  it('skips empty / whitespace-only thinking blocks (nothing useful to replay)', () => {
    const rows = chatMessageToAgentApiRows({
      id: 'a1',
      role: 'assistant',
      content: '回答',
      timestamp: 1,
      blocks: [
        { type: 'thinking', text: '   ' },
        { type: 'text', text: '回答' },
      ],
    })
    // Only text survives, so the row collapses to a string content.
    expect(rows).toHaveLength(1)
    expect(typeof rows[0].content === 'string' || Array.isArray(rows[0].content)).toBe(true)
    if (Array.isArray(rows[0].content)) {
      const parts = rows[0].content as Array<Record<string, unknown>>
      expect(parts.find((p) => p.type === 'thinking')).toBeUndefined()
    }
  })

  // ─── Historical-attachment staleness markers (P0 anti-confabulation) ───

  it('current-turn user message (turnDistance=0) is NOT wrapped in <historical-attachments>', () => {
    // Default behavior — no options arg — preserves the pre-fix output.
    const rows = chatMessageToAgentApiRows(
      buildUserMessageWithAttachments([
        {
          type: 'image',
          name: 'now.png',
          base64: 'PNG',
          mediaType: 'image/png',
          size: 100,
        },
      ]),
    )
    const parts = contentParts(rows)
    const text = parts.find((p) => p.type === 'text') as { text: string } | undefined
    if (text) {
      expect(text.text).not.toContain('<historical-attachments')
      expect(text.text).not.toContain('<historical-snapshot')
    }
  })

  it('historical user message with image attachment gets a <historical-attachments> notice', () => {
    const rows = chatMessageToAgentApiRows(
      buildUserMessageWithAttachments(
        [
          {
            type: 'image',
            name: 'old-screenshot.png',
            base64: 'OLDPNG',
            mediaType: 'image/png',
            size: 200,
          },
        ],
        '看这张图',
      ),
      { turnDistance: 3 },
    )
    const parts = contentParts(rows)
    const text = parts.find((p) => p.type === 'text') as { text: string }
    expect(text).toBeTruthy()
    expect(text.text).toContain('<historical-attachments turn-distance="3">')
    expect(text.text).toContain('3 turns ago')
    expect(text.text).toContain('1 image')
    expect(text.text).toContain('看这张图')
    // The image block itself is unchanged — bytes still flow to the model.
    const img = parts.find((p) => p.type === 'image') as { source: { data: string } }
    expect(img.source.data).toBe('OLDPNG')
  })

  it('singular vs plural turn label ("1 turn ago" vs "N turns ago")', () => {
    const rowsOne = chatMessageToAgentApiRows(
      buildUserMessageWithAttachments([
        { type: 'image', name: 'a.png', base64: 'A', mediaType: 'image/png', size: 1 },
      ]),
      { turnDistance: 1 },
    )
    const rowsTwo = chatMessageToAgentApiRows(
      buildUserMessageWithAttachments([
        { type: 'image', name: 'b.png', base64: 'B', mediaType: 'image/png', size: 1 },
      ]),
      { turnDistance: 2 },
    )
    const oneText = (contentParts(rowsOne).find((p) => p.type === 'text') as { text: string }).text
    const twoText = (contentParts(rowsTwo).find((p) => p.type === 'text') as { text: string }).text
    expect(oneText).toContain('1 turn ago')
    expect(oneText).not.toContain('1 turns ago')
    expect(twoText).toContain('2 turns ago')
  })

  /**
   * Extract the assembled user-message text regardless of whether the row
   * collapsed to a string (text-only attachments) or remained an array of
   * parts (mixed binary + text). Both shapes are valid per the existing
   * Anthropic-block contract; tests that care about preamble content
   * should not be sensitive to which one applies.
   */
  function getUserText(rows: ReturnType<typeof chatMessageToAgentApiRows>): string {
    expect(rows).toHaveLength(1)
    const c = rows[0].content
    if (typeof c === 'string') return c
    expect(Array.isArray(c)).toBe(true)
    const parts = c as Array<Record<string, unknown>>
    const t = parts.find((p) => p.type === 'text') as { text: string } | undefined
    return t?.text ?? ''
  }

  it('historical file attachment wraps preamble in <historical-snapshot path="...">', () => {
    const rows = chatMessageToAgentApiRows(
      buildUserMessageWithAttachments([
        {
          type: 'file',
          name: 'foo.py',
          path: '/abs/path/to/foo.py',
          size: 100,
          kind: 'code',
          status: 'ready',
          text: { content: 'def hello():\n    pass', truncated: false, originalChars: 22 },
        },
      ]),
      { turnDistance: 2 },
    )
    const text = getUserText(rows)
    // Per-file wrapper carries the path so the model knows exactly which
    // snapshot might be stale and where to call `read_file`.
    expect(text).toContain('<historical-snapshot path="/abs/path/to/foo.py" turn-distance="2">')
    expect(text).toContain('def hello()')
    expect(text).toContain('</historical-snapshot>')
    // The aggregate notice still appears (counts files).
    expect(text).toContain('<historical-attachments turn-distance="2">')
    expect(text).toContain('1 file')
  })

  it('escapes special chars in attachment path to keep <historical-snapshot> well-formed', () => {
    const rows = chatMessageToAgentApiRows(
      buildUserMessageWithAttachments([
        {
          type: 'file',
          name: 'weird.txt',
          // Contrived path with `<` / `>` / `&` / `"` to verify escaping —
          // real OS paths shouldn't contain these, but we never want a
          // user-controlled string to break our wrapper markup.
          path: '/tmp/<a&b"c>.txt',
          size: 10,
          kind: 'text',
          status: 'ready',
          text: { content: 'hello', truncated: false, originalChars: 5 },
        },
      ]),
      { turnDistance: 1 },
    )
    const text = getUserText(rows)
    expect(text).toContain('path="/tmp/&lt;a&amp;b&quot;c&gt;.txt"')
    // No raw unescaped chars in attribute position.
    expect(text).not.toMatch(/path="\/tmp\/<a&b"c>\.txt"/)
  })

  it('historical message with no attachments is unchanged (no notice spam)', () => {
    const rows = chatMessageToAgentApiRows(
      {
        id: 'u1',
        role: 'user',
        content: '只是文字消息',
        timestamp: 1,
      },
      { turnDistance: 5 },
    )
    expect(rows).toHaveLength(1)
    // Pure-text user message stays a plain string with no markup.
    expect(rows[0].content).toBe('只是文字消息')
  })

  it('historical message counts both image attachments and PDF page images', () => {
    const rows = chatMessageToAgentApiRows(
      buildUserMessageWithAttachments([
        {
          type: 'image',
          name: 'paste1.png',
          base64: 'P1',
          mediaType: 'image/png',
          size: 10,
        },
        {
          type: 'file',
          name: 'scan.pdf',
          path: '/tmp/scan.pdf',
          size: 1000,
          kind: 'pdf',
          status: 'ready',
          pageImages: [
            { page: 1, base64: 'PAGE1', mediaType: 'image/jpeg', source: 'pdftoppm' },
            { page: 2, base64: 'PAGE2', mediaType: 'image/jpeg', source: 'pdftoppm' },
          ],
        },
      ]),
      { turnDistance: 4 },
    )
    const parts = contentParts(rows)
    const text = parts.find((p) => p.type === 'text') as { text: string }
    // 1 direct image + 2 PDF page images = 3 images; 1 file.
    expect(text.text).toContain('3 images + 1 file')
  })

  it('negative or non-integer turnDistance is clamped to 0 (no wrapping)', () => {
    // Defense in depth — caller bugs should not crash the model with a
    // bizarre `turn-distance="-1.7"` attribute.
    const rows = chatMessageToAgentApiRows(
      buildUserMessageWithAttachments([
        { type: 'image', name: 'x.png', base64: 'X', mediaType: 'image/png', size: 1 },
      ]),
      { turnDistance: -1.7 },
    )
    const parts = contentParts(rows)
    const text = parts.find((p) => p.type === 'text') as { text: string } | undefined
    if (text) {
      expect(text.text).not.toContain('<historical-attachments')
    }
  })

  // ─── P2: <recall-pointer> binary stripping after N turns ───
  //
  // Default threshold is 5 turns (POLE_STRIP_BINARIES_AFTER_TURNS env override).
  // Tests below override the env var per case so they run deterministically
  // regardless of host environment. We restore the original value in afterEach.

  describe('binary stripping (turnDistance ≥ POLE_STRIP_BINARIES_AFTER_TURNS)', () => {
    const ENV_KEY = 'POLE_STRIP_BINARIES_AFTER_TURNS'
    let originalEnv: string | undefined

    beforeEach(() => {
      originalEnv = process.env[ENV_KEY]
    })

    afterEach(() => {
      if (originalEnv === undefined) delete process.env[ENV_KEY]
      else process.env[ENV_KEY] = originalEnv
    })

    /**
     * Count blocks of a given type in the row's content. Returns 0 when
     * the row collapsed to a string (no array blocks at all).
     */
    function blockCount(
      rows: ReturnType<typeof chatMessageToAgentApiRows>,
      type: string,
    ): number {
      expect(rows).toHaveLength(1)
      const c = rows[0].content
      if (typeof c === 'string') return 0
      return (c as Array<Record<string, unknown>>).filter((p) => p.type === type).length
    }

    it('keeps image bytes when turnDistance < threshold', () => {
      process.env[ENV_KEY] = '5'
      const rows = chatMessageToAgentApiRows(
        buildUserMessageWithAttachments([
          {
            type: 'image',
            name: 'fresh.png',
            base64: 'KEEP_ME',
            mediaType: 'image/png',
            size: 100,
            sha256: 'abc123',
          },
        ]),
        { turnDistance: 4 },
      )
      expect(blockCount(rows, 'image')).toBe(1)
      const text = getUserText(rows)
      expect(text).not.toContain('<recall-pointer')
    })

    it('strips image bytes and emits a <recall-pointer> when turnDistance ≥ threshold', () => {
      process.env[ENV_KEY] = '5'
      const rows = chatMessageToAgentApiRows(
        buildUserMessageWithAttachments(
          [
            {
              type: 'image',
              name: 'old-screenshot.png',
              base64: 'STRIPPED',
              mediaType: 'image/png',
              size: 100,
              sha256: 'sha-abc-123',
            },
          ],
          'I asked about this image earlier',
        ),
        { turnDistance: 6 },
      )
      // Original image bytes must be GONE (this is the whole point of P2).
      expect(blockCount(rows, 'image')).toBe(0)
      const text = getUserText(rows)
      // Pointer carries enough metadata for the recall_attachment tool.
      expect(text).toContain('<recall-pointer')
      expect(text).toContain('kind="image"')
      expect(text).toContain('name="old-screenshot.png"')
      expect(text).toContain('sha256="sha-abc-123"')
      expect(text).toContain('attached-turn-distance="6"')
      // Notice now mentions stripped binaries + tool name.
      expect(text).toContain('have been replaced with `<recall-pointer>`')
      expect(text).toContain('`recall_attachment`')
      // User text still survives.
      expect(text).toContain('I asked about this image earlier')
    })

    it('strips PDF document + page images, emits ONE pointer per file', () => {
      process.env[ENV_KEY] = '3'
      const rows = chatMessageToAgentApiRows(
        buildUserMessageWithAttachments([
          {
            type: 'file',
            name: 'old-spec.pdf',
            path: '/tmp/old-spec.pdf',
            size: 5_000,
            kind: 'pdf',
            mimeType: 'application/pdf',
            sha256: 'pdf-sha',
            status: 'ready',
            pdf: { base64: 'PDF_BYTES_GONE', pageCount: 2, sizeBytes: 5_000, oversized: false },
            pageImages: [
              { page: 1, base64: 'P1', mediaType: 'image/jpeg', source: 'pdftoppm' },
              { page: 2, base64: 'P2', mediaType: 'image/jpeg', source: 'pdftoppm' },
            ],
          },
        ]),
        { turnDistance: 5 },
      )
      // No document block, no page-image blocks — all bytes stripped.
      expect(blockCount(rows, 'document')).toBe(0)
      expect(blockCount(rows, 'image')).toBe(0)
      const text = getUserText(rows)
      // ONE pointer for the whole file (not one per emitted block).
      // Match only the OPENING TAG with a kind= attribute — the
      // <historical-attachments> notice text mentions the literal
      // string "<recall-pointer>" in prose, which we must not double-count.
      const matches = text.match(/<recall-pointer kind=/g) ?? []
      expect(matches).toHaveLength(1)
      expect(text).toContain('kind="pdf"')
      expect(text).toContain('sha256="pdf-sha"')
      expect(text).toContain('pages="2 pages"')
    })

    it('strips multiple direct images independently', () => {
      process.env[ENV_KEY] = '4'
      const rows = chatMessageToAgentApiRows(
        buildUserMessageWithAttachments([
          {
            type: 'image',
            name: 'a.png',
            base64: 'A',
            mediaType: 'image/png',
            size: 10,
            sha256: 'sha-A',
          },
          {
            type: 'image',
            name: 'b.png',
            base64: 'B',
            mediaType: 'image/png',
            size: 10,
            sha256: 'sha-B',
          },
        ]),
        { turnDistance: 4 },
      )
      expect(blockCount(rows, 'image')).toBe(0)
      const text = getUserText(rows)
      const matches = text.match(/<recall-pointer kind=/g) ?? []
      expect(matches).toHaveLength(2)
      expect(text).toContain('sha256="sha-A"')
      expect(text).toContain('sha256="sha-B"')
    })

    it('omits sha256 attribute and warns when attachment has no sha256', () => {
      // Older / browser-origin pastes may not carry a sha256 — recall is
      // impossible in that case, so the pointer must say so explicitly
      // rather than dangle an empty `sha256=""` that the model would try
      // to call recall_attachment with.
      process.env[ENV_KEY] = '2'
      const rows = chatMessageToAgentApiRows(
        buildUserMessageWithAttachments([
          {
            type: 'image',
            name: 'no-sha.png',
            base64: 'NOSHA',
            mediaType: 'image/png',
            size: 10,
          },
        ]),
        { turnDistance: 3 },
      )
      const text = getUserText(rows)
      expect(text).toContain('<recall-pointer')
      expect(text).not.toContain('sha256=')
      expect(text).toContain('not cached and cannot be auto-recalled')
    })

    it('threshold = 0 disables stripping entirely', () => {
      // Operators may want to opt out (token cost less critical than vision
      // continuity, e.g. UI debugging sessions).
      process.env[ENV_KEY] = '0'
      const rows = chatMessageToAgentApiRows(
        buildUserMessageWithAttachments([
          {
            type: 'image',
            name: 'never-stripped.png',
            base64: 'KEEP',
            mediaType: 'image/png',
            size: 1,
            sha256: 'x',
          },
        ]),
        { turnDistance: 99 },
      )
      expect(blockCount(rows, 'image')).toBe(1)
      const text = getUserText(rows)
      expect(text).not.toContain('<recall-pointer')
    })

    it('default threshold (env unset) is 5', () => {
      delete process.env[ENV_KEY]
      const rowsAt4 = chatMessageToAgentApiRows(
        buildUserMessageWithAttachments([
          { type: 'image', name: 'a.png', base64: 'A', mediaType: 'image/png', size: 1, sha256: 's' },
        ]),
        { turnDistance: 4 },
      )
      const rowsAt5 = chatMessageToAgentApiRows(
        buildUserMessageWithAttachments([
          { type: 'image', name: 'a.png', base64: 'A', mediaType: 'image/png', size: 1, sha256: 's' },
        ]),
        { turnDistance: 5 },
      )
      // 4 < 5 → kept; 5 ≥ 5 → stripped.
      expect(blockCount(rowsAt4, 'image')).toBe(1)
      expect(blockCount(rowsAt5, 'image')).toBe(0)
    })

    it('preserves text preamble even when binary is stripped (file with both text + binary)', () => {
      // For docx/pdfs with text.content, the text body is small + useful;
      // we keep it (still wrapped in <historical-snapshot>) and only strip
      // the heavy binary fan-out (document block / page images).
      process.env[ENV_KEY] = '2'
      const rows = chatMessageToAgentApiRows(
        buildUserMessageWithAttachments([
          {
            type: 'file',
            name: 'spec.pdf',
            path: '/tmp/spec.pdf',
            size: 1_000,
            kind: 'pdf',
            mimeType: 'application/pdf',
            sha256: 'spec-sha',
            status: 'ready',
            pdf: { base64: 'PDF_GONE', pageCount: 1, sizeBytes: 1_000, oversized: false },
            text: { content: '## Spec heading\nbody text', truncated: false, originalChars: 30 },
          },
        ]),
        { turnDistance: 3 },
      )
      expect(blockCount(rows, 'document')).toBe(0)
      const text = getUserText(rows)
      expect(text).toContain('<recall-pointer')
      // Text body survives in <historical-snapshot> form.
      expect(text).toContain('<historical-snapshot path="/tmp/spec.pdf"')
      expect(text).toContain('Spec heading')
    })
  })
})

// --- buildMessagesWithContext: compact_boundary filtering ---------------

import { buildMessagesWithContext } from './contextBuilder'

describe('buildMessagesWithContext: filters compact_boundary rows', () => {
  it('drops compact_boundary entries before producing API rows', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: 1 },
      {
        id: 'compact-1',
        role: 'assistant',
        kind: 'compact_boundary',
        compactBoundary: { level: 'auto_compact', reclaimedTokens: 12_345 },
        content: '',
        timestamp: 2,
      },
      { id: 'a1', role: 'assistant', content: 'world', timestamp: 3 },
    ]
    const rows = buildMessagesWithContext(messages, {})
    // Two real turns (plus possibly a reminder row), but the boundary
    // must not appear as either an empty assistant or an empty user.
    const empties = rows.filter(
      (r) =>
        (typeof r.content === 'string' && r.content.trim() === '') ||
        (Array.isArray(r.content) && r.content.length === 0),
    )
    expect(empties).toHaveLength(0)
    const texts = rows
      .map((r) => (typeof r.content === 'string' ? r.content : ''))
      .join('|')
    expect(texts).toContain('hello')
    expect(texts).toContain('world')
  })

  // Plan Phase 2.B — _streamFallbackTombstone 整条丢弃（仅在真正空壳时）
  describe('streamFallbackTombstone (Phase 2.B)', () => {
    it('returns [] for tombstoned messages that are also empty (true empty shell)', () => {
      const rows = chatMessageToAgentApiRows({
        id: 'msg-tombstoned',
        role: 'assistant',
        content: '',
        timestamp: 1,
        blocks: [],
        _streamFallbackTombstone: true,
      })
      expect(rows).toEqual([])
    })

    it('KEEPS tombstoned messages whose fallback retry refilled blocks (fallback succeeded)', () => {
      // Plan §2.B 修订：fallback 后非流式响应往同一条消息追加 blocks 是
      // emitAnthropicNonStreamMessageAsStreamCallbacks 的正常行为。tombstone
      // 标记保留但 blocks 已经有真实 fallback 内容 — 必须回灌给下一轮。
      const rows = chatMessageToAgentApiRows({
        id: 'msg-fallback-recovered',
        role: 'assistant',
        content: '',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'fallback succeeded with this content' }],
        _streamFallbackTombstone: true, // 标记没清，但 fallback 成功
      })
      expect(rows.length).toBeGreaterThan(0)
    })

    it('KEEPS tombstoned messages whose fallback refilled top-level content', () => {
      // 同上但通过 content 字段填充（applyBatchedDeltas 把 text delta 累积到顶级 content）
      const rows = chatMessageToAgentApiRows({
        id: 'msg-content-recovered',
        role: 'assistant',
        content: 'fallback response text',
        timestamp: 1,
        blocks: [],
        _streamFallbackTombstone: true,
      })
      expect(rows.length).toBeGreaterThan(0)
    })

    it('still emits rows for normal (non-tombstoned) messages', () => {
      const rows = chatMessageToAgentApiRows({
        id: 'm-ok',
        role: 'assistant',
        content: 'hi',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'hi' }],
      })
      expect(rows.length).toBeGreaterThan(0)
    })
  })

  // 2026-07 interruption protocol — user Stop must be visible to the model
  describe('interruption protocol (2026-07)', () => {
    it('serializes a stopped tool_use as an interrupt-flavoured error tool_result (not the benign catch-all)', () => {
      const rows = chatMessageToAgentApiRows({
        id: 'a-stopped',
        role: 'assistant',
        content: '',
        timestamp: 1,
        blocks: [
          {
            type: 'tool_use',
            id: 'toolu_stop',
            name: 'Bash',
            input: { command: 'sleep 100' },
            status: 'stopped',
          },
        ],
      })
      const userRow = rows.find(
        (r) =>
          r.role === 'user' &&
          Array.isArray(r.content) &&
          (r.content as Array<Record<string, unknown>>).some((b) => b.type === 'tool_result'),
      )
      expect(userRow).toBeDefined()
      const tr = (userRow!.content as Array<Record<string, unknown>>).find(
        (b) => b.type === 'tool_result',
      )!
      expect(tr.tool_use_id).toBe('toolu_stop')
      expect(tr.is_error).toBe(true)
      expect(String(tr.content)).toContain('interrupted by user')
      // Must NOT be the "benign no-op, just continue" catch-all.
      expect(String(tr.content)).not.toContain('benign no-op')
    })

    it('appends [User interrupted during tool execution.] after an interrupted tool turn', () => {
      const rows = chatMessageToAgentApiRows({
        id: 'a-int-tool',
        role: 'assistant',
        content: '',
        timestamp: 1,
        interruptedByUser: true,
        blocks: [
          {
            type: 'tool_use',
            id: 'toolu_x',
            name: 'Bash',
            input: {},
            status: 'stopped',
          },
        ],
      })
      const last = rows[rows.length - 1]
      expect(last.role).toBe('user')
      expect(last.content).toBe('[User interrupted during tool execution.]')
    })

    it('appends [User interrupted during model response.] after an interrupted text-only turn', () => {
      const rows = chatMessageToAgentApiRows({
        id: 'a-int-text',
        role: 'assistant',
        content: '让我先分析一下这个问题，我认为',
        timestamp: 1,
        interruptedByUser: true,
        blocks: [{ type: 'text', text: '让我先分析一下这个问题，我认为' }],
      })
      const last = rows[rows.length - 1]
      expect(last.role).toBe('user')
      expect(last.content).toBe('[User interrupted during model response.]')
    })

    it('does not append a marker for non-interrupted messages', () => {
      const rows = chatMessageToAgentApiRows({
        id: 'a-normal',
        role: 'assistant',
        content: 'done',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'done' }],
      })
      expect(
        rows.some(
          (r) =>
            typeof r.content === 'string' && r.content.includes('[User interrupted'),
        ),
      ).toBe(false)
    })

    it('marker survives mergeAdjacentUserMessages as a leading block of the next user turn', () => {
      const interruptedRows = chatMessageToAgentApiRows({
        id: 'a-int-merge',
        role: 'assistant',
        content: '半截回复',
        timestamp: 1,
        interruptedByUser: true,
        blocks: [{ type: 'text', text: '半截回复' }],
      })
      const merged = mergeAdjacentUserMessages([
        ...interruptedRows,
        { role: 'user', content: '继续，但换个方案' },
      ])
      const lastUser = merged[merged.length - 1]
      expect(lastUser.role).toBe('user')
      const text = JSON.stringify(lastUser.content)
      expect(text).toContain('[User interrupted during model response.]')
      expect(text).toContain('继续，但换个方案')
    })
  })

  // Plan Phase 4 — redacted_thinking 块原样回灌
  describe('redacted_thinking echo (Phase 4)', () => {
    it('emits a redacted_thinking part in the assistant row with the data blob verbatim', () => {
      const rows = chatMessageToAgentApiRows({
        id: 'a-redacted',
        role: 'assistant',
        content: '',
        timestamp: 1,
        blocks: [
          { type: 'redacted_thinking', data: 'ENCRYPTED_BLOB_ABC123' },
          { type: 'text', text: 'final answer' },
        ],
      })
      // assistant row 至少有一个
      expect(rows.length).toBeGreaterThan(0)
      const assistantRow = rows.find((r) => r.role === 'assistant')
      expect(assistantRow).toBeDefined()
      const parts = assistantRow!.content
      expect(Array.isArray(parts)).toBe(true)
      const redactedPart = (parts as Array<Record<string, unknown>>).find(
        (p) => p.type === 'redacted_thinking',
      )
      expect(redactedPart).toBeDefined()
      expect(redactedPart!.data).toBe('ENCRYPTED_BLOB_ABC123')
    })

    it('skips redacted_thinking blocks with empty data (defensive)', () => {
      const rows = chatMessageToAgentApiRows({
        id: 'a-empty',
        role: 'assistant',
        content: '',
        timestamp: 1,
        blocks: [
          { type: 'redacted_thinking', data: '' },
          { type: 'text', text: 'answer' },
        ],
      })
      const assistantRow = rows.find((r) => r.role === 'assistant')
      const parts = (assistantRow?.content as Array<Record<string, unknown>>) ?? []
      const redactedParts = parts.filter((p) => p.type === 'redacted_thinking')
      expect(redactedParts).toHaveLength(0)
    })
  })
})
