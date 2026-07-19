/**
 * Memory consolidation worker thread.
 *
 * Runs the 5-pass consolidation pipeline (hash dedup, name dedup, Jaccard,
 * semantic embedding dedup, stale pruning, content compression) in a
 * dedicated Node `worker_threads` Worker so the Electron main process event
 * loop stays free.
 *
 * Message protocol:
 *
 *   parent → worker
 *     { type: 'consolidate', reqId, absDir, opts: { dryRun?, fullSweep?, embedAvailable? } }
 *
 *   worker → parent
 *     { type: 'consolidate-progress', reqId, pass, progress }
 *     { type: 'consolidate-result', reqId, result }
 *     { type: 'error', reqId, error }
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { parentPort } from 'node:worker_threads'
import type { EmbeddingMode } from '../embedding/dispatch'

if (!parentPort) {
  throw new Error('[memoryWorker] must be spawned as a worker_thread')
}
const port = parentPort

// ---------------------------------------------------------------------------
// Constants (mirror autoConsolidate.ts)
// ---------------------------------------------------------------------------

const MAX_CONTENT_LENGTH = 3000
const STALE_AGE_DAYS = 60
const JACCARD_DEDUP_THRESHOLD = 0.78
const JACCARD_SEED_THRESHOLD = 0.45
const MIN_CONTENT_FOR_JACCARD = 80
const EMBEDDING_DEDUP_THRESHOLD = 0.88
const LSH_HYPERPLANE_BITS = 8

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MemoryFrontmatter {
  name: string
  content_hash?: string
  enabled?: boolean
  type?: string
  updated?: string
  created?: string
  scope?: string
  description?: string
  originalLength?: number
  originalHash?: string
  truncatedHash?: string
  [key: string]: unknown
}

interface MemoryEntry {
  filename: string
  absPath: string
  frontmatter: MemoryFrontmatter
  content: string
  ageDays: number
}

interface MergePair {
  kept: string
  removed: string
}

interface ConsolidationResult {
  merged: number
  pruned: number
  compressed: number
  unchanged: number
  errors: string[]
  plan?: ConsolidationPlan
}

interface ConsolidationPlan {
  merges: Array<MergePair & { pass: string }>
  prunes: Array<{ filename: string; reason: string; ageDays: number }>
  compresses: Array<{ filename: string; fromLen: number; toLen: number }>
  totalEntries: number
  incremental: boolean
}

interface ConsolidateOpts {
  dryRun?: boolean
  fullSweep?: boolean
  embedAvailable?: boolean
}

// ---------------------------------------------------------------------------
// File I/O helpers (worker-local)
// ---------------------------------------------------------------------------

async function listMemoriesAtRoot(memDir: string): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = []
  try {
    const dirents = await fsp.readdir(memDir, { withFileTypes: true })
    for (const d of dirents) {
      if (!d.isFile() || !d.name.endsWith('.md')) continue
      if (d.name === 'MEMORY.md' || d.name === 'MEMORY.md.backup') continue
      const abs = path.join(memDir, d.name)
      const raw = await fsp.readFile(abs, 'utf8')
      const parsed = parseMemoryFile(raw)
      const stat = await fsp.stat(abs)
      const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24)
      entries.push({
        filename: d.name,
        absPath: abs,
        frontmatter: parsed.frontmatter,
        content: parsed.content,
        ageDays,
      })
    }
  } catch { /* dir doesn't exist yet */ }
  return entries
}

function parseMemoryFile(raw: string): { frontmatter: MemoryFrontmatter; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/m)
  if (!match) return { frontmatter: { name: 'unnamed' }, content: raw }
  const yaml = match[1] || ''
  const content = match[2] || ''
  const fm: MemoryFrontmatter = { name: 'unnamed' }
  for (const line of yaml.split('\n')) {
    const eq = line.indexOf(':')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (val === 'true') fm[key] = true
    else if (val === 'false') fm[key] = false
    else fm[key] = val
  }
  return { frontmatter: fm, content }
}

function serializeMemoryFile(fm: MemoryFrontmatter, content: string): string {
  const yaml = Object.entries(fm)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      if (typeof v === 'boolean') return `${k}: ${v}`
      if (typeof v === 'number') return `${k}: ${v}`
      return `${k}: "${String(v).replace(/"/g, '\\"')}"`
    })
    .join('\n')
  return `---\n${yaml}\n---\n${content}`
}

