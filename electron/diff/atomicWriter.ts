/**
 * Atomic file writer for the DiffTransaction pipeline (P3a).
 *
 * Protocol (cross-platform; Windows + POSIX friendly):
 *   1. Verify the caller's expectation of the current disk content via contentHash
 *      (optional — skip when writing brand-new files).
 *   2. If `targetPath` is a symlink, resolve it once via `readlinkSync` and write to the
 *      ULTIMATE target instead. This preserves the symlink itself (rename-into-symlink
 *      would silently replace the link with a regular file, breaking `node_modules/.bin`,
 *      versioned-dist pins, etc.). Resolution is a single hop — we trust callers not to
 *      stack arbitrary symlink chains intentionally.
 *   3. Write the new bytes to `<resolvedTarget>.tmp-<uuid>` in the SAME directory as the
 *      resolved target (rename across filesystems is not atomic and can leave the target
 *      half-written if the source and target live on different volumes).
 *   4. fsync the temp file so the data payload is durable before the name swap.
 *   5. Preserve file permissions: if the target existed, `chmod` the temp to its mode
 *      BEFORE rename — otherwise SSH keys, executable scripts, and other mode-sensitive
 *      files would silently flip to `umask`-default permissions after the swap.
 *   6. Rename temp → target. Node's `fs.renameSync` maps to `MoveFileExW` with
 *      `MOVEFILE_REPLACE_EXISTING` on Windows and to `rename(2)` on POSIX — both are
 *      atomic w.r.t. concurrent readers. On Windows the default lacks
 *      `MOVEFILE_WRITE_THROUGH`, so we fsync the PARENT DIR afterwards too (Node has no
 *      direct API for dir fsync on Windows, but `openSync`/`fsyncSync`/`closeSync` on a
 *      directory handle works — we do it best-effort and ignore EPERM).
 *   7. Read the file back and compute a post-write hash. If it does not match the
 *      expected content we return `{ ok: false, code: 'HASH_MISMATCH_POST_WRITE' }` so
 *      the caller can decide whether to roll back (they own the DT; we don't).
 *   8. On any failure in steps 3–7 we try to unlink the temp file (best-effort).
 *
 * What we DO NOT do:
 *   • Lock the target — that's the caller's job (see `withExclusiveFileLock` in the
 *     existing tools layer). Atomicity here is about partial-write prevention, not
 *     concurrent-writer arbitration.
 *   • Recursively resolve symlinks (we follow exactly one hop).
 *
 * We re-use `hashFileContent` from `readFileState` so the hash algorithm stays consistent
 * with the Content-Hash anchored edit gate — any drift would make "pre-write hash matches
 * but post-write hash doesn't" confusing.
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { hashFileContent } from '../tools/readFileState'

export type AtomicWriteErrorCode =
  | 'HASH_MISMATCH_PRE_WRITE'
  | 'HASH_MISMATCH_POST_WRITE'
  | 'TEMP_WRITE_FAILED'
  | 'RENAME_FAILED'
  | 'VERIFY_READ_FAILED'

export interface AtomicWriteOk {
  ok: true
  /** Bytes written (UTF-8 encoded length). */
  bytesWritten: number
  /** Hash of the content actually on disk after the write. */
  postWriteHash: string
  /** mtime at the moment of the successful verify read. */
  postWriteMtimeMs: number
}

export interface AtomicWriteError {
  ok: false
  code: AtomicWriteErrorCode
  message: string
  /** Original error (if any) for structured logging. */
  cause?: unknown
}

export type AtomicWriteResult = AtomicWriteOk | AtomicWriteError

export interface AtomicWriteOptions {
  /**
   * Expected current on-disk content hash. When supplied we re-hash before writing and
   * refuse if it differs. Supply `null` for brand-new files.
   */
  expectedContentHash: string | null
  /**
   * Full new content to persist. Line endings / BOM handling is the caller's
   * responsibility — we write exactly the bytes the encoding step produces.
   */
  newContent: string
  /**
   * Disk encoding for `newContent` and for the pre-write / post-verify reads.
   *
   * Defaults to `'utf-8'`, which fits modern repos virtually 100%. Pass
   * `'utf16le'` to round-trip a file whose BOM detection (via
   * `detectBufferEncoding` in `../utils/lineEndings`) identified it as
   * UTF-16LE — Node handles the BOM bytes on both sides automatically when
   * encoding is `utf16le`. Same encoding MUST be used for hash + verify;
   * the function applies it to all three reads/writes internally.
   *
   * Anything else (e.g. legacy 8-bit encodings) is not on the supported
   * encoding contract here: pass the file's bytes through a converter
   * upstream and feed us UTF-8 if you need them.
   */
  encoding?: BufferEncoding
  /**
   * Override the hash function (test hook). Defaults to the shared `hashFileContent`.
   */
  _hashFn?: (s: string) => string
}

