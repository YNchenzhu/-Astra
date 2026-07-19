/**
 * Auto-extract memories from conversation — enhanced with upstream §4 mechanisms.
 *
 * When a conversation ends (or at periodic intervals), this module extracts
 * long-term-worthy information from the transcript. Supports:
 *
 * - the IDE mechanism: only process messages since last extraction
 * - Coalescing: merge overlapping extraction requests
 * - Mutual exclusion: skip if main agent already wrote memories this round
 * - Drain: wait for in-flight extractions at shutdown
 *
 * Fire-and-forget: errors are logged but never propagate to the caller.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  applyProviderDefaults,
  streamText,
  type ProviderConfig,
  type ProviderId,
} from '../ai/client'
import { SIDE_QUERY_ALWAYS_THINKING } from '../ai/sideQueryThinkingPolicy'
import { resolveAiCredentialsFromDisk } from '../ai/diskCredentials'
import { readDiskSettings } from '../settings/settingsAccess'
import type { Task } from '../tools/TaskManager'
import * as service from './service'
import {
  getMemoryFeatureFlags,
  isAutoMemoryGloballyDisabled,
  isLikelyNonInteractiveHostSession,
} from './memoryFeatureFlags'
import { sanitizeFilename, serializeMemoryFile, resolveFilenameWithoutCollision } from './storage'
import { validateMemoryPath, isUserSuppliedMirrorPathSafe } from './pathSafety'
import { resolveRealPathAllowingMissingLeaf } from '../tools/canonicalPath'
import type {
  ExtractedMemory,
  AutoExtractResult,
  MemoryFrontmatter,
} from './types'
import {
  getExtractionCursor,
  advanceExtractionCursor,
  countMessagesSinceCursor,
  stashPendingContext,
  consumePendingContext,
  trackExtraction,
  incrementExtractionRound,
  shouldThrottleExtraction,
  hasRecentMemoryApiWrite,
  hasMemoryWritesSince,
  clearMainAgentMemoryWrite,
  loadExtractionCursor,
  saveExtractionCursor,
} from './extractionState'
import { markExtractionComplete, probeEmbeddingAvailability } from './autoConsolidate'
import { consolidateInWorker } from './memoryWorkerClient'
import type { ConsolidationResult as WorkerConsolidationResult } from './memoryWorkerClient'
import { withConsolidationLock } from './consolidationLock'
import { listMemoriesAtRoot } from './storage'
import {
  precomputeMemoryEmbeddings,
  pruneOrphanMemoryVectors,
} from './embeddingRecall'

/** Options for worker-based consolidation (mirrors memoryWorkerClient.ConsolidateOpts). */
interface WorkerConsolidateOpts {
  dryRun?: boolean
  fullSweep?: boolean
  embedAvailable?: boolean
  onProgress?: (msg: Record<string, unknown>) => void
}

/**
 * Run consolidation via worker thread, gated by a cross-process lock
 * (audit fix F1). The lock ensures that two Electron hosts opened on the
 * same memory directory cannot both fire a consolidation pass — the
 * in-memory file-lock in extractionState only guards INTRA-process
 * collisions.
 *
 * Falls back to direct call if the worker fails to initialise (dev
 * builds may not emit memoryWorker.js). Lock release / rollback on
 * throw is handled by `withConsolidationLock`.
 */
async function runConsolidation(
  memDir: string,
  opts: WorkerConsolidateOpts,
): Promise<WorkerConsolidationResult> {
  const locked = await withConsolidationLock(memDir, async () => {
    try {
      return await consolidateInWorker(memDir, opts)
    } catch (err) {
      // Worker unavailable (dev / hot-reload / missing .js) — skip
      // consolidation rather than blocking the main process event loop.
      // We RETURN a "skipped" result here rather than throwing so the
      // lock-release path treats this as success (the run did complete,
      // it just produced no work). Throwing would trigger rollback and
      // the time-gate would never advance for a permanently-broken
      // worker, locking the user out of consolidation entirely.
      console.warn('[autoExtract] worker consolidation failed, skipping:', err)
      return {
        merged: 0,
        pruned: 0,
        compressed: 0,
        unchanged: 0,
        errors: [String(err)],
      } as WorkerConsolidationResult
    }
  })
  if (locked !== null) return locked
  // Lock contention: another process is consolidating right now. Return a
  // no-op result so the caller's downstream logging treats this as a
  // clean skip rather than an error.
  console.log('[autoExtract] consolidation skipped — another process holds the lock')
  return {
    merged: 0,
    pruned: 0,
    compressed: 0,
    unchanged: 0,
    errors: [],
  }
}

