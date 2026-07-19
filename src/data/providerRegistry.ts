/**
 * Single source of truth for provider metadata.
 *
 * Replaces the scattered hard-coded tables in:
 *   - `electron/ai/client.ts` (PROVIDERS, getModelsForProvider, applyProviderDefaults)
 *   - `src/stores/settings/providers.ts` (PROVIDERS, MODELS_BY_PROVIDER, PROTOCOL_HINTS)
 *   - `src/utils/resolveProviderBaseUrl.ts` (getBuiltinDefaultBaseUrl)
 *
 * Adding a new Anthropic-compatible gateway now only requires appending one
 * entry to `PROVIDER_ENTRIES` — no more duplicate switch/if blocks across
 * three files.
 */

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'openai2'
  | 'gemini'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'compatible'
  | 'dashscope'
  | 'minimax'
  | 'zhipu'
  | 'kimi'
  | 'deepseek'

export interface ProviderRegistryEntry {
  id: ProviderId
  name: string
  defaultModel: string
  /** Built-in base URL (empty string when user must supply one, e.g. `compatible`). */
  baseUrl: string
  /** Shown in Settings dialog as a protocol hint. */
  protocolHint: string
  models: Array<{
    id: string
    name: string
    /**
     * Authoritative context-window size (input tokens) for this exact model id.
     *
     * Pushed to the main process via `context:set-registry-windows` at boot
     * and consulted by `getModelContextWindowTokens` BEFORE the regex
     * fallback. When unknown / unverified, default to **256_000** — most
     * modern non-Claude SKUs are at least 256K, and users can override per
     * model in Settings → 上下文 → 模型窗口覆盖.
     *
     * Adding a new model = drop the id here with the right number; no regex
     * maintenance required.
     */
    contextWindow?: number
  }>
}