/**
 * Best-effort directory fsync. On Windows opening a directory for fsync requires special
 * flags; rather than fighting the platform we swallow the common errors silently — the
 * rename itself is the atomic point, and dir fsync is only a durability belt-and-braces.
 */
function fsyncDirBestEffort(dirPath: string): void {
  try {
    const fd = fs.openSync(dirPath, 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    /* EPERM / EISDIR / ENOSUPP — ignore. Best-effort. */
  }
}

/** Remove the temp file if it still exists. Never throws. */
function unlinkTempQuietly(tempPath: string): void {
  try {
    fs.unlinkSync(tempPath)
  } catch {
    /* already gone, fine */
  }
}

/**
 * Errno values for which `fs.renameSync` failures are commonly transient on
 * Windows (and occasionally elsewhere) and worth retrying:
 *
 *   • EPERM — `MoveFileExW` returned ERROR_ACCESS_DENIED because another
 *     process holds a handle on the target (browser preview, Defender
 *     real-time scan, Windows Search Indexer, OneDrive/Dropbox sync clients,
 *     other editors). Usually clears within a few hundred ms.
 *   • EBUSY — target is genuinely in use; same backoff strategy applies.
 *   • EACCES — permission denied, but the same window-of-contention pattern
 *     manifests on Windows under heavy AV load. Retrying is cheap and the
 *     legitimate "no write permission" case still surfaces after backoff
 *     exhaustion with the same errno preserved in the message.
 *   • EMFILE / ENFILE — file-descriptor exhaustion. Pure resource pressure;
 *     a short wait gives the OS a chance to reclaim FDs.
 *
 * We deliberately do NOT retry ENOENT / ENOTDIR / EXDEV / ENOSPC — those
 * are structural failures that won't resolve on their own.
 */
const RETRYABLE_RENAME_ERRNOS = new Set([
  'EPERM',
  'EBUSY',
  'EACCES',
  'EMFILE',
  'ENFILE',
])

/**
 * Backoff schedule in ms. 5 attempts: 50 → 100 → 200 → 400 → 800 (total
 * sleep ≤ 1550 ms in the worst case, plus the 6 syscall costs). Chosen so
 * the slow path stays comfortably under 2 s — most real Windows contention
 * windows close within the first two retries (≤200 ms), so the long tail
 * is rare in practice.
 */
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const

/**
 * Synchronous sleep using `Atomics.wait` on a private SharedArrayBuffer.
 * `atomicWriteFile` runs inside the caller's lock and is sync by design,
 * so we cannot use `setTimeout`. Blocking the event loop for ≤1.6 s on
 * the write hot path is an acceptable trade for the much-improved Windows
 * reliability — alternative would be a top-to-bottom async refactor.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return
  const buf = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(buf, 0, 0, ms)
}

/**
 * Attempt the temp → target rename, retrying transient Windows-style
 * errnos with a small exponential backoff. Returns the final error if all
 * attempts fail.
 *
 * The `attempts` count returned is used to enrich the error message so the
 * agent / log reader can tell "this errored immediately" from "we tried
 * for 1.5 s and it kept failing" — the latter strongly suggests a process
 * is permanently holding the file open and no amount of further retry
 * will help.
 */
function renameWithBackoff(
  tempPath: string,
  targetAbs: string,
): { ok: true; attempts: number } | { ok: false; attempts: number; error: NodeJS.ErrnoException } {
  let lastError: NodeJS.ErrnoException | undefined
  const totalAttempts = RENAME_RETRY_DELAYS_MS.length + 1
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    try {
      fs.renameSync(tempPath, targetAbs)
      return { ok: true, attempts: attempt + 1 }
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      lastError = err
      const code = err.code ?? ''
      if (!RETRYABLE_RENAME_ERRNOS.has(code)) {
        // Non-retryable (e.g. ENOENT / EXDEV / ENOSPC) — fail fast.
        return { ok: false, attempts: attempt + 1, error: err }
      }
      const delay = RENAME_RETRY_DELAYS_MS[attempt]
      if (delay === undefined) break
      sleepSync(delay)
    }
  }
  return { ok: false, attempts: totalAttempts, error: lastError as NodeJS.ErrnoException }
}

