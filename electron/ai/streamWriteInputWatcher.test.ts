/**
 * Unit tests for the provider-agnostic `StreamWriteInputWatcher`. Drives
 * the watcher with synthetic per-block input_json_delta chunks the way the
 * Anthropic and OpenAI-compatible providers would in production, and
 * asserts the watcher fires a rejection exactly when the model has emitted
 * enough JSON to prove a `Write` call will be rejected by the preflight
 * gate.
 *
 * Contract under test (current): write_file is ONLY for creating NEW files.
 * The watcher rejects as soon as `filePath` is extractable AND points at any
 * existing regular file on disk ? even a zero-byte one. The legacy 50-byte
 * threshold no longer exists.
 */
import { afterEach, beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { setWorkspacePath } from '../tools/workspaceState'
import { StreamWriteInputWatcher } from './streamWriteInputWatcher'

/**
 * Local sizing helper. After the "any existing file ? use edit_file" rule
 * landed (no 50-byte threshold any more), the exact byte count of the
 * fixture file does not affect the watcher verdict ? any non-directory
 * file rejects. Keeping a single named constant keeps the test bodies
 * readable.
 */
const LARGE_FILE_BODY_BYTES = 4096

let workspaceDir: string

beforeAll(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-wiw-'))
})

afterAll(() => {
  try {
    fs.rmSync(workspaceDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

beforeEach(() => {
  setWorkspacePath(workspaceDir)
})

afterEach(() => {
  setWorkspacePath(null)
})

describe('StreamWriteInputWatcher ? rejection path', () => {
  it('fires a rejection AS SOON AS `filePath` to an existing file is extractable, before `content` streams', () => {
    const big = 'a'.repeat(LARGE_FILE_BODY_BYTES)
    fs.writeFileSync(path.join(workspaceDir, 'existing.ts'), big)

    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(0, { id: 'toolu_w1', name: 'Write' })

    // Stream tiny chunks like the SDK / a real gateway would.
    expect(w.feedInputJsonDelta(0, '{"file')).toBeNull()
    expect(w.feedInputJsonDelta(0, 'Path":"exi')).toBeNull()
    expect(w.feedInputJsonDelta(0, 'sting.ts"')).not.toBeNull()

    const r = w.getRejection()
    expect(r).not.toBeNull()
    expect(r!.toolUse.id).toBe('toolu_w1')
    expect(r!.toolUse.name).toBe('Write')
    expect(r!.toolUse.input.filePath).toBe('existing.ts')
    // No `content` field on the synthetic tool_use ? we aborted before it streamed.
    expect(Object.keys(r!.toolUse.input)).toEqual(['filePath'])
    expect(r!.error).toMatch(/write_file refused/)
    expect(r!.error).toMatch(/edit_file/)
    expect(r!.filePath).toBe('existing.ts')
    // Audit B2: pin the reason discriminator so an accidental rename of
    // the existing-file branch ('existing_file') triggers a test failure.
    expect(r!.reason).toBe('existing_file')
    // Existing-file path also carries the pre-baked verdict so the batch /
    // orchestrated execution paths (which never run B-grade's disk
    // preflight) surface the canonical "use edit_file" message instead of
    // a misleading Zod "missing required argument" error.
    expect(r!.toolUse.preflightError).toBe(r!.error)
  })

  it('does NOT fire on a `path`-alias write to a NEW file, even when `content` streams first in a later chunk', () => {
    // Regression: the partial-JSON scanner did not know the `path` alias
    // (which Zod accepts), so `{"path":…,"content":…}` was mis-classified
    // as content-before-filePath and aborted with an empty synthetic
    // input — every provider emitting `path` failed write_file with a
    // misleading "missing/empty required argument" error.
    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(0, { id: 'toolu_path_alias', name: 'write_file' })
    expect(w.feedInputJsonDelta(0, '{"path":"brand-new-file.md"')).toBeNull()
    expect(w.feedInputJsonDelta(0, ',"content":"big body…')).toBeNull()
    expect(w.getRejection()).toBeNull()
  })

  it('fires the existing-file rejection for the `path` alias too', () => {
    const big = 'a'.repeat(LARGE_FILE_BODY_BYTES)
    fs.writeFileSync(path.join(workspaceDir, 'path-alias.ts'), big)

    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(0, { id: 'toolu_path_alias_2', name: 'write_file' })
    expect(w.feedInputJsonDelta(0, '{"path":"path-alias.ts"')).not.toBeNull()
    const r = w.getRejection()!
    expect(r.reason).toBe('existing_file')
    expect(r.toolUse.input.filePath).toBe('path-alias.ts')
    expect(r.toolUse.preflightError).toBe(r.error)
  })

  it('also fires for snake_case `write_file` + `file_path` aliases', () => {
    const big = 'a'.repeat(LARGE_FILE_BODY_BYTES)
    fs.writeFileSync(path.join(workspaceDir, 'legacy.ts'), big)

    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(0, { id: 'toolu_w_legacy', name: 'write_file' })

    expect(w.feedInputJsonDelta(0, '{"file_path":"legacy.ts"')).not.toBeNull()
    const r = w.getRejection()!
    expect(r.toolUse.name).toBe('write_file')
    expect(r.toolUse.input.filePath).toBe('legacy.ts')
  })

  it('routes deltas by tool_use_id via feedInputJsonDeltaById (gateway adapter path)', () => {
    const big = 'a'.repeat(LARGE_FILE_BODY_BYTES)
    fs.writeFileSync(path.join(workspaceDir, 'id-routed.ts'), big)

    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(7, { id: 'toolu_w_id', name: 'Write' })

    // Gateway adapters don't always preserve the Anthropic `index`; the
    // id-based variant must still find the block.
    expect(w.feedInputJsonDeltaById('toolu_w_id', '{"filePath":"id-routed.ts"')).not.toBeNull()
  })

  it('fires on a tiny existing file (no soft threshold any more)', () => {
    // Pre-rule a sub-50-byte file would have passed silently. Under the
    // strengthened contract, the very same fixture must trigger an early
    // rejection so the model doesn't waste tokens streaming a doomed
    // `content` payload.
    fs.writeFileSync(path.join(workspaceDir, 'tiny.txt'), 'x')

    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(0, { id: 'toolu_w_tiny', name: 'Write' })
    expect(w.feedInputJsonDelta(0, '{"filePath":"tiny.txt"')).not.toBeNull()
    const r = w.getRejection()!
    expect(r.toolUse.input.filePath).toBe('tiny.txt')
    expect(r.error).toMatch(/edit_file/)
  })

  it('fires on a zero-byte existing file (firmest case ? empty file must still route through edit_file)', () => {
    fs.writeFileSync(path.join(workspaceDir, 'empty.txt'), '')

    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(0, { id: 'toolu_w_empty_file', name: 'Write' })
    expect(w.feedInputJsonDelta(0, '{"filePath":"empty.txt"')).not.toBeNull()
    expect(w.getRejection()!.error).toMatch(/edit_file/)
  })
})

describe('StreamWriteInputWatcher ? pass-through (no false positives)', () => {
  it('returns null for a Write on a brand-new file (legitimate create)', () => {
    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(0, { id: 'toolu_w_new', name: 'Write' })

    expect(w.feedInputJsonDelta(0, '{"filePath":"brand-new.ts"')).toBeNull()
    // Subsequent `content` chunks should NOT spuriously trigger the
    // watcher ? they're past the per-block `confirmedSafe` shortcut.
    expect(w.feedInputJsonDelta(0, ',"content":"export const x = 1"}')).toBeNull()
    expect(w.getRejection()).toBeNull()
  })

  it('returns null for non-Write tools targeting an existing file', () => {
    const big = 'a'.repeat(LARGE_FILE_BODY_BYTES)
    fs.writeFileSync(path.join(workspaceDir, 'shared.ts'), big)

    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(0, { id: 'toolu_e_1', name: 'Edit' })
    expect(w.feedInputJsonDelta(0, '{"filePath":"shared.ts","oldString":"a","newString":"b"}')).toBeNull()
    expect(w.getRejection()).toBeNull()
  })

  it('returns null on unknown block index (delta arrived without registration)', () => {
    const w = new StreamWriteInputWatcher()
    expect(w.feedInputJsonDelta(0, '{"filePath":"anything.ts"}')).toBeNull()
  })

  it('returns null on empty delta', () => {
    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(0, { id: 'toolu_w_empty', name: 'Write' })
    expect(w.feedInputJsonDelta(0, '')).toBeNull()
  })
})

describe('StreamWriteInputWatcher ? single-fire semantics', () => {
  it('fires AT MOST ONCE across all blocks ? subsequent calls return null even on a brand-new violation', () => {
    const big = 'a'.repeat(LARGE_FILE_BODY_BYTES)
    fs.writeFileSync(path.join(workspaceDir, 'first.ts'), big)
    fs.writeFileSync(path.join(workspaceDir, 'second.ts'), big)

    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(0, { id: 'toolu_w_first', name: 'Write' })
    w.registerToolUseBlock(1, { id: 'toolu_w_second', name: 'Write' })

    expect(w.feedInputJsonDelta(0, '{"filePath":"first.ts"')).not.toBeNull()
    // Another delta on the SAME (rejected) block ? still null.
    expect(w.feedInputJsonDelta(0, ',"content":"x"}')).toBeNull()
    // A delta on a DIFFERENT block that would also reject ? still null,
    // because the caller is expected to have aborted by now. This
    // prevents the parent emitting two synthetic tool_uses for one
    // aborted stream.
    expect(w.feedInputJsonDelta(1, '{"filePath":"second.ts"')).toBeNull()
    expect(w.getRejection()!.toolUse.id).toBe('toolu_w_first')
  })

  it('releaseBlock removes the tracker entry (long-stream memory bound)', () => {
    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(3, { id: 'toolu_w_release', name: 'Write' })
    w.releaseBlock(3)
    // After release, deltas for index 3 are unknown again.
    expect(w.feedInputJsonDelta(3, '{"filePath":"anything"')).toBeNull()
  })

  it('rejects with absolute path (no workspace-relative resolution issues)', () => {
    const big = 'a'.repeat(LARGE_FILE_BODY_BYTES + 200)
    const absPath = path.join(workspaceDir, 'abs-target.ts')
    fs.writeFileSync(absPath, big)

    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(0, { id: 'toolu_w_abs', name: 'Write' })

    // JSON-encode the absolute path so backslashes are escaped.
    const encoded = JSON.stringify(absPath)
    const rej = w.feedInputJsonDelta(0, `{"filePath":${encoded}`)
    expect(rej).not.toBeNull()
    expect(rej!.toolUse.input.filePath).toBe(absPath)
  })
})

describe('StreamWriteInputWatcher ? defensive guards', () => {
  it('ignores malformed registration calls', () => {
    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(-1, { id: 'x', name: 'Write' })
    w.registerToolUseBlock(0, { id: '', name: 'Write' } as unknown as { id: string; name: string })
    w.registerToolUseBlock(0, { id: 'ok', name: 42 as unknown as string })
    // None of the above should have registered; deltas are no-op.
    expect(w.feedInputJsonDelta(-1, '{"filePath":"x"')).toBeNull()
    expect(w.feedInputJsonDelta(0, '{"filePath":"x"')).toBeNull()
  })
})

describe('StreamWriteInputWatcher — content-before-filePath (no longer aborts)', () => {
  // DeepSeek V4 Pro (via Anthropic-compat gateway) emits write_file
  // arguments in the order {"content":"…","filePath":"…"} — ignoring the
  // tool schema's property order. The model could otherwise stream a
  // multi-KB `content` payload before the host ever knows the target
  // path, defeating the entire purpose of C-grade preflight.
  //
  // The watcher detects this signature (`content` key present, no
  // `filePath`/`file_path` key) but — as of debug session 0af1ac — it no
  // longer aborts the stream. Aborting killed every legitimate NEW-file
  // write from content-first models (which cannot reorder their JSON keys),
  // producing an infinite abort→retry→abort loop. Instead it marks the
  // block `confirmedSafe` and lets the full stream complete; writes to an
  // EXISTING file are still rejected by the in-tool disk preflight at write
  // time.

  it('does NOT abort when `content` appears before `filePath` (marks the block safe)', () => {
    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(0, { id: 'toolu_inv', name: 'Write' })

    // Model emits `content` key first. The detector recognises the
    // content-before-filePath signature but must NOT fire a rejection.
    expect(w.feedInputJsonDelta(0, '{"content":"')).toBeNull()
    expect(w.getRejection()).toBeNull()
    // The block is now confirmedSafe, so subsequent deltas (the bulky
    // content body, then the trailing `filePath`) are no-ops and never
    // produce a late rejection.
    expect(w.feedInputJsonDelta(0, 'export const x = 1","filePath":"new.ts"}')).toBeNull()
    expect(w.getRejection()).toBeNull()
  })

  it('does NOT abort even when the `content` key straddles multiple deltas', () => {
    // Real Anthropic-compat streams chunk the JSON arguments at arbitrary
    // byte boundaries — the `"content":` key token can straddle 2-3
    // input_json_delta events. None of these may produce a rejection.
    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(0, { id: 'toolu_multi', name: 'Write' })

    expect(w.feedInputJsonDelta(0, '{"con')).toBeNull()
    expect(w.feedInputJsonDelta(0, 'tent"')).toBeNull()
    expect(w.feedInputJsonDelta(0, ':"')).toBeNull()
    expect(w.getRejection()).toBeNull()
  })

  it('does NOT fire when `filePath` arrives in the same delta as `content` (filePath first)', () => {
    // Sanity guard: a single-delta full input where filePath comes first
    // must still go through the normal extract → preflight path, not the
    // content-before-filePath branch.
    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(0, { id: 'toolu_safe', name: 'Write' })

    // No existing file at `brand-new.ts` → preflight allows it → null.
    const rej = w.feedInputJsonDelta(
      0,
      '{"filePath":"brand-new-create.ts","content":"export const x = 1"}',
    )
    expect(rej).toBeNull()
  })

  it('does NOT fire on Edit/MultiEdit tools that happen to stream a `content`-shaped key', () => {
    // Defensive: only built-in full-file write tools (`write_file` /
    // `Write`) are eligible for any C-grade check. Edit uses
    // `oldString`/`newString` and has no `content` field — but the test
    // pins the invariant in case a future tool definition collides.
    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(0, { id: 'toolu_e_ok', name: 'Edit' })

    expect(w.feedInputJsonDelta(0, '{"content":"some"}')).toBeNull()
    expect(w.getRejection()).toBeNull()
  })

  it('falls back to confirmedSafe when `filePath` streams as an empty string', () => {
    // Model emits `{"filePath":"","content":"?large blob?"}`. The
    // extractor's empty-filter (`v.length > 0`) returns null for the
    // empty path, so the watcher would otherwise keep `+=`-ing the
    // entire content stream. The cap stops the bleeding.
    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(0, { id: 'toolu_empty', name: 'Write' })

    expect(w.feedInputJsonDelta(0, '{"filePath":"","content":"')).toBeNull()
    const chunk = 'y'.repeat(1024)
    for (let i = 0; i < 5; i++) {
      expect(w.feedInputJsonDelta(0, chunk)).toBeNull()
    }
    // Further deltas after the bailout are short-circuited too ?
    // confirmedSafe makes the block a no-op for the remainder of the
    // stream, no matter what arrives next.
    expect(w.feedInputJsonDelta(0, 'extra')).toBeNull()
    expect(w.getRejection()).toBeNull()
  })

  it('still extracts `filePath` correctly under the cap when key order is normal', () => {
    // Sanity check: the cap must not regress the happy path. A small
    // legit `filePath`-first stream still triggers the rejection on
    // the chunk that closes the string.
    const big = 'a'.repeat(LARGE_FILE_BODY_BYTES)
    fs.writeFileSync(path.join(workspaceDir, 'normal.ts'), big)

    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(0, { id: 'toolu_normal', name: 'Write' })

    expect(w.feedInputJsonDelta(0, '{"filePath":"normal.ts"')).not.toBeNull()
  })
})

describe('StreamWriteInputWatcher ? idToIndex reverse map', () => {
  it('routes by-id deltas in O(1) and survives block-index reuse', () => {
    const big = 'a'.repeat(LARGE_FILE_BODY_BYTES)
    fs.writeFileSync(path.join(workspaceDir, 'reused.ts'), big)

    const w = new StreamWriteInputWatcher()
    // First block: index 0, id "tu_a"
    w.registerToolUseBlock(0, { id: 'tu_a', name: 'Write' })
    w.releaseBlock(0)
    // The releaseBlock above must have dropped the reverse entry for
    // "tu_a"; a stale by-id lookup post-release returns null.
    expect(w.feedInputJsonDeltaById('tu_a', '{"filePath":"reused.ts"')).toBeNull()

    // Reuse index 0 for a different tool_use. By-id lookup for the
    // new id must succeed.
    w.registerToolUseBlock(0, { id: 'tu_b', name: 'Write' })
    expect(w.feedInputJsonDeltaById('tu_b', '{"filePath":"reused.ts"')).not.toBeNull()
  })

  it('moves a same-id block to a new index without orphaning the old slot', () => {
    // Some gateways re-emit content_block_start for an existing id with
    // a different index. The watcher must re-bind the reverse map and
    // discard the stale slot so by-id routing follows the latest index.
    const big = 'a'.repeat(LARGE_FILE_BODY_BYTES)
    fs.writeFileSync(path.join(workspaceDir, 'rebound.ts'), big)

    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(0, { id: 'tu_x', name: 'Write' })
    w.registerToolUseBlock(2, { id: 'tu_x', name: 'Write' })

    // Old index 0 slot must have been cleared, otherwise a stray
    // delta to index 0 would still match the old (now-orphaned) block.
    expect(w.feedInputJsonDelta(0, '{"filePath":"rebound.ts"')).toBeNull()
    // The id now points at index 2 and a by-id feed lands there.
    expect(w.feedInputJsonDeltaById('tu_x', '{"filePath":"rebound.ts"')).not.toBeNull()
  })

  it('rejects registration with an empty `id` to keep the reverse map collision-free', () => {
    // idToIndex.set('', N) would let multiple empty-id blocks collide
    // on the same key; reject empty ids up front. (Empty `name` is
    // intentionally NOT rejected ? out of scope for this change.)
    const w = new StreamWriteInputWatcher()
    w.registerToolUseBlock(0, { id: '', name: 'Write' })
    // No block was registered, so the by-id lookup is a no-op even
    // though the id passed in is the same empty string.
    expect(w.feedInputJsonDeltaById('', '{"filePath":"any.ts"')).toBeNull()
    // Index-based feed is also a no-op because nothing registered.
    expect(w.feedInputJsonDelta(0, '{"filePath":"any.ts"')).toBeNull()
  })
})