export const PROVIDER_ENTRIES: ProviderRegistryEntry[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    defaultModel: 'claude-sonnet-4-20250514',
    baseUrl: 'https://api.anthropic.com',
    protocolHint: 'SDK appends /v1/messages to your Base URL',
    models: [
      // Claude family — 200K (Anthropic docs)
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', contextWindow: 200_000 },
      { id: 'claude-opus-4-20250115', name: 'Claude Opus 4', contextWindow: 200_000 },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200_000 },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    defaultModel: 'MiniMax-M2.7',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    protocolHint: 'MiniMax Anthropic 兼容接口（默认 https://api.minimaxi.com/anthropic），仅需 API Key',
    models: [
      // MiniMax M3 — 原生多模态（图片/视频输入），1M 上下文（API 保底 512K）
      { id: 'MiniMax-M3', name: 'MiniMax M3 (视觉)', contextWindow: 1_000_000 },
      // MiniMax M2.x — 纯文本；256K fallback (verify in Settings if needed)
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', contextWindow: 256_000 },
      { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed', contextWindow: 256_000 },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', contextWindow: 256_000 },
      { id: 'MiniMax-M2.5-highspeed', name: 'MiniMax M2.5 Highspeed', contextWindow: 256_000 },
      { id: 'MiniMax-M2.1', name: 'MiniMax M2.1', contextWindow: 256_000 },
      { id: 'MiniMax-M2.1-highspeed', name: 'MiniMax M2.1 Highspeed', contextWindow: 256_000 },
      { id: 'MiniMax-M2', name: 'MiniMax M2', contextWindow: 256_000 },
    ],
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    defaultModel: 'glm-4.7',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    protocolHint:
      '智谱 Claude 兼容（默认 https://open.bigmodel.cn/api/anthropic）。填控制台 API Key；GLM 编码套餐见 Coding Plan / Claude Code 文档（ANTHROPIC_AUTH_TOKEN），应用会同时发送 Bearer 与 x-api-key 以兼容',
    models: [
      // GLM-5 / 4.7 — 256K fallback; 4.5-air/flash documented as 128K
      { id: 'glm-5', name: 'GLM-5', contextWindow: 256_000 },
      { id: 'glm-4.7', name: 'GLM-4.7', contextWindow: 256_000 },
      { id: 'glm-4.5-air', name: 'GLM-4.5 Air', contextWindow: 128_000 },
      { id: 'glm-4.5-flash', name: 'GLM-4.5 Flash', contextWindow: 128_000 },
    ],
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    defaultModel: 'kimi-k2.5',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    protocolHint: 'Kimi Anthropic 兼容（默认 https://api.moonshot.cn/anthropic）；密钥对应文档中的 ANTHROPIC_AUTH_TOKEN',
    models: [
      // Kimi K2 family — 256K (Moonshot docs)
      { id: 'kimi-k2.5', name: 'Kimi K2.5', contextWindow: 256_000 },
      { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', contextWindow: 256_000 },
      { id: 'kimi-k2-thinking-turbo', name: 'Kimi K2 Thinking Turbo', contextWindow: 256_000 },
      { id: 'kimi-k2-0905-preview', name: 'Kimi K2 0905 Preview', contextWindow: 256_000 },
      { id: 'kimi-k2-turbo-preview', name: 'Kimi K2 Turbo Preview', contextWindow: 256_000 },
      { id: 'kimi-k2-0711-preview', name: 'Kimi K2 0711 Preview', contextWindow: 256_000 },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    defaultModel: 'deepseek-v4-pro',
    baseUrl: 'https://api.deepseek.com/anthropic',
    protocolHint:
      'DeepSeek Anthropic 兼容（默认 https://api.deepseek.com/anthropic），使用 API Key（x-api-key）。支持 thinking（budget_tokens 会被服务端忽略）与 output_config.effort；不支持 cache_control / image / document。推荐使用 deepseek-v4-pro / deepseek-v4-flash；旧的 deepseek-chat / deepseek-reasoner 将于 2026/07/24 弃用',
    models: [
      // DeepSeek — V4 Pro is 1M, others 128K (DeepSeek docs)
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 128_000 },
      { id: 'deepseek-chat', name: 'DeepSeek Chat (2026/07/24 弃用)', contextWindow: 128_000 },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (2026/07/24 弃用)', contextWindow: 128_000 },
    ],
  },
  {
    id: 'dashscope',
    name: '阿里通义 (DashScope)',
    defaultModel: 'qwen3-max',
    baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    protocolHint: '阿里云百炼 Anthropic 兼容接口，无需填写 Base URL',
    models: [
      // Qwen — 3.7 Max/Plus are 1M (Aliyun docs, 2026-05/06); Coder family 1M;
      // 3.5/3.6 Plus/Flash 256K; legacy 128K.
      // 注意：Max 系列是纯文本模型（不支持图片输入）；图片/视频请选 Plus/Flash/VL。
      { id: 'qwen3.7-max', name: '千问 3.7 Max (纯文本)', contextWindow: 1_000_000 },
      { id: 'qwen3.7-plus', name: '千问 3.7 Plus (视觉)', contextWindow: 1_000_000 },
      { id: 'qwen3.6-plus', name: '千问 3.6 Plus (视觉)', contextWindow: 256_000 },
      { id: 'qwen3-max', name: '千问 3 Max', contextWindow: 256_000 },
      { id: 'qwen3-coder-plus', name: '千问 3 Coder Plus', contextWindow: 1_000_000 },
      { id: 'qwen3-coder-next', name: '千问 3 Coder Next', contextWindow: 1_000_000 },
      { id: 'qwen3.5-plus', name: '千问 3.5 Plus', contextWindow: 256_000 },
      { id: 'qwen3.5-flash', name: '千问 3.5 Flash', contextWindow: 256_000 },
      { id: 'qwen-plus', name: '千问 Plus', contextWindow: 128_000 },
      { id: 'qwen-turbo', name: '千问 Turbo', contextWindow: 1_000_000 },
      { id: 'qwen-max', name: '千问 Max', contextWindow: 256_000 },
      { id: 'qwq-plus', name: 'QwQ Plus (推理)', contextWindow: 128_000 },
      { id: 'qwen-long', name: '千问 Long (长文本)', contextWindow: 10_000_000 },
      { id: 'qwen3-vl-plus', name: '千问 3 VL Plus (视觉)', contextWindow: 256_000 },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI Chat',
    defaultModel: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    protocolHint: 'OpenAI Chat API format - SDK appends /v1/chat/completions',
    models: [
      // OpenAI — 4o family 128K, o3/o4-mini 200K (OpenAI docs)
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128_000 },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128_000 },
      { id: 'o3', name: 'o3', contextWindow: 200_000 },
      { id: 'o4-mini', name: 'o4-mini', contextWindow: 200_000 },
    ],
  },
  {
    id: 'openai2',
    name: 'OpenAI Responses API',
    defaultModel: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    protocolHint: 'OpenAI Responses API format - will be auto-converted to Claude format',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o (Responses API)', contextWindow: 128_000 },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini (Responses API)', contextWindow: 128_000 },
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini Native',
    defaultModel: 'gemini-2.5-pro',
    baseUrl: 'https://generativelanguage.googleapis.com',
    protocolHint: 'SDK appends /v1beta/models/{model} to your Base URL',
    models: [
      // Gemini 2.5 — 1M (Google docs)
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1_000_000 },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1_000_000 },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', contextWindow: 1_000_000 },
    ],
  },
  {
    id: 'bedrock',
    name: 'AWS Bedrock',
    defaultModel: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    protocolHint: 'Uses AWS Bedrock runtime SDK (region required)',
    models: [
      { id: 'us.anthropic.claude-sonnet-4-20250514-v1:0', name: 'Claude Sonnet 4 (Bedrock)', contextWindow: 200_000 },
      { id: 'us.anthropic.claude-opus-4-20250115-v1:0', name: 'Claude Opus 4 (Bedrock)', contextWindow: 200_000 },
      { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', name: 'Claude Haiku 4.5 (Bedrock)', contextWindow: 200_000 },
    ],
  },
  {
    id: 'vertex',
    name: 'GCP Vertex AI',
    defaultModel: 'claude-sonnet-4-20250514',
    baseUrl: 'https://us-central1-aiplatform.googleapis.com',
    protocolHint: 'Uses GCP Vertex AI endpoint (project ID required)',
    models: [
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4 (Vertex)', contextWindow: 200_000 },
      { id: 'claude-opus-4-20250115', name: 'Claude Opus 4 (Vertex)', contextWindow: 200_000 },
      { id: 'claude-haiku-4-5@20251001', name: 'Claude Haiku 4.5 (Vertex)', contextWindow: 200_000 },
    ],
  },
  {
    id: 'foundry',
    name: 'Azure Foundry',
    defaultModel: 'claude-sonnet-4-20250514',
    baseUrl: 'https://api.anthropic.com',
    protocolHint: 'Uses Azure Foundry endpoint',
    models: [
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4 (Foundry)', contextWindow: 200_000 },
      { id: 'claude-opus-4-20250115', name: 'Claude Opus 4 (Foundry)', contextWindow: 200_000 },
    ],
  },
  {
    id: 'compatible',
    name: 'Compatible Format',
    defaultModel: 'gpt-4o',
    baseUrl: '',
    protocolHint: 'Auto-detect and convert OpenAI/OpenAI2/Gemini formats to Claude',
    models: [
      // `compatible` users are expected to add their own model id; default
      // 256K fallback applies until they override in Settings → 上下文.
      { id: 'auto', name: 'Auto-detect (recommended)' },
      { id: 'custom', name: 'Custom Model' },
    ],
  },
]