/** Kept for compatibility; auto-extract is gated by settings / caller (no global one-shot guard). */
export function resetExtractGuard(): void {}

/** Per-conversation in-progress flag for coalescing */
const inProgress = new Map<string, boolean>()

/** Advance cursor in-memory and persist to disk (best-effort). */
function advanceAndPersistCursor(
  conversationId: string,
  lastMsgId: string,
  memoryDir: string | null,
): void {
  advanceExtractionCursor(conversationId, lastMsgId)
  if (memoryDir) {
    saveExtractionCursor(memoryDir, conversationId, getExtractionCursor(conversationId))
  }
}

// ---------------------------------------------------------------------------
// LLM call for extraction (with retry on transient failures)
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3
const RETRY_BASE_MS = 1000

function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    /rate.?limit|429|too many requests/i.test(msg) ||
    /timeout|timed.?out|ETIMEDOUT/i.test(msg) ||
    /network|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(msg) ||
    /server.?error|5\d{2}|internal server/i.test(msg) ||
    /overloaded|capacity/i.test(msg)
  )
}

async function callLLM(
  config: ProviderConfig,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const resolvedModel =
    typeof model === 'string' && model.trim()
      ? model.trim()
      : 'claude-sonnet-4-20250514'

  let lastError: unknown

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1)
      console.log(`[AutoExtract] Retry attempt ${attempt}/${MAX_RETRIES} after ${delay}ms`)
      await new Promise((r) => setTimeout(r, delay))
    }

    let acc = ''
    let err: string | undefined
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 120_000)
    try {
      await streamText(
        config,
        {
          model: resolvedModel,
          messages: [{ role: 'user', content: userMessage }],
          systemPrompt,
          maxTokens: 2048,
          alwaysThinking: SIDE_QUERY_ALWAYS_THINKING,
        },
        {
          onTextDelta: (text) => {
            acc += text
          },
          onMessageEnd: () => {},
          onError: (e) => {
            err = e
          },
        },
        ac.signal,
      )
    } finally {
      clearTimeout(timer)
    }

    if (!err) return acc

    lastError = err
    if (attempt === MAX_RETRIES) break
    if (!isTransientError(err)) break
  }

  throw new Error(lastError instanceof Error ? lastError.message : String(lastError))
}

// ---------------------------------------------------------------------------
// Prompt construction — enhanced with existing memory manifest
// ---------------------------------------------------------------------------

