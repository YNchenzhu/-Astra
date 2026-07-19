import { createHash } from 'node:crypto'
import { estimateMessageTokens, estimateTextTokens } from './tokenCounter'
import { getTokenCountFromUsage } from './tokenUsageAccounting'
import type { SystemPromptLayers } from '../ai/systemPrompt'

export interface PromptDiagnosticsPayloadSummary {
  systemPromptTokens: number
  systemContextTokens: number
  userContextTokens: number
  userMetaTokens: number
  toolSchemaTokens: number
  messageTokens: number
  messageCount: number
  hashes: {
    systemPrompt: string
    systemContext?: string
    userContext?: string
    userMeta?: string
  }
  cacheControl: {
    systemContext: boolean
    messageLevel: boolean
  }
}

export interface PromptDiagnosticsTiming {
  startedAt: number
  firstResponseAt?: number
  endedAt?: number
  ttfbMs?: number
  totalMs?: number
}

export interface PromptDiagnosticsRecord {
  requestId: string
  conversationId?: string
  agentId?: string
  providerId: string
  model: string
  iteration: number
  status: 'running' | 'success' | 'error'
  payload: PromptDiagnosticsPayloadSummary
  thinking: {
    effort?: string
    alwaysThinking: boolean
    thinkingBudgetTokens?: number
  }
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
    totalInputWithCache: number
  }
  timing: PromptDiagnosticsTiming
  diagnosis: string[]
  error?: string
}

/**
 * Per-conversation ring buffer cap. Picking 20 keeps any one chat's
 * diagnostics deep enough to spot patterns across a working session
 * while a busy parallel chat cannot evict another chat's history.
 *
 * Records without a conversation id (e.g. one-off renderer pings before
 * an agent context is wired) bucket under {@link GLOBAL_BUCKET_KEY}.
 */
const MAX_RECORDS_PER_BUCKET = 20
const GLOBAL_BUCKET_KEY = '__global__'
/** Absolute ceiling across all buckets — protects against unbounded conversation churn. */
const MAX_BUCKETS = 32

const buckets = new Map<string, PromptDiagnosticsRecord[]>()
let nextSeq = 1

function bucketKey(conversationId: string | undefined): string {
  const k = conversationId?.trim()
  return k ? k : GLOBAL_BUCKET_KEY
}

function getBucket(key: string): PromptDiagnosticsRecord[] {
  let bucket = buckets.get(key)
  if (!bucket) {
    bucket = []
    buckets.set(key, bucket)
    while (buckets.size > MAX_BUCKETS) {
      const oldest = buckets.keys().next().value
      if (oldest === undefined || oldest === key) break
      buckets.delete(oldest)
    }
  }
  return bucket
}

function findRecord(requestId: string): PromptDiagnosticsRecord | undefined {
  for (const bucket of buckets.values()) {
    const hit = bucket.find((r) => r.requestId === requestId)
    if (hit) return hit
  }
  return undefined
}

function hashText(text: string): string {
  if (!text) return ''
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

function textOfFirstUserMeta(messages: Array<Record<string, unknown>>): string {
  const first = messages[0]
  if (!first || first._convertedFromSystem !== true) return ''
  return typeof first.content === 'string' ? first.content : JSON.stringify(first.content ?? '')
}

function computeDiagnosis(record: PromptDiagnosticsRecord): string[] {
  const out: string[] = []
  const usage = record.usage
  if (record.thinking.effort === 'high' || record.thinking.effort === 'max') {
    out.push(`reasoning effort is ${record.thinking.effort}`)
  }
  if (record.thinking.alwaysThinking) {
    out.push('extended thinking is forced on')
  }
  if (record.timing.ttfbMs != null && record.timing.ttfbMs > 20_000) {
    out.push(`slow first token (${Math.round(record.timing.ttfbMs / 1000)}s)`)
  }
  if (usage) {
    const totalInput = Math.max(1, usage.totalInputWithCache)
    const cacheHitRate = usage.cacheReadInputTokens / totalInput
    if (usage.cacheReadInputTokens === 0 && record.payload.systemPromptTokens > 8_000) {
      out.push('large prompt with no cache read')
    } else if (cacheHitRate < 0.25 && totalInput > 8_000) {
      out.push(`low prompt-cache hit rate (${Math.round(cacheHitRate * 100)}%)`)
    }
    if (usage.cacheCreationInputTokens > 8_000) {
      out.push(`large cache write (${usage.cacheCreationInputTokens} tokens)`)
    }
  }
  if (record.payload.userMetaTokens > 6_000) {
    out.push(`large user-meta context (${record.payload.userMetaTokens} tokens)`)
  }
  if (record.payload.toolSchemaTokens > 6_000) {
    out.push(`large tool schema payload (${record.payload.toolSchemaTokens} tokens)`)
  }
  return out.length > 0 ? out : ['no obvious prompt-side bottleneck']
}

function upsert(record: PromptDiagnosticsRecord): void {
  const bucket = getBucket(bucketKey(record.conversationId))
  const idx = bucket.findIndex((r) => r.requestId === record.requestId)
  if (idx >= 0) bucket[idx] = record
  else bucket.push(record)
  while (bucket.length > MAX_RECORDS_PER_BUCKET) bucket.shift()
}

export function startPromptDiagnostics(input: {
  conversationId?: string
  agentId?: string
  providerId: string
  model: string
  iteration: number
  systemPrompt: string
  systemPromptLayers?: SystemPromptLayers
  apiMessages: Array<Record<string, unknown>>
  toolTokens: number
  effort?: string
  alwaysThinking?: boolean
  thinkingBudgetTokens?: number
  messageLevelCacheControl?: boolean
  systemContextCacheControl?: boolean
  now?: number
}): string {
  const requestId = `diag-${Date.now().toString(36)}-${nextSeq++}`
  const userMeta = textOfFirstUserMeta(input.apiMessages)
  const startedAt = input.now ?? Date.now()
  const record: PromptDiagnosticsRecord = {
    requestId,
    conversationId: input.conversationId,
    agentId: input.agentId,
    providerId: input.providerId,
    model: input.model,
    iteration: input.iteration,
    status: 'running',
    payload: {
      systemPromptTokens: estimateTextTokens(input.systemPrompt),
      systemContextTokens: estimateTextTokens(input.systemPromptLayers?.systemContext ?? ''),
      userContextTokens: estimateTextTokens(input.systemPromptLayers?.userContext ?? ''),
      userMetaTokens: userMeta ? estimateTextTokens(userMeta) : 0,
      toolSchemaTokens: Math.max(0, Math.ceil(input.toolTokens)),
      messageTokens: input.apiMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0),
      messageCount: input.apiMessages.length,
      hashes: {
        systemPrompt: hashText(input.systemPrompt),
        ...(input.systemPromptLayers?.systemContext
          ? { systemContext: hashText(input.systemPromptLayers.systemContext) }
          : {}),
        ...(input.systemPromptLayers?.userContext
          ? { userContext: hashText(input.systemPromptLayers.userContext) }
          : {}),
        ...(userMeta ? { userMeta: hashText(userMeta) } : {}),
      },
      cacheControl: {
        systemContext: input.systemContextCacheControl === true,
        messageLevel: input.messageLevelCacheControl === true,
      },
    },
    thinking: {
      effort: input.effort,
      alwaysThinking: input.alwaysThinking === true,
      thinkingBudgetTokens: input.thinkingBudgetTokens,
    },
    timing: { startedAt },
    diagnosis: [],
  }
  record.diagnosis = computeDiagnosis(record)
  upsert(record)
  return requestId
}

