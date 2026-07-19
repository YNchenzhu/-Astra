/**
 * Memory service orchestration.
 * - User-scoped memories → install bundle: `{bundleRoot}/memory/user` (logical id prefix `user:`)
 * - Project/session memories → workspace: `{workspace}/.claude/memory`
 */

import path from 'node:path'
import type {
  MemoryEntry,
  MemoryEntryDisplay,
  CreateMemoryParams,
  UpdateMemoryParams,
  ExtractedMemory,
  MemoryScope,
} from './types'
import {
  sanitizeFilename,
  resolveFilenameWithoutCollision,
  resolveWorkspaceMemoryDir,
  userMemoryDir,
  listMemoriesAtRoot,
  readMemoryFile,
  writeMemoryFile,
  writeMemoryFileAsync,
  deleteMemoryFile,
  rebuildIndexInDir,
  rebuildIndexInDirAsync,
} from './storage'
import * as recall from './recall'
import { RECALL_FINAL_TOP_K } from './recallPipeline'
import { findRelevantMemories, resetSurfacedMemories } from './findRelevantMemories'
import type { SharedQueryEmbedding } from '../embedding/sharedQueryVector'
import { scanWorkspaceMemdir } from './memdir'
import { syncTeamMemory, type BlockedSecretReport } from './teamSync'
import { buildMemorySystemPrompt, buildRecalledMemoryPrompt } from './memoryPrompt'
import { validateMemoryPath } from './pathSafety'
import {
  drainPendingExtractions,
  recordMemoryApiWrite,
  tryAcquireFileLock,
  releaseFileLock,
} from './extractionState'
import { getMemoryFeatureFlags } from './memoryFeatureFlags'
import { appendKairosDailyLogLine } from './kairosDailyLog'
import { userMessageContentToPlainText } from '../utils/userMessageText'

/** Renderer/API filename prefix for bundle (install-side) user memories */
export const USER_MEMORY_LOGICAL_PREFIX = 'user:'

let bundleDataRoot: string = ''
let activeWorkspacePath: string | null = null

export interface RecalledMemoryForUi {
  filename: string
  name: string
  type: string
  matchSnippet: string
}

let lastRecalledForUi: RecalledMemoryForUi[] = []

export function getLastRecalledForUi(): RecalledMemoryForUi[] {
  return lastRecalledForUi
}

export function initMemoryService(bundleRoot: string): void {
  bundleDataRoot = bundleRoot.trim()
}

/** Install-side bundle root (for user memories). Used by Write/Edit path gates. */
export function getMemoryBundleDataRoot(): string {
  return bundleDataRoot
}

/** Resolved workspace memory directory (null if no workspace is open). */
export function getActiveWorkspaceMemoryDir(): string | null {
  return workspaceDir()
}

export function setActiveWorkspace(workspacePath: string | null): void {
  const t = typeof workspacePath === 'string' ? workspacePath.trim() : ''
  activeWorkspacePath = t.length > 0 ? t : null
}

function userDir(): string | null {
  return bundleDataRoot ? userMemoryDir(bundleDataRoot) : null
}

function workspaceDir(): string | null {
  return activeWorkspacePath ? resolveWorkspaceMemoryDir(activeWorkspacePath) : null
}

function resolveDiskLocation(
  logicalFilename: string,
): { dir: string; diskName: string } | null {
  if (logicalFilename.startsWith(USER_MEMORY_LOGICAL_PREFIX)) {
    const dir = userDir()
    if (!dir) return null
    return {
      dir,
      diskName: logicalFilename.slice(USER_MEMORY_LOGICAL_PREFIX.length),
    }
  }
  const dir = workspaceDir()
  if (!dir) return null
  return { dir, diskName: logicalFilename }
}

function listLocalMemoryEntries(): MemoryEntry[] {
  const out: MemoryEntry[] = []
  const ud = userDir()
  if (ud) {
    out.push(...listMemoriesAtRoot(ud))
  }
  const wd = workspaceDir()
  if (wd) {
    out.push(...listMemoriesAtRoot(wd))
  }
  return out
}