async function writeMemoryFileAsync(memDir: string, filename: string, fm: MemoryFrontmatter, content: string): Promise<void> {
  const abs = path.join(memDir, filename)
  await fsp.writeFile(abs, serializeMemoryFile(fm, content), 'utf8')
}

async function deleteMemoryFileAsync(memDir: string, filename: string): Promise<void> {
  const abs = path.join(memDir, filename)
  await fsp.unlink(abs).catch(() => { /* already gone */ })
}

// ---------------------------------------------------------------------------
// File operations abstraction (dry-run aware)
// ---------------------------------------------------------------------------

interface FileOps {
  merge(keepFile: string, removeFile: string, newContent: string, newFm: MemoryFrontmatter): Promise<void>
  deleteFile(filename: string): Promise<void>
  updateFile(filename: string, newContent: string, newFm: MemoryFrontmatter): Promise<void>
}

function createFileOps(memDir: string, dryRun: boolean): FileOps {
  return {
    async merge(keepFile, removeFile, newContent, newFm) {
      if (!dryRun) {
        await writeMemoryFileAsync(memDir, keepFile, newFm, newContent)
        await deleteMemoryFileAsync(memDir, removeFile)
      }
    },
    async deleteFile(filename) {
      if (!dryRun) await deleteMemoryFileAsync(memDir, filename)
    },
    async updateFile(filename, newContent, newFm) {
      if (!dryRun) await writeMemoryFileAsync(memDir, filename, newFm, newContent)
    },
  }
}

// ---------------------------------------------------------------------------
// Pass 0: Hash dedup
// ---------------------------------------------------------------------------

async function runHashDedup(entries: MemoryEntry[], ops: FileOps): Promise<{ kept: MemoryEntry[]; mergedPairs: MergePair[] }> {
  const byHash = new Map<string, MemoryEntry[]>()
  for (const e of entries) {
    const h = crypto.createHash('sha256').update(e.content).digest('hex')
    if (!byHash.has(h)) byHash.set(h, [])
    byHash.get(h)!.push(e)
  }
  const kept: MemoryEntry[] = []
  const mergedPairs: MergePair[] = []
  for (const [, group] of byHash) {
    kept.push(group[0])
    for (let i = 1; i < group.length; i++) {
      await ops.merge(group[0].filename, group[i].filename, group[0].content, group[0].frontmatter)
      mergedPairs.push({ kept: group[0].filename, removed: group[i].filename })
    }
  }
  return { kept, mergedPairs }
}

// ---------------------------------------------------------------------------
// Pass 1: Name dedup
// ---------------------------------------------------------------------------

async function runNameDedup(entries: MemoryEntry[], ops: FileOps): Promise<{ kept: MemoryEntry[]; mergedPairs: MergePair[] }> {
  // `kept` and `mergedPairs` MUST be declared before the first loop —
  // the no-name early-continue branch below pushes into `kept` directly,
  // and the previous declaration order triggered a TDZ ReferenceError
  // the moment a memory entry without a frontmatter name reached this
  // pass (TS2448 / TS2454).
  const kept: MemoryEntry[] = []
  const mergedPairs: MergePair[] = []
  const byName = new Map<string, MemoryEntry[]>()
  for (const e of entries) {
    const n = (e.frontmatter.name || '').toLowerCase()
    if (!n) { kept.push(e); continue }
    if (!byName.has(n)) byName.set(n, [])
    byName.get(n)!.push(e)
  }
  for (const [, group] of byName) {
    if (group.length <= 1) { kept.push(group[0]); continue }
    group.sort((a, b) => (b.content.length - a.content.length))
    kept.push(group[0])
    const combined = group.map((e) => e.content).join('\n\n---\n\n')
    for (let i = 1; i < group.length; i++) {
      await ops.merge(group[0].filename, group[i].filename, combined, group[0].frontmatter)
      mergedPairs.push({ kept: group[0].filename, removed: group[i].filename })
    }
  }
  // NOTE: do NOT iterate `entries` again to top-up `kept` — the first loop
  // already pushes empty-name entries directly, and the byName loop covers
  // every named entry. A second pass on `entries` re-pushed every empty-name
  // entry (its key '' is never in `byName`), causing duplicates downstream
  // in Pass 2 Jaccard (self-similarity) and Pass 3 semantic dedup.
  return { kept, mergedPairs }
}

