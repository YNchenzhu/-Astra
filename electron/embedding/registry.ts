/**
 * Vector-store namespace registry.
 *
 * Source of truth for "which namespaces exist on disk, what each one
 * indexes, and which embedding model produced its vectors". Persisted at
 *
 *   {userData}/vector-store/index.json
 *
 * Why this file, when the vector files themselves already encode kind / fp
 * in their *names*?
 *
 *   - Reverse lookup. A filename `attachment-a3f9...-2b4c....json` says
 *     nothing about which user attachment it indexed. The registry stores
 *     the original `sourceLabel` ("invoice.pdf", "/Users/me/proj") so
 *     Settings UI / GC can render it.
 *   - Aggregated stats. Without the registry, every `vector:stats` IPC
 *     would have to stat() every file. With it, we can answer the same
 *     question in O(entries).
 *   - Garbage collection. "Which namespaces have a stale fingerprint?"
 *     becomes a one-line filter; without the registry it would require
 *     opening every namespace JSON to read its stored `model` field.
 *
 * Crash safety: writes go through `atomicWrite` (tmp + rename) and an
 * in-process per-key serialization chain, so concurrent updates from
 * different subsystems don't shred the file. Read failures fall back to
 * an empty registry — the worst case is a single rebuild of the index by
 * scanning the `ns/` directory, which `rebuildFromDisk()` handles.
 */

import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { createHash } from 'crypto'
import { parseNamespace, type NsKind } from './namespaces'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One row in the registry — one row per (kind, source, fp). */
export interface NsRegistryEntry {
  /** Filename-safe namespace id, e.g. `attachment-a3f9...-2b4c...`. */
  ns: string
  kind: NsKind
  /**
   * Human-readable source description for UI. NOT used as a key — the
   * canonical key is `ns`. May contain user paths / filenames.
   */
  sourceLabel: string
  /** Model fingerprint as embedded in the namespace (12 hex). */
  fp: string
  /** Provider:model label for UI ("openai:text-embedding-3-small"). */
  model: string
  /** Output dimensionality. */
  dim: number
  /** Epoch ms of the most recent upsert. */
  builtAt: number
  /** Number of chunks currently in the namespace. */
  chunkCount: number
  /** Disk size of the namespace JSON file, refreshed lazily on writes. */
  sizeBytes: number
}

interface RegistryShape {
  version: 2
  entries: NsRegistryEntry[]
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

let rootPromise: Promise<string> | null = null
async function vsRoot(): Promise<string> {
  if (rootPromise) return rootPromise
  rootPromise = (async () => {
    const d = path.join(app.getPath('userData'), 'vector-store')
    await mkdir(d, { recursive: true })
    return d
  })()
  return rootPromise
}

export async function registryFile(): Promise<string> {
  return path.join(await vsRoot(), 'index.json')
}

// ---------------------------------------------------------------------------
// Cache + serialization
// ---------------------------------------------------------------------------

let memCache: RegistryShape | null = null
let loadInFlight: Promise<RegistryShape> | null = null

async function loadRegistry(): Promise<RegistryShape> {
  if (memCache) return memCache
  if (loadInFlight) return loadInFlight
  loadInFlight = (async () => {
    try {
      const raw = await readFile(await registryFile(), 'utf8')
      const parsed = JSON.parse(raw) as Partial<RegistryShape>
      if (parsed && parsed.version === 2 && Array.isArray(parsed.entries)) {
        memCache = { version: 2, entries: parsed.entries }
        return memCache
      }
    } catch {
      // missing or corrupt → fall through to empty
    }
    memCache = { version: 2, entries: [] }
    return memCache
  })()
  try {
    return await loadInFlight
  } finally {
    loadInFlight = null
  }
}

// Per-process write serialization — every save chains onto the previous one,
// so concurrent upsert/remove calls never trample each other's snapshot.
let writeChain: Promise<void> = Promise.resolve()

async function atomicSave(reg: RegistryShape): Promise<void> {
  const file = await registryFile()
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(reg), 'utf8')
  await rename(tmp, file)
}

