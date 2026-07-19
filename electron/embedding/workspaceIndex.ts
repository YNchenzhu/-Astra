/**
 * Workspace (codebase) semantic index.
 *
 *   root directory → walk source files → chunk per file → embed → upsert into
 *   vectorStore namespace `workspace-<sha1(absRoot):16>`.
 *
 * Key design choices:
 *
 *  - **One namespace per workspace root**. Switching workspaces transparently
 *    uses a different namespace; no mixing of vectors.
 *  - **Chunker is line-window based** (sliding ~120 lines with 20-line overlap)
 *    which matches source code structure far better than the paragraph
 *    chunker used for attachments. Keeps function bodies + surrounding
 *    context inside the same chunk most of the time.
 *  - **Batched embeds** (64 chunks/batch) to amortize cloud API / ONNX startup.
 *  - **Persistent status sidecar** at `{userData}/workspace-index-meta/<nsHash>.json`
 *    so the UI can show `indexed / stale / builtAt / fileCount / chunkCount`
 *    without replaying the whole scan.
 *  - **Progress callback** for the IPC handler to stream progress to the
 *    renderer — long workspaces can take 10–60s on cloud, users need feedback.
 *
 * This module deliberately does **not** import any renderer state; all
 * settings are read fresh via `readDiskSettings` for each call, so the
 * renderer never has to proxy them.
 */

import { mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import { readDiskSettings } from '../settings/settingsAccess'
import { dispatchEmbed, type EmbeddingMode } from './dispatch'
import { walkChunkInWorker } from './localModel'
import { wrapWithFingerprint } from './resolved'
import { buildNamespace, sourceHashOf, type SourceKey } from './namespaces'
import { entriesByKind } from './registry'
import type { EmbeddingProviderConfig } from './types'
import {
  dropNamespace as vsDropNamespace,
  hasNamespace as vsHasNamespace,
  patchNamespace as vsPatchNamespace,
  queryTopK as vsQueryTopK,
  readNamespaceChunks as vsReadNamespaceChunks,
  upsertNamespace as vsUpsertNamespace,
  type Chunk,
  type ScoredChunk,
} from './vectorStore'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceIndexStatus {
  indexed: boolean
  namespace: string
  filesScanned: number
  filesIndexed: number
  chunkCount: number
  bytesSource: number
  model: string
  dim: number
  builtAt: number
  durationMs: number
  /** Reports per-file failure reasons so the UI can surface partial failures. */
  errors: Array<{ file: string; error: string }>
}

export interface BuildOptions {
  /** Force a full rebuild even when a namespace already exists. */
  force?: boolean
  /** Hard cap on files scanned — prevents runaway embed costs on monorepos. */
  maxFiles?: number
  /** Hard cap on bytes per file — skips minified bundles / generated output. */
  maxBytesPerFile?: number
  /** Optional per-progress-tick callback (e.g., IPC streaming). */
  onProgress?: (tick: BuildProgressTick) => void
}

export interface BuildProgressTick {
  phase: 'walk' | 'chunk' | 'embed' | 'upsert' | 'done'
  filesScanned: number
  filesIndexed: number
  chunksEmbedded: number
  chunksTotal: number
}

export interface QueryHit extends ScoredChunk {
  filePath: string
  startLine: number
  endLine: number
}

// ---------------------------------------------------------------------------
// Namespace + status persistence
// ---------------------------------------------------------------------------
//
// Namespacing model (post v2 migration):
//
//   Each (workspace root × embedding-model fingerprint) gets its own
//   namespace named `workspace-<srcHash16>-<fp12>`. Switching embedding
//   models therefore writes/reads a different namespace — old indexes
//   stay on disk (queryable if the user switches back) but never poison
//   queries from the new model.
//
//   The status sidecar (filesScanned / errors / etc.) is keyed by the
//   namespace string, so each (root × fp) pair has its own sidecar.

/** Build the workspace SourceKey — same input regardless of fingerprint. */
function workspaceSourceKey(root: string): SourceKey {
  const norm = path.resolve(root).replace(/\\/g, '/').toLowerCase()
  return { kind: 'workspace', id: norm }
}

/** Stable 16-hex hash of the workspace root — used in the namespace. */
function workspaceSourceHash(root: string): string {
  return sourceHashOf(workspaceSourceKey(root))
}

/**
 * Compose the fp-bearing namespace for this workspace+model. Callers that
 * have already embedded once (or want to bypass the embed step for status
 * lookups) provide the fp directly.
 */
function workspaceNamespaceFor(root: string, fp: string): string {
  return buildNamespace(workspaceSourceKey(root), fp)
}

/**
 * Legacy namespace shape (pre-v2). Still readable for back-compat: if the
 * user built an index before the migration, we surface its status until
 * they rebuild. Read-only — never written.
 */
function legacyWorkspaceNamespace(root: string): string {
  return `workspace-${workspaceSourceHash(root)}`
}

async function statusDir(): Promise<string> {
  const d = path.join(app.getPath('userData'), 'workspace-index-meta')
  await mkdir(d, { recursive: true })
  return d
}

async function readStatus(ns: string): Promise<WorkspaceIndexStatus | null> {
  try {
    const d = await statusDir()
    const raw = await readFile(path.join(d, `${ns}.json`), 'utf8')
    const parsed = JSON.parse(raw) as WorkspaceIndexStatus
    if (parsed && typeof parsed === 'object' && parsed.namespace === ns) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

async function writeStatus(status: WorkspaceIndexStatus): Promise<void> {
  try {
    const d = await statusDir()
    await writeFile(path.join(d, `${status.namespace}.json`), JSON.stringify(status), 'utf8')
  } catch {
    /* non-fatal — status is advisory */
  }
}

/**
 * Find the *most recent* indexed namespace belonging to this workspace.
 *
 * Used by the UI when the user hasn't yet performed any embed call (so we
 * don't know the active fp). We pick the newest entry from the registry
 * filtered by `sourceHash`. After a fresh embed succeeds the caller can
 * also pass the resolved fp explicitly, in which case that wins.
 */
async function findActiveWorkspaceNamespace(root: string, preferredFp?: string): Promise<string | null> {
  const sh = workspaceSourceHash(root)
  const ws = (await entriesByKind('workspace')).filter((e) => e.ns.includes(`-${sh}-`))
  if (ws.length === 0) {
    // Legacy fallback: pre-v2 single-namespace shape.
    const legacy = legacyWorkspaceNamespace(root)
    if (await vsHasNamespace(legacy)) return legacy
    return null
  }
  if (preferredFp) {
    const exact = ws.find((e) => e.fp === preferredFp)
    if (exact) return exact.ns
  }
  // Newest first.
  ws.sort((a, b) => b.builtAt - a.builtAt)
  return ws[0].ns
}

export async function getWorkspaceIndexStatus(root: string): Promise<WorkspaceIndexStatus> {
  const ns = (await findActiveWorkspaceNamespace(root)) ?? legacyWorkspaceNamespace(root)
  const stored = await readStatus(ns)
  const exists = await vsHasNamespace(ns)
  if (stored && exists) return { ...stored, indexed: true }
  return {
    indexed: exists,
    namespace: ns,
    filesScanned: stored?.filesScanned ?? 0,
    filesIndexed: stored?.filesIndexed ?? 0,
    chunkCount: stored?.chunkCount ?? 0,
    bytesSource: stored?.bytesSource ?? 0,
    model: stored?.model ?? '',
    dim: stored?.dim ?? 0,
    builtAt: stored?.builtAt ?? 0,
    durationMs: stored?.durationMs ?? 0,
    errors: stored?.errors ?? [],
  }
}

/**
 * Drop *all* namespaces belonging to this workspace, regardless of which
 * embedding model produced them. The "clear" button in Settings is a
 * blanket wipe — when a user wants to remove only stale-fp indexes, they
 * use the per-fp GC button in the cache panel (see registry GC IPC).
 */
export async function clearWorkspaceIndex(root: string): Promise<{ ok: true; cleared: number }> {
  const sh = workspaceSourceHash(root)
  const ws = (await entriesByKind('workspace')).filter((e) => e.ns.includes(`-${sh}-`))
  let cleared = 0
  for (const e of ws) {
    await vsDropNamespace(e.ns)
    try {
      const d = await statusDir()
      await writeFile(path.join(d, `${e.ns}.json`), '', 'utf8').catch(() => {})
    } catch { /* non-fatal */ }
    cleared++
  }
  // Also sweep the legacy single-namespace shape (idempotent if absent).
  const legacy = legacyWorkspaceNamespace(root)
  if (await vsHasNamespace(legacy)) {
    await vsDropNamespace(legacy)
    cleared++
  }
  return { ok: true, cleared }
}

// ---------------------------------------------------------------------------
// Chunker (line-window, code-friendly) — still needed for incremental updates
// ---------------------------------------------------------------------------

const CHUNK_WINDOW_LINES = 120
const CHUNK_OVERLAP_LINES = 20
const CHUNK_MAX_CHARS = 4_000

export interface CodeChunk {
  id: string
  text: string
  relPath: string
  startLine: number
  endLine: number
}

export function chunkCodeFile(relPath: string, content: string): CodeChunk[] {
  const lines = content.split(/\r?\n/)
  if (lines.length === 0) return []
  const out: CodeChunk[] = []
  let i = 0
  const fileId = relPath.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)
  while (i < lines.length) {
    const end = Math.min(lines.length, i + CHUNK_WINDOW_LINES)
    let text = lines.slice(i, end).join('\n')
    if (text.length > CHUNK_MAX_CHARS) text = text.slice(0, CHUNK_MAX_CHARS)
    if (text.trim().length > 0) {
      out.push({ id: `${fileId}:${i + 1}-${end}`, text, relPath, startLine: i + 1, endLine: end })
    }
    if (end >= lines.length) break
    i = end - CHUNK_OVERLAP_LINES
    if (i <= (out[out.length - 1]?.startLine ?? 0)) i = end
  }
  return out
}

// Conservative extension list — anything not in here is skipped.
const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.scala',
  '.c', '.cc', '.cpp', '.h', '.hpp',
  '.cs', '.fs', '.swift', '.m', '.mm',
  '.php', '.lua', '.dart', '.ex', '.exs', '.erl', '.clj',
  '.sh', '.bash', '.zsh', '.ps1',
  '.sql', '.graphql', '.proto',
  '.vue', '.svelte', '.astro',
  '.css', '.scss', '.less', '.sass',
  '.html', '.htm',
  '.md', '.mdx', '.rst', '.txt',
])

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'dist-electron', 'build', 'out', 'target', 'release',
  '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache',
  'coverage', '.nyc_output',
  '__pycache__', '.venv', 'venv', 'env',
  '.idea', '.vscode', '.cursor', '.claude',
  'vendor',
])

