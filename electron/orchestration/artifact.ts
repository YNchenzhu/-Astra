/**
 * ArtifactPort: centralize "rich outputs produced by a turn" for renderer consumption.
 *
 * the IDE ships a first-class artifact model (diffs, canvases, structured schemas, tables). In
 * our codebase these surface today via different channels — inline diff preview IPC, stream
 * events, tool-result content, etc. The ArtifactPort is an orchestration-level bus where any
 * producer can post a typed artifact, and the kernel can emit a consolidated "artifact manifest"
 * at Terminal so the renderer (and session persistence) sees one aggregated list per turn.
 *
 * Strategic role:
 *   - Decouples artifact producers (tools, compaction, subagents) from renderer routing.
 *   - Ready extension point for session replay / canvas resurrection: every artifact carries an
 *     id + producerTurn so the renderer can reattach it when reopening a conversation.
 *   - The port is optional — kernels built without one retain legacy behavior byte-for-byte.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createAppendListChannel } from './channels'

export type ArtifactKind =
  | 'diff'
  | 'canvas'
  | 'schema'
  | 'table'
  | 'image'
  | 'link'
  | 'summary'
  | 'custom'

export type ArtifactEntry = {
  id: string
  kind: ArtifactKind
  /** Human-readable label for UI (e.g. 'electron/orchestration/kernel.ts'). */
  label?: string
  /** Stable producer label — typically tool name or subsystem (e.g. 'Edit', 'compact'). */
  producer: string
  /** 1-indexed outer turn this artifact belongs to. */
  producerTurn?: number
  /** 1-indexed inner model iteration within the turn (when applicable). */
  producerInnerTurn?: number
  /**
   * Opaque payload. Callers decide the shape; common shapes:
   *   - diff: `{ filePath, originalContent, modifiedContent }`
   *   - canvas: `{ componentModule, props }`
   *   - schema: `{ title, jsonSchema }`
   * Keep payloads JSON-serializable so the manifest can be persisted or replayed.
   */
  payload: Record<string, unknown>
  /** Wall-clock ms when published. */
  at: number
}

export interface ArtifactPort {
  publish(entry: Omit<ArtifactEntry, 'id' | 'at'>): ArtifactEntry
  list(filter?: { producerTurn?: number; kind?: ArtifactKind }): ArtifactEntry[]
  clear(): void
}

/**
 * In-memory artifact port with optional capacity cap. Callers that want persistence can wrap
 * this port with a decorator that flushes to disk on each publish.
 */
export function createInMemoryArtifactPort(options?: {
  maxEntries?: number
  /** Optional observer — e.g. send a `TransportPort.emit` as each artifact is published. */
  onPublish?: (entry: ArtifactEntry) => void
}): ArtifactPort {
  const max = Math.max(1, options?.maxEntries ?? 200)
  // the in-memory storage is an AppendList channel. Behaviour stays byte-for-byte
  // identical (FIFO overflow at `max`, insertion-order list). The win is that the FIFO
  // policy is no longer duplicated against `sessionCommands` / `checkpoint` and the channel
  // can later be snapshotted as part of a unified `KernelChannelSnapshot` (P2.1 plumbing).
  const channel = createAppendListChannel<ArtifactEntry>({ maxSize: max })
  let entries: ArtifactEntry[] = channel.empty()
  return {
    publish(partial) {
      const entry: ArtifactEntry = {
        id: randomUUID(),
        at: Date.now(),
        ...partial,
      }
      entries = channel.reduce(entries, entry)
      try {
        options?.onPublish?.(entry)
      } catch (e) {
        console.warn('[ArtifactPort] onPublish failed:', e)
      }
      return entry
    },
    list(filter) {
      if (!filter) return entries.slice()
      return entries.filter((e) => {
        if (filter.producerTurn !== undefined && e.producerTurn !== filter.producerTurn) {
          return false
        }
        if (filter.kind !== undefined && e.kind !== filter.kind) return false
        return true
      })
    },
    clear() {
      entries = channel.empty()
    },
  }
}

