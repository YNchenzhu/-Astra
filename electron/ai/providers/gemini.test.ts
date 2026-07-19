import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ProviderConfig, StreamCallbacks } from '../client'

/**
 * Regression tests for the native Gemini SDK provider (`streamGemini`).
 *
 * Focus: the system-prompt routing fix and the tool-arg robustness against
 * stringified inputs. We mock `@google/generative-ai` so the provider runs
 * end-to-end inside Vitest without hitting the network.
 */

// ─── Mock @google/generative-ai ───
//
// We capture the `ModelParams` passed to `getGenerativeModel` so the test
// can assert system instructions / tool definitions land on the SDK call
// the way Gemini expects.
//
// `vi.mock` is hoisted to the top of the file, so any top-level `const`s
// referenced from the factory are still `undefined` when it runs. The
// `vi.hoisted` block hoists the spies alongside the mock so they're
// initialized in the right order.
const { mockGetGenerativeModel, mockGenerateContentStream } = vi.hoisted(() => ({
  mockGetGenerativeModel: vi.fn(),
  mockGenerateContentStream: vi.fn(),
}))

vi.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: class {
      getGenerativeModel = mockGetGenerativeModel
    },
  }
})

import { streamGemini } from './gemini'

function mkConfig(): ProviderConfig {
  return {
    id: 'gemini',
    name: 'Gemini',
    apiKey: 'AIzatest',
  }
}

type StreamParams = Parameters<typeof streamGemini>[1]

function mkParams(overrides: Partial<StreamParams> = {}): StreamParams {
  return {
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  }
}

function makeCollector(): {
  calls: StreamCallbacks
  text: string[]
  tools: Array<{ id: string; name: string; input: Record<string, unknown> }>
  ends: number
  errors: string[]
  stopReasons: Array<string | undefined>
} {
  const text: string[] = []
  const tools: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
  const errors: string[] = []
  const stopReasons: Array<string | undefined> = []
  let ends = 0
  return {
    calls: {
      onTextDelta: (t) => text.push(t),
      onToolUse: (t) => tools.push({ id: t.id, name: t.name, input: t.input }),
      onMessageEnd: (usage) => {
        stopReasons.push(usage?.stopReason)
        ends += 1
      },
      onError: (e) => errors.push(e),
    },
    text,
    tools,
    get ends() {
      return ends
    },
    errors,
    stopReasons,
  } as ReturnType<typeof makeCollector>
}

/** Build an async iterable with a single Gemini chunk. */
function makeStream(parts: Array<Record<string, unknown>>, finishReason?: string): {
  stream: AsyncIterable<{ candidates: Array<{ content: { parts: Array<Record<string, unknown>> }; finishReason?: string }> }>
} {
  return {
    stream: (async function* gen() {
      yield {
        candidates: [{ content: { parts }, ...(finishReason ? { finishReason } : {}) }],
      }
    })(),
  }
}