// ---------------------------------------------------------------------------
// Pass 2: Jaccard near-duplicate detection
// ---------------------------------------------------------------------------

function tokenizeForJaccard(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter((w) => w.length > 2))
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const w of a) if (b.has(w)) intersection++
  return intersection / (a.size + b.size - intersection)
}

async function runJaccardDedup(
  entries: MemoryEntry[],
  ops: FileOps,
  _incremental: boolean,
): Promise<{ kept: MemoryEntry[]; mergedPairs: MergePair[]; seedPairs: Array<{ a: MemoryEntry; b: MemoryEntry }> }> {
  const kept = [...entries]
  const mergedPairs: MergePair[] = []
  const seedPairs: Array<{ a: MemoryEntry; b: MemoryEntry }> = []
  const removed = new Set<string>()

  for (let i = 0; i < kept.length; i++) {
    if (removed.has(kept[i].filename)) continue
    const a = kept[i]
    if (a.content.length < MIN_CONTENT_FOR_JACCARD) continue
    const tokensA = tokenizeForJaccard(a.content)
    for (let j = i + 1; j < kept.length; j++) {
      if (removed.has(kept[j].filename)) continue
      const b = kept[j]
      if (b.content.length < MIN_CONTENT_FOR_JACCARD) continue
      const tokensB = tokenizeForJaccard(b.content)
      const sim = jaccardSimilarity(tokensA, tokensB)
      if (sim >= JACCARD_DEDUP_THRESHOLD) {
        await ops.merge(a.filename, b.filename, a.content, a.frontmatter)
        mergedPairs.push({ kept: a.filename, removed: b.filename })
        removed.add(b.filename)
      } else if (sim >= JACCARD_SEED_THRESHOLD) {
        seedPairs.push({ a, b })
      }
    }
  }
  return { kept: kept.filter((e) => !removed.has(e.filename)), mergedPairs, seedPairs }
}

// ---------------------------------------------------------------------------
// Pass 3: Semantic dedup (embedding + LSH)
// ---------------------------------------------------------------------------

