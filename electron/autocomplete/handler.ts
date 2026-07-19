/**
 * Tab auto-completion handler for Electron main process.
 *
 * Implements a lightweight FIM (Fill-in-the-Middle) completion pipeline:
 *   1. Collect cursor context (prefix / suffix from current file)
 *   2. Build a FIM prompt
 *   3. Call a fast model via the unified AI client (non-streaming, low maxTokens)
 *   4. Return the completion text
 */

import { streamText, type ProviderConfig, type ProviderId } from '../ai/client'
import { SIDE_QUERY_ALWAYS_THINKING } from '../ai/sideQueryThinkingPolicy'
import { resolveAiCredentialsFromDisk } from '../ai/diskCredentials'

// ---------- Types ----------

export interface CompletionRequest {
  /** Text before cursor (prefix) */
  prefix: string
  /** Text after cursor (suffix) */
  suffix: string
  /** File language for language-aware prompting */
  language?: string
  /** File path relative to workspace (for context) */
  filePath?: string
  /** Additional context from recently edited files */
  recentSnippets?: Array<{ path: string; content: string }>
}

export interface CompletionResponse {
  completion: string
  /** Latency in ms (for telemetry) */
  latencyMs: number
}

// ---------- FIM Prompt Builder ----------

/**
 * Build a FIM-style prompt. Works with most providers that support code completion.
 * Format: <PRE>prefix<SUF>suffix<MID>
 */
function buildFimPrompt(request: CompletionRequest): string {
  const { prefix, suffix, language, filePath, recentSnippets } = request

  let contextBlock = ''

  // Add recent file snippets as extra context (P2 priority, limited budget)
  if (recentSnippets && recentSnippets.length > 0) {
    const snippetLines = recentSnippets
      .slice(0, 2) // Max 2 snippets to stay within budget
      .map((s) => `// From ${s.path}:\n${s.content.slice(-200)}`)
      .join('\n\n')
    contextBlock = `${snippetLines}\n\n`
  }

  const langHint = language ? `Language: ${language}\n` : ''
  const pathHint = filePath ? `File: ${filePath}\n` : ''

  // Use the standard FIM format understood by most models
  return `${langHint}${pathHint}Complete the code at the cursor position. Only output the completion, nothing else.\n\n${contextBlock}<PRE>${prefix}<SUF>${suffix}<MID>`
}

/**
 * Alternative: For OpenAI-compatible models, use a simpler chat-style prompt.
 */
function buildChatFimPrompt(request: CompletionRequest): string {
  const { prefix, suffix, language } = request

  const lastLines = prefix.split('\n').slice(-15).join('\n')
  const nextLines = suffix.split('\n').slice(0, 10).join('\n')

  return `You are a code completion assistant. Complete the code at the cursor position (marked by <|CURSOR|>). Output ONLY the code to insert, no explanation, no markdown fences.

${language ? `Language: ${language}` : ''}

\`\`\`
${lastLines}<|CURSOR|>
${nextLines}
\`\`\`

Output only the code that should replace <|CURSOR|>:`
}

// ---------- Completion Cache ----------

const completionCache = new Map<string, { completion: string; timestamp: number }>()
const CACHE_TTL = 30_000 // 30 seconds
const MAX_CACHE_SIZE = 100

function getCacheKey(request: CompletionRequest): string {
  const prefixKey = request.prefix.slice(-200)
  const suffixKey = request.suffix.slice(0, 100)
  return `${request.filePath || ''}||${prefixKey}||${suffixKey}||${request.language || ''}`
}

function getCached(key: string): string | null {
  const entry = completionCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    completionCache.delete(key)
    return null
  }
  return entry.completion
}

function setCache(key: string, completion: string): void {
  // Evict old entries if cache is too large
  if (completionCache.size >= MAX_CACHE_SIZE) {
    const oldest = [...completionCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)
    for (let i = 0; i < 10; i++) {
      completionCache.delete(oldest[i][0])
    }
  }
  completionCache.set(key, { completion, timestamp: Date.now() })
}

// ---------- Active Abort Controller ----------

let activeAbortController: AbortController | null = null

// ---------- Main Handler ----------

