/**
 * upstream 上下文报告 §10.2 / §10.3 — Anthropic Messages 形态下的 thinking / redacted_thinking 与签名处理。
 *
 * §10.2
 * 1. 本轮请求未启用 extended thinking 时，从历史 assistant 块中移除 `thinking` / `redacted_thinking`
 *    （否则与「仅 max_thinking>0 的查询可带此类块」不一致，易导致 400）。
 * 2. assistant 消息不得以 `thinking` / `redacted_thinking` 为**最后一块** — 委托 {@link fixThinkingBlockPosition}。
 * 3. 不在此函数内拆散 tool_use / tool_result 链；仅做块级过滤与尾部修补。
 *
 * §10.3 — 模型切换（含 skill 覆盖模型、回退等）：从 `thinking` 块去掉 `signature`，避免跨模型校验失败。
 * Opt-out: `POLE_ANTHROPIC_STRIP_THINKING_SIGNATURE_ON_MODEL_CHANGE=0`
 *
 * 上一成功流模型 id 缓存在 {@link rememberLastStreamModelForThinkingTranscript}（由 `runAgenticLoop` 写入）。
 * 产品约定：Claude 形 transcript 的清洗**只在 agentic 循环内**对 `apiMessages` 做一次；兼容层不再重复（见 `compatibleClient` 注释）。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { ProviderId } from '../ai/client'
import { fixThinkingBlockPosition } from './fixThinkingBlockPosition'
import { writeJsonFileAtomic } from '../fs/atomicWrite'

const MAX_STREAM_MODEL_ENTRIES = 256

/**
 * §10.3 三元组：把"上一轮成功流的标识"扩展为 `(provider, model, configId)`
 * 元组。原来只比对 model 字符串会漏掉两种 mismatch：
 *   1. 同模型 id 不同 provider（如 `claude-sonnet-4` 从 anthropic 切到 bedrock）
 *   2. 同 provider 同模型不同 API key / config（用户在 ApiConfig 之间切换）
 * 这两种情况下旧签名都对新凭证/路由失效，会触发 400。
 *
 * 持久化文件 schema 也从 v1（flat `{convId: modelId}`）升级到 v2
 * （`{convId: snapshot}`），并保留对 v1 旧文件的无损读取。
 */
export interface ThinkingStreamSnapshot {
  provider: ProviderId
  model: string
  /** 来自 SettingsState.activeConfigId；manual mode 时 undefined */
  configId?: string
}

const lastStreamModelByConversation = new Map<string, ThinkingStreamSnapshot>()

// ─── Persistence (§10.3 cross-restart correctness) ───────────────────────────
//
// The in-memory Map above is a per-process cache. Without a disk-backed source
// of truth, the §10.3 "strip signatures on model change" guard silently
// regresses across an app restart: `peekLastStreamModelForThinkingTranscript`
// returns `undefined`, the strip is skipped, and the next turn echoes a stale
// signature into the new model's request. DeepSeek's Anthropic-compat endpoint
// answers with HTTP 400; Anthropic native rejects on signature mismatch.
//
// We persist `{convId → snapshot}` next to the conversation folders (single
// writer in main, JSON sidecar — deliberately NOT inlined into the
// per-conversation files to avoid schema migration and write races with the
// renderer's autosave).
const PERSIST_FILENAME = '_thinking-stream-models.json'

interface PersistedThinkingStreamModelsV1 {
  version: 1
  byConversationId: Record<string, string> // value = modelId
}
interface PersistedThinkingStreamModelsV2 {
  version: 2
  byConversationId: Record<string, ThinkingStreamSnapshot>
}
type PersistedThinkingStreamModels =
  | PersistedThinkingStreamModelsV1
  | PersistedThinkingStreamModelsV2

let persistRoot = ''
let persistInitialized = false
let persistFlushHandle: ReturnType<typeof setTimeout> | null = null
const PERSIST_FLUSH_DEBOUNCE_MS = 200

function persistFilePath(): string {
  return path.join(persistRoot, 'conversations', PERSIST_FILENAME)
}