const SKIP_FILE_PATTERNS: RegExp[] = [
  /\.min\.(js|css)$/i,
  /\.bundle\.(js|css)$/i,
  /\.map$/i,
  /^(package-lock|yarn|pnpm-lock)\.(json|yaml|lock)$/i,
]

// ---------------------------------------------------------------------------
// Embedding config bridge
// ---------------------------------------------------------------------------

interface WsSettings {
  embeddingProviderId?: string
  embeddingModel?: string
  embeddingApiKey?: string
  embeddingBaseUrl?: string
  embeddingDimensions?: number
  embeddingMode?: EmbeddingMode
  embeddingLocalModelId?: string
}

function getCloudConfig(s: WsSettings): EmbeddingProviderConfig | null {
  if (!s.embeddingProviderId || !s.embeddingModel) return null
  return {
    providerId: s.embeddingProviderId,
    model: s.embeddingModel,
    apiKey: s.embeddingApiKey,
    baseUrl: s.embeddingBaseUrl,
    dimensions: s.embeddingDimensions,
  }
}

// ---------------------------------------------------------------------------
// Build + query
// ---------------------------------------------------------------------------

const EMBED_BATCH = 64
const workspaceLazyRehydrateInflight = new Map<string, Promise<void>>()
const workspaceIncrementalInflight = new Map<
  string,
  Promise<WorkspaceIndexStatus | null>
>()

function normalizedWorkspaceKey(root: string): string {
  return path.resolve(root).replace(/\\/g, '/').toLowerCase()
}

function buildDispatchCfg(settings: WsSettings) {
  return {
    mode: settings.embeddingMode || 'auto',
    localModelId: settings.embeddingLocalModelId,
    cloud: getCloudConfig(settings) || undefined,
  } satisfies {
    mode: EmbeddingMode
    localModelId?: string
    cloud?: EmbeddingProviderConfig
  }
}

