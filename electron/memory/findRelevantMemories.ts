/**
 * AI-based memory relevance selection — adapted from upstream §2.6.
 *
 * Uses a sideQuery LLM call (lightweight model) to pick the most relevant
 * memories from the full manifest, returning at most {@link MAX_RELEVANT} items.
 * Falls back to keyword scoring when the LLM call fails or is disabled.
 */

import type { MemoryEntry } from './types'
import { recallMemories } from './recall'
import { RECALL_FINAL_TOP_K } from './recallPipeline'
import { streamText, applyProviderDefaults, type ProviderConfig, type ProviderId } from '../ai/client'
import { SIDE_QUERY_ALWAYS_THINKING } from '../ai/sideQueryThinkingPolicy'
import { stripInlineThinkingXml } from '../ai/stripInlineThinkingXml'
import { resolveAiCredentialsFromDisk } from '../ai/diskCredentials'
import { readDiskSettings } from '../settings/settingsAccess'
import type { SharedQueryEmbedding } from '../embedding/sharedQueryVector'

/**
 * Per-turn surfaced cap — single source of truth shared with the hybrid
 * pipeline ({@link RECALL_FINAL_TOP_K}). Audit M2: previously a local `5`
 * that was unreachable because `hybridRecall` truncated its output to 3
 * before this module ever saw it, and inconsistent with the non-AI
 * `recallForPrompt` path. Aligning both to the same constant removes the
 * dead value and keeps the surfaced count invariant across entry points.
 */
const MAX_RELEVANT = RECALL_FINAL_TOP_K

/**
 * Candidate pool size handed to the LLM re-selector. Wider than
 * {@link MAX_RELEVANT} on purpose: the selector must choose FROM a real
 * shortlist, not from the already-truncated surfaced top-N (audit M2). Kept
 * under the pipeline's internal `CAND_POOL_SIZE` (30) so we never ask for
 * more than RRF produced.
 */
const SELECTOR_CANDIDATE_POOL = 12

export interface RelevantMemory {
  filename: string
  mtimeMs: number
}

/**
 * Per-call surfaced set (upstream pattern: scan the current conversation's
 * messages for `relevant_memories` attachment paths).
 *
 * The old module-level `alreadySurfaced` Set was a global that leaked across
 * conversations — switching workspaces or compacting wouldn't reliably clear it,
 * causing valid memories to be silently suppressed. Now the caller passes the
 * set explicitly, derived from the current API messages.
 */

export function buildAlreadySurfacedSet(
  apiMessages: Array<Record<string, unknown>>,
): Set<string> {
  const surfaced = new Set<string>()
  for (const msg of apiMessages) {
    const content = msg.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as Record<string, unknown>).type === 'relevant_memories'
      ) {
        const memories = (block as Record<string, unknown>).memories
        if (Array.isArray(memories)) {
          for (const mem of memories) {
            if (typeof mem === 'object' && mem !== null && 'filename' in mem) {
              surfaced.add(String((mem as Record<string, unknown>).filename))
            }
          }
        }
      }
    }
  }
  return surfaced
}

/** @deprecated Use `buildAlreadySurfacedSet` instead. Kept for backward-compat callers. */
export function resetSurfacedMemories(): void {
  // No-op — the global set is no longer used by the primary path.
}

/** @deprecated Use `buildAlreadySurfacedSet` instead. */
export function markMemorySurfaced(_filename: string): void {
  // No-op — the global set is no longer used by the primary path.
}

function formatMemoryManifest(memories: MemoryEntry[]): string {
  return memories
    .map((m) => {
      const tag = `[${m.frontmatter.type}]`
      const updated = m.frontmatter.updated
      return m.frontmatter.description
        ? `- ${tag} ${m.filename} (${updated}): ${m.frontmatter.description}`
        : `- ${tag} ${m.filename} (${updated})`
    })
    .join('\n')
}

/**
 * True when a provider error indicates `tool_choice: required` / object form
 * was rejected because the gateway has thinking-mode enabled for this model.
 *
 * Observed wordings (ordered by how common we've seen them in the wild):
 *   - Zhipu GLM / DeepSeek thinking: `"tool_choice parameter does not support
 *     being set to required or object in thinking mode"`
 *   - Anthropic-compat proxies: `"tool_choice object not supported with
 *     thinking"`
 *
 * We match on both the "tool_choice" + "thinking" tokens so minor phrasing
 * drift doesn't regress the fallback.
 */
function isThinkingModeToolChoiceError(err: string | undefined): boolean {
  if (!err) return false
  const m = err.toLowerCase()
  return m.includes('tool_choice') && m.includes('thinking')
}