function readPersisted(): Record<string, ThinkingStreamSnapshot> {
  if (!persistRoot) return {}
  const fp = persistFilePath()
  if (!fs.existsSync(fp)) return {}
  try {
    const raw = fs.readFileSync(fp, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PersistedThinkingStreamModels>
    if (!parsed || !parsed.byConversationId) return {}

    const out: Record<string, ThinkingStreamSnapshot> = {}

    if (parsed.version === 2) {
      // v2 direct read
      for (const [k, v] of Object.entries(parsed.byConversationId)) {
        if (typeof k !== 'string' || !k) continue
        const snap = v as Partial<ThinkingStreamSnapshot>
        if (!snap || typeof snap.model !== 'string' || !snap.model) continue
        if (typeof snap.provider !== 'string' || !snap.provider) continue
        out[k] = {
          provider: snap.provider as ProviderId,
          model: snap.model,
          ...(typeof snap.configId === 'string' && snap.configId
            ? { configId: snap.configId }
            : {}),
        }
      }
      return out
    }

    if (parsed.version === 1) {
      // v1 → v2 migration. The old format only stored model id, so provider/configId
      // are unknown until we observe them again. Mark provider as `'unknown'` so the
      // first post-restart turn always mismatches (worst case: one extra signature
      // strip — harmless). On successful stream completion the entry gets rewritten
      // with the real triple via rememberLastStreamModelForThinkingTranscript().
      for (const [k, v] of Object.entries(
        (parsed as PersistedThinkingStreamModelsV1).byConversationId,
      )) {
        if (typeof k === 'string' && k && typeof v === 'string' && v) {
          out[k] = { provider: 'unknown' as ProviderId, model: v }
        }
      }
      return out
    }

    return {}
  } catch {
    // Corrupted JSON — treat as no data. The next write will overwrite.
    return {}
  }
}

function schedulePersistFlush(): void {
  if (!persistRoot) return
  if (persistFlushHandle !== null) return
  persistFlushHandle = setTimeout(() => {
    persistFlushHandle = null
    flushPersistNow()
  }, PERSIST_FLUSH_DEBOUNCE_MS)
}

function flushPersistNow(): void {
  if (!persistRoot) return
  const payload: PersistedThinkingStreamModelsV2 = {
    version: 2,
    byConversationId: Object.fromEntries(lastStreamModelByConversation.entries()),
  }
  try {
    fs.mkdirSync(path.dirname(persistFilePath()), { recursive: true })
    writeJsonFileAtomic(persistFilePath(), payload)
  } catch {
    // Best-effort: a write failure here is recoverable on the next set.
    // We deliberately don't surface the error to callers — the §10.3
    // guarantee degrades gracefully (next restart loses one mapping)
    // rather than breaking the chat flow.
  }
}

/**
 * Wire up disk persistence for the thinking-stream model map. Idempotent —
 * subsequent calls are no-ops unless {@link resetThinkingTranscriptStreamModelMapForTests}
 * is called first.
 *
 * @param storageRoot The same root passed to `initConversationService`
 *   (i.e. user data or settings-overridden storage path). The persistence
 *   file lives at `<root>/conversations/_thinking-stream-models.json`,
 *   alongside the conversation buckets.
 */
export function initThinkingStreamModelPersistence(storageRoot: string): void {
  if (persistInitialized) return
  const r = storageRoot.trim()
  if (!r) return
  persistRoot = r
  persistInitialized = true
  // Seed the in-memory map from disk. We intentionally do this even when the
  // map is non-empty (warm boot via tests / HMR) — disk wins on init so a
  // long-stale module-level value can't outvote a freshly-written sidecar.
  const persisted = readPersisted()
  for (const [convId, snapshot] of Object.entries(persisted)) {
    lastStreamModelByConversation.set(convId, snapshot)
  }
  // Trim the seeded map down to the cap if a disk file accumulated past
  // the in-memory ceiling on a prior version.
  while (lastStreamModelByConversation.size > MAX_STREAM_MODEL_ENTRIES) {
    const first = lastStreamModelByConversation.keys().next().value as string | undefined
    if (first) lastStreamModelByConversation.delete(first)
    else break
  }
}

/**
 * Force any pending debounced writes through immediately. Call this from
 * the app shutdown path so a stream that completed in the last 200ms
 * doesn't get dropped.
 */
export function flushThinkingStreamModelPersistence(): void {
  if (persistFlushHandle !== null) {
    clearTimeout(persistFlushHandle)
    persistFlushHandle = null
  }
  flushPersistNow()
}

export function peekLastStreamModelForThinkingTranscript(
  conversationId: string | undefined,
): ThinkingStreamSnapshot | undefined {
  const k = conversationId?.trim()
  if (!k) return undefined
  return lastStreamModelByConversation.get(k)
}

export function rememberLastStreamModelForThinkingTranscript(
  conversationId: string | undefined,
  snapshot: ThinkingStreamSnapshot,
): void {
  const k = conversationId?.trim()
  const m = snapshot.model.trim()
  if (!k || !m || !snapshot.provider) return
  const next: ThinkingStreamSnapshot = {
    provider: snapshot.provider,
    model: m,
    ...(snapshot.configId ? { configId: snapshot.configId } : {}),
  }
  const prev = lastStreamModelByConversation.get(k)
  lastStreamModelByConversation.set(k, next)
  while (lastStreamModelByConversation.size > MAX_STREAM_MODEL_ENTRIES) {
    const first = lastStreamModelByConversation.keys().next().value as string | undefined
    if (first) lastStreamModelByConversation.delete(first)
    else break
  }
  // Only flush on actual value change. Saves the common case of "many
  // back-to-back turns on the same model" from spamming writeJsonFileAtomic.
  if (
    !prev ||
    prev.provider !== next.provider ||
    prev.model !== next.model ||
    prev.configId !== next.configId
  ) {
    schedulePersistFlush()
  }
}

export function resetThinkingTranscriptStreamModelMapForTests(): void {
  lastStreamModelByConversation.clear()
  if (persistFlushHandle !== null) {
    clearTimeout(persistFlushHandle)
    persistFlushHandle = null
  }
  persistInitialized = false
  persistRoot = ''
}

export function providerUsesAnthropicMessagesApi(providerId: ProviderId): boolean {
  switch (providerId) {
    case 'anthropic':
    case 'bedrock':
    case 'vertex':
    case 'foundry':
    case 'dashscope':
    case 'minimax':
    case 'zhipu':
    case 'kimi':
    case 'deepseek':
      return true
    default:
      return false
  }
}

function normalizeModelId(model: string): string {
  return model.trim().toLowerCase()
}

function cloneContent(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content
  return (content as Record<string, unknown>[]).map((b) => ({ ...b }))
}

function cloneMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return messages.map((m) => ({
    ...m,
    content: cloneContent(m.content),
  }))
}

