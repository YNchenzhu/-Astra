import {
  createTransformContext,
  detectStreamFormat,
  transformStreamEvent,
  type APIFormat,
} from './transformer'

type StreamEvent = Record<string, unknown>

type VirtualBlockKind = 'thinking' | 'text' | 'tool_use'

interface VirtualBlock {
  index: number
  kind: VirtualBlockKind
}

const CANONICAL_CLAUDE_EVENT_TYPES = new Set([
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
  'error',
])

function isRecord(value: unknown): value is StreamEvent {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return undefined
  return typeof value.text === 'string' ? value.text : undefined
}

function readReasoningText(value: StreamEvent): string | undefined {
  return (
    readString(value.reasoning_content) ??
    readString(value.reasoning) ??
    readString(value.thinking)
  )
}

function detectCompatStreamFormat(event: StreamEvent): APIFormat {
  if (Array.isArray(event.choices)) return 'openai'
  return detectStreamFormat(event)
}

function normalizeLooseClaudeDelta(event: StreamEvent): StreamEvent[] | null {
  if (event.type !== 'content_block_delta') return null
  const delta = isRecord(event.delta) ? event.delta : undefined
  if (!delta) return null

  const deltaType = typeof delta.type === 'string' ? delta.type : ''
  if (
    deltaType === 'thinking_delta' ||
    deltaType === 'signature_delta' ||
    deltaType === 'reasoning_summary_delta' ||
    deltaType === 'input_json_delta'
  ) {
    return [event]
  }

  const reasoning = readReasoningText(delta)
  const text =
    typeof delta.text === 'string'
      ? delta.text
      : typeof delta.content === 'string'
        ? delta.content
        : undefined
  if (!reasoning && !text) return [event]

  const normalized: StreamEvent[] = []
  if (reasoning) {
    normalized.push({
      ...event,
      delta: { type: 'thinking_delta', thinking: reasoning },
    })
  }
  if (text) {
    normalized.push({
      ...event,
      delta: { type: 'text_delta', text },
    })
  }
  return normalized
}

/**
 * Normalize loose third-party Anthropic streams into canonical Claude events.
 *
 * Gateways exposed behind an Anthropic base URL frequently respond with an
 * OpenAI Chat stream, omit `object`, or attach `reasoning_content` / `thinking`
 * to an otherwise Claude-shaped delta. This stateful adapter gives the shared
 * Anthropic consumer one event language and synthesizes block boundaries for
 * OpenAI-style streams so completed thinking reaches `onThinkingBlock` before
 * answer text begins.
 */
export class AnthropicCompatStreamNormalizer {
  private readonly transformContext = createTransformContext()
  private lockedFormat: APIFormat | null = null
  private nextVirtualIndex = 0
  private activeVirtualBlock: VirtualBlock | null = null

  normalize(rawEvent: StreamEvent): StreamEvent[] {
    const eventFormat = this.resolveFormat(rawEvent)
    let transformed = transformStreamEvent(rawEvent, eventFormat, this.transformContext)

    if (!transformed && eventFormat !== 'claude') {
      const redetected = detectCompatStreamFormat(rawEvent)
      if (redetected !== eventFormat) {
        transformed = transformStreamEvent(rawEvent, redetected, this.transformContext)
      }
    }

    const sourceEvents = Array.isArray(transformed)
      ? transformed.filter(isRecord)
      : isRecord(transformed)
        ? [transformed]
        : []
    const normalized: StreamEvent[] = []
    for (const event of sourceEvents) {
      const looseClaudeEvents = normalizeLooseClaudeDelta(event) ?? [event]
      for (const looseEvent of looseClaudeEvents) {
        normalized.push(...this.attachVirtualBlockBoundaries(looseEvent, eventFormat))
      }
    }
    return normalized
  }

  flush(): StreamEvent[] {
    return this.closeVirtualBlock()
  }

  private resolveFormat(event: StreamEvent): APIFormat {
    const detected = detectCompatStreamFormat(event)
    if (this.lockedFormat) {
      return detected !== 'claude' && detected !== this.lockedFormat
        ? detected
        : this.lockedFormat
    }
    if (detected !== 'claude' || CANONICAL_CLAUDE_EVENT_TYPES.has(String(event.type ?? ''))) {
      this.lockedFormat = detected
    }
    return detected
  }

  private attachVirtualBlockBoundaries(event: StreamEvent, sourceFormat: APIFormat): StreamEvent[] {
    if (sourceFormat === 'claude' || typeof event.index === 'number') {
      return [event]
    }

    if (event.type === 'content_block_start') {
      const block = isRecord(event.content_block) ? event.content_block : undefined
      const blockType = block?.type
      if (blockType === 'thinking' || blockType === 'text' || blockType === 'tool_use') {
        const kind = blockType as VirtualBlockKind
        const prefix = this.closeVirtualBlock()
        const active = this.openVirtualBlock(kind)
        return [...prefix, { ...event, index: active.index }]
      }
      return [event]
    }

    if (event.type === 'content_block_delta') {
      const delta = isRecord(event.delta) ? event.delta : undefined
      const deltaType = delta?.type
      const kind: VirtualBlockKind | null =
        deltaType === 'thinking_delta'
          ? 'thinking'
          : deltaType === 'text_delta' || deltaType === 'reasoning_summary_delta'
            ? 'text'
            : deltaType === 'input_json_delta'
              ? 'tool_use'
              : null
      if (!kind) return [event]
      const prefix = this.ensureVirtualBlock(kind)
      return [...prefix.events, { ...event, index: prefix.block.index }]
    }

    if (event.type === 'content_block_stop') {
      return this.closeVirtualBlock()
    }

    if (event.type === 'message_stop') {
      return [...this.closeVirtualBlock(), event]
    }

    return [event]
  }

  private ensureVirtualBlock(kind: VirtualBlockKind): { block: VirtualBlock; events: StreamEvent[] } {
    if (this.activeVirtualBlock?.kind === kind) {
      return { block: this.activeVirtualBlock, events: [] }
    }
    const events = this.closeVirtualBlock()
    const block = this.openVirtualBlock(kind)
    const contentBlock: StreamEvent =
      kind === 'thinking'
        ? { type: 'thinking', thinking: '' }
        : kind === 'text'
          ? { type: 'text', text: '' }
          : { type: 'tool_use', id: '', name: '', input: {} }
    events.push({
      type: 'content_block_start',
      index: block.index,
      content_block: contentBlock,
    })
    return { block, events }
  }

  private openVirtualBlock(kind: VirtualBlockKind): VirtualBlock {
    const block = { index: this.nextVirtualIndex++, kind }
    this.activeVirtualBlock = block
    return block
  }

  private closeVirtualBlock(): StreamEvent[] {
    if (!this.activeVirtualBlock) return []
    const event: StreamEvent = {
      type: 'content_block_stop',
      index: this.activeVirtualBlock.index,
    }
    this.activeVirtualBlock = null
    return [event]
  }
}