function toDisplay(
  entry: MemoryEntry,
  sourcePath?: string,
  logicalUserFile = false,
): MemoryEntryDisplay {
  return {
    filename: logicalUserFile
      ? `${USER_MEMORY_LOGICAL_PREFIX}${entry.filename}`
      : entry.filename,
    name: entry.frontmatter.name,
    description: entry.frontmatter.description,
    type: entry.frontmatter.type,
    content: entry.content,
    updated: entry.frontmatter.updated,
    ageDays: entry.ageDays,
    isStale: entry.isStale,
    scope: entry.frontmatter.scope,
    enabled: entry.frontmatter.enabled ?? true,
    tags: entry.frontmatter.tags,
    sourcePath,
  }
}

function collectMemoriesForRecall(): MemoryEntry[] {
  const byName = new Map<string, MemoryEntry>()

  const ud = userDir()
  if (ud) {
    for (const m of listMemoriesAtRoot(ud)) {
      if (m.frontmatter.enabled === false) continue
      byName.set(m.frontmatter.name.trim().toLowerCase(), {
        ...m,
        filename: `${USER_MEMORY_LOGICAL_PREFIX}${m.filename}`,
      })
    }
  }

  const wd = workspaceDir()
  if (wd) {
    for (const m of listMemoriesAtRoot(wd)) {
      if (m.frontmatter.enabled === false) continue
      byName.set(m.frontmatter.name.trim().toLowerCase(), m)
    }
  }

  if (activeWorkspacePath) {
    for (const e of scanWorkspaceMemdir(activeWorkspacePath)) {
      if (e.frontmatter.enabled === false) continue
      const m: MemoryEntry = {
        filename: `memdir:${e.sourcePath}`,
        frontmatter: e.frontmatter,
        content: e.content,
        ageDays: e.ageDays,
        isStale: e.isStale,
      }
      byName.set(m.frontmatter.name.trim().toLowerCase(), m)
    }
  }

  return [...byName.values()]
}

export function recallForPrompt(
  userMessage: unknown,
  alreadySurfaced: ReadonlySet<string> = new Set(),
): string {
  lastRecalledForUi = []
  const text = userMessageContentToPlainText(userMessage)
  if (!text.trim()) return ''

  const allMemories = collectMemoriesForRecall()
  if (allMemories.length === 0) return ''

  const eligible =
    alreadySurfaced.size > 0
      ? allMemories.filter((m) => !alreadySurfaced.has(m.filename))
      : allMemories
  if (eligible.length === 0) return ''

  // Audit M2: align the sync keyword path's surfaced count with the AI/hybrid
  // path (RECALL_FINAL_TOP_K) so the two entry points don't disagree on how
  // many memories a turn may surface.
  const relevant = recall.recallMemories(text, eligible, RECALL_FINAL_TOP_K)
  if (relevant.length === 0) return ''

  lastRecalledForUi = relevant.map((m) => {
    const line =
      m.content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? ''
    return {
      filename: m.filename,
      name: m.frontmatter.name,
      type: m.frontmatter.type,
      matchSnippet: line.slice(0, 200),
    }
  })

  return recall.formatMemoriesForPrompt(relevant)
}

export function listMemories(): MemoryEntryDisplay[] {
  const merged: MemoryEntryDisplay[] = []
  const ud = userDir()
  if (ud) {
    for (const e of listMemoriesAtRoot(ud)) {
      merged.push(toDisplay(e, undefined, true))
    }
  }
  const wd = workspaceDir()
  if (wd) {
    for (const e of listMemoriesAtRoot(wd)) {
      merged.push(toDisplay(e))
    }
  }
  return merged.sort(
    (a, b) =>
      new Date(b.updated).getTime() - new Date(a.updated).getTime(),
  )
}

export function getMemory(filename: string): MemoryEntryDisplay | null {
  if (filename.startsWith('memdir:')) return null

  const loc = resolveDiskLocation(filename)
  if (!loc) return null

  const entry = readMemoryFile(loc.dir, loc.diskName)
  return entry
    ? toDisplay(
        entry,
        undefined,
        filename.startsWith(USER_MEMORY_LOGICAL_PREFIX),
      )
    : null
}

function targetDirForNewMemory(scope: MemoryScope): string | null {
  if (scope === 'user') {
    return userDir()
  }
  return workspaceDir()
}