/** §10.3 — 去掉 thinking 块上的签名（模型切换后互不兼容）。 */
export function stripThinkingSignaturesFromAssistantBlocks(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const out = cloneMessages(messages)
  for (const msg of out) {
    if (msg.role !== 'assistant') continue
    const content = msg.content
    if (!Array.isArray(content)) continue
    const blocks = content as Record<string, unknown>[]
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      if (!b || typeof b !== 'object') continue
      if (b.type === 'thinking' && 'signature' in b) {
        const copy = { ...(b as Record<string, unknown>) }
        delete copy.signature
        blocks[i] = copy
      }
    }
  }
  return out
}

const THINKING_LIKE = new Set(['thinking', 'redacted_thinking'])

// ─── R1 — Cross-provider distance-based historical-thinking truncation ──────
//
// Companion to the Anthropic-only P1/P2 server-side controls in
// `electron/ai/anthropicThinkingApiContext.ts`. P1/P2 only fire on
// first-party `api.anthropic.com` (they need `anthropic-beta` headers
// the Bedrock/Vertex/Foundry SDKs don't surface, and the various third-
// party Anthropic-compat gateways simply ignore beta tokens). For users
// on Bedrock / Vertex / Foundry / Zhipu / Kimi / MiniMax / DashScope
// the historical thinking text was being echoed verbatim every turn
// regardless of how stale it was — bloating prompts AND giving the model
// a fresh chance to anchor on its own (possibly wrong) past reasoning.
//
// R1 is the cross-provider safety net. It runs in
// `applyAnthropicThinkingTranscriptCore`, so every Anthropic-shape
// request benefits (the OpenAI Chat / Gemini transformers strip thinking
// at their own layer; nothing to do for them).
//
// Conservative thresholds:
//   distance 0 (last turn)        — full text (current context, never touch)
//   distance 1                    — full text (last completed turn — recent)
//   distance 2                    — truncate to 800 chars
//   distance 3+ (older turns)     — truncate to 200 chars
//
// The text suffix is intentionally model-visible: telling the model
// "this was elided" gives it permission to NOT treat the truncated
// payload as the full prior reasoning. upstream doesn't add this hint
// because they rely on `clear_thinking_20251015` server-side; for the
// non-server-controlled paths an explicit signal is cheap insurance
// against misinterpretation.

