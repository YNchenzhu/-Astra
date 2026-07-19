/**
 * Lightweight vector store for RAG chunks.
 *
 * Design trade-off: we deliberately pick JSON-on-disk + in-memory cosine scan
 * over SQLite+sqlite-vec to avoid native modules (better-sqlite3 needs a per-
 * Electron-ABI rebuild, sqlite-vec needs extension loading). For the typical
 * user's workspace (hundreds-to-low-thousands of chunks) scan cost is < 20ms,
 * below perception — and the interface is swappable later.
 *
 * Layout (on-disk, v2):
 *   {userData}/vector-store/
 *     index.json                          — namespace registry (see ./registry.ts)
 *     ns/                                 — namespace JSON files, one per (kind, source, fp)
 *       attachment-<src16>-<fp12>.json
 *       workspace-<src16>-<fp12>.json
 *       memory-<src16>-<fp12>.json
 *     ns-*.json                           — legacy v1 files; read-fall-back, never written
 *
 * Each namespace JSON looks like:
 *   { dim: number, model: string, chunks: Chunk[], vectors: number[][] }
 * where `vectors[i]` is L2-normalized so cosine similarity == dot product.
 *
 * Concurrency: writes go through `withNsLock` — a per-namespace promise chain
 * that serializes upsert/patch/drop calls for the same namespace. Without it,
 * two parallel callers (e.g. workspace index build + attachment ingest) could
 * race on `read → mutate → write` and shred the file.
 */

import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import {
  clearAllEntries,
  getNamespaceEntry,
  removeEntry,
  upsertEntry,
  type NsRegistryEntry,
} from './registry'
import { parseNamespace, type NsKind } from './namespaces'

export interface Chunk {
  id: string
  /** Ordered position within the source (0-based). */
  index: number
  text: string
  /** Free-form metadata (page number, sheet name, heading path, etc.). */
  meta?: Record<string, unknown>
}

export interface ScoredChunk extends Chunk {
  score: number
  namespace: string
}

interface Namespace {
  dim: number
  model: string
  chunks: Chunk[]
  vectors: number[][]
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

let rootPromise: Promise<string> | null = null

/** Root of the vector store. Created on first access. */
async function vsRoot(): Promise<string> {
  if (rootPromise) return rootPromise
  rootPromise = (async () => {
    const d = path.join(app.getPath('userData'), 'vector-store')
    await mkdir(d, { recursive: true })
    await mkdir(path.join(d, 'ns'), { recursive: true })
    return d
  })()
  return rootPromise
}

function safeNsName(namespace: string): string {
  return namespace.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128)
}

/** New-layout filename — used for *all* writes. */
function nsFileNew(root: string, namespace: string): string {
  return path.join(root, 'ns', `${safeNsName(namespace)}.json`)
}

/** Legacy v1 filename — read fallback only; never written. */
function nsFileLegacy(root: string, namespace: string): string {
  return path.join(root, `ns-${safeNsName(namespace)}.json`)
}

/**
 * Resolve a namespace's actual on-disk file. Prefers the new `ns/` layout;
 * falls back to the legacy root-level filename so that pre-migration data
 * remains queryable until the user (or the migrator) moves it.
 */
async function locateNs(namespace: string): Promise<{ file: string; legacy: boolean } | null> {
  const root = await vsRoot()
  const newPath = nsFileNew(root, namespace)
  try {
    const s = await stat(newPath)
    if (s.isFile()) return { file: newPath, legacy: false }
  } catch { /* fallthrough */ }
  const oldPath = nsFileLegacy(root, namespace)
  try {
    const s = await stat(oldPath)
    if (s.isFile()) return { file: oldPath, legacy: true }
  } catch { /* fallthrough */ }
  return null
}

// ---------------------------------------------------------------------------
// Per-namespace write serialization
// ---------------------------------------------------------------------------

const nsLocks = new Map<string, Promise<unknown>>()

/**
 * Run `fn` while holding the per-namespace write lock. Concurrent callers for
 * the same namespace queue; callers for different namespaces proceed in
 * parallel. Frees the lock once `fn` settles.
 */
async function withNsLock<T>(namespace: string, fn: () => Promise<T>): Promise<T> {
  const previous = nsLocks.get(namespace) ?? Promise.resolve()
  let resolveCurrent: () => void = () => {}
  const ticket = new Promise<void>((r) => { resolveCurrent = r })
  nsLocks.set(namespace, previous.then(() => ticket))
  try {
    await previous
    return await fn()
  } finally {
    resolveCurrent()
    // GC: if no further chained writes piled on, drop the entry so the map
    // doesn't grow unbounded across long sessions.
    if (nsLocks.get(namespace) === previous.then(() => ticket)) {
      nsLocks.delete(namespace)
    }
  }
}

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------