export function createMemory(params: CreateMemoryParams): MemoryEntryDisplay {
  const scope = params.scope ?? 'project'
  const dir = targetDirForNewMemory(scope)
  if (!dir) {
    throw new Error(
      scope === 'user'
        ? '用户记忆目录未初始化（安装侧数据根不可用）'
        : '未打开工作区：项目记忆需保存在当前仓库的 .claude/memory 下',
    )
  }

  const filename = sanitizeFilename(params.name)
  const now = new Date().toISOString()

  // F8 collision check (IPC path): unlike the auto-extract pipeline — which
  // silently hash-suffixes on collision so background extractions don't
  // disturb hand-written memories — the IPC-driven create is an explicit
  // user action with an expected filename. If the sanitised filename is
  // already taken by a memory with a DIFFERENT name, surface the conflict
  // back to the UI as an error so the user can pick a unique name instead
  // of silently overwriting.
  const collidingExisting = readMemoryFile(dir, filename)
  if (
    collidingExisting &&
    collidingExisting.frontmatter.name.trim().toLowerCase() !==
      params.name.trim().toLowerCase()
  ) {
    throw new Error(
      `Cannot create memory "${params.name}": the sanitised filename ` +
      `"${filename}" is already used by a different memory named ` +
      `"${collidingExisting.frontmatter.name}". Pick a more distinctive name.`,
    )
  }

  // Acquire file-level lock: avoid racing with auto-extract.
  if (!tryAcquireFileLock(filename, 'agent')) {
    throw new Error(`Cannot create "${filename}" — file is locked by another writer. Retry in a moment.`)
  }

  try {
    const entry = writeMemoryFile(dir, filename, {
      name: params.name,
      description: params.description,
      type: params.type,
      created: now,
      updated: now,
      scope,
      enabled: params.enabled !== false,
      tags: params.tags,
    }, params.content)

    rebuildIndexInDir(dir)
    recordMemoryApiWrite()
    maybeAppendKairosLine(`Memory created: ${params.name}`)
    return toDisplay(entry, undefined, scope === 'user')
  } finally {
    releaseFileLock(filename)
  }
}

function maybeAppendKairosLine(line: string): void {
  const ws = activeWorkspacePath?.trim()
  if (!ws || !getMemoryFeatureFlags().kairosDailyLogEnabled) return
  try {
    appendKairosDailyLogLine(ws, line)
  } catch {
    /* ignore */
  }
}

export function updateMemory(
  params: UpdateMemoryParams,
): MemoryEntryDisplay | null {
  // Audit fix A4: `memdir:` entries are workspace-scanned read-only sources
  // (raw markdown under `<workspace>/.claude/memdir/`). Previously this
  // path silently returned `null`, and the UI surfaced it as "update failed"
  // with no explanation. Throw a clear error so the renderer can show the
  // user why mutation was refused. Same treatment in `deleteMemory` and
  // `toggleMemoryEnabled` below.
  if (params.filename.startsWith('memdir:')) {
    throw new Error(
      'Memdir entries are read-only — they are raw markdown files scanned ' +
      'from the workspace and cannot be updated through the memory API. ' +
      'Edit the source markdown file directly.',
    )
  }

  const loc = resolveDiskLocation(params.filename)
  if (!loc) return null

  const existing = readMemoryFile(loc.dir, loc.diskName)
  if (!existing) return null

  // Acquire file-level lock: avoid racing with auto-extract.
  // Audit M8: throw on contention instead of returning `null`. A bare `null`
  // is indistinguishable from "memory not found" to the IPC caller / UI;
  // surfacing a distinct error lets the renderer tell the user to retry
  // (mirrors createMemory's lock-contention behaviour).
  if (!tryAcquireFileLock(loc.diskName, 'agent')) {
    throw new Error(
      `Cannot update "${loc.diskName}" — file is locked by another writer. Retry in a moment.`,
    )
  }

  try {
    const entry = writeMemoryFile(loc.dir, loc.diskName, {
      name: params.name ?? existing.frontmatter.name,
      description: params.description ?? existing.frontmatter.description,
      type: params.type ?? existing.frontmatter.type,
      created: existing.frontmatter.created,
      updated: existing.frontmatter.updated,
      scope: params.scope ?? existing.frontmatter.scope,
      enabled: params.enabled ?? existing.frontmatter.enabled ?? true,
      tags: params.tags ?? existing.frontmatter.tags,
    }, params.content ?? existing.content)

    rebuildIndexInDir(loc.dir)
    recordMemoryApiWrite()
    maybeAppendKairosLine(`Memory updated: ${entry.frontmatter.name}`)
    return toDisplay(
      entry,
      undefined,
      params.filename.startsWith(USER_MEMORY_LOGICAL_PREFIX),
    )
  } finally {
    releaseFileLock(loc.diskName)
  }
}