/**
 * Resolve a single symlink hop, if the caller's path is a symlink. Returns the
 * absolute path the symlink points to, or the input unchanged. Errors other than
 * "not a symlink" / "doesn't exist" propagate so callers can surface the failure
 * (don't silently swallow EACCES — that would write to the wrong place).
 *
 * **One-hop only.** For a stacked chain `a → b → c`:
 *   - `readlinkSync(a)` returns `b` (or `b`'s pre-resolution form);
 *   - we write the temp file in `dir(b)` and `rename(temp, b)`;
 *   - `rename(2)` REPLACES the entry at `b` (it does not follow symlinks for
 *     the destination), so if `b` was itself a symlink to `c`, the link `b`
 *     is overwritten with a regular file and `c` is left untouched.
 *
 * This matches upstream's behaviour. The 1-hop pattern is correct
 * for the overwhelming common case (`node_modules/.bin/foo → ../foo/dist/cli.js`,
 * monorepo shared-config pins, etc.) and intentionally NOT multi-hop because
 * (a) recursive resolution would let a stale symlink chain redirect writes
 * unpredictably and (b) the additional readlink calls are wasted on the
 * regular-file case which is ~99% of writes. Document the limitation and
 * expect callers to set up symlink chains they actually want overwritten.
 */
function resolveSymlinkOneHop(targetAbs: string): string {
  let linkTarget: string
  try {
    linkTarget = fs.readlinkSync(targetAbs)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    // ENOENT — file doesn't exist (new file write). EINVAL / UV_EINVAL — not
    // a symlink (regular file). Both leave the path unchanged.
    if (code === 'ENOENT' || code === 'EINVAL' || code === 'UV_EINVAL') {
      return targetAbs
    }
    // Other errors (EACCES, EISDIR, …) — let them propagate by re-throwing.
    throw e
  }
  return path.isAbsolute(linkTarget)
    ? linkTarget
    : path.resolve(path.dirname(targetAbs), linkTarget)
}

/**
 * Stat a target ONLY if it currently exists as a regular file/link. Returns
 * `null` when the file is absent (new-file create path). Errors propagate so
 * we don't pretend "permission denied" looks the same as "fresh path".
 */