function normalizeWorkspaceRelPath(root: string, absPath: string): string {
  return path.relative(path.resolve(root), path.resolve(absPath)).replace(/\\/g, '/')
}

function isWorkspaceIndexablePath(root: string, absPath: string): boolean {
  const rel = normalizeWorkspaceRelPath(root, absPath)
  if (!rel || rel.startsWith('..')) return false
  const parts = rel.split('/').filter(Boolean)
  if (parts.some((p) => SKIP_DIRS.has(p))) return false
  const base = path.basename(absPath)
  if (SKIP_FILE_PATTERNS.some((r) => r.test(base))) return false
  return CODE_EXTS.has(path.extname(base).toLowerCase())
}

async function queueWorkspaceLazyRehydrate(root: string): Promise<void> {
  const key = normalizedWorkspaceKey(root)
  const existing = workspaceLazyRehydrateInflight.get(key)
  if (existing) return existing
  const task = (async () => {
    try {
      await buildWorkspaceIndex(root, { force: true })
    } catch (err) {
      console.warn(
        '[workspaceIndex] lazy rehydrate failed:',
        err instanceof Error ? err.message : String(err),
      )
    } finally {
      workspaceLazyRehydrateInflight.delete(key)
    }
  })()
  workspaceLazyRehydrateInflight.set(key, task)
  return task
}

function toQueryHits(hits: ScoredChunk[]): QueryHit[] {
  return hits.map((h) => {
    const meta = h.meta || {}
    return {
      ...h,
      filePath: typeof meta.relPath === 'string' ? meta.relPath : '',
      startLine: typeof meta.startLine === 'number' ? meta.startLine : 0,
      endLine: typeof meta.endLine === 'number' ? meta.endLine : 0,
    }
  })
}