export function deleteMemory(filename: string): boolean {
  if (filename.startsWith('memdir:')) {
    throw new Error(
      'Memdir entries are read-only — they are raw markdown files scanned ' +
      'from the workspace and cannot be deleted through the memory API. ' +
      'Delete the source markdown file directly.',
    )
  }

  const loc = resolveDiskLocation(filename)
  if (!loc) return false

  const ok = deleteMemoryFile(loc.dir, loc.diskName)
  if (ok) {
    rebuildIndexInDir(loc.dir)
  }
  return ok
}

export async function batchCreateOrUpdate(entries: ExtractedMemory[]): Promise<{
  created: number
  updated: number
}> {
  const wd = workspaceDir()
  if (!wd || entries.length === 0) return { created: 0, updated: 0 }

  let created = 0
  let updated = 0

  for (const entry of entries) {
    // F8 collision check: when the sanitised filename is already taken by
    // an entry with a DIFFERENT `frontmatter.name`, hash-suffix the
    // filename instead of silently overwriting whatever the user hand-wrote
    // there. Same-name updates (the common case) pass through untouched.
    const rawFilename = sanitizeFilename(entry.name)
    const filename = resolveFilenameWithoutCollision(wd, rawFilename, entry.name)
    if (filename !== rawFilename) {
      console.log(
        `[Memory] Auto-extract: filename "${rawFilename}" collides with existing memory; ` +
        `using "${filename}" instead to avoid overwriting a different memory.`,
      )
    }

    // Acquire per-file lock to avoid racing with main-agent writes.
    // This is a non-blocking try — if locked we skip that entry rather
    // than slowing down the extraction pipeline.
    if (!tryAcquireFileLock(filename, 'auto-extract')) {
      console.log(`[Memory] Skipping "${filename}" — locked by another writer`)
      continue
    }

    try {
      const existing = readMemoryFile(wd, filename)
      const now = new Date().toISOString()

      await writeMemoryFileAsync(wd, filename, {
        name: entry.name,
        description: entry.description,
        type: entry.type,
        created: existing ? existing.frontmatter.created : now,
        updated: now,
        scope: existing?.frontmatter.scope ?? 'project',
        enabled: existing?.frontmatter.enabled !== false,
        tags: existing?.frontmatter.tags,
      }, entry.content)

      if (existing) {
        updated++
      } else {
        created++
      }
    } finally {
      releaseFileLock(filename)
    }
  }

  await rebuildIndexInDirAsync(wd)
  // Intentionally NOT calling recordMemoryApiWrite() here: this entry point
  // is invoked by the auto-extract pipeline itself (electron/memory/autoExtract.ts).
  // Bumping the global timestamp would poison every OTHER active conversation's
  // next auto-extract round via hasRecentMemoryApiWrite — cross-conversation
  // false-positive that was the original F5 motivation. The per-conversation
  // mutex is owned by recordMainAgentMemoryWrite / hasMemoryWritesSince now;
  // IPC-driven user writes still bump the global flag via createMemory /
  // updateMemory / toggleMemoryEnabled below.
  if (created + updated > 0) {
    maybeAppendKairosLine(`Auto-extract: +${created} created, ${updated} updated`)
  }
  return { created, updated }
}

/** Manifest for durable extract prompt (upstream §4 — pre-inject scan). */
export function getWorkspaceMemoryManifestForExtraction(): string {
  const wd = workspaceDir()
  if (!wd) return ''
  return listMemoriesAtRoot(wd)
    .map(
      (e) =>
        `- [${e.frontmatter.type}] ${e.filename}: ${e.frontmatter.description || e.frontmatter.name}`,
    )
    .slice(0, 80)
    .join('\n')
}

export function getExistingMemoryNames(): string[] {
  return listLocalMemoryEntries().map((m) => m.frontmatter.name)
}

export function scanMemdir(): MemoryEntryDisplay[] {
  const localDisp = listMemories()

  if (!activeWorkspacePath) return localDisp

  const ext = scanWorkspaceMemdir(activeWorkspacePath)
  const extDisp = ext.map((e) =>
    toDisplay(
      {
        filename: `memdir:${path.basename(e.sourcePath)}`,
        frontmatter: e.frontmatter,
        content: e.content,
        ageDays: e.ageDays,
        isStale: e.isStale,
      },
      e.sourcePath,
    ),
  )

  const seen = new Set(localDisp.map((d) => d.name.trim().toLowerCase()))
  const merged = [...localDisp]
  for (const d of extDisp) {
    const k = d.name.trim().toLowerCase()
    if (seen.has(k)) continue
    merged.push(d)
    seen.add(k)
  }

  return merged.sort(
    (a, b) =>
      new Date(b.updated).getTime() - new Date(a.updated).getTime(),
  )
}

