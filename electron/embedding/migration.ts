/**
 * One-shot v1 → v2 vector-store layout migration.
 *
 * v1 layout (pre-fingerprint):
 *   {userData}/vector-store/ns-<oldName>.json     - mixed legacy ns names
 *   {userData}/workspace-index-meta/<ns>.json     - workspace status sidecars
 *   {userData}/memory-vectors/<sha20>.json        - private memory recall cache
 *
 * v2 layout:
 *   {userData}/vector-store/index.json            - registry
 *   {userData}/vector-store/ns/<ns>.json          - namespace files
 *   {userData}/vector-store/meta/<ns>.json        - status sidecars (TBD)
 *   (legacy memory cache is fully retired — vectors live in the unified store)
 *
 * Migration strategy: archive, don't transform.
 *
 *   - Vectors are pure caches; sources (attachments, source code, memory
 *     markdowns) all live elsewhere on disk and can re-embed cheaply.
 *   - In-place rename of legacy filenames into fp-bearing v2 names is
 *     fragile (the fp depends on the model that produced the vector — a
 *     fact we'd have to read out of every namespace file and trust).
 *   - Archiving sidesteps both risks. The user's first send/build after
 *     upgrade silently rebuilds whatever it actually needs.
 *
 * Idempotent: a marker file in the new layout signals "already migrated";
 * subsequent calls are no-ops.
 */

import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'

const MARKER_FILENAME = '.v2-migrated'

export interface MigrationReport {
  /** Whether anything was archived this run. */
  migrated: boolean
  /** Absolute path of the archive directory, or null when nothing moved. */
  archiveDir: string | null
  /** What we relocated (per source dir, count of files moved). */
  details: Array<{ from: string; files: number }>
}

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

async function fileCount(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir)
    let n = 0
    for (const e of entries) {
      try {
        const s = await stat(path.join(dir, e))
        if (s.isFile()) n++
      } catch { /* skip */ }
    }
    return n
  } catch {
    return 0
  }
}

/**
 * Run once at app startup. Cheap and safe to invoke unconditionally; returns
 * `migrated: false` when nothing needs doing.
 *
 * Returns a report the renderer can show as a one-time toast.
 */
export async function migrateVectorStoreV1ToV2(): Promise<MigrationReport> {
  const userData = app.getPath('userData')
  const vsRoot = path.join(userData, 'vector-store')
  const marker = path.join(vsRoot, MARKER_FILENAME)

  // Already migrated → no-op.
  if (await pathExists(marker)) {
    return { migrated: false, archiveDir: null, details: [] }
  }

  const candidates: Array<{ srcDir: string; label: string }> = [
    // v1 vector store root: contains `ns-*.json` files alongside (potentially)
    // a v1 `index.json` with the old single-version shape.
    { srcDir: vsRoot, label: 'vector-store-root' },
    { srcDir: path.join(userData, 'workspace-index-meta'), label: 'workspace-index-meta' },
    { srcDir: path.join(userData, 'memory-vectors'), label: 'memory-vectors' },
  ]

  // Detect v1 artifacts. For vsRoot we only count legacy `ns-*.json` files;
  // any other file (notably the new index.json or `ns/` subdir) is part of
  // v2 already.
  const probes: Array<{ src: string; v1Files: number; label: string }> = []
  let total = 0
  for (const c of candidates) {
    if (!(await pathExists(c.srcDir))) continue
    if (c.srcDir === vsRoot) {
      // Filter to v1 shape only.
      try {
        const entries = await readdir(c.srcDir)
        const legacyFiles = entries.filter((e) => /^ns-.*\.json$/.test(e))
        probes.push({ src: c.srcDir, v1Files: legacyFiles.length, label: c.label })
        total += legacyFiles.length
      } catch { /* skip */ }
    } else {
      const n = await fileCount(c.srcDir)
      if (n > 0) {
        probes.push({ src: c.srcDir, v1Files: n, label: c.label })
        total += n
      }
    }
  }

  if (total === 0) {
    // First-ever run, or the user has no v1 artifacts. Drop the marker so
    // we don't probe again next launch.
    try { await mkdir(vsRoot, { recursive: true }) } catch { /* noop */ }
    try { await writeFile(marker, new Date().toISOString(), 'utf8') } catch { /* noop */ }
    return { migrated: false, archiveDir: null, details: [] }
  }

  // Archive everything we found.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archiveDir = path.join(userData, `vector-store-legacy-${stamp}`)
  await mkdir(archiveDir, { recursive: true })

  const details: MigrationReport['details'] = []
  for (const probe of probes) {
    if (probe.label === 'vector-store-root') {
      // Move only the legacy files; keep new-layout artifacts intact.
      const dst = path.join(archiveDir, 'vector-store')
      await mkdir(dst, { recursive: true })
      let moved = 0
      try {
        const entries = await readdir(probe.src)
        for (const e of entries) {
          if (!/^ns-.*\.json$/.test(e)) continue
          try {
            await rename(path.join(probe.src, e), path.join(dst, e))
            moved++
          } catch { /* skip individual failure */ }
        }
      } catch { /* dir may have vanished */ }
      if (moved > 0) details.push({ from: probe.label, files: moved })
    } else {
      // Whole-directory move.
      const dst = path.join(archiveDir, path.basename(probe.src))
      try {
        await rename(probe.src, dst)
        details.push({ from: probe.label, files: probe.v1Files })
      } catch {
        // rename across volumes can fail on some platforms — fall back to
        // file-by-file copy is overkill for caches; just skip and let the
        // user delete the old dir manually.
      }
    }
  }

  // Drop a small README in the archive so the user knows what it is.
  try {
    await writeFile(
      path.join(archiveDir, '_README.txt'),
      [
        'Vector store v1 → v2 migration archive',
        `Created: ${new Date().toString()}`,
        '',
        'These directories held cached embedding vectors from a previous version',
        'of this app. They are no longer used. If retrieval works correctly after',
        'the upgrade, you can safely delete this entire folder.',
        '',
        'Archived contents:',
        ...details.map((d) => `  - ${d.from}: ${d.files} files`),
      ].join('\n'),
      'utf8',
    )
  } catch { /* non-fatal */ }

  // Drop the marker so we don't migrate again.
  try { await mkdir(vsRoot, { recursive: true }) } catch { /* noop */ }
  try { await writeFile(marker, new Date().toISOString(), 'utf8') } catch { /* noop */ }

  return { migrated: true, archiveDir, details }
}