beforeEach(() => {
  mockGetGenerativeModel.mockReset()
  mockGenerateContentStream.mockReset()
  // Default: `getGenerativeModel(...)` returns an object whose
  // `generateContentStream` is the mock; tests can override per-case.
  mockGetGenerativeModel.mockImplementation(() => ({
    generateContentStream: mockGenerateContentStream,
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('streamGemini — systemInstruction routing (regression)', () => {
  it('passes systemPrompt as ModelParams.systemInstruction (NOT as a fake user/model turn at the front of contents)', async () => {
    mockGenerateContentStream.mockResolvedValue(
      makeStream([{ text: 'hi back' }]),
    )

    const coll = makeCollector()
    await streamGemini(
      mkConfig(),
      mkParams({
        systemPrompt: 'You are an assistant. Be terse.',
      }),
      coll.calls,
      new AbortController().signal,
    )

    // 1) `getGenerativeModel` MUST receive systemInstruction so Gemini
    //    treats it at the model level instead of inline as a user turn.
    expect(mockGetGenerativeModel).toHaveBeenCalledTimes(1)
    const [modelConfig] = mockGetGenerativeModel.mock.calls[0]
    expect(modelConfig.systemInstruction).toBeDefined()
    expect(modelConfig.systemInstruction.role).toBe('system')
    expect(modelConfig.systemInstruction.parts[0]).toEqual({
      text: 'You are an assistant. Be terse.',
    })

    // 2) The contents array MUST NOT contain a synthetic
    //    [user(systemPrompt), model('Understood…')] front-pad.
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(1)
    const [streamArg] = mockGenerateContentStream.mock.calls[0]
    expect(streamArg.contents).toHaveLength(1)
    expect(streamArg.contents[0]).toEqual({
      role: 'user',
      parts: [{ text: 'hello' }],
    })

    expect(coll.errors).toEqual([])
    expect(coll.text.join('')).toBe('hi back')
    expect(coll.ends).toBe(1)
  })

  it('omits systemInstruction entirely when no systemPrompt is provided', async () => {
    mockGenerateContentStream.mockResolvedValue(makeStream([{ text: 'ok' }]))

    await streamGemini(
      mkConfig(),
      mkParams({ systemPrompt: undefined }),
      makeCollector().calls,
      new AbortController().signal,
    )

    const [modelConfig] = mockGetGenerativeModel.mock.calls[0]
    expect(modelConfig.systemInstruction).toBeUndefined()
  })
})

describe('streamGemini — functionCall.args robustness (regression)', () => {
  it('rescues stringified functionCall.args from third-party Gemini-compat gateways', async () => {
    // Some Gemini-compat proxies serialize `args` as a JSON string.
    // The bare `typeof === "object"` check used to drop it to `{}` — same
    // failure mode as OpenAI2. `parseToolArguments` rescues the payload.
    mockGenerateContentStream.mockResolvedValue(
      makeStream([
        {
          functionCall: {
            name: 'write_file',
            args: '{"filePath":"/x.txt","content":"abc"}',
          },
        },
      ]),
    )

    const coll = makeCollector()
    await streamGemini(
      mkConfig(),
      mkParams({
        tools: [
          {
            name: 'write_file',
            description: 'Create a file',
            input_schema: {
              type: 'object',
              properties: { filePath: { type: 'string' }, content: { type: 'string' } },
              required: ['filePath', 'content'],
            },
          },
        ],
      }),
      coll.calls,
      new AbortController().signal,
    )

    expect(coll.errors).toEqual([])
    expect(coll.tools).toHaveLength(1)
    expect(coll.tools[0]).toMatchObject({
      name: 'write_file',
      input: { filePath: '/x.txt', content: 'abc' },
    })
  })

  it('passes through a normal object args payload unchanged', async () => {
    mockGenerateContentStream.mockResolvedValue(
      makeStream([
        {
          functionCall: {
            name: 'read_file',
            args: { filePath: '/y.txt' },
          },
        },
      ]),
    )

    const coll = makeCollector()
    await streamGemini(
      mkConfig(),
      mkParams({
        tools: [
          {
            name: 'read_file',
            description: 'Read a file',
            input_schema: {
              type: 'object',
              properties: { filePath: { type: 'string' } },
              required: ['filePath'],
            },
          },
        ],
      }),
      coll.calls,
      new AbortController().signal,
    )

    expect(coll.tools).toHaveLength(1)
    expect(coll.tools[0].input).toEqual({ filePath: '/y.txt' })
  })
})

describe('streamGemini — stopReason propagation', () => {
  it('maps Gemini MAX_TOKENS finishReason to Claude max_tokens', async () => {
    mockGenerateContentStream.mockResolvedValue(
      makeStream([{ text: 'partial answer' }], 'MAX_TOKENS'),
    )

    const coll = makeCollector()
    await streamGemini(
      mkConfig(),
      mkParams(),
      coll.calls,
      new AbortController().signal,
    )

    expect(coll.stopReasons).toEqual(['max_tokens'])
  })

  it('marks thinking-only streams without finishReason as max_tokens', async () => {
    mockGenerateContentStream.mockResolvedValue(
      makeStream([{ thought: 'internal reasoning only' }]),
    )

    const coll = makeCollector()
    await streamGemini(
      mkConfig(),
      mkParams({ alwaysThinking: true }),
      coll.calls,
      new AbortController().signal,
    )

    expect(coll.stopReasons).toEqual(['max_tokens'])
  })
})