async function semanticDedup(
  entries: MemoryEntry[],
  ops: FileOps,
  seedPairs: Array<{ a: MemoryEntry; b: MemoryEntry }>,
  _incremental: boolean,
): Promise<{ merged: number; mergedPairs: MergePair[]; kept: MemoryEntry[]; errors: string[] }> {
  // This pass requires embedding — dynamically import in the worker
  const errors: string[] = []
  const mergedPairs: MergePair[] = []
  const kept = [...entries]
  const removed = new Set<string>()

  // Try to embed
  let embeddings: number[][] = []
  try {
    const { dispatchEmbed } = await import('../embedding/dispatch')
    const { readDiskSettings } = await import('../settings/settingsAccess')
    // readDiskSettings() returns `Record<string, unknown>`.  Project the
    // embedding-related slice through a narrow view so the property
    // accesses below are still type-checked instead of falling through to
    // `any`.  Unknown keys remain undefined, which the consumers already
    // tolerate via `||` defaults.
    interface EmbeddingSettingsView {
      embeddingMode?: EmbeddingMode
      embeddingProviderId?: string
      embeddingModel?: string
      embeddingApiKey?: string
      embeddingBaseUrl?: string
      embeddingDimensions?: number
      embeddingLocalModelId?: string
    }
    const settings = readDiskSettings() as EmbeddingSettingsView
    const mode: EmbeddingMode = settings.embeddingMode || 'auto'
    const cloud = settings.embeddingProviderId && settings.embeddingModel
      ? { providerId: settings.embeddingProviderId, model: settings.embeddingModel, apiKey: settings.embeddingApiKey, baseUrl: settings.embeddingBaseUrl, dimensions: settings.embeddingDimensions }
      : undefined
    const dispatchCfg = { mode, localModelId: settings.embeddingLocalModelId, cloud: cloud || undefined }

    const texts = entries.map((e) => `${e.frontmatter.name}\n${e.content}`).slice(0, 200)
    const result = await dispatchEmbed(dispatchCfg, texts)
    if (result.ok) {
      embeddings = result.vectors
    } else {
      errors.push(`embedding failed: ${result.error}`)
    }
  } catch (e) {
    errors.push(`embedding import failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  if (embeddings.length === 0) {
    return { merged: 0, mergedPairs, kept, errors }
  }

  // LSH bucketing
  const numEntries = entries.length
  const dim = embeddings[0]?.length || 0
  if (dim === 0) return { merged: 0, mergedPairs, kept, errors }

  // BUG-P2 fix: use a deterministic Mulberry32 PRNG with the same seed
  // as `electron/memory/autoConsolidate.ts`. Previously the worker used
  // `Math.random()` despite the comment claiming "deterministic seed",
  // so the worker and the main-process autoConsolidate produced
  // different bucket assignments for the same input — same memory entries
  // could merge in one path and not the other, breaking deterministic
  // dedupe. Mirroring the main code keeps both call sites in lock-step.
  let lshState = 0x9e3779b9
  const lshRng = (): number => {
    lshState |= 0
    lshState = (lshState + 0x6d2b79f5) | 0
    let t = Math.imul(lshState ^ (lshState >>> 15), 1 | lshState)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const hyperplanes: number[][] = []
  for (let h = 0; h < LSH_HYPERPLANE_BITS; h++) {
    const hp = new Array(dim)
    for (let d = 0; d < dim; d++) hp[d] = lshRng() * 2 - 1
    hyperplanes.push(hp)
  }

  function getBucket(vec: number[]): number {
    let bucket = 0
    for (let h = 0; h < LSH_HYPERPLANE_BITS; h++) {
      let dot = 0
      for (let d = 0; d < dim; d++) dot += vec[d] * hyperplanes[h][d]
      if (dot > 0) bucket |= (1 << h)
    }
    return bucket
  }

  const buckets = new Map<number, number[]>()
  for (let i = 0; i < numEntries; i++) {
    const b = getBucket(embeddings[i])
    if (!buckets.has(b)) buckets.set(b, [])
    buckets.get(b)!.push(i)
  }

  // Compare within buckets
  const cosineSim = (a: number[], b: number[]): number => {
    let dot = 0, na = 0, nb = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      na += a[i] * a[i]
      nb += b[i] * b[i]
    }
    return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
  }

  const compared = new Set<string>()
  function comparePair(i: number, j: number) {
    if (i === j || removed.has(entries[i].filename) || removed.has(entries[j].filename)) return
    const key = i < j ? `${i}-${j}` : `${j}-${i}`
    if (compared.has(key)) return
    compared.add(key)
    const sim = cosineSim(embeddings[i], embeddings[j])
    if (sim >= EMBEDDING_DEDUP_THRESHOLD) {
      const keep = entries[i].content.length >= entries[j].content.length ? i : j
      const drop = keep === i ? j : i
      removed.add(entries[drop].filename)
      mergedPairs.push({ kept: entries[keep].filename, removed: entries[drop].filename })
    }
  }

  for (const [, indices] of buckets) {
    for (let i = 0; i < indices.length; i++) {
      for (let j = i + 1; j < indices.length; j++) {
        comparePair(indices[i], indices[j])
      }
    }
  }

  // Also compare seed pairs
  for (const { a, b } of seedPairs) {
    const ai = entries.findIndex((e) => e.filename === a.filename)
    const bi = entries.findIndex((e) => e.filename === b.filename)
    if (ai >= 0 && bi >= 0) comparePair(ai, bi)
  }

  return { merged: mergedPairs.length, mergedPairs, kept: kept.filter((e) => !removed.has(e.filename)), errors }
}

// ---------------------------------------------------------------------------
// Pass 5: Content compression
// ---------------------------------------------------------------------------

function compressContentWithIntegrity(content: string, maxLen: number): { compressed: string; originalLength: number } {
  if (content.length <= maxLen) return { compressed: content, originalLength: content.length }
  const truncated = content.slice(0, maxLen)
  const truncatedHash = crypto.createHash('sha256').update(truncated).digest('hex').slice(0, 16)
  return {
    compressed: `${truncated}\n\n---\n[compressed] original length: ${content.length}, truncated hash: ${truncatedHash}`,
    originalLength: content.length,
  }
}

// ---------------------------------------------------------------------------
// Main consolidation entry point
// ---------------------------------------------------------------------------

async function consolidate(absDir: string, opts: ConsolidateOpts = {}): Promise<ConsolidationResult> {
  const dryRun = opts.dryRun === true
  const result: ConsolidationResult = { merged: 0, pruned: 0, compressed: 0, unchanged: 0, errors: [] }
  const plan: ConsolidationPlan = { merges: [], prunes: [], compresses: [], totalEntries: 0, incremental: false }

  const entries = await listMemoriesAtRoot(absDir)
  plan.totalEntries = entries.length
  if (entries.length === 0) {
    if (dryRun) result.plan = plan
    return result
  }

  port.postMessage({ type: 'consolidate-progress', pass: 'start', total: entries.length })

  const ops = createFileOps(absDir, dryRun)

  // Pass 0: hash dedup
  port.postMessage({ type: 'consolidate-progress', pass: 'hash', progress: 0 })
  const p0 = await runHashDedup(entries, ops)
  result.merged += p0.mergedPairs.length
  for (const m of p0.mergedPairs) plan.merges.push({ ...m, pass: 'hash' })

  // Pass 1: name dedup
  port.postMessage({ type: 'consolidate-progress', pass: 'name', progress: 0 })
  const p1 = await runNameDedup(p0.kept, ops)
  result.merged += p1.mergedPairs.length
  for (const m of p1.mergedPairs) plan.merges.push({ ...m, pass: 'name' })

  // Pass 2: Jaccard
  port.postMessage({ type: 'consolidate-progress', pass: 'jaccard', progress: 0 })
  const p2 = await runJaccardDedup(p1.kept, ops, false)
  result.merged += p2.mergedPairs.length
  for (const m of p2.mergedPairs) plan.merges.push({ ...m, pass: 'jaccard' })

  // Pass 3: semantic
  port.postMessage({ type: 'consolidate-progress', pass: 'semantic', progress: 0 })
  if (opts.embedAvailable && p2.kept.length > 1) {
    try {
      const p3 = await semanticDedup(p2.kept, ops, p2.seedPairs, false)
      result.merged += p3.merged
      for (const m of p3.mergedPairs) plan.merges.push({ ...m, pass: 'semantic' })
      result.errors.push(...p3.errors)
      p2.kept = p3.kept
    } catch (e) {
      result.errors.push(`embedding dedup failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Pass 4: prune
  port.postMessage({ type: 'consolidate-progress', pass: 'prune', progress: 0 })
  const postPrune: MemoryEntry[] = []
  for (const e of p2.kept) {
    if (e.ageDays > STALE_AGE_DAYS && e.frontmatter.enabled === false && e.frontmatter.type !== 'user') {
      plan.prunes.push({ filename: e.filename, reason: 'stale_disabled', ageDays: e.ageDays })
      await ops.deleteFile(e.filename)
      result.pruned++
    } else {
      postPrune.push(e)
    }
  }

  // Pass 5: compress
  port.postMessage({ type: 'consolidate-progress', pass: 'compress', progress: 0 })
  for (const e of postPrune) {
    if (e.content.length > MAX_CONTENT_LENGTH) {
      plan.compresses.push({ filename: e.filename, fromLen: e.content.length, toLen: Math.min(e.content.length, MAX_CONTENT_LENGTH) })
      if (dryRun) { result.compressed++; continue }
      const c = compressContentWithIntegrity(e.content, MAX_CONTENT_LENGTH)
      await ops.updateFile(e.filename, c.compressed, { ...e.frontmatter, originalLength: c.originalLength })
      result.compressed++
    }
  }

  result.unchanged = entries.length - result.merged - result.pruned - result.compressed
  if (dryRun) result.plan = plan

  port.postMessage({ type: 'consolidate-progress', pass: 'done', progress: 1 })
  return result
}

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

interface InMsg {
  type: 'consolidate'
  reqId: number
  absDir: string
  opts?: ConsolidateOpts
}

port.on('message', async (msg: InMsg) => {
  const { type, reqId } = msg
  try {
    if (type === 'consolidate') {
      const result = await consolidate(msg.absDir, msg.opts || {})
      port.postMessage({ type: 'consolidate-result', reqId, result })
      return
    }
    throw new Error(`unknown message type: ${type}`)
  } catch (err) {
    port.postMessage({ type: 'error', reqId, error: err instanceof Error ? err.message : String(err) })
  }
})