function chainWrite(fn: () => Promise<void>): Promise<void> {
  const next = writeChain.then(fn, fn) // run even if the previous chain rejected
  // Swallow the chain's rejection so a single failing save doesn't permanently
  // poison the chain for subsequent callers; each `chainWrite` returns a fresh
  // promise that surfaces its own outcome to its own caller.
  writeChain = next.catch(() => undefined)
  return next
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Snapshot of all entries. Cheap; reads from in-memory cache. */
export async function listAllNamespaces(): Promise<NsRegistryEntry[]> {
  const reg = await loadRegistry()
  return reg.entries.map((e) => ({ ...e })) // defensive copy
}

/** Look up a single entry by namespace id. */
export async function getNamespaceEntry(ns: string): Promise<NsRegistryEntry | null> {
  const reg = await loadRegistry()
  const found = reg.entries.find((e) => e.ns === ns)
  return found ? { ...found } : null
}

/** Insert or update a single entry. */
export async function upsertEntry(entry: NsRegistryEntry): Promise<void> {
  await chainWrite(async () => {
    const reg = await loadRegistry()
    const idx = reg.entries.findIndex((e) => e.ns === entry.ns)
    if (idx >= 0) reg.entries[idx] = { ...entry }
    else reg.entries.push({ ...entry })
    await atomicSave(reg)
  })
}

/** Drop a single entry by ns id. No-op if it isn't present. */
export async function removeEntry(ns: string): Promise<void> {
  await chainWrite(async () => {
    const reg = await loadRegistry()
    const before = reg.entries.length
    reg.entries = reg.entries.filter((e) => e.ns !== ns)
    if (reg.entries.length !== before) await atomicSave(reg)
  })
}

/** Drop every entry — used after `clearAll()` on the underlying store. */
export async function clearAllEntries(): Promise<void> {
  await chainWrite(async () => {
    memCache = { version: 2, entries: [] }
    await atomicSave(memCache)
  })
}

/** Filter helpers used by stats, GC, and the high-level query API. */
export async function entriesByKind(kind: NsKind): Promise<NsRegistryEntry[]> {
  return (await listAllNamespaces()).filter((e) => e.kind === kind)
}

export async function entriesByFp(fp: string): Promise<NsRegistryEntry[]> {
  return (await listAllNamespaces()).filter((e) => e.fp === fp)
}

export async function staleByFp(activeFp: string): Promise<NsRegistryEntry[]> {
  return (await listAllNamespaces()).filter((e) => e.fp !== activeFp)
}

// ---------------------------------------------------------------------------
// Recovery: rebuild the registry by scanning the ns/ directory
// ---------------------------------------------------------------------------

/**
 * Walk the on-disk `ns/` directory and reconstruct the registry from the
 * authoritative JSON files. Useful after a crash that left index.json out
 * of sync, or as a once-per-launch self-heal.
 *
 * Conservative: legacy (non-fingerprinted) files are listed with `fp =
 * 'legacy'` so they show up in `inventory()` and can be GC'd.
 */
export async function rebuildFromDisk(): Promise<NsRegistryEntry[]> {
  const root = await vsRoot()
  const nsDir = path.join(root, 'ns')
  // The new layout puts every namespace under ns/. The legacy layout had
  // them at the root with `ns-` prefixes — scan both for migration.
  const dirs = [nsDir, root]
  const seen = new Set<string>()
  const out: NsRegistryEntry[] = []

  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const full = path.join(dir, name)
      if (!name.endsWith('.json')) continue
      if (name === 'index.json') continue
      let st
      try {
        st = await stat(full)
        if (!st.isFile()) continue
      } catch {
        continue
      }

      // Resolve the bare namespace id from the filename (strip ns/ns- prefix).
      let nsId = name.replace(/\.json$/, '')
      if (nsId.startsWith('ns-')) nsId = nsId.slice(3)
      if (seen.has(nsId)) continue
      seen.add(nsId)

      // Read the file just enough to know its model + dim.
      let model = ''
      let dim = 0
      let chunkCount = 0
      try {
        const raw = await readFile(full, 'utf8')
        const j = JSON.parse(raw) as { model?: string; dim?: number; chunks?: unknown[] }
        model = typeof j.model === 'string' ? j.model : ''
        dim = typeof j.dim === 'number' ? j.dim : 0
        chunkCount = Array.isArray(j.chunks) ? j.chunks.length : 0
      } catch {
        // unreadable → still register so the GC can sweep it
      }

      const parsed = parseNamespace(nsId)
      if (parsed) {
        out.push({
          ns: nsId,
          kind: parsed.kind,
          sourceLabel: '',
          fp: parsed.fp,
          model,
          dim,
          builtAt: st.mtimeMs,
          chunkCount,
          sizeBytes: st.size,
        })
      } else {
        // Legacy namespace — categorize by prefix.
        const kind: NsKind = nsId.startsWith('att-')
          ? 'attachment'
          : nsId.startsWith('workspace-')
            ? 'workspace'
            : 'memory'
        out.push({
          ns: nsId,
          kind,
          sourceLabel: '',
          fp: 'legacy',
          model,
          dim,
          builtAt: st.mtimeMs,
          chunkCount,
          sizeBytes: st.size,
        })
      }
    }
  }

  await chainWrite(async () => {
    memCache = { version: 2, entries: out }
    await atomicSave(memCache)
  })
  return out
}

// ---------------------------------------------------------------------------
// Test seam — let unit tests force a clean state without touching disk.
// ---------------------------------------------------------------------------

/** Reset the in-memory cache. Disk is NOT touched. Test-only. */
export function __resetForTests(): void {
  memCache = null
  loadInFlight = null
  writeChain = Promise.resolve()
  rootPromise = null
}

/**
 * Stable hash for arbitrary source labels — used by callers that want a
 * predictable display id without exposing raw paths to the UI.
 * Not strictly required by the registry itself; lives here so consumers
 * have a one-stop import.
 */
export function shortHash(s: string, len = 12): string {
  return createHash('sha1').update(s).digest('hex').slice(0, len)
}