const R1_DISTANCE_NO_TRUNCATE_THROUGH = 1
const R1_TRUNC_LEN_DISTANCE_2 = 800
const R1_TRUNC_LEN_DISTANCE_3PLUS = 200

// ─── 2026-07 uplift #15 — post-failure reflection exemption ─────────────
//
// The adaptive thinking budget (`adaptiveThinkingBudget.ts`) deliberately
// grants the FULL budget to the iteration right after an all-errors tool
// batch — that's where the model reasons about what went wrong. R1 then
// used to truncate exactly that reasoning down to 800/200 chars within a
// couple of iterations, so the paid-for failure analysis vanished from
// context right when a retry-loop needs it most ("why did this fail last
// time?"). Assistant turns that immediately follow an all-errors
// tool_result batch are detected FROM THE TRANSCRIPT (deterministic — no
// new state) and keep their full thinking text for
// {@link R1_REFLECTION_KEEP_FULL_THROUGH} turns of distance before the
// normal distance schedule resumes.
//
// Opt out via `POLE_THINKING_REFLECTION_EXEMPT=0`.

const R1_REFLECTION_KEEP_FULL_THROUGH = 4

function reflectionExemptEnabled(): boolean {
  return process.env.POLE_THINKING_REFLECTION_EXEMPT !== '0'
}

function toolResultLooksFailed(block: Record<string, unknown>): boolean {
  if (block.is_error === true) return true
  const c = block.content
  return typeof c === 'string' && c.trimStart().startsWith('Error:')
}

/**
 * Does the user-message span between the PREVIOUS assistant message and
 * `assistantIdx` carry at least one tool_result, ALL of which failed?
 * Host attachments push extra user messages after the tool_result carrier,
 * so the whole span is scanned, not just the adjacent message. Exported
 * for tests.
 */
export function assistantFollowsAllErrorToolBatch(
  messages: ReadonlyArray<Record<string, unknown>>,
  assistantIdx: number,
): boolean {
  let sawToolResult = false
  for (let i = assistantIdx - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) break
    if (msg.role === 'assistant') break
    if (msg.role !== 'user') continue
    const content = msg.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown>>) {
      if (!block || block.type !== 'tool_result') continue
      sawToolResult = true
      if (!toolResultLooksFailed(block)) return false
    }
  }
  return sawToolResult
}

function r1TruncationLengthForDistance(
  distance: number,
  isPostFailureReflection = false,
): number | undefined {
  if (distance <= R1_DISTANCE_NO_TRUNCATE_THROUGH) return undefined
  if (isPostFailureReflection && distance <= R1_REFLECTION_KEEP_FULL_THROUGH) {
    return undefined
  }
  if (distance === 2) return R1_TRUNC_LEN_DISTANCE_2
  return R1_TRUNC_LEN_DISTANCE_3PLUS
}

/**
 * 2026-06 multi-turn degradation fix (root cause 4b) — the suffix used to
 * be a ~200-char explanation repeated verbatim on EVERY truncated block;
 * by round 13-18 the same English sentence appeared 30+ times in context,
 * which is itself uniform-pattern pollution. Shortened to a compact
 * sentinel line. The phrase `chars of historical reasoning elided` is the
 * idempotency sentinel checked by {@link truncateHistoricalThinkingByDistance}
 * — keep it verbatim.
 */
function r1TruncationSuffix(elidedChars: number, distance: number): string {
  return (
    `\n…[${elidedChars} chars of historical reasoning elided ` +
    `(${distance} turns ago); re-verify from current evidence]`
  )
}

