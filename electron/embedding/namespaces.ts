/**
 * Single, authoritative namespace generator.
 *
 * A namespace identifies one (kind, source, model-fp) triple inside the
 * vector store:
 *
 *   <kind>-<sourceHash16>-<fp12>
 *   ─────  ────────────────  ────
 *     │           │            └── 12-hex model fingerprint (see ./fingerprint.ts)
 *     │           └── 16-hex sha1 of `${kind}:${sourceId}` — opaque, irreversible
 *     └── 'attachment' | 'workspace' | 'memory'
 *
 * Why this shape?
 *   - Including the model fingerprint in the namespace string means every
 *     `hasNamespace()` / `queryTopK()` call answers exactly one question:
 *     "do I have vectors for this source produced by THIS model?". Switching
 *     models naturally produces a different namespace, so old vectors don't
 *     poison new queries.
 *   - The kind prefix makes namespaces sortable and groupable on disk and
 *     in the registry (see ./registry.ts) without parsing JSON contents.
 *   - The sha hash of sourceId is used so secrets / paths don't leak into
 *     filenames and so all namespace files share a uniform character set
 *     (Linux/Windows/macOS-safe).
 *
 * IMPORTANT: every consumer that needs a namespace MUST call
 * `buildNamespace()` from this module. Construction-by-string-concat in
 * other files is deprecated and will be removed once migration completes.
 */

import { createHash } from 'crypto'

export type NsKind = 'attachment' | 'workspace' | 'memory'

export interface SourceKey {
  kind: NsKind
  /**
   * Per-kind source identifier. Conventions:
   *   - attachment: the attachment sha256 (lowercased), optionally suffixed
   *                 with `:${kind}` to distinguish e.g. `pdf` vs `excel`
   *                 extractions of the same bytes
   *   - workspace : `path.resolve(root)` lowercased + `/`-normalized
   *   - memory    : `user` for the install-side bundle, `project:${absRoot}`
   *                 for workspace-scoped memories
   */
  id: string
}

const FP_RE = /^[0-9a-f]{12}$/
const SOURCE_RE = /^[0-9a-f]{16}$/
const NS_RE = /^(attachment|workspace|memory)-([0-9a-f]{16})-([0-9a-f]{12})$/

/**
 * Hash the source id into a 16-hex chunk. The kind is mixed into the hash so
 * `attachment:xxx` and `workspace:xxx` (where `xxx` happens to be the same
 * id by accident) never collide — even though the kind prefix outside also
 * separates them.
 */
export function sourceHashOf(src: SourceKey): string {
  return createHash('sha1').update(`${src.kind}:${src.id}`).digest('hex').slice(0, 16)
}

/** Build a namespace string for the given source + model fingerprint. */
export function buildNamespace(src: SourceKey, fp: string): string {
  if (!FP_RE.test(fp)) {
    throw new Error(`buildNamespace: invalid fingerprint "${fp}" (expected 12 hex chars)`)
  }
  return `${src.kind}-${sourceHashOf(src)}-${fp}`
}

/** Reverse — pull the structural pieces out of a well-formed namespace. */
export function parseNamespace(ns: string): { kind: NsKind; sourceHash: string; fp: string } | null {
  const m = NS_RE.exec(ns)
  if (!m) return null
  return { kind: m[1] as NsKind, sourceHash: m[2], fp: m[3] }
}

/** True when the namespace was produced by `buildNamespace` (vs a legacy ad-hoc string). */
export function isFingerprintedNamespace(ns: string): boolean {
  return NS_RE.test(ns)
}

/**
 * Legacy namespace detection. Used during the v1 → v2 migration to identify
 * the file shapes that pre-date the fingerprint scheme:
 *   - `att-{kind}-{sha32}`         (rag.ts attachmentNamespace)
 *   - `workspace-{sha16}`          (workspaceIndex.ts workspaceNamespace)
 *   - `attachment-{sha16}`         (defunct dead-code form)
 *   - `memory-{sha16}`             (defunct dead-code form — never written today)
 */
export function isLegacyNamespace(ns: string): boolean {
  if (isFingerprintedNamespace(ns)) return false
  return (
    /^att-[A-Za-z0-9_-]+-[0-9a-f]{32}$/.test(ns) ||
    /^workspace-[0-9a-f]{16}$/.test(ns) ||
    /^attachment-[0-9a-f]{16}$/.test(ns) ||
    /^memory-[0-9a-f]{16}$/.test(ns)
  )
}

/** Validate that a hex string looks like a 16-char source hash (utility). */
export function isSourceHash(s: string): boolean {
  return SOURCE_RE.test(s)
}