function normalizeVec(v: number[]): number[] {
  let s = 0
  for (const x of v) s += x * x
  const inv = s > 0 ? 1 / Math.sqrt(s) : 0
  return v.map((x) => x * inv)
}

// ---------------------------------------------------------------------------
// Atomic file IO
// ---------------------------------------------------------------------------

async function atomicWriteJson(file: string, obj: unknown): Promise<{ size: number }> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  const payload = JSON.stringify(obj)
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, file)
  return { size: Buffer.byteLength(payload, 'utf8') }
}

async function readNamespace(file: string): Promise<Namespace | null> {
  try {
    const raw = await readFile(file, 'utf8')
    const j = JSON.parse(raw) as Partial<Namespace>
    if (!j || typeof j !== 'object') return null
    return {
      dim: typeof j.dim === 'number' ? j.dim : 0,
      model: typeof j.model === 'string' ? j.model : '',
      chunks: Array.isArray(j.chunks) ? j.chunks as Chunk[] : [],
      vectors: Array.isArray(j.vectors) ? j.vectors as number[][] : [],
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Registry helper — extract sourceLabel/kind/fp metadata for a write
// ---------------------------------------------------------------------------

interface RegistryHints {
  /** Optional human-readable label ("invoice.pdf", "/Users/me/proj"). */
  sourceLabel?: string
  /** Optional kind override; otherwise inferred from the namespace prefix. */
  kind?: NsKind
}

async function refreshRegistryAfterWrite(
  ns: string,
  model: string,
  dim: number,
  chunkCount: number,
  sizeBytes: number,
  hints: RegistryHints,
): Promise<void> {
  const parsed = parseNamespace(ns)
  const kind: NsKind = hints.kind
    ?? parsed?.kind
    ?? (ns.startsWith('attachment-') || ns.startsWith('att-')
      ? 'attachment'
      : ns.startsWith('workspace-')
        ? 'workspace'
        : 'memory')
  const fp = parsed?.fp ?? 'legacy'
  const existing = await getNamespaceEntry(ns)
  const entry: NsRegistryEntry = {
    ns,
    kind,
    sourceLabel: hints.sourceLabel ?? existing?.sourceLabel ?? '',
    fp,
    model: model || existing?.model || '',
    dim: dim || existing?.dim || 0,
    builtAt: Date.now(),
    chunkCount,
    sizeBytes,
  }
  await upsertEntry(entry)
}

// ---------------------------------------------------------------------------
// Public API: existence + read
// ---------------------------------------------------------------------------

export async function hasNamespace(namespace: string): Promise<boolean> {
  return (await locateNs(namespace)) !== null
}

// ---------------------------------------------------------------------------
// Public API: full overwrite
// ---------------------------------------------------------------------------

/**
 * Replace a namespace's contents entirely. Convenience wrapper over
 * `patchNamespace({ replaceAll: true })`. Kept for callers (workspace index)
 * that build the entire namespace in one shot.
 */
export async function upsertNamespace(
  namespace: string,
  model: string,
  chunks: Chunk[],
  vectors: number[][],
  hints: RegistryHints = {},
): Promise<void> {
  if (chunks.length !== vectors.length) {
    throw new Error(
      `vectorStore: chunks/vectors length mismatch (${chunks.length} vs ${vectors.length})`,
    )
  }
  await patchNamespace(
    namespace,
    { model, replaceAll: { chunks, vectors } },
    hints,
  )
}

// ---------------------------------------------------------------------------
// Public API: incremental patch
// ---------------------------------------------------------------------------

export interface ChunkPatch {
  /**
   * Model label for this write — provider:model name, e.g. `local:bge-m3`
   * or `openai:text-embedding-3-small`. Required for the first write of a
   * namespace; subsequent writes can omit and reuse the stored value.
   */
  model?: string
  /** Add or update by chunk id. Vectors and chunks must be same length. */
  upsert?: { chunks: Chunk[]; vectors: number[][] }
  /** Drop chunk ids. No-op for ids not present. */
  remove?: string[]
  /** Wholesale replacement; takes precedence over upsert/remove if set. */
  replaceAll?: { chunks: Chunk[]; vectors: number[][] }
}

/**
 * Add / replace / remove chunks within a namespace atomically.
 *
 * Behavior contract:
 *   - First write must include either `model` or a `replaceAll` payload that
 *     supplies vectors (we infer dim from `vectors[0].length`).
 *   - Dim mismatch on `upsert` against an existing namespace throws — vectors
 *     of different dims must live in different namespaces, which the
 *     fingerprint scheme guarantees by construction.
 *   - Concurrent calls for the same namespace serialize via `withNsLock`.
 *   - Always atomic: tmp file + rename, no partial writes.
 *   - Registry entry is refreshed after every successful write.
 */
export async function patchNamespace(
  namespace: string,
  patch: ChunkPatch,
  hints: RegistryHints = {},
): Promise<void> {
  return withNsLock(namespace, async () => {
    const root = await vsRoot()
    const file = nsFileNew(root, namespace)

    const located = await locateNs(namespace)
    let current: Namespace | null = located ? await readNamespace(located.file) : null
    // If the file currently lives in the legacy root, copy it into the new
    // ns/ subdir so subsequent reads pick the canonical path. Best-effort —
    // a failure here just falls through to a fresh create on the next write.
    if (located?.legacy) {
      try {
        await mkdir(path.dirname(file), { recursive: true })
        if (current) await atomicWriteJson(file, current)
        await unlink(located.file).catch(() => undefined)
      } catch { /* non-fatal */ }
    }
    if (!current) {
      current = { dim: 0, model: '', chunks: [], vectors: [] }
    }

    // ----- replaceAll wins over upsert/remove -----
    if (patch.replaceAll) {
      const { chunks, vectors } = patch.replaceAll
      if (chunks.length !== vectors.length) {
        throw new Error(
          `patchNamespace.replaceAll: chunks/vectors length mismatch (${chunks.length} vs ${vectors.length})`,
        )
      }
      const next: Namespace = {
        dim: vectors[0]?.length ?? 0,
        model: patch.model || current.model || '',
        chunks: chunks.slice(),
        vectors: vectors.map(normalizeVec),
      }
      const { size } = await atomicWriteJson(file, next)
      await refreshRegistryAfterWrite(namespace, next.model, next.dim, next.chunks.length, size, hints)
      return
    }

    // ----- upsert / remove path -----
    const byId = new Map<string, { chunk: Chunk; vector: number[] }>()
    for (let i = 0; i < current.chunks.length; i++) {
      byId.set(current.chunks[i].id, { chunk: current.chunks[i], vector: current.vectors[i] || [] })
    }

    if (patch.upsert) {
      const { chunks, vectors } = patch.upsert
      if (chunks.length !== vectors.length) {
        throw new Error(
          `patchNamespace.upsert: chunks/vectors length mismatch (${chunks.length} vs ${vectors.length})`,
        )
      }
      const incomingDim = vectors[0]?.length ?? 0
      if (current.dim > 0 && incomingDim > 0 && incomingDim !== current.dim) {
        throw new Error(
          `patchNamespace: dim mismatch — namespace "${namespace}" stores ${current.dim}-dim vectors ` +
          `but caller supplied ${incomingDim}-dim. ` +
          `Switch to a fingerprinted namespace (see electron/embedding/namespaces.ts) so ` +
          `different models live in different namespaces.`,
        )
      }
      if (current.dim === 0 && incomingDim > 0) current.dim = incomingDim
      for (let i = 0; i < chunks.length; i++) {
        byId.set(chunks[i].id, { chunk: chunks[i], vector: normalizeVec(vectors[i]) })
      }
    }
    if (patch.remove) {
      for (const id of patch.remove) byId.delete(id)
    }

    const newChunks: Chunk[] = []
    const newVectors: number[][] = []
    for (const v of byId.values()) {
      newChunks.push(v.chunk)
      newVectors.push(v.vector)
    }

    const next: Namespace = {
      dim: current.dim,
      model: patch.model || current.model || '',
      chunks: newChunks,
      vectors: newVectors,
    }
    const { size } = await atomicWriteJson(file, next)
    await refreshRegistryAfterWrite(namespace, next.model, next.dim, next.chunks.length, size, hints)
  })
}

// ---------------------------------------------------------------------------
// Public API: drop
// ---------------------------------------------------------------------------

export async function dropNamespace(namespace: string): Promise<void> {
  await withNsLock(namespace, async () => {
    const located = await locateNs(namespace)
    if (located) {
      try { await unlink(located.file) } catch { /* noop */ }
    }
    await removeEntry(namespace)
  })
}

// ---------------------------------------------------------------------------
// Public API: introspection
// ---------------------------------------------------------------------------

/**
 * List the chunk ids currently stored in a namespace, without touching the
 * vectors. Used by the memory-recall code to figure out "which entries do I
 * still need to embed?" without paying for the cosine math.
 *
 * Returns an empty array when the namespace doesn't exist or fails to read.
 */
export async function listChunkIds(namespace: string): Promise<string[]> {
  const located = await locateNs(namespace)
  if (!located) return []
  const ns = await readNamespace(located.file)
  if (!ns) return []
  return ns.chunks.map((c) => c.id)
}

/**
 * Read the chunk + vector pairs stored in a namespace. Mostly an escape
 * hatch for callers that need to score against more than one query in the
 * same turn (memory recall) without re-doing IO. Returns null when the
 * namespace doesn't exist.
 */
export async function readNamespaceChunks(
  namespace: string,
): Promise<{ dim: number; model: string; chunks: Chunk[]; vectors: number[][] } | null> {
  const located = await locateNs(namespace)
  if (!located) return null
  return readNamespace(located.file)
}

// ---------------------------------------------------------------------------
// Public API: query
// ---------------------------------------------------------------------------

export interface QueryOptions {
  topK?: number
  /** Namespaces to search. Empty array = none. */
  namespaces: string[]
  /**
   * Cosine floor — chunks scoring strictly below this are dropped, not
   * just demoted. Default 0 preserves legacy "always return top-K" behaviour
   * for any caller that hasn't opted in. The retrieval prefetch pipeline
   * passes a non-zero floor (typ. 0.30, BGE-M3 measured "relevant vs
   * noise" boundary) so unrelated queries don't get noise injected into
   * the system prompt.
   */
  minScore?: number
}

export async function queryTopK(
  queryVector: number[],
  opts: QueryOptions,
): Promise<ScoredChunk[]> {
  const k = Math.max(1, opts.topK ?? 6)
  const minScore = typeof opts.minScore === 'number' ? opts.minScore : 0
  const q = normalizeVec(queryVector)

  const scored: ScoredChunk[] = []
  for (const namespace of opts.namespaces) {
    const located = await locateNs(namespace)
    if (!located) continue
    const ns = await readNamespace(located.file)
    if (!ns) continue
    if (ns.dim !== q.length) continue // dim mismatch — skip silently (legacy fallback)
    for (let i = 0; i < ns.chunks.length; i++) {
      const v = ns.vectors[i]
      if (!v || v.length !== q.length) continue
      let dot = 0
      for (let j = 0; j < v.length; j++) dot += v[j] * q[j]
      // Filter on the way in — sort happens on the smaller post-filter set,
      // and the slice(0, k) at the end can never resurrect a dropped chunk.
      if (dot < minScore) continue
      scored.push({ ...ns.chunks[i], score: dot, namespace })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

// ---------------------------------------------------------------------------
// Disk usage
// ---------------------------------------------------------------------------

/** Disk usage stats for UI display. Walks both the new ns/ dir and legacy root files. */
export async function storeStats(): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  try {
    const root = await vsRoot()
    // New layout: ns/
    try {
      const nsDir = path.join(root, 'ns')
      const ents = await readdir(nsDir)
      for (const e of ents) {
        try {
          const s = await stat(path.join(nsDir, e))
          if (s.isFile()) { files++; bytes += s.size }
        } catch { /* skip */ }
      }
    } catch { /* dir may not exist yet */ }
    // Legacy: ns-*.json at root
    const ents = await readdir(root)
    for (const e of ents) {
      if (!e.startsWith('ns-')) continue
      try {
        const s = await stat(path.join(root, e))
        if (s.isFile()) { files++; bytes += s.size }
      } catch { /* skip */ }
    }
  } catch { /* noop */ }
  return { files, bytes }
}

export async function clearAll(): Promise<{ removed: number }> {
  let removed = 0
  try {
    const root = await vsRoot()
    // New layout
    try {
      const nsDir = path.join(root, 'ns')
      const ents = await readdir(nsDir)
      for (const e of ents) {
        try { await unlink(path.join(nsDir, e)); removed++ } catch { /* skip */ }
      }
    } catch { /* noop */ }
    // Legacy
    const ents = await readdir(root)
    for (const e of ents) {
      if (!e.startsWith('ns-')) continue
      try { await unlink(path.join(root, e)); removed++ } catch { /* skip */ }
    }
    await clearAllEntries()
  } catch { /* noop */ }
  return { removed }
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

export function __resetForTests(): void {
  rootPromise = null
  nsLocks.clear()
}

// ---------------------------------------------------------------------------
// Re-exports of namespace utilities
// ---------------------------------------------------------------------------

// Note: the legacy `namespaceFor()` symbol that lived here used to be dead
// code — every consumer either constructed namespaces by hand or used a
// per-subsystem helper. Use `buildNamespace()` from `./namespaces.ts`
// instead, which mandates the model fingerprint.
export { isFingerprintedNamespace } from './namespaces'