/**
 * Distance-based truncation pass. Only operates on `thinking` blocks; leaves
 * `redacted_thinking` (already opaque) and every other block type alone.
 *
 * Idempotency:
 *   - Blocks already shortened by save-time compaction (renderer-side
 *     `compactThinkingOnSave`, sentinel `characters elided on save`) are
 *     skipped — no double truncation.
 *   - Blocks already shortened by a prior R1 pass (sentinel `chars of
 *     historical reasoning elided`) are skipped.
 *
 * Side effect on truncated blocks:
 *   - `signature` is removed because truncating the text invalidates any
 *     cryptographic signature over it. Anthropic's transcript-replay
 *     invariants accept missing signatures (only matters when the
 *     same-model request also has a `tool_use`); first-party path uses
 *     P2's `clear_thinking_20251015` instead and never reaches here for
 *     the strict signature case.
 *
 * Returns the input array reference unchanged when no message was
 * touched — cheap fast path for short conversations.
 */
export function truncateHistoricalThinkingByDistance(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  let changed = false
  const out: Array<Record<string, unknown>> = messages.slice()
  // Walk backward, counting assistant turns. distance = 0 for the LAST
  // assistant message, 1 for the one before that, etc. User messages
  // don't bump the counter — the asymmetry matches the "turn index"
  // model the rest of the codebase uses (one turn = one assistant
  // message regardless of how many user messages preceded it).
  let distance = -1
  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i]
    if (msg.role !== 'assistant') continue
    distance++
    // #15 — post-failure reflection turns keep full thinking for longer
    // (see the exemption block above). Checked lazily: only when the
    // distance schedule would otherwise truncate.
    const isReflection =
      reflectionExemptEnabled() &&
      distance > R1_DISTANCE_NO_TRUNCATE_THROUGH &&
      distance <= R1_REFLECTION_KEEP_FULL_THROUGH &&
      assistantFollowsAllErrorToolBatch(out, i)
    const limit = r1TruncationLengthForDistance(distance, isReflection)
    if (limit === undefined) continue
    const content = msg.content
    if (!Array.isArray(content)) continue
    const blocks = content as Array<Record<string, unknown>>
    let touched = false
    const newBlocks = blocks.map((b) => {
      if (!b || typeof b !== 'object') return b
      if (b.type !== 'thinking') return b
      const text = typeof b.thinking === 'string' ? b.thinking : ''
      if (text.length <= limit) return b
      // Idempotency sentinels — don't re-truncate either flavour.
      if (text.includes('characters elided on save')) return b
      if (text.includes('chars of historical reasoning elided')) return b
      touched = true
      const preview = text.slice(0, limit)
      const elided = text.length - limit
      const next: Record<string, unknown> = {
        ...b,
        thinking: preview + r1TruncationSuffix(elided, distance),
      }
      // Truncating invalidates the signature; drop it. Downstream the
      // Anthropic-native invariant requires either matching signature OR
      // no signature on a thinking block — never partial.
      delete next.signature
      return next
    })
    if (touched) {
      out[i] = { ...msg, content: newBlocks }
      changed = true
    }
  }
  return changed ? out : messages
}

/**
 * Env opt-out for R1. Mirrors the {@link applyAnthropicThinkingTranscriptCore}
 * pattern of `POLE_*` toggles for things users on third-party gateways
 * may want to disable (e.g. an internal proxy that re-validates signatures
 * and would 400 on truncated blocks).
 */
function r1Enabled(): boolean {
  return process.env.POLE_DISABLE_DISTANCE_THINKING_TRUNCATION !== '1'
}

/**
 * §10.2 — 本轮未开 thinking 请求时从历史中移除 thinking 类块；assistant 变空则补占位 text。
 *
 * 2026-07 审计复核（P2-3）—— 本清除在 iteration 级调用点是**持久化**的
 * （写回 `state.apiMessages`），与 R1 距离截断的 ephemeral 化修复不同。
 * 复核结论：by-design 成立，不改为 ephemeral。论证：
 *
 *   1. 非永久丢失 —— 下一个用户回合 renderer 会经
 *      `src/services/contextBuilder.ts#chatMessageToAgentApiRows` 从
 *      `ChatMessage.blocks`（从未被本清除触碰）无条件重新发出 thinking 块
 *      重建 apiMessages，推理记录跨回合自愈。
 *   2. wire 正确性要求移除 —— thinking 关闭时历史 thinking 块会被
 *      Anthropic 形 API 拒绝（400）；持久化保证 run 内所有下游消费者
 *      （compact / fork / sub-agent continuation）看到同一份已合法化
 *      的 transcript，无需每条 provider 路径重复清洗。
 *   3. run 内无消费者受损 —— compact 的 prompt 格式化器
 *      （`compact.ts#formatCompactContentBlock`）本就不读 thinking 块，
 *      ephemeral 化的唯一理论收益（run 内 compact 保留推理）为零。
 */
