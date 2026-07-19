import { describe, it, expect, beforeEach } from 'vitest'
import {
  __resetTelemetryForTests,
  classifyProviderError,
  emitContextTelemetryEvent,
  emitProviderErrorTelemetryEvent,
  getRecentTelemetryEvents,
  summarizeRecentTelemetry,
} from './contextEvents'

describe('telemetry/contextEvents', () => {
  beforeEach(() => {
    __resetTelemetryForTests()
    // Route disk writes to a temp dir so tests don't accidentally write into
    // electron userData (which isn't available during vitest).
    process.env.ASTRA_TELEMETRY_DIR = process.env.RUNNER_TEMP || `${process.cwd()}/.vitest-telemetry`
  })

  describe('emitContextTelemetryEvent', () => {
    it('stores events in the ring with timestamps', () => {
      emitContextTelemetryEvent({
        action: 'micro_compact',
        level: 'micro_compact',
        estimatedTokensBefore: 80_000,
        estimatedTokensAfter: 30_000,
        reclaimed: 50_000,
        conversationId: 'conv-1',
      })
      const events = getRecentTelemetryEvents({ limit: 5 })
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        kind: 'context',
        action: 'micro_compact',
        reclaimed: 50_000,
        conversationId: 'conv-1',
      })
      expect(typeof events[0].ts).toBe('number')
    })

    it('returns most recent first', () => {
      emitContextTelemetryEvent({ action: 'soft_clear', level: 'error' })
      emitContextTelemetryEvent({ action: 'micro_compact', level: 'micro_compact' })
      emitContextTelemetryEvent({ action: 'auto_compact', level: 'auto_compact' })
      const events = getRecentTelemetryEvents({ limit: 2 })
      expect(events).toHaveLength(2)
      // Newest first — auto_compact was last, soft_clear was first.
      if (events[0].kind === 'context') expect(events[0].action).toBe('auto_compact')
      if (events[1].kind === 'context') expect(events[1].action).toBe('micro_compact')
    })
  })

  describe('emitProviderErrorTelemetryEvent + classification', () => {
    it('HTTP 401 → auth', () => {
      expect(classifyProviderError('invalid key', 401)).toBe('auth')
    })

    it('HTTP 429 → rate_limit', () => {
      expect(classifyProviderError('Too many requests', 429)).toBe('rate_limit')
    })

    it('HTTP 529 → overloaded (Anthropic-specific)', () => {
      expect(classifyProviderError('Overloaded', 529)).toBe('overloaded')
    })

    it('ECONNRESET → network', () => {
      expect(classifyProviderError('socket hang up: ECONNRESET')).toBe('network')
    })

    it('timeout → timeout', () => {
      expect(classifyProviderError('request timed out')).toBe('timeout')
    })

    it('context length message → context_length', () => {
      expect(classifyProviderError('prompt is too long')).toBe('context_length')
    })

    it('abort → abort', () => {
      expect(classifyProviderError('Request was aborted')).toBe('abort')
    })

    it('status from error object', () => {
      expect(classifyProviderError({ status: 500, message: 'server error' })).toBe('gateway_500')
    })

    it('unknown fallback', () => {
      expect(classifyProviderError('mystery')).toBe('unknown')
    })

    it('emits with wire + model + provider', () => {
      emitProviderErrorTelemetryEvent({
        providerId: 'zhipu',
        wire: 'anthropic-compat',
        model: 'glm-4.7',
        errorKind: 'rate_limit',
        message: '429 too many',
      })
      const ev = getRecentTelemetryEvents({ kind: 'provider_error' })[0]
      expect(ev).toBeDefined()
      if (ev?.kind === 'provider_error') {
        expect(ev.providerId).toBe('zhipu')
        expect(ev.wire).toBe('anthropic-compat')
        expect(ev.errorKind).toBe('rate_limit')
      }
    })
  })

  describe('summarizeRecentTelemetry', () => {
    it('counts by kind + action', () => {
      emitContextTelemetryEvent({ action: 'micro_compact', level: 'micro_compact' })
      emitContextTelemetryEvent({ action: 'micro_compact', level: 'micro_compact' })
      emitContextTelemetryEvent({ action: 'auto_compact', level: 'auto_compact' })
      emitProviderErrorTelemetryEvent({
        providerId: 'openai',
        errorKind: 'rate_limit',
        message: '429',
      })
      const s = summarizeRecentTelemetry()
      expect(s.total).toBe(4)
      expect(s.context.micro_compact).toBe(2)
      expect(s.context.auto_compact).toBe(1)
      expect(s.providerErrors.rate_limit).toBe(1)
    })

    it('respects sinceMs filter', () => {
      const past = Date.now() - 60_000
      emitContextTelemetryEvent({ action: 'micro_compact', level: 'micro_compact' })
      const s = summarizeRecentTelemetry(past)
      expect(s.total).toBe(1)
      const s2 = summarizeRecentTelemetry(Date.now() + 60_000)
      expect(s2.total).toBe(0)
    })
  })

  describe('ring buffer cap', () => {
    it('drops oldest when capacity exceeded', () => {
      // Push > 500 events (ring capacity).
      for (let i = 0; i < 600; i++) {
        emitContextTelemetryEvent({
          action: 'micro_compact',
          level: 'micro_compact',
          estimatedTokensBefore: i,
        })
      }
      const events = getRecentTelemetryEvents({ limit: 500 })
      expect(events).toHaveLength(500)
      // Oldest retained should be event 100 (first 100 evicted).
      const oldest = events[events.length - 1]
      if (oldest.kind === 'context') {
        expect(oldest.estimatedTokensBefore).toBe(100)
      }
    })
  })
})