function statIfExists(p: string): fs.Stats | null {
  try {
    return fs.statSync(p)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/**
 * Core atomic write. All IPC / DT coupling lives outside this function — pass bytes,
 * get a structured result back.
 */
export function atomicWriteFile(
  targetPath: string,
  options: AtomicWriteOptions,
): AtomicWriteResult {
  const hashFn = options._hashFn ?? hashFileContent
  // Default to UTF-8 for the 99% case; callers that detected UTF-16LE BOM
  // pass `'utf16le'` so we read/write/verify in matching encoding. The
  // single `encoding` flows through every fs op below so we never mix
  // (e.g. write utf16le bytes but verify as utf-8) which would falsely
  // surface as HASH_MISMATCH_POST_WRITE.
  const encoding: BufferEncoding = options.encoding ?? 'utf-8'
  const inputAbs = path.resolve(targetPath)

  // Step 0 — symlink resolution. If `inputAbs` is a symlink, write to its
  // target so the link itself is preserved. Done BEFORE the pre-write hash
  // check so the hash compares against the bytes the caller actually saw
  // (which is what `readFileSync` would have returned — and `readFileSync`
  // follows the symlink, just like we do here).
  let targetAbs: string
  try {
    targetAbs = resolveSymlinkOneHop(inputAbs)
  } catch (e) {
    return {
      ok: false,
      code: 'VERIFY_READ_FAILED',
      message: `Failed to resolve symlink for ${inputAbs}: ${String(e)}`,
      cause: e,
    }
  }
  const dir = path.dirname(targetAbs)

  // Step 1 — pre-write hash check.
  if (options.expectedContentHash !== null) {
    let current = ''
    try {
      current = fs.existsSync(targetAbs) ? fs.readFileSync(targetAbs, encoding) : ''
    } catch (e) {
      return {
        ok: false,
        code: 'VERIFY_READ_FAILED',
        message: `Failed to read current disk content for hash verification: ${String(e)}`,
        cause: e,
      }
    }
    const currentHash = hashFn(current)
    if (currentHash !== options.expectedContentHash) {
      return {
        ok: false,
        code: 'HASH_MISMATCH_PRE_WRITE',
        message:
          'On-disk content hash no longer matches the caller\'s baseSnapshot — refusing to overwrite.',
      }
    }
  }

  // Capture target's existing mode (if any) BEFORE temp write — we apply it
  // to the temp before the rename so the swap is permission-preserving.
  // Doing the stat here (rather than between rename and chmod) means the
  // mode reflects pre-write state, not the post-rename file's umask default.
  const existingStat = statIfExists(targetAbs)
  const preservedMode = existingStat?.mode

  // Step 2 — write bytes to sibling temp. Collocated in the same directory so the
  // final rename is guaranteed atomic (same volume).
  const tempName = `.${path.basename(targetAbs)}.tmp-${randomUUID()}`
  const tempPath = path.join(dir, tempName)
  try {
    // `wx` ensures we never clobber a stale temp file from a prior crash.
    const fd = fs.openSync(tempPath, 'wx')
    try {
      fs.writeFileSync(fd, options.newContent, encoding)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch (e) {
    unlinkTempQuietly(tempPath)
    return {
      ok: false,
      code: 'TEMP_WRITE_FAILED',
      message: `Failed to write temp file at ${tempPath}: ${String(e)}`,
      cause: e,
    }
  }

  // Step 2.5 — preserve file permissions. If the target existed, copy its mode
  // onto the temp BEFORE rename. Failures here are best-effort: a chmod failure
  // (e.g. on a filesystem that doesn't support modes, like FAT) shouldn't
  // sink an otherwise-correct write. The temp's openSync(`wx`) default mode
  // is whatever umask gives, which is the fallback.
  if (preservedMode !== undefined) {
    try {
      fs.chmodSync(tempPath, preservedMode)
    } catch {
      /* best-effort — preserve content even if mode preservation fails. */
    }
  }

  // Step 3 — atomic rename, with backoff retries for transient Windows-style
  // errnos (EPERM/EBUSY/EACCES/EMFILE/ENFILE). See `renameWithBackoff` /
  // RETRYABLE_RENAME_ERRNOS for rationale. Total worst-case sleep ≤1.6 s.
  const renameOutcome = renameWithBackoff(tempPath, targetAbs)
  if (!renameOutcome.ok) {
    unlinkTempQuietly(tempPath)
    const err = renameOutcome.error
    const code = err.code ?? 'UNKNOWN'
    const isRetryable = RETRYABLE_RENAME_ERRNOS.has(code)
    // Compose a message that is actionable for BOTH a human reading logs AND
    // an LLM agent that has to decide whether to retry the edit.
    //
    // Key facts the agent needs:
    //   1. The on-disk file is UNCHANGED — atomicWriter wrote to a sibling
    //      temp and unlinked it; the original bytes are untouched. So the
    //      agent's prior baseReadId / readId on this path is still valid.
    //   2. On Windows, retryable errnos almost always mean another process
    //      holds a handle. List the common culprits so the human can act.
    const attemptsSuffix =
      renameOutcome.attempts > 1
        ? ` after ${renameOutcome.attempts} attempts (last delay ${RENAME_RETRY_DELAYS_MS[Math.min(renameOutcome.attempts - 2, RENAME_RETRY_DELAYS_MS.length - 1)] ?? 0} ms)`
        : ''
    const stableLine = `The file on disk is UNCHANGED — no bytes were written. Your previous baseReadId / readId on this path remains valid; the agent may retry the edit with the same baseReadId.`
    const windowsHint = isRetryable
      ? ` On Windows the ${code} errno on rename almost always means another process holds an open handle on the target file: a browser tab previewing it, antivirus real-time scan (e.g. Windows Defender), Windows Search Indexer, OneDrive / Dropbox sync clients, or another editor with the file open. Close those and retry.`
      : ''
    return {
      ok: false,
      code: 'RENAME_FAILED',
      message:
        `Failed to rename ${tempPath} → ${targetAbs}${attemptsSuffix}: ${String(err)}. ` +
        stableLine +
        windowsHint,
      cause: err,
    }
  }

  // Step 4 — best-effort parent dir fsync so the directory entry is durable too.
  fsyncDirBestEffort(dir)

  // Step 5 — verify by re-reading. This catches the pathological case where a filesystem
  // filter driver (AV on Windows, corrupted FS, etc) mutated the payload on the way out.
  let verifyContent: string
  let stat: fs.Stats
  try {
    verifyContent = fs.readFileSync(targetAbs, encoding)
    stat = fs.statSync(targetAbs)
  } catch (e) {
    return {
      ok: false,
      code: 'VERIFY_READ_FAILED',
      message: `Post-write verify read failed: ${String(e)}`,
      cause: e,
    }
  }
  if (verifyContent !== options.newContent) {
    return {
      ok: false,
      code: 'HASH_MISMATCH_POST_WRITE',
      message: 'Bytes on disk after rename differ from the requested payload.',
    }
  }

  return {
    ok: true,
    bytesWritten: Buffer.byteLength(options.newContent, encoding),
    postWriteHash: hashFn(options.newContent),
    postWriteMtimeMs: stat.mtimeMs,
  }
}