export function removeThinkingAndRedactedBlocksFromAssistants(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const out = cloneMessages(messages)
  for (const msg of out) {
    if (msg.role !== 'assistant') continue
    const content = msg.content
    if (!Array.isArray(content)) continue
    const blocks = content as Record<string, unknown>[]
    const kept = blocks.filter((b) => b && typeof b === 'object' && !THINKING_LIKE.has(String(b.type)))
    if (kept.length === 0) {
      msg.content = [{ type: 'text', text: ' ' }]
    } else {
      msg.content = kept
    }
  }
  return out
}

export type ApplyAnthropicThinkingTranscriptCoreOptions = {
  /** 本轮请求使用的 provider id（用于三元组对比） */
  currentProvider: ProviderId
  currentModel: string
  /** 本轮请求使用的 activeConfigId（manual mode 时 undefined） */
  currentConfigId?: string
  /** 上一轮成功流的三元组快照；首轮为 undefined */
  previousStreamSnapshot?: ThinkingStreamSnapshot
  thinkingRequestActive: boolean
  stripSignaturesOnModelChange: boolean
  /**
   * When true, historical `thinking` / `redacted_thinking` blocks are never
   * stripped and `fixThinkingBlockPosition` is skipped. Required for DeepSeek's
   * Anthropic-compat endpoint which 400s when thinking blocks are removed or
   * altered (they must be echoed back verbatim).
   */
  strictThinkingEcho?: boolean
  /**
   * 2026-06 multi-turn degradation fix (root cause 4) — R1 distance-based
   * truncation is now EPHEMERAL: the agentic loop's iteration-level call
   * (which writes its result back into `state.apiMessages` and therefore
   * persists) sets this to `false`, and the truncation runs instead on the
   * per-request wire copy in `stream.ts` via
   * {@link applyEphemeralDistanceThinkingTruncation}. Before this fix the
   * truncated text + anchoring suffix were destructively persisted every
   * iteration, permanently destroying the reasoning record while the
   * conclusion text survived. Defaults to `true` to preserve behaviour
   * for any other caller.
   */
  applyDistanceTruncation?: boolean
}

/**
 * §10.3 三元组键：把 (provider, model, configId) 折叠成一个可比较字符串。
 * provider/configId 缺一不可（不同 provider 或不同 API key 都会让旧签名失效）。
 */
function snapshotKey(s: ThinkingStreamSnapshot | undefined): string | null {
  if (!s) return null
  if (!s.provider || !s.model || s.model.trim() === '') return null
  return `${s.provider}|${normalizeModelId(s.model)}|${s.configId ?? ''}`
}

/**
 * §10.2 / §10.3 实际变换（不校验 provider）。`streamCompatibleFormat` 与 `normalizeAnthropicThinkingTranscript` 共用。
 */
