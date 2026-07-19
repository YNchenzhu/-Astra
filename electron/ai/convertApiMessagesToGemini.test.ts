import { describe, it, expect } from 'vitest'
import { convertApiMessagesToGemini } from './convertApiMessagesToGemini'

describe('convertApiMessagesToGemini', () => {
  it('merges tool_result blocks and trailing text into one user turn in source order', () => {
    const apiMessages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'a' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: 'file contents',
          },
          { type: 'text', text: 'discovery hint' },
        ],
      },
    ]

    const contents = convertApiMessagesToGemini(apiMessages)

    const userTurns = contents.filter((c) => c.role === 'user')
    expect(userTurns).toHaveLength(2)
    expect(userTurns[0].parts).toHaveLength(1)
    expect(userTurns[0].parts[0]).toMatchObject({
      functionResponse: { name: 'Read', response: { result: 'file contents' } },
    })
    expect(userTurns[1].parts[0]).toEqual({ text: 'discovery hint' })
  })

  it('moves functionResponse ahead of text when replying to a functionCall', () => {
    const apiMessages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'x', name: 'Grep', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'note first' },
          { type: 'tool_result', tool_use_id: 'x', name: 'Grep', content: 'ok' },
        ],
      },
    ]

    const contents = convertApiMessagesToGemini(apiMessages)
    const users = contents.filter((c) => c.role === 'user')
    expect(users).toHaveLength(2)
    expect(users[0].parts[0]).toMatchObject({
      functionResponse: { name: 'Grep', response: { result: 'ok' } },
    })
    expect(users[1].parts[0]).toEqual({ text: 'note first' })
  })

  it('maps tool_result name from prior assistant tool_use id when name omitted', () => {
    const apiMessages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'abc', name: 'Edit', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'abc', content: 'done' }],
      },
    ]

    const contents = convertApiMessagesToGemini(apiMessages)
    const fr = contents.find((c) => c.role === 'user')?.parts[0] as {
      functionResponse: { name: string }
    }
    expect(fr.functionResponse.name).toBe('Edit')
  })

  it('drops orphan functionResponse parts when the model functionCall was compacted away', () => {
    const contents = convertApiMessagesToGemini([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'missing', content: 'orphan' },
          { type: 'text', text: 'continue' },
        ],
      },
    ])

    expect(contents).toEqual([{ role: 'user', parts: [{ text: 'continue' }] }])
  })

  it('inserts synthetic functionResponse parts for missing tool results', () => {
    const contents = convertApiMessagesToGemini([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'missing', name: 'Read', input: {} }],
      },
      { role: 'user', content: 'what next?' },
    ])

    expect(contents.map((c) => c.role)).toEqual(['model', 'user', 'user'])
    expect(contents[1].parts[0]).toMatchObject({
      functionResponse: { name: 'Read' },
    })
    expect(JSON.stringify(contents[1].parts[0])).toContain('synthetic functionResponse')
    expect(contents[2]).toEqual({ role: 'user', parts: [{ text: 'what next?' }] })
  })

  it('maps user image blocks to inlineData parts', () => {
    const apiMessages: Array<Record<string, unknown>> = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'AAA',
            },
          },
        ],
      },
    ]

    const contents = convertApiMessagesToGemini(apiMessages)
    const user = contents.find((c) => c.role === 'user')
    expect(user?.parts).toHaveLength(2)
    expect(user?.parts[0]).toEqual({ text: 'what is this' })
    expect(user?.parts[1]).toEqual({
      inlineData: { mimeType: 'image/png', data: 'AAA' },
    })
  })

  it('assistant message keeps text and tool_use in order on one model turn', () => {
    const apiMessages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling tool' },
          { type: 'tool_use', id: '1', name: 'Read', input: { path: 'p' } },
        ],
      },
    ]

    const contents = convertApiMessagesToGemini(apiMessages)
    const model = contents.find((c) => c.role === 'model')
    expect(model?.parts).toHaveLength(2)
    expect(model?.parts[0]).toEqual({ text: 'calling tool' })
    expect(model?.parts[1]).toMatchObject({ functionCall: { name: 'Read' } })
  })

  // ─── Regression: tool_result with multipart content (text + image) ───
  //
  // Before the fix, `b.content` arrays were `JSON.stringify`-ed wholesale,
  // which collapsed any image / document children to a literal JSON
  // representation in the `result` string — Gemini saw raw JSON text and
  // had no inlineData parts to look at, so the model could never "see"
  // images returned by tools.
  it('explodes tool_result with mixed text+image children into a functionResponse plus sibling inlineData parts', () => {
    const apiMessages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'snap', name: 'Screenshot', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'snap',
            content: [
              { type: 'text', text: 'PNG saved at /tmp/x.png' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'BASE64_DATA' },
              },
            ],
          },
        ],
      },
    ]

    const contents = convertApiMessagesToGemini(apiMessages)
    const userTurn = contents.find((c) => c.role === 'user')
    expect(userTurn?.parts).toHaveLength(2)
    expect(userTurn?.parts[0]).toMatchObject({
      functionResponse: { name: 'Screenshot', response: { result: 'PNG saved at /tmp/x.png' } },
    })
    expect(userTurn?.parts[1]).toEqual({
      inlineData: { mimeType: 'image/png', data: 'BASE64_DATA' },
    })
  })

  it('tool_result with only image children (no text) still attaches inlineData and a placeholder result', () => {
    const apiMessages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'snap2', name: 'Screenshot', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'snap2',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: 'JPEG_DATA' },
              },
            ],
          },
        ],
      },
    ]

    const contents = convertApiMessagesToGemini(apiMessages)
    const userTurn = contents.find((c) => c.role === 'user')
    expect(userTurn?.parts).toHaveLength(2)
    expect(userTurn?.parts[0]).toMatchObject({
      functionResponse: { name: 'Screenshot' },
    })
    // Sentinel placeholder so functionResponse.response is never empty
    // (Gemini 400s on empty struct).
    expect((userTurn?.parts[0] as { functionResponse: { response: { result: string } } })
      .functionResponse.response.result).toContain('1 file(s) attached')
    expect(userTurn?.parts[1]).toEqual({
      inlineData: { mimeType: 'image/jpeg', data: 'JPEG_DATA' },
    })
  })

  // ─── Regression: tool_use.input arriving as a JSON string ───
  //
  // History replay through some Anthropic-compat proxies re-serializes
  // `tool_use.input` as a JSON string. Without `parseToolArguments`, the
  // bare cast `(b.input as Record) || {}` collapsed it to `{}` and Gemini
  // saw an empty `functionCall.args`.
  it('parses stringified tool_use.input back to an object on assistant model turn', () => {
    const apiMessages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'write_file',
            input: '{"filePath":"/x.txt","content":"hello"}',
          },
        ],
      },
    ]

    const contents = convertApiMessagesToGemini(apiMessages)
    const model = contents.find((c) => c.role === 'model')
    expect(model?.parts[0]).toMatchObject({
      functionCall: {
        name: 'write_file',
        args: { filePath: '/x.txt', content: 'hello' },
      },
    })
  })

  // ─── Regression: systemPrompt is no longer injected as a fake user/model turn ───
  //
  // The old signature `convertApiMessagesToGemini(messages, systemPrompt)`
  // pushed `[user(systemPrompt), model("Understood…")]` at the front. That
  // doubled the system prompt with `streamGemini`'s now-correct
  // `modelConfig.systemInstruction` and polluted the conversation. The
  // signature has changed — `systemPrompt` is gone — and there must be no
  // fake turn produced even when the agentic loop's first message is a
  // user prompt.
  it('does NOT inject any synthetic user/model turn at the front (systemPrompt routes via systemInstruction)', () => {
    const apiMessages: Array<Record<string, unknown>> = [
      { role: 'user', content: 'hello' },
    ]
    const contents = convertApiMessagesToGemini(apiMessages)
    expect(contents).toHaveLength(1)
    expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'hello' }] })
  })
})