export async function buildWorkspaceIndex(
  root: string,
  options: BuildOptions = {},
): Promise<WorkspaceIndexStatus> {
  const start = Date.now()
  const maxFiles = options.maxFiles ?? 5_000
  const maxBytesPerFile = options.maxBytesPerFile ?? 200_000
  const errors: Array<{ file: string; error: string }> = []

  const settings = readDiskSettings() as WsSettings
  const mode: EmbeddingMode = settings.embeddingMode || 'auto'
  const cloud = getCloudConfig(settings)
  if (mode === 'cloud' && !cloud) {
    throw new Error('Cloud 嵌入模式未配置嵌入模型')
  }

  // Walk + chunk (delegated to worker for isolation)
  options.onProgress?.({ phase: 'walk', filesScanned: 0, filesIndexed: 0, chunksEmbedded: 0, chunksTotal: 0 })
  const walkResult = await walkChunkInWorker(root, {
    maxFiles,
    maxBytesPerFile,
    onProgress: (wp) => {
      options.onProgress?.({
        phase: 'walk',
        filesScanned: wp.filesScanned,
        filesIndexed: wp.filesIndexed,
        chunksEmbedded: 0,
        chunksTotal: wp.totalChunks,
      })
    },
  })

  const { filesScanned: scannedCount, chunks: fileChunks, errors: walkErrors } = walkResult
  errors.push(...walkErrors)

  // Flatten chunks
  const allChunks: CodeChunk[] = []
  let filesIndexed = 0
  let bytesSource = 0
  for (const fc of fileChunks) {
    allChunks.push(...fc.chunks)
    filesIndexed += 1
    bytesSource += fc.size
  }

  // Empty workspace — wipe every fp's namespace for this root so the UI
  // ("0 个代码块") matches reality.
  if (allChunks.length === 0) {
    await clearWorkspaceIndex(root)
    const placeholderNs = workspaceNamespaceFor(
      root,
      // synthetic 12-hex placeholder ('e' for "empty"); never matches a real fp
      'e0e0e0e0e0e0',
    )
    const status: WorkspaceIndexStatus = {
      indexed: false,
      namespace: placeholderNs,
      filesScanned: scannedCount,
      filesIndexed: 0,
      chunkCount: 0,
      bytesSource,
      model: '',
      dim: 0,
      builtAt: Date.now(),
      durationMs: Date.now() - start,
      errors,
    }
    options.onProgress?.({ phase: 'done', filesScanned: scannedCount, filesIndexed: 0, chunksEmbedded: 0, chunksTotal: 0 })
    return status
  }

  // ----- First batch determines fp -----
  // We embed batch #1 immediately so we know the resolved model + fp before
  // anything else. Once fp is known we can short-circuit on `hasNamespace`
  // when the caller didn't pass `force`.
  const dispatchCfg = { mode, localModelId: settings.embeddingLocalModelId, cloud: cloud || undefined }
  const firstBatch = allChunks.slice(0, EMBED_BATCH)
  const firstRaw = await dispatchEmbed(dispatchCfg, firstBatch.map((c) => c.text))
  if (!firstRaw.ok) {
    throw new Error(`嵌入失败（批次 1）：${firstRaw.error}`)
  }
  const firstFp = wrapWithFingerprint(dispatchCfg, firstRaw)
  const ns = workspaceNamespaceFor(root, firstFp.fp)
  const model = firstFp.modelLabel
  const dim = firstFp.dim

  // Short-circuit: caller didn't force a rebuild AND we already have
  // vectors for this exact (root × fp). Saves the rest of the embed cost.
  if (!options.force && (await vsHasNamespace(ns))) {
    const stored = await readStatus(ns)
    if (stored) {
      options.onProgress?.({ phase: 'done', filesScanned: scannedCount, filesIndexed, chunksEmbedded: stored.chunkCount, chunksTotal: stored.chunkCount })
      return { ...stored, indexed: true }
    }
  }

  const vectors: number[][] = [...firstRaw.vectors]
  options.onProgress?.({
    phase: 'embed',
    filesScanned: scannedCount,
    filesIndexed,
    chunksEmbedded: vectors.length,
    chunksTotal: allChunks.length,
  })
  for (let off = EMBED_BATCH; off < allChunks.length; off += EMBED_BATCH) {
    const batch = allChunks.slice(off, off + EMBED_BATCH)
    const r = await dispatchEmbed(dispatchCfg, batch.map((c) => c.text))
    if (!r.ok) {
      throw new Error(`嵌入失败（批次 ${off / EMBED_BATCH + 1}）：${r.error}`)
    }
    if (r.dim !== dim) {
      throw new Error(`嵌入维度不一致：前批 ${dim} vs 本批 ${r.dim}（请删除模型缓存后重试）`)
    }
    vectors.push(...r.vectors)
    options.onProgress?.({
      phase: 'embed',
      filesScanned: scannedCount,
      filesIndexed,
      chunksEmbedded: vectors.length,
      chunksTotal: allChunks.length,
    })
  }

  // Upsert.
  options.onProgress?.({ phase: 'upsert', filesScanned: scannedCount, filesIndexed, chunksEmbedded: vectors.length, chunksTotal: allChunks.length })
  const storeChunks: Chunk[] = allChunks.map((c, idx) => ({
    id: c.id,
    index: idx,
    text: c.text,
    meta: {
      relPath: c.relPath,
      startLine: c.startLine,
      endLine: c.endLine,
    },
  }))
  await vsUpsertNamespace(ns, model, storeChunks, vectors, {
    sourceLabel: root,
    kind: 'workspace',
  })

  const status: WorkspaceIndexStatus = {
    indexed: true,
    namespace: ns,
    filesScanned: scannedCount,
    filesIndexed,
    chunkCount: allChunks.length,
    bytesSource,
    model,
    dim,
    builtAt: Date.now(),
    durationMs: Date.now() - start,
    errors,
  }
  await writeStatus(status)
  options.onProgress?.({ phase: 'done', filesScanned: scannedCount, filesIndexed, chunksEmbedded: vectors.length, chunksTotal: allChunks.length })
  return status
}

async function buildStatusFromNamespace(
  root: string,
  namespace: string,
  fallback: Partial<WorkspaceIndexStatus> = {},
): Promise<WorkspaceIndexStatus> {
  const stored = await vsReadNamespaceChunks(namespace)
  const sidecar = await readStatus(namespace)
  const uniqueFiles = new Set(
    (stored?.chunks ?? [])
      .map((c) => c.meta?.relPath)
      .filter((p): p is string => typeof p === 'string' && p.length > 0),
  ).size
  return {
    indexed: Boolean(stored),
    namespace,
    filesScanned: sidecar?.filesScanned ?? fallback.filesScanned ?? uniqueFiles,
    filesIndexed: uniqueFiles,
    chunkCount: stored?.chunks.length ?? 0,
    bytesSource: sidecar?.bytesSource ?? fallback.bytesSource ?? 0,
    model: stored?.model ?? sidecar?.model ?? fallback.model ?? '',
    dim: stored?.dim ?? sidecar?.dim ?? fallback.dim ?? 0,
    builtAt: Date.now(),
    durationMs: fallback.durationMs ?? 0,
    errors: sidecar?.errors ?? fallback.errors ?? [],
  }
}