/** Single attempt of the side-query with the given `toolChoice` flavour. */
async function runSideQueryAttempt(params: {
  config: ProviderConfig
  model: string
  systemPrompt: string
  userMessage: string
  toolChoice: 'auto' | undefined
}): Promise<{
  err: string | undefined
  selectedFromTool: string[] | null
  accText: string
}> {
  let acc = ''
  let err: string | undefined
  let selectedFromTool: string[] | null = null
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 30_000)
  try {
    await streamText(
      params.config,
      {
        model: params.model,
        messages: [{ role: 'user', content: params.userMessage }],
        systemPrompt: params.systemPrompt,
        maxTokens: 256,
        alwaysThinking: SIDE_QUERY_ALWAYS_THINKING,
        tools: [
          {
            name: 'select_relevant_memories',
            description:
              'Return the most relevant memory filenames in structured JSON.',
            input_schema: {
              type: 'object',
              properties: {
                selected_filenames: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
              required: ['selected_filenames'],
              additionalProperties: false,
            },
          },
        ],
        // Never pass the object form of `tool_choice` here: thinking-mode
        // models on several gateways (Zhipu GLM, DeepSeek thinking, some
        // Anthropic-compat proxies) reject it. `'auto'` is the widest
        // compatible form; when even that fails we retry with no toolChoice.
        ...(params.toolChoice ? { toolChoice: params.toolChoice } : {}),
      },
      {
        onTextDelta: (text) => { acc += text },
        onMessageEnd: () => {},
        onError: (e) => { err = e },
        onToolUse: (toolUse) => {
          if (toolUse.name !== 'select_relevant_memories') return
          const raw = toolUse.input?.selected_filenames
          if (Array.isArray(raw)) {
            selectedFromTool = raw.filter(
              (v): v is string => typeof v === 'string' && v.trim().length > 0,
            )
          }
        },
      },
      ac.signal,
    )
  } finally {
    clearTimeout(timer)
  }
  return { err, selectedFromTool, accText: acc }
}