/**
 * Snapshot of every `(modelId → contextWindow)` declared in the registry.
 *
 * The renderer pushes this map to the main process at boot via
 * `context:set-registry-windows`, where it is consulted by
 * `getModelContextWindowTokens` BEFORE the regex fallback. Adding a new
 * model with a `contextWindow` field is therefore enough to fix the
 * "上下文百分比不准" gauge — no main-process or regex change required.
 *
 * Note: provider id is NOT in the key. Across providers a duplicate
 * `gpt-4o` resolves to the same window — last write wins, but all our
 * duplicates declare the same number, so order is irrelevant.
 */
export function buildRegistryContextWindowMap(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const provider of PROVIDER_ENTRIES) {
    for (const m of provider.models) {
      if (typeof m.contextWindow === 'number' && Number.isFinite(m.contextWindow) && m.contextWindow > 0) {
        out[m.id.toLowerCase()] = m.contextWindow
      }
    }
  }
  return out
}

/** O(1) lookup by ProviderId. */
export const PROVIDER_ENTRY_BY_ID: Readonly<Record<ProviderId, ProviderRegistryEntry>> =
  PROVIDER_ENTRIES.reduce((acc, entry) => {
    acc[entry.id] = entry
    return acc
  }, {} as Record<ProviderId, ProviderRegistryEntry>)

/** Default model for a provider (first in its model list). */
export function getDefaultModel(providerId: ProviderId): string {
  const entry = PROVIDER_ENTRY_BY_ID[providerId]
  return entry?.models[0]?.id ?? ''
}