export async function incrementallyUpdateWorkspaceIndex(
  root: string,
  changedPaths: string[],
  removedPaths: string[] = [],
): Promise<WorkspaceIndexStatus | null> {
  const key = normalizedWorkspaceKey(root)
  const previous = workspaceIncrementalInflight.get(key) ?? Promise.resolve(null)
  const current = previous.then(async () => {
    const rootAbs = path.resolve(root)
    const changed = Array.from(
      new Set(
        changedPaths
          .map((p) => path.resolve(p))
          .filter((p) => p.startsWith(rootAbs)),
      ),
    )
    const removed = Array.from(
      new Set(
        removedPaths
          .map((p) => path.resolve(p))
          .filter((p) => p.startsWith(rootAbs)),
      ),
    )
    if (changed.length === 0 && removed.length === 0) {
      return null
    }

    const settings = readDiskSettings() as WsSettings
    const dispatchCfg = buildDispatchCfg(settings)
    if (dispatchCfg.mode === 'cloud' && !dispatchCfg.cloud) {
      return null
    }

    const existingNs = await findActiveWorkspaceNamespace(root)
    const changedIndexable = changed.filter((p) => isWorkspaceIndexablePath(root, p))

    let targetNs = existingNs
    let model = ''
    let dim = 0

    if (changedIndexable.length > 0) {
      const firstAbs = changedIndexable[0]
      let firstContent = ''
      try {
        firstContent = await readFile(firstAbs, 'utf8')
      } catch {
        firstContent = ''
      }
      const firstChunks = chunkCodeFile(
        normalizeWorkspaceRelPath(root, firstAbs),
        firstContent,
      )
      if (firstChunks.length > 0) {
        const probe = await dispatchEmbed(dispatchCfg, [firstChunks[0].text])
        if (!probe.ok || probe.vectors.length === 0) {
          return existingNs ? buildStatusFromNamespace(root, existingNs) : null
        }
        const wrapped = wrapWithFingerprint(dispatchCfg, probe)
        const exactNs = workspaceNamespaceFor(root, wrapped.fp)
        if (!(await vsHasNamespace(exactNs))) {
          void queueWorkspaceLazyRehydrate(root)
          return existingNs ? buildStatusFromNamespace(root, existingNs) : null
        }
        targetNs = exactNs
        model = wrapped.modelLabel
        dim = wrapped.dim
      }
    }

    if (!targetNs) {
      return null
    }
    const currentNs = await vsReadNamespaceChunks(targetNs)
    if (!currentNs) {
      return null
    }
    if (!model) model = currentNs.model
    if (!dim) dim = currentNs.dim

    const affectedRelPaths = new Set<string>()
    for (const p of changed) affectedRelPaths.add(normalizeWorkspaceRelPath(root, p))
    for (const p of removed) affectedRelPaths.add(normalizeWorkspaceRelPath(root, p))

    const removeIds = currentNs.chunks
      .filter((c) => {
        const rel = c.meta?.relPath
        return typeof rel === 'string' && affectedRelPaths.has(rel)
      })
      .map((c) => c.id)

    const upsertChunks: Chunk[] = []
    const upsertVectors: number[][] = []
    const changedBytes: Array<{ relPath: string; bytes: number }> = []

    for (const absPath of changedIndexable) {
      let content = ''
      try {
        content = await readFile(absPath, 'utf8')
      } catch {
        continue
      }
      const relPath = normalizeWorkspaceRelPath(root, absPath)
      changedBytes.push({ relPath, bytes: content.length })
      const codeChunks = chunkCodeFile(relPath, content)
      if (codeChunks.length === 0) continue
      for (let off = 0; off < codeChunks.length; off += EMBED_BATCH) {
        const batch = codeChunks.slice(off, off + EMBED_BATCH)
        const embed = await dispatchEmbed(dispatchCfg, batch.map((c) => c.text))
        if (!embed.ok || embed.dim !== dim) {
          void queueWorkspaceLazyRehydrate(root)
          return buildStatusFromNamespace(root, targetNs)
        }
        for (let i = 0; i < batch.length; i++) {
          const c = batch[i]
          upsertChunks.push({
            id: c.id,
            index: upsertChunks.length,
            text: c.text,
            meta: {
              relPath: c.relPath,
              startLine: c.startLine,
              endLine: c.endLine,
            },
          })
          upsertVectors.push(embed.vectors[i])
        }
      }
    }

    await vsPatchNamespace(
      targetNs,
      {
        model,
        ...(removeIds.length > 0 ? { remove: removeIds } : {}),
        ...(upsertChunks.length > 0 ? { upsert: { chunks: upsertChunks, vectors: upsertVectors } } : {}),
      },
      { sourceLabel: root, kind: 'workspace' },
    )

    const prevStatus = await readStatus(targetNs)
    const nextStatus = await buildStatusFromNamespace(root, targetNs, {
      filesScanned: prevStatus?.filesScanned,
      bytesSource: prevStatus?.bytesSource,
      errors: prevStatus?.errors,
      model,
      dim,
    })
    await writeStatus(nextStatus)
    return nextStatus
  })
  workspaceIncrementalInflight.set(key, current)
  try {
    return await current
  } finally {
    if (workspaceIncrementalInflight.get(key) === current) {
      workspaceIncrementalInflight.delete(key)
    }
  }
}