async function sideQueryLLM(
  config: ProviderConfig,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string[]> {
  // Attempt 1 — `toolChoice: 'auto'`. This is what every provider accepts
  // and what the overwhelming majority of models honor when a single tool is
  // registered alongside a clear system prompt instructing to call it.
  let attempt = await runSideQueryAttempt({
    config,
    model,
    systemPrompt,
    userMessage,
    toolChoice: 'auto',
  })

  // Attempt 2 — some thinking-mode gateways reject EVEN `'auto'` when tools
  // are present. Retry without any toolChoice field at all; the parsed
  // free-text fallback (`parseFilenameResponse`) picks up the response in
  // that path.
  if (attempt.err && isThinkingModeToolChoiceError(attempt.err)) {
    console.warn(
      '[memory.sideQueryLLM] retrying without tool_choice: thinking-mode gateway rejected it —',
      attempt.err,
    )
    attempt = await runSideQueryAttempt({
      config,
      model,
      systemPrompt,
      userMessage,
      toolChoice: undefined,
    })
  }

  if (attempt.err) throw new Error(attempt.err)
  if (attempt.selectedFromTool) return attempt.selectedFromTool
  return parseFilenameResponse(attempt.accText)
}

function resolveProviderConfig(): { config: ProviderConfig; model: string } | null {
  const s = readDiskSettings()
  const creds = resolveAiCredentialsFromDisk(s)
  try {
    const config = applyProviderDefaults({
      id: creds.providerId as ProviderId,
      name: creds.providerId,
      apiKey: creds.apiKey,
      baseUrl: creds.baseUrl || undefined,
      awsRegion: creds.awsRegion || undefined,
      projectId: creds.projectId || undefined,
    })
    const model =
      typeof creds.model === 'string' && creds.model.trim()
        ? creds.model.trim()
        : 'claude-sonnet-4-20250514'
    return { config, model }
  } catch {
    return null
  }
}

/**
 * AI-based relevance selection: present the memory manifest to a lightweight
 * model and ask it to pick the most relevant files for the user's query.
 *
 * Returns the filenames selected by the model (max {@link MAX_RELEVANT}).
 * Falls back to keyword recall when:
 *  - LLM credentials are unavailable
 *  - AI recall is disabled in settings
 *  - The LLM call fails
 */
export async function findRelevantMemories(
  query: string,
  allMemories: MemoryEntry[],
  alreadySurfaced: ReadonlySet<string> = new Set(),
  opts: {
    shared?: SharedQueryEmbedding
    /** Cosine floor passed to hybridRecall. Default 0 (legacy). */
    minScore?: number
  } = {},
): Promise<MemoryEntry[]> {
  if (!query.trim() || allMemories.length === 0) return []

  const eligible = allMemories.filter(
    (m) => m.frontmatter.enabled !== false && !alreadySurfaced.has(m.filename),
  )
  if (eligible.length === 0) return []

  const settings = readDiskSettings()
  const useAiRecall = settings.memoryAiRecallEnabled !== false

  // Hybrid recall pipeline (BM25 + vector + freshness + structured, fused by
  // RRF, optionally reranked). This is the new primary path — it degrades
  // gracefully through its layers, so it does the right thing whether the
  // user has configured embedding + rerank, just embedding, or nothing at all.
  //
  // We keep `useAiRecall` as an after-the-fact *re-selector*: if the user
  // still wants the LLM's judgement on top of retrieval results, we pass the
  // fused top-N to it below instead of ranking the full manifest.
  let hybridEntries: MemoryEntry[] = []
  try {
    const { hybridRecall } = await import('./recallPipeline')
    // Request a WIDER pool than the surfaced cap so the LLM re-selector below
    // has a real shortlist to choose from (audit M2). The non-AI path slices
    // back to MAX_RELEVANT before returning, so the surfaced count is
    // unchanged regardless of which path we take.
    const r = await hybridRecall(query, eligible, {
      shared: opts.shared,
      minScore: opts.minScore,
      topK: useAiRecall ? SELECTOR_CANDIDATE_POOL : MAX_RELEVANT,
    })
    hybridEntries = r.entries
  } catch {
    // Fall through to legacy behaviour below.
  }

  if (!useAiRecall) {
    // LLM selector off → return the pipeline's final top-N directly. If the
    // pipeline itself degraded all the way (e.g. brand-new install with no
    // embedding, no reranker, no settings), `hybridEntries` will already be
    // the legacy keyword/BM25 result.
    if (hybridEntries.length > 0) return hybridEntries.slice(0, MAX_RELEVANT)
    return keywordFallback(query, eligible)
  }

  const provider = resolveProviderConfig()
  if (!provider) {
    return keywordFallback(query, eligible)
  }

  try {
    // Narrow the manifest to the hybrid top candidates (when available) so
    // the LLM selector is fast and cheap. Fall back to the full manifest only
    // when the pipeline itself returned nothing.
    const manifestPool = hybridEntries.length > 0 ? hybridEntries : eligible
    const manifest = formatMemoryManifest(manifestPool)
    const systemPrompt = [
      'You are a memory relevance selector. Given a user query and a manifest of memory files,',
      `select up to ${MAX_RELEVANT} files most relevant to the query.`,
      '',
      'Respond by calling the `select_relevant_memories` tool.',
      'Put the selected filenames in `selected_filenames`.',
      'If none are relevant, call the tool with an empty array.',
    ].join('\n')

    const userMsg = [
      `User query: ${query}`,
      '',
      'Memory manifest:',
      manifest,
    ].join('\n')

    const parsed = await sideQueryLLM(provider.config, provider.model, systemPrompt, userMsg)
    if (parsed.length === 0) {
      // LLM couldn't pick — trust the hybrid pipeline if we have it.
      if (hybridEntries.length > 0) return hybridEntries.slice(0, MAX_RELEVANT)
      return keywordFallback(query, eligible)
    }

    const selected = parsed
      .map((fname) => manifestPool.find((m) => m.filename === fname))
      .filter((m): m is MemoryEntry => m !== undefined)
      .slice(0, MAX_RELEVANT)

    if (selected.length === 0) {
      if (hybridEntries.length > 0) return hybridEntries.slice(0, MAX_RELEVANT)
      return keywordFallback(query, eligible)
    }

    return selected
  } catch (e) {
    console.warn('[findRelevantMemories] AI selection failed:', e)
    if (hybridEntries.length > 0) return hybridEntries.slice(0, MAX_RELEVANT)
    return keywordFallback(query, eligible)
  }
}

function keywordFallback(query: string, memories: MemoryEntry[]): MemoryEntry[] {
  return recallMemories(query, memories, MAX_RELEVANT)
}

function parseFilenameResponse(raw: string): string[] {
  // 3P thinking gateways (DeepSeek-R1, Zhipu GLM) sometimes encode chain-of-thought
  // as inline <thinking>/<think> XML in the free-text channel. Strip those first
  // so the JSON-array extractor below isn't poisoned by filenames mentioned inside
  // reasoning. See electron/ai/stripInlineThinkingXml.ts for details.
  let text = stripInlineThinkingXml(raw).trim()
  const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (codeBlock) text = codeBlock[1].trim()

  const startIdx = text.indexOf('[')
  const endIdx = text.lastIndexOf(']')
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return []

  try {
    const arr = JSON.parse(text.slice(startIdx, endIdx + 1))
    if (!Array.isArray(arr)) return []
    return arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
  } catch {
    return []
  }
}