function buildExtractionPrompt(
  conversationSummary: string,
  existingMemoryNames: string[],
  memoryManifest?: string,
): { system: string; user: string } {
  const existingSection =
    existingMemoryNames.length > 0
      ? `已有记忆列表（避免重复创建）：\n${existingMemoryNames.map((n) => `- ${n}`).join('\n')}`
      : '当前没有任何记忆。'

  const manifestSection = memoryManifest
    ? `\n\n已有记忆清单（含类型和描述）：\n${memoryManifest}`
    : ''

  const system = `你是一个记忆提取助手。请分析以下对话内容，从中提炼值得长期记住的信息。

提取规则：
1. 只提取有长期价值的信息：项目决策、技术难点及解法、用户偏好、架构选择、非显而易见的约束或约定
2. 每条记忆必须有明确的名称（英文短横线风格）和内容（Markdown 格式）
3. 如果已有同名记忆，通过更新内容来合并，不要重复创建

禁止保存的内容（以下一律不提取）：
- 可从当前项目状态直接推导的信息：代码模式、架构模式、文件路径、项目结构
- Git 历史、最近变更、commit message —— git log / git blame 是权威来源
- 调试方案、修复步骤 —— 修复已在代码中，commit message 包含上下文
- 临时任务状态、进行中工作、当前对话上下文 —— 仅当次会话有效
- CLAUDE.md / AGENTS.md 中已有的内容 —— 避免冗余和漂移
- 一次性分析结果、会议摘要、收件箱汇总 —— 无长期复用价值

重要提示 — 记忆漂移防护：
- 只提取对话中明确陈述的事实，不要推断或填补细节
- 如果你不确定某个事实在当前项目中是否仍然有效，不要提取
- 宁可遗漏一条记忆，也不要存储一条可能已过期的错误记忆
- 对话中用户提到的"现状"描述优先于任何训练数据中的假设

${existingSection}${manifestSection}

请严格返回 JSON 数组，每个元素包含：
- name: 记忆名称（英文，短横线风格，如 "user-coding-style"）
- type: user | feedback | project | reference
- description: 简短描述（一句话）
- content: 详细内容（Markdown 格式）

如果没有值得提取的内容，返回空数组 []
只返回 JSON，不要有任何其他文字。`

  const user = `对话内容：\n${conversationSummary}`

  return { system, user }
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

function parseExtractionResult(raw: string): ExtractedMemory[] {
  let jsonStr = raw.trim()

  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim()
  }

  const startIdx = jsonStr.indexOf('[')
  const endIdx = jsonStr.lastIndexOf(']')
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return []

  jsonStr = jsonStr.slice(startIdx, endIdx + 1)

  try {
    const parsed = JSON.parse(jsonStr)
    if (!Array.isArray(parsed)) return []

    const validTypes = new Set<string>(['user', 'feedback', 'project', 'reference'])

    return parsed.filter(
      (item: unknown) =>
        item &&
        typeof item === 'object' &&
        typeof (item as { name?: unknown }).name === 'string' &&
        typeof (item as { type?: unknown }).type === 'string' &&
        validTypes.has(String((item as { type: string }).type)) &&
        typeof (item as { description?: unknown }).description === 'string' &&
        typeof (item as { content?: unknown }).content === 'string' &&
        String((item as { content: string }).content).trim().length > 0,
    ) as ExtractedMemory[]
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Conversation summarizer — cursor-aware
// ---------------------------------------------------------------------------

function summarizeConversation(
  messages: Array<{ role: string; content: string; id?: string }>,
  cursorUuid?: string | null,
): string {
  const MAX_CHARS = 8000
  const MAX_SINGLE_MSG_CHARS = 800

  let startIdx = 0
  if (cursorUuid) {
    const cursorPos = messages.findIndex((m) => m.id === cursorUuid)
    if (cursorPos !== -1) {
      startIdx = cursorPos + 1
    }
  }

  const relevantMessages = messages.slice(startIdx)
  const parts: string[] = []
  let totalLen = 0

  for (let i = relevantMessages.length - 1; i >= 0; i--) {
    const msg = relevantMessages[i]
    const roleLabel = (() => {
      switch (msg.role) {
        case 'user': return '用户'
        case 'assistant': return '助手'
        case 'tool': return '工具结果'
        default: return msg.role
      }
    })()
    const text =
      typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)

    // Smart truncation: for tool_result messages (often very long), keep
    // the first and last portions to preserve structure while staying compact.
    let truncated: string
    if (text.length > MAX_SINGLE_MSG_CHARS) {
      const head = text.slice(0, Math.floor(MAX_SINGLE_MSG_CHARS * 0.7))
      const tail = text.slice(-Math.floor(MAX_SINGLE_MSG_CHARS * 0.3))
      truncated = `${head}\n… (${text.length - MAX_SINGLE_MSG_CHARS} chars omitted) …\n${tail}`
    } else {
      truncated = text
    }

    const line = `[${roleLabel}]: ${truncated}`

    if (totalLen + line.length > MAX_CHARS) break

    parts.unshift(line)
    totalLen += line.length
  }

  return parts.join('\n\n')
}

/** Exported for unit testing (audit M4/M6). */
export function mirrorExtractedToDirectory(
  dir: string,
  entries: ExtractedMemory[],
): void {
  const root = path.resolve(dir.trim())
  if (!root) return

  // #4 hardening: this `dir` is user-supplied (renderer IPC param
  // `autoMemoryDirectory` or settings.autoMemoryDirectory). Without these
  // guards a compromised IPC payload — or a tampered userData settings
  // file — could redirect the mirror into ~/.ssh, ~/.aws, etc.
  // validateMemoryPath catches structural issues (relative, UNC, null
  // byte, root); isUserSuppliedMirrorPathSafe catches the sensitive
  // credential-tree segments that the bundleDataRoot path is allowed to
  // contain (AppData on Windows) but a user-supplied mirror is not.
  const shape = validateMemoryPath(root)
  if (!shape.valid) {
    console.warn(`[AutoExtract] Refusing mirror to ${root}: ${shape.reason}`)
    return
  }
  const safety = isUserSuppliedMirrorPathSafe(root)
  if (!safety.valid) {
    console.warn(`[AutoExtract] Refusing mirror to ${root}: ${safety.reason}`)
    return
  }
  // Audit M6: `isUserSuppliedMirrorPathSafe` is a string-shape check and does
  // NOT resolve symlinks — a symlinked path segment (e.g. `~/notes` → `~/.ssh`)
  // could still redirect this writer into a credential dir. Resolve the real
  // path (following links on the nearest existing ancestor when the leaf is
  // missing) and re-run the credential-segment check on the resolved target,
  // matching the realpath-aware AI file-tool gate.
  const realRoot = resolveRealPathAllowingMissingLeaf(root)
  // Re-run BOTH gates on the resolved target. A symlinked segment can turn a
  // shape-valid input into a drive root / UNC / filesystem root, which the
  // first `validateMemoryPath(root)` could not have seen — so the structural
  // gate must run on `realRoot` too, not just the credential-segment check.
  const realShape = validateMemoryPath(realRoot)
  if (!realShape.valid) {
    console.warn(
      `[AutoExtract] Refusing mirror to ${root} (resolves to ${realRoot}): ${realShape.reason}`,
    )
    return
  }
  const realSafety = isUserSuppliedMirrorPathSafe(realRoot)
  if (!realSafety.valid) {
    console.warn(
      `[AutoExtract] Refusing mirror to ${root} (resolves to ${realRoot}): ${realSafety.reason}`,
    )
    return
  }

  fs.mkdirSync(realRoot, { recursive: true })
  const ts = new Date().toISOString()
  // Audit M4: distinct memory names can sanitise to the same filename. Reuse
  // the primary store's collision resolver — it checks the EXISTING file's
  // frontmatter name and only suffixes when the on-disk name differs (a true
  // collision), so a re-mirror of the SAME memory overwrites in place while
  // two different memories never clobber each other. Because we write each
  // entry to disk before the next iteration, this also covers in-batch
  // collisions (the prior entry is already on disk for the resolver to see).
  for (const e of entries) {
    const fm: MemoryFrontmatter = {
      name: e.name,
      description: e.description,
      type: e.type,
      created: ts,
      updated: ts,
      scope: 'project',
      enabled: true,
    }
    const baseFilename = sanitizeFilename(e.name)
    const filename = resolveFilenameWithoutCollision(realRoot, baseFilename, e.name)
    const raw = serializeMemoryFile(fm, e.content)
    fs.writeFileSync(path.join(realRoot, filename), raw, 'utf-8')
  }
}

async function runMemoryExtractionPipeline(
  config: ProviderConfig,
  model: string,
  summary: string,
  extraExportDir?: string,
  memoryManifest?: string,
): Promise<AutoExtractResult & { created: number; updated: number }> {
  const manifest =
    memoryManifest ?? service.getWorkspaceMemoryManifestForExtraction()
  const result: AutoExtractResult & { created: number; updated: number } = {
    memories: [],
    errors: [],
    created: 0,
    updated: 0,
  }

  try {
    const existingNames = service.getExistingMemoryNames()
    const { system, user } = buildExtractionPrompt(summary, existingNames, manifest)
    const rawResponse = await callLLM(config, model, system, user)
    const extracted = parseExtractionResult(rawResponse)
    if (extracted.length === 0) return result

    const writeResult = await service.batchCreateOrUpdate(extracted)
    result.memories = extracted
    result.created = writeResult.created
    result.updated = writeResult.updated

    if (extraExportDir?.trim()) {
      try {
        mirrorExtractedToDirectory(extraExportDir, extracted)
      } catch (e) {
        console.warn('[AutoExtract] Mirror to extra dir failed:', e)
      }
    }

    console.log(
      `[AutoExtract] Extracted ${extracted.length} memories ` +
        `(created: ${writeResult.created}, updated: ${writeResult.updated})`,
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.warn('[AutoExtract] Failed:', msg)
    result.errors.push(msg)
  }

  return result
}

/** Shared by auto-extract and manual session-memory IPC. */
export function providerConfigFromDisk(): { config: ProviderConfig; model: string } | null {
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AutoExtractOptions {
  autoMemoryDirectory?: string
  conversationId?: string
}

/**
 * Run auto-extraction on the conversation, with cursor/coalescing support.
 * Call without await (fire-and-forget). Supports upstream §4 mechanisms:
 * - the IDE: only processes messages since last extraction
 * - Mutual exclusion: skips if main agent wrote memories this round
 * - Coalescing: stashes new requests when extraction is in-progress
 * - Throttling: configurable extraction interval
 */
export async function autoExtractFromConversation(
  config: ProviderConfig,
  model: string,
  messages: Array<{ role: string; content: string; id?: string }>,
  options?: AutoExtractOptions,
): Promise<AutoExtractResult> {
  const result: AutoExtractResult = { memories: [], errors: [] }

  const conversationId = options?.conversationId || 'default'

  const userMessages = messages.filter((m) => m.role === 'user')
  if (userMessages.length === 0) return result

  const assistantMessages = messages.filter((m) => m.role === 'assistant')
  if (assistantMessages.length === 0) return result

  if (isAutoMemoryGloballyDisabled()) return result

  const flagsEarly = getMemoryFeatureFlags()
  if (isLikelyNonInteractiveHostSession() && !flagsEarly.extractInNonInteractive) {
    return result
  }

  incrementExtractionRound(conversationId)

  const throttleN = getMemoryFeatureFlags().memoryExtractThrottleN
  if (shouldThrottleExtraction(conversationId, throttleN)) {
    return result
  }

  // ── Restore cursor from disk if in-memory cursor is still at defaults ──
  const memDir = service.getActiveWorkspaceMemoryDir()
  const cursor = getExtractionCursor(conversationId)
  if (memDir && cursor.lastMemoryMessageUuid === null && cursor.extractionCount === 0) {
    const diskCursor = await loadExtractionCursor(memDir, conversationId)
    if (diskCursor) {
      cursor.lastMemoryMessageUuid = diskCursor.lastMemoryMessageUuid
      cursor.extractionCount = diskCursor.extractionCount
    }
  }
  const newMsgCount = countMessagesSinceCursor(messages, cursor.lastMemoryMessageUuid)
  if (newMsgCount === 0) return result

  if (inProgress.get(conversationId)) {
    stashPendingContext({
      conversationId,
      messages,
      timestamp: Date.now(),
    })
    return result
  }

  inProgress.set(conversationId, true)

  const extractionPromise = (async () => {
    try {
      // Per-conversation mutex (was F5 in audit): if the MAIN agent already
      // wrote memories for THIS conversation since the last extract round,
      // the LLM fork would just rediscover the same facts. Skip + advance
      // the cursor so the next round only considers messages after the
      // main-agent write. recordMainAgentMemoryWrite is fired from
      // `runAgenticToolUseBody.ts` whenever a memory-tree path is mutated
      // by the main agent.
      //
      // Fallback: `hasRecentMemoryApiWrite(45_000)` still covers IPC-driven
      // user writes (Settings UI "save memory" button, toggle-enabled, etc.)
      // — those don't go through the agentic loop and aren't keyed by
      // conversation. A user clicking save in any chat briefly suppresses
      // every chat's auto-extract; acceptable, it's a rare manual action.
      const skipReason =
        hasMemoryWritesSince(conversationId, 0)
          ? 'main_agent_wrote_in_conv'
          : hasRecentMemoryApiWrite(45_000)
            ? 'recent_ipc_write'
            : null
      if (skipReason) {
        if (messages.length > 0) {
          const lastMsg = messages[messages.length - 1]
          if (lastMsg.id) advanceAndPersistCursor(conversationId, lastMsg.id, memDir)
        }
        // Clear the per-conversation flag so the next round starts fresh.
        // The global flag self-expires on its 45s window.
        clearMainAgentMemoryWrite(conversationId)
        return
      }

      const summary = summarizeConversation(messages, cursor.lastMemoryMessageUuid)
      if (summary.trim().length < 50) return

      const pipeline = await runMemoryExtractionPipeline(
        config,
        model,
        summary,
        options?.autoMemoryDirectory,
        undefined,
      )
      result.memories = pipeline.memories
      result.errors = pipeline.errors

      // Embed/feedback closure (MEM-ARCH1). When new memories were just
      // written to disk, look them up by name in the live memory list and
      // pre-embed them off the critical path. Pre-audit the very next
      // recall paid the embed cost inline (rankMemoriesByEmbedding's
      // "need" branch); now that work moves here, so the next user turn
      // gets warm-cached vector hits.
      //
      // Best-effort + decoupled: any failure logs and continues; nothing
      // about the extraction outcome depends on the embed succeeding.
      if (memDir && (pipeline.created + pipeline.updated > 0) && pipeline.memories.length > 0) {
        try {
          const live = listMemoriesAtRoot(memDir)
          const wantedNames = new Set(pipeline.memories.map((m) => m.name))
          const fresh = live.filter((m) => wantedNames.has(m.frontmatter.name))
          if (fresh.length > 0) {
            const warm = await precomputeMemoryEmbeddings(fresh)
            if (warm.embedded > 0) {
              console.log(
                `[AutoExtract] vector warmup: embedded ${warm.embedded} new ` +
                `memory entr${warm.embedded === 1 ? 'y' : 'ies'} (cached ${warm.cached})`,
              )
            }
          }
        } catch (e) {
          console.warn('[AutoExtract] vector warmup failed (non-fatal):', e)
        }
      }

      if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1]
        if (lastMsg.id) {
          advanceAndPersistCursor(conversationId, lastMsg.id, memDir)
        }
      }

      // ── Auto-consolidation trigger ──
      // If this extraction created or updated memories, bump the
      // consolidation counter and run a background pass when the
      // threshold is reached.
      if (pipeline.created + pipeline.updated > 0 && markExtractionComplete()) {
        const memDir = service.getActiveWorkspaceMemoryDir()
        if (memDir) {
          // Probe once before the consolidation kicks off so we don't pay the dynamic-import +
          // failed-embed cost inside semanticDedup on every extraction when embedding is not
          // configured. Result is cached for ~60s by the consolidate module.
          probeEmbeddingAvailability().then((embedAvailable) =>
            runConsolidation(memDir, { embedAvailable }),
          ).then(async (cr) => {
            if (cr.merged + cr.pruned + cr.compressed > 0) {
              console.log(
                `[AutoConsolidate] ${cr.merged} merged, ${cr.pruned} pruned, ` +
                `${cr.compressed} compressed, ${cr.unchanged} unchanged` +
                (cr.errors.length > 0 ? ` (${cr.errors.length} errors)` : ''),
              )
              // After consolidation merged/pruned MD files, sweep the
              // vector cache for orphan chunks that no longer correspond
              // to a live MD file (MEM2). Best-effort — failures are
              // logged inside the helper and don't impact the extract path.
              try {
                const survivors = listMemoriesAtRoot(memDir).map((m) => ({
                  filename: m.filename,
                  content: m.content,
                }))
                const gc = await pruneOrphanMemoryVectors(survivors)
                if (gc.removed > 0) {
                  console.log(
                    `[AutoConsolidate] vector GC: removed ${gc.removed} orphan ` +
                    `chunk(s) across ${gc.namespaces} namespace(s)`,
                  )
                }
              } catch (e) {
                console.warn('[AutoConsolidate] vector GC failed:', e)
              }
            }
          }).catch((e) =>
            console.warn('[AutoConsolidate] Background pass failed:', e),
          )
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.warn('[AutoExtract] Failed:', msg)
      result.errors.push(msg)
    } finally {
      // Delete (don't `set(false)`) so the Map doesn't keep one entry per
      // conversation forever. The L486 gate uses truthy check, so absence is
      // semantically identical to `false` but releases the key + entry.
      inProgress.delete(conversationId)

      // Reset the per-conversation main-agent-write flag at end-of-round.
      // The skip-branch above also clears it, but a "fall-through and ran"
      // round won't hit that branch. Clearing here keeps the next round's
      // mutex precise — only writes that happen AFTER this point count.
      clearMainAgentMemoryWrite(conversationId)

      const pending = consumePendingContext(conversationId)
      if (pending) {
        console.log('[AutoExtract] Running trailing extraction from stashed context')
        autoExtractFromConversation(config, model, pending.messages, {
          ...options,
          conversationId: pending.conversationId,
        }).catch((e) =>
          console.warn('[AutoExtract] Trailing extraction failed:', e),
        )
      }
    }
  })()

  trackExtraction(extractionPromise)

  return result
}

/**
 * After a task completes, optionally extract memories (when settings auto-memory is on).
 * Skips `plan` / `system` tasks and when `metadata.memoryExtract === false`.
 */
export async function extractMemoryPostTask(
  task: Task,
): Promise<{ created: number; updated: number }> {
  const disk = providerConfigFromDisk()
  if (!disk) return { created: 0, updated: 0 }

  const s = readDiskSettings()
  if (s.autoMemoryEnabled === false || isAutoMemoryGloballyDisabled()) {
    return { created: 0, updated: 0 }
  }

  if (task.metadata.memoryExtract === false) {
    return { created: 0, updated: 0 }
  }

  const resolvedSource = (
    typeof task.source === 'string' && task.source.trim()
      ? task.source.trim().toLowerCase()
      : typeof task.metadata.source === 'string' && String(task.metadata.source).trim()
        ? String(task.metadata.source).trim().toLowerCase()
        : ''
  )
  if (resolvedSource === 'plan' || resolvedSource === 'system') {
    return { created: 0, updated: 0 }
  }

  const parts: string[] = [`[Task] ${task.subject}`]
  if (task.description) parts.push(`[Description] ${task.description}`)
  if (task.activeForm) parts.push(`[Active form] ${task.activeForm}`)
  const metaJson = JSON.stringify(task.metadata)
  if (metaJson.length > 2) {
    parts.push(`[Metadata] ${metaJson.slice(0, 3000)}`)
  }

  const transcript = parts.join('\n\n')
  if (transcript.trim().length < 30) return { created: 0, updated: 0 }

  // Same #4 guard as mirrorExtractedToDirectory: short-circuit a tampered
  // settings.autoMemoryDirectory before it reaches the writer. The writer
  // re-checks (defense in depth), but failing fast keeps the log message
  // attached to the source field rather than the internal mirror site.
  const rawExtraDir =
    typeof s.autoMemoryDirectory === 'string' ? s.autoMemoryDirectory.trim() : ''
  let extraDir: string | undefined
  if (rawExtraDir) {
    const resolvedExtra = path.resolve(rawExtraDir)
    const shape = validateMemoryPath(resolvedExtra)
    const safety = shape.valid ? isUserSuppliedMirrorPathSafe(resolvedExtra) : shape
    if (shape.valid && safety.valid) {
      extraDir = resolvedExtra
    } else {
      console.warn(
        `[AutoExtract] Ignoring settings.autoMemoryDirectory="${rawExtraDir}": ${(shape.valid ? safety : shape).reason}`,
      )
    }
  }

  const pipeline = await runMemoryExtractionPipeline(
    disk.config,
    disk.model,
    transcript,
    extraDir,
  )

  // ── Auto-consolidation trigger (same as autoExtractFromConversation) ──
  if (pipeline.created + pipeline.updated > 0 && markExtractionComplete()) {
    const memDir = service.getActiveWorkspaceMemoryDir()
    if (memDir) {
      probeEmbeddingAvailability().then((embedAvailable) =>
        runConsolidation(memDir, { embedAvailable }),
      ).then(async (cr) => {
        if (cr.merged + cr.pruned + cr.compressed > 0) {
          console.log(
            `[AutoConsolidate] ${cr.merged} merged, ${cr.pruned} pruned, ` +
            `${cr.compressed} compressed, ${cr.unchanged} unchanged` +
            (cr.errors.length > 0 ? ` (${cr.errors.length} errors)` : ''),
          )
          // Vector GC — see autoExtractFromConversation above (MEM2).
          try {
            const survivors = listMemoriesAtRoot(memDir).map((m) => ({
              filename: m.filename,
              content: m.content,
            }))
            const gc = await pruneOrphanMemoryVectors(survivors)
            if (gc.removed > 0) {
              console.log(
                `[AutoConsolidate] vector GC: removed ${gc.removed} orphan ` +
                `chunk(s) across ${gc.namespaces} namespace(s)`,
              )
            }
          } catch (e) {
            console.warn('[AutoConsolidate] vector GC failed:', e)
          }
        }
      }).catch((e) =>
        console.warn('[AutoConsolidate] Background pass failed:', e),
      )
    }
  }

  return { created: pipeline.created, updated: pipeline.updated }
}