export async function queryWorkspaceIndex(
  root: string,
  query: string,
  topK = 6,
  opts: {
    shared?: import('./sharedQueryVector').SharedQueryEmbedding
    /** Cosine floor passed straight to vectorStore.queryTopK. Default 0 (no floor). */
    minScore?: number
  } = {},
): Promise<QueryHit[]> {
  if (!query.trim()) return []

  // Embed the query first — its fingerprint determines which namespace to
  // hit. If the exact-fp namespace is missing but we *do* have stale
  // workspace namespaces from an older model, align with memory recall:
  // queue a background rehydrate for the current fp rather than querying
  // the wrong model's vectors.
  //
  // When `opts.shared` is provided by the retrieval prefetch pipeline, we
  // reuse that vector + fp instead of paying for a second forward pass —
  // the whole point of the shared query-vector optimization.
  let qVec: number[]
  let qFp: string
  if (opts.shared) {
    qVec = opts.shared.vector
    qFp = opts.shared.fp
  } else {
    const settings = readDiskSettings() as WsSettings
    const mode: EmbeddingMode = settings.embeddingMode || 'auto'
    const cloud = getCloudConfig(settings)
    const dispatchCfg = { mode, localModelId: settings.embeddingLocalModelId, cloud: cloud || undefined }

    const qr = await dispatchEmbed(dispatchCfg, [query])
    if (!qr.ok || qr.vectors.length === 0) return []
    const wrapped = wrapWithFingerprint(dispatchCfg, qr)
    qVec = qr.vectors[0]
    qFp = wrapped.fp
  }

  const minScore = opts.minScore
  const ns = workspaceNamespaceFor(root, qFp)
  if (await vsHasNamespace(ns)) {
    const hits = await vsQueryTopK(qVec, { topK, namespaces: [ns], minScore })
    return toQueryHits(hits)
  }

  // Legacy no-fp namespace is the only fallback we still query directly.
  // Fingerprinted-but-stale namespaces are intentionally NOT queried with the
  // new model's vectors; that would mix embedding spaces. Instead we kick off
  // a background rebuild and return no results for this turn.
  const legacy = legacyWorkspaceNamespace(root)
  if (await vsHasNamespace(legacy)) {
    void queueWorkspaceLazyRehydrate(root)
    const hits = await vsQueryTopK(qVec, { topK, namespaces: [legacy], minScore })
    return toQueryHits(hits)
  }

  const latestNs = await findActiveWorkspaceNamespace(root)
  if (latestNs && latestNs !== ns) {
    void queueWorkspaceLazyRehydrate(root)
  }
  return []
}