export function runTeamMemorySync(): {
  exported: number
  imported: number
  teamDir: string
  blockedSecrets: BlockedSecretReport[]
} {
  if (!activeWorkspacePath) {
    return { exported: 0, imported: 0, teamDir: '', blockedSecrets: [] }
  }
  return syncTeamMemory(activeWorkspacePath)
}

export function toggleMemoryEnabled(
  filename: string,
  enabled: boolean,
): MemoryEntryDisplay | null {
  if (filename.startsWith('memdir:')) {
    throw new Error(
      'Memdir entries are read-only — they are raw markdown files scanned ' +
      'from the workspace and cannot be toggled enabled/disabled through ' +
      'the memory API. Move or rename the source markdown file instead.',
    )
  }

  const loc = resolveDiskLocation(filename)
  if (!loc) return null

  const existing = readMemoryFile(loc.dir, loc.diskName)
  if (!existing) return null

  const entry = writeMemoryFile(loc.dir, loc.diskName, {
    ...existing.frontmatter,
    enabled,
  }, existing.content)
  rebuildIndexInDir(loc.dir)
  recordMemoryApiWrite()
  return toDisplay(
    entry,
    undefined,
    filename.startsWith(USER_MEMORY_LOGICAL_PREFIX),
  )
}

// ---------------------------------------------------------------------------
// AI-based recall (upstream §2.6)
// ---------------------------------------------------------------------------

/**
 * AI-powered recall: uses LLM to select the most relevant memories.
 * Falls back to keyword scoring when LLM is unavailable.
 *
 * @param userMessage - the user message text (or multimodal content)
 * @param alreadySurfaced - set of memory filenames to exclude (upstream pattern:
 *   derived from the current conversation's prior `relevant_memories` attachments,
 *   so memories we just showed aren't re-surfaced on the next turn)
 * @param opts.shared - upstream-computed query embedding (prefetch pipeline)
 * @param opts.outRecalled - optional output array — when provided, the
 *   recalled memory descriptors are appended here so the caller has a
 *   per-call snapshot. The module-level `lastRecalledForUi` is also
 *   updated for the IPC `memory:last-recalled` UI surface, but that
 *   global is best-effort across parallel conversations: use this output
 *   parameter when correctness within one call matters (e.g. the
 *   retrieval prefetch threading recalled memories into a single turn's
 *   relevant_memories attachment).
 */
export async function recallForPromptAI(
  userMessage: unknown,
  alreadySurfaced: ReadonlySet<string> = new Set(),
  opts: {
    shared?: SharedQueryEmbedding
    outRecalled?: RecalledMemoryForUi[]
    /** Cosine floor for the vector source — passed straight through. Default 0. */
    minScore?: number
  } = {},
): Promise<string> {
  lastRecalledForUi = []
  const text = userMessageContentToPlainText(userMessage)
  if (!text.trim()) return ''

  const allMemories = collectMemoriesForRecall()
  if (allMemories.length === 0) return ''

  const relevant = await findRelevantMemories(text, allMemories, alreadySurfaced, {
    shared: opts.shared,
    minScore: opts.minScore,
  })
  if (relevant.length === 0) return ''

  const recalled: RecalledMemoryForUi[] = relevant.map((m) => {
    const line =
      m.content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? ''
    return {
      filename: m.filename,
      name: m.frontmatter.name,
      type: m.frontmatter.type,
      matchSnippet: line.slice(0, 200),
    }
  })
  lastRecalledForUi = recalled
  if (opts.outRecalled) {
    for (const m of recalled) opts.outRecalled.push(m)
  }

  return buildRecalledMemoryPrompt(
    relevant.map((m) => ({
      name: m.frontmatter.name,
      type: m.frontmatter.type,
      content: m.content,
      ageDays: m.ageDays,
      isStale: m.isStale,
    })),
  )
}

/**
 * Reset the surfaced-memories tracking (call at session/conversation start).
 */
export function resetMemoryRecallState(): void {
  resetSurfacedMemories()
  lastRecalledForUi = []
  resetSessionRecallBudget()
}

// ---------------------------------------------------------------------------
// System prompt memory section (upstream §7.1)
// ---------------------------------------------------------------------------