/**
 * Manifest payload emitted at Terminal — plain JSON so session persistence / IPC can forward it
 * unchanged. Caller chooses how to route (typically as part of `onTranscriptCommitted`).
 */
export type ArtifactManifest = {
  turn: number
  entries: ArtifactEntry[]
}

/**
 * File-backed ArtifactPort that mirrors {@link createInMemoryArtifactPort} but additionally
 * serialises every published entry to `<conversationDir>/artifacts/<id>.json`. This unblocks
 * canvas/diff resurrection on conversation reopen — without it, artifacts survive only as long
 * as the original kernel is alive.
 *
 * Storage layout:
 *   <conversationDir>/artifacts/
 *     index.json          ← ordered list of {id, kind, producerTurn, producer, label, at}
 *     <id>.json           ← full {@link ArtifactEntry} (payload included)
 *
 * Writes are best-effort + atomic (tmp + rename). Failures degrade to in-memory behavior so
 * artifact publication never throws into the agentic loop.
 */
export function createFileArtifactPort(
  conversationDir: string,
  options?: {
    maxEntries?: number
    onPublish?: (entry: ArtifactEntry) => void
  },
): ArtifactPort {
  const max = Math.max(1, options?.maxEntries ?? 200)
  const dir = path.join(conversationDir, 'artifacts')
  const indexPath = path.join(dir, 'index.json')

  function ensureDir(): void {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* ignore */
    }
  }

  function loadIndex(): ArtifactEntry[] {
    try {
      if (!fs.existsSync(indexPath)) return []
      const raw = fs.readFileSync(indexPath, 'utf-8')
      const parsed = JSON.parse(raw) as ArtifactEntry[]
      return Array.isArray(parsed) ? parsed : []
    } catch (e) {
      console.warn('[FileArtifactPort] loadIndex failed:', e)
      return []
    }
  }

  function writeJsonAtomic(file: string, value: unknown): void {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf-8')
    fs.renameSync(tmp, file)
  }

  function writeIndex(entries: ArtifactEntry[]): void {
    try {
      ensureDir()
      writeJsonAtomic(indexPath, entries)
    } catch (e) {
      console.warn('[FileArtifactPort] writeIndex failed:', e)
    }
  }

  function writeEntry(entry: ArtifactEntry): void {
    try {
      ensureDir()
      writeJsonAtomic(path.join(dir, `${entry.id}.json`), entry)
    } catch (e) {
      console.warn('[FileArtifactPort] writeEntry failed:', e)
    }
  }

  function deleteEntryFile(id: string): void {
    try {
      const f = path.join(dir, `${id}.json`)
      if (fs.existsSync(f)) fs.unlinkSync(f)
    } catch {
      /* ignore */
    }
  }

  // Re-hydrate from disk so reopened conversations expose artifacts published in prior sessions.
  const entries: ArtifactEntry[] = loadIndex()

  return {
    publish(partial) {
      const entry: ArtifactEntry = {
        id: randomUUID(),
        at: Date.now(),
        ...partial,
      }
      entries.push(entry)
      while (entries.length > max) {
        const dropped = entries.shift()
        if (dropped) deleteEntryFile(dropped.id)
      }
      writeEntry(entry)
      writeIndex(entries)
      try {
        options?.onPublish?.(entry)
      } catch (e) {
        console.warn('[FileArtifactPort] onPublish failed:', e)
      }
      return entry
    },
    list(filter) {
      if (!filter) return entries.slice()
      return entries.filter((e) => {
        if (filter.producerTurn !== undefined && e.producerTurn !== filter.producerTurn) {
          return false
        }
        if (filter.kind !== undefined && e.kind !== filter.kind) return false
        return true
      })
    },
    clear() {
      for (const e of entries) deleteEntryFile(e.id)
      entries.length = 0
      try {
        if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath)
      } catch {
        /* ignore */
      }
    },
  }
}