export function markPromptDiagnosticsFirstResponse(requestId: string, now = Date.now()): void {
  const record = findRecord(requestId)
  if (!record || record.timing.firstResponseAt != null) return
  record.timing.firstResponseAt = now
  record.timing.ttfbMs = Math.max(0, now - record.timing.startedAt)
  record.diagnosis = computeDiagnosis(record)
  upsert(record)
}

export function finishPromptDiagnostics(
  requestId: string,
  usage: Record<string, unknown> | undefined,
  now = Date.now(),
): void {
  const record = findRecord(requestId)
  if (!record) return
  record.status = 'success'
  record.timing.endedAt = now
  record.timing.totalMs = Math.max(0, now - record.timing.startedAt)
  if (usage) {
    const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
    const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
    const cacheCreationInputTokens =
      typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0
    const cacheReadInputTokens =
      typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0
    record.usage = {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      totalInputWithCache: getTokenCountFromUsage(usage),
    }
  }
  record.diagnosis = computeDiagnosis(record)
  upsert(record)
}

export function failPromptDiagnostics(requestId: string, error: unknown, now = Date.now()): void {
  const record = findRecord(requestId)
  if (!record) return
  record.status = 'error'
  record.error = error instanceof Error ? error.message : String(error)
  record.timing.endedAt = now
  record.timing.totalMs = Math.max(0, now - record.timing.startedAt)
  record.diagnosis = computeDiagnosis(record)
  upsert(record)
}

/**
 * Returns the most recent diagnostics records.
 *
 * @param limit - max records to return (capped per-bucket size).
 * @param conversationId - when provided, restrict to that conversation's
 *   bucket; otherwise the global bucket plus every conversation bucket is
 *   flattened and re-sorted by `startedAt` desc.
 */
export function getPromptDiagnosticsRecords(
  limit = MAX_RECORDS_PER_BUCKET,
  conversationId?: string,
): PromptDiagnosticsRecord[] {
  const n = Number.isFinite(limit)
    ? Math.max(1, Math.min(MAX_RECORDS_PER_BUCKET * MAX_BUCKETS, Math.floor(limit)))
    : MAX_RECORDS_PER_BUCKET

  if (conversationId !== undefined) {
    const bucket = buckets.get(bucketKey(conversationId)) ?? []
    return bucket
      .slice(-n)
      .reverse()
      .map((r) => structuredClone(r))
  }

  const flat: PromptDiagnosticsRecord[] = []
  for (const bucket of buckets.values()) {
    flat.push(...bucket)
  }
  flat.sort((a, b) => b.timing.startedAt - a.timing.startedAt)
  return flat.slice(0, n).map((r) => structuredClone(r))
}

/**
 * @internal Test-only seam. Production code MUST NOT call this — it
 * wipes the diagnostics ring buffer. Named with the `__` prefix so a
 * grep for production callers immediately flags any accidental import.
 */
export function __resetPromptDiagnosticsForTests(): void {
  buckets.clear()
  nextSeq = 1
}