/**
 * Build the full memory section for injection into the system prompt.
 *
 * Audit fix B-1 (2026-05) — when the memory store is empty (no
 * curated entries AND no memdir markdown), emit a short one-line
 * note instead of the full multi-page tutorial. The tutorial teaches
 * the model "you have a memory system" which on a fresh install
 * triggers reflexive "let me check memory" loops that always return
 * zero hits and waste turns. The short note still tells the model
 * the subsystem exists (so it doesn't claim "you have no memory of
 * me"), without inviting empty recall checks.
 */
export function getMemorySystemPromptSection(autoMemoryEnabled: boolean): string {
  if (!autoMemoryEnabled) return ''
  // Defensive: if listMemories throws (e.g. service not initialised),
  // fall back to the full tutorial — strictly better than silently
  // omitting memory awareness on a transient init race.
  let nonEmpty = true
  try {
    nonEmpty = listMemories().length > 0 || scanMemdir().length > 0
  } catch {
    nonEmpty = true
  }
  if (!nonEmpty) {
    return [
      '# Memory System',
      '',
      'A persistent memory subsystem is wired up but currently EMPTY for this workspace and user.',
      'No prior memory entries have been recorded; do NOT spend tool calls "checking memory" reflexively.',
      'If the user explicitly asks to remember / recall something, the relevant tools are still available — full schema documentation will be re-injected once entries exist.',
    ].join('\n')
  }
  return buildMemorySystemPrompt({
    workspacePath: activeWorkspacePath,
    autoMemoryEnabled,
  })
}

// ---------------------------------------------------------------------------
// Path safety (upstream §2.5)
// ---------------------------------------------------------------------------

/**
 * Validate a path before using it as a memory directory.
 */
export function validateMemoryDirectory(dir: string): { valid: boolean; reason?: string } {
  return validateMemoryPath(dir)
}

// ---------------------------------------------------------------------------
// Drain for graceful shutdown (upstream §4.6)
// ---------------------------------------------------------------------------

export { drainPendingExtractions }

// ---------------------------------------------------------------------------
// P0 session-level recall budget (see `retrievalPrefetch.ts`)
// ---------------------------------------------------------------------------
//
// Pre-audit this was a single process-wide counter, which meant a busy
// workspace conversation could exhaust the budget and silently disable
// memory recall in every other parallel chat. It's now per-conversationId
// so two chats can each have their own budget. The Map is bounded with a
// soft LRU cap (entries pop on size, oldest first via insertion-order Map
// semantics) so a long-running app that opens hundreds of conversations
// doesn't keep stale counters around forever.

const SESSION_RECALL_MAX_BUCKETS = 256
const sessionRecalledBytesByConv = new Map<string, number>()
const SESSION_DEFAULT_KEY = '__default__'

function normConvKey(conversationId?: string | null): string {
  const t = typeof conversationId === 'string' ? conversationId.trim() : ''
  return t.length > 0 ? t : SESSION_DEFAULT_KEY
}

function touchConvBucket(key: string, n: number): void {
  // Bounded LRU: refresh insertion order on touch; evict oldest on overflow.
  const prev = sessionRecalledBytesByConv.get(key) ?? 0
  if (sessionRecalledBytesByConv.has(key)) {
    sessionRecalledBytesByConv.delete(key)
  } else if (sessionRecalledBytesByConv.size >= SESSION_RECALL_MAX_BUCKETS) {
    const oldest = sessionRecalledBytesByConv.keys().next().value
    if (oldest !== undefined) sessionRecalledBytesByConv.delete(oldest)
  }
  sessionRecalledBytesByConv.set(key, prev + n)
}

/** Reset every conversation's recall budget. Called on workspace switch. */
export function resetSessionRecallBudget(): void {
  sessionRecalledBytesByConv.clear()
}

/** Drop the bucket for one conversation (call when the conversation is deleted). */
export function clearSessionRecallBudgetForConversation(conversationId?: string | null): void {
  sessionRecalledBytesByConv.delete(normConvKey(conversationId))
}

export function recordSessionRecallBytes(n: number, conversationId?: string | null): void {
  if (!Number.isFinite(n) || n <= 0) return
  touchConvBucket(normConvKey(conversationId), n)
}

export function getSessionRecallBytes(conversationId?: string | null): number {
  return sessionRecalledBytesByConv.get(normConvKey(conversationId)) ?? 0
}