export function applyAnthropicThinkingTranscriptCore(
  messages: Array<Record<string, unknown>>,
  options: ApplyAnthropicThinkingTranscriptCoreOptions,
): Array<Record<string, unknown>> {
  let out = cloneMessages(messages)
  const prevKey = snapshotKey(options.previousStreamSnapshot)
  const curKey = snapshotKey({
    provider: options.currentProvider,
    model: options.currentModel,
    configId: options.currentConfigId,
  })
  if (
    options.stripSignaturesOnModelChange &&
    prevKey != null &&
    curKey != null &&
    prevKey !== curKey
  ) {
    out = stripThinkingSignaturesFromAssistantBlocks(out)
  }
  // DeepSeek Anthropic-compat endpoint requires historical thinking blocks to
  // be preserved verbatim; stripping them (even when the current request does
  // not explicitly activate thinking) triggers HTTP 400.
  if (!options.strictThinkingEcho && !options.thinkingRequestActive) {
    out = removeThinkingAndRedactedBlocksFromAssistants(out)
  }
  // R1 — distance-based truncation of historical thinking blocks. Runs
  // after the §10.2 removal pass so a `thinkingRequestActive: false`
  // turn already had its thinking blocks dropped (R1 has nothing to do
  // there). For `thinkingRequestActive: true` turns, R1 catches the
  // long historical thinking that survived. Skipped for DeepSeek strict
  // echo (would 400 on any modification), skippable via env opt-out,
  // and skipped by the iteration-level persisted call (see
  // {@link ApplyAnthropicThinkingTranscriptCoreOptions.applyDistanceTruncation}).
  if (
    !options.strictThinkingEcho &&
    options.applyDistanceTruncation !== false &&
    r1Enabled()
  ) {
    out = truncateHistoricalThinkingByDistance(out)
  }
  return fixThinkingBlockPosition(out, options.strictThinkingEcho)
}

/**
 * Request-time (EPHEMERAL) R1 application — called from `stream.ts` on the
 * wire copy of the transcript, alongside the goal recitation. Never
 * mutates the input; returns the same reference when nothing applies.
 *
 * The model still sees truncated historical thinking on every request
 * (same prompt-shaping benefit as before), but `state.apiMessages` and
 * the persisted conversation keep the FULL reasoning record — a later
 * compact, fork, or model switch works from intact data.
 */
export function applyEphemeralDistanceThinkingTruncation(
  messages: Array<Record<string, unknown>>,
  options?: { strictThinkingEcho?: boolean },
): Array<Record<string, unknown>> {
  if (options?.strictThinkingEcho) return messages
  if (!r1Enabled()) return messages
  return truncateHistoricalThinkingByDistance(messages)
}

export type NormalizeAnthropicThinkingTranscriptOptions = {
  providerId: ProviderId
  /** 本轮将发往 API 的模型 id */
  currentModel: string
  /** 本轮请求使用的 activeConfigId（manual mode 时 undefined） */
  currentConfigId?: string
  /** 上一轮流式成功结束时的三元组快照；首轮为 undefined */
  previousStreamSnapshot?: ThinkingStreamSnapshot
  /** 本轮是否在 wire 上启用 extended thinking（含 compatible 的 alwaysThinking） */
  thinkingRequestActive: boolean
  stripSignaturesOnModelChange: boolean
  /**
   * Claude 工具 transcript（apiMessages）在走 compatible / OpenAI 原生等路径时仍须清洗 — 与 provider 无关。
   */
  forceClaudeShapedMessages?: boolean
  /**
   * When true, historical `thinking` / `redacted_thinking` blocks are never
   * stripped and `fixThinkingBlockPosition` is skipped. Required for DeepSeek's
   * Anthropic-compat endpoint which 400s when thinking blocks are removed or
   * altered (they must be echoed back verbatim).
   */
  strictThinkingEcho?: boolean
  /** See {@link ApplyAnthropicThinkingTranscriptCoreOptions.applyDistanceTruncation}. */
  applyDistanceTruncation?: boolean
}

/**
 * 在 `runAgenticLoop` 每轮 `streamText` 前对 `apiMessages` 调用。
 */
export function normalizeAnthropicThinkingTranscript(
  messages: Array<Record<string, unknown>>,
  options: NormalizeAnthropicThinkingTranscriptOptions,
): Array<Record<string, unknown>> {
  if (!providerUsesAnthropicMessagesApi(options.providerId) && !options.forceClaudeShapedMessages) {
    return messages
  }
  return applyAnthropicThinkingTranscriptCore(messages, {
    currentProvider: options.providerId,
    currentModel: options.currentModel,
    currentConfigId: options.currentConfigId,
    previousStreamSnapshot: options.previousStreamSnapshot,
    thinkingRequestActive: options.thinkingRequestActive,
    stripSignaturesOnModelChange: options.stripSignaturesOnModelChange,
    strictThinkingEcho: options.strictThinkingEcho,
    applyDistanceTruncation: options.applyDistanceTruncation,
  })
}