export async function handleTabCompletion(
  request: CompletionRequest,
  settings: Record<string, unknown>
): Promise<CompletionResponse> {
  const startTime = Date.now()

  // Cancel any in-flight completion
  if (activeAbortController) {
    activeAbortController.abort()
  }

  // Bail out if the feature is disabled in settings
  if (settings.tabAutocompleteEnabled === false) {
    return { completion: '', latencyMs: 0 }
  }

  // Check cache first
  const cacheKey = getCacheKey(request)
  const cached = getCached(cacheKey)
  if (cached) {
    return { completion: cached, latencyMs: Date.now() - startTime }
  }

  const disk = resolveAiCredentialsFromDisk(settings)

  if (!disk.apiKey) {
    return { completion: '', latencyMs: 0 }
  }

  const providerId = disk.providerId as ProviderId
  const baseUrl = disk.baseUrl
  const awsRegion = disk.awsRegion
  const projectId = disk.projectId

  const completionModel = getCompletionModel(providerId, disk.model || undefined)

  const config: ProviderConfig = {
    id: providerId,
    name: providerId,
    apiKey: disk.apiKey,
    baseUrl,
    awsRegion,
    projectId,
  }

  // Build the prompt — use chat-style for OpenAI, FIM for others
  const useChatPrompt = providerId === 'openai'
  const prompt = useChatPrompt ? buildChatFimPrompt(request) : buildFimPrompt(request)

  const abortController = new AbortController()
  activeAbortController = abortController

  try {
    let completionText = ''

    await streamText(
      config,
      {
        model: completionModel,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 256, // Keep completions short
        systemPrompt: 'You are a code completion engine. Output only code, no explanation.',
        alwaysThinking: SIDE_QUERY_ALWAYS_THINKING,
      },
      {
        onTextDelta: (text) => {
          completionText += text
        },
        onMessageEnd: () => {
          // Stream completed
        },
        onError: (error) => {
          console.warn('[TabCompletion] Error:', error)
        },
      },
      abortController.signal
    )

    // Clean up FIM artifacts from the response
    completionText = cleanCompletion(completionText, request)

    // Cache the result
    if (completionText) {
      setCache(cacheKey, completionText)
    }

    return { completion: completionText, latencyMs: Date.now() - startTime }
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      return { completion: '', latencyMs: 0 }
    }
    console.warn('[TabCompletion] Failed:', error)
    return { completion: '', latencyMs: Date.now() - startTime }
  } finally {
    if (activeAbortController === abortController) {
      activeAbortController = null
    }
  }
}

/**
 * Cancel any in-flight completion request.
 */
export function cancelTabCompletion(): void {
  if (activeAbortController) {
    activeAbortController.abort()
    activeAbortController = null
  }
}

// ---------- Helpers ----------

/**
 * Select a fast model suitable for tab completion.
 * Falls back to the configured model if no lighter option is available.
 */
function getCompletionModel(providerId: ProviderId, configuredModel?: string): string {
  // For tab completion, prefer haiku/mini models for speed.
  // When the user has not configured the fast model (or it is unavailable),
  // fall back to whatever model they actually set — otherwise we may hit
  // a 400 for an unprovisioned account (e.g. haiku on a Sonnet-only plan).
  const fallback = configuredModel || 'gpt-4o-mini'

  switch (providerId) {
    case 'anthropic':
    case 'bedrock':
    case 'vertex':
    case 'foundry': {
      // Only use haiku if the user hasn't overridden the model or explicitly
      // set it to haiku. Otherwise they likely don't have it provisioned.
      const haikuForProvider = providerId === 'bedrock'
        ? 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
        : providerId === 'vertex'
          ? 'claude-haiku-4-5@20251001'
          : 'claude-haiku-4-5-20251001'
      if (!configuredModel || configuredModel === haikuForProvider) return haikuForProvider
      return fallback
    }
    case 'openai':
      return configuredModel === 'gpt-4o-mini' || !configuredModel ? 'gpt-4o-mini' : fallback
    case 'gemini':
      return configuredModel === 'gemini-2.5-flash-lite' || !configuredModel ? 'gemini-2.5-flash-lite' : fallback
    case 'minimax':
      return configuredModel === 'MiniMax-M2.1-highspeed' || !configuredModel ? 'MiniMax-M2.1-highspeed' : fallback
    case 'zhipu':
      return configuredModel === 'glm-4.5-flash' || !configuredModel ? 'glm-4.5-flash' : fallback
    case 'kimi':
      return configuredModel === 'kimi-k2-turbo-preview' || !configuredModel ? 'kimi-k2-turbo-preview' : fallback
    case 'deepseek':
      if (!configuredModel) return 'deepseek-v4-flash'
      if (
        configuredModel === 'deepseek-v4-flash' ||
        configuredModel === 'deepseek-v4-pro' ||
        configuredModel === 'deepseek-chat'
      ) {
        return configuredModel
      }
      return fallback
    default:
      return fallback
  }
}

/**
 * Clean up the raw completion text:
 * - Remove markdown code fences
 * - Remove leading/trailing whitespace artifacts
 * - Trim to a reasonable single-statement completion
 */
function cleanCompletion(raw: string, request: CompletionRequest): string {
  let text = raw.trim()

  // Remove markdown code fences if the model wrapped them
  if (text.startsWith('```')) {
    text = text.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '')
  }

  // Remove <MID> artifacts from FIM response
  text = text.replace(/<MID>/g, '')

  // If the completion starts with the same content as the end of prefix,
  // trim the duplicated part
  const lastPrefixLine = request.prefix.split('\n').pop() || ''
  if (lastPrefixLine && text.startsWith(lastPrefixLine)) {
    text = text.slice(lastPrefixLine.length)
  }

  // Don't return very long completions for tab — cap at reasonable length
  const lines = text.split('\n')
  if (lines.length > 5) {
    text = lines.slice(0, 5).join('\n')
  }

  return text.trim()
}
