/**
 * Provider-agnostic state machine that watches a model's `tool_use` input
 * stream and, the **moment** we can prove a `Write` call is destined to be
 * rejected by the preflight gate, signals the caller to abort the rest of
 * the streaming response.
 *
 * Why this exists (C-grade preflight):
 *
 *   B-grade ({@link StreamingToolExecutor} pre-execute hook) rejects a
 *   doomed Write the **instant** its tool_use block finishes streaming —
 *   no permission flow, no orchestration, no file lock. But by then the
 *   model has already emitted the entire `content` parameter (often many
 *   KB), which costs real output tokens and real wall-clock latency.
 *
 *   The Write tool input schema, in practice, looks like:
 *     {"filePath":"<path>","content":"…large blob…"}
 *
 *   The watcher fires on **two** signals, both before `content` finishes
 *   streaming:
 *
 *     1. {@link extractFilePathFromPartialJson} successfully parses
 *        `filePath` (cheap, JSON-aware). This succeeds the instant the
 *        closing quote of the path value arrives — covers schemas where
 *        the model emits `filePath` first, which is the recommended order
 *        and what most well-behaved models do.
 *
 *     2. {@link detectContentBeforeFilePath} signature trips: the `content`
 *        key is on the wire but no `filePath` / `file_path` key has
 *        streamed yet. This catches models that ignore the schema property
 *        order (notably DeepSeek V4 Pro via Anthropic-compat gateways
 *        emits `{"content":"…","filePath":"…"}`). The synthetic rejection
 *        from this branch has an empty `input` (we never saw the path)
 *        and carries `toolUse.preflightError` so the executor can surface
 *        the canonical educative message without re-running a disk check
 *        that would fail-open on the empty input.
 *
 *   The watcher is **stateless across providers**: Anthropic-native
 *   (`content_block_start` / `content_block_delta`) and OpenAI-compatible
 *   (function arguments delta) both feed the same instance.
 *
 * Lifecycle per stream attempt:
 *
 *   const watcher = new StreamWriteInputWatcher()
 *   // … on `content_block_start` for a tool_use:
 *   watcher.registerToolUseBlock(index, { id, name })
 *   // … on each `input_json_delta` chunk:
 *   const rej = watcher.feedInputJsonDelta(index, partialJson)
 *   if (rej) { emit synthetic onToolUse, abort the underlying stream }
 *   // … on `content_block_stop`:
 *   watcher.releaseBlock(index)
 *
 * The watcher is **single-fire**: once it has surfaced a rejection for any
 * block, subsequent `feed*` calls return `null`. The expectation is that
 * the caller has already aborted the stream after the first reject — any
 * further partial JSON chunks are stale.
 *
 * Known edge: when the host's `bypassStreamingForPolicy` flag is true,
 * `agenticLoop/stream.ts` skips `streamingToolExecutor.addTool(...)` for
 * this synthetic tool_use, so the batch-fallback path runs the tool with
 * the empty input. C-grade still saved the bulky `content` tokens; the
 * model just sees a less-helpful generic "filePath missing" instead of
 * the canonical "retry with filePath first OR switch to edit_file"
 * message. This is acceptable degradation in that rare branch.
 */

import {
  extractWorkspaceFilePathFromToolInput,
  isBuiltinFullFileWriteTool,
} from '../tools/builtinToolAliases'
import {
  preflightWriteTool,
} from '../tools/writeToolPreflightGate'

export interface WatcherToolUseInfo {
  /** Anthropic / model-supplied tool_use_id (e.g. `toolu_…`). */
  id: string
  /** Tool name as emitted by the model (`Write`, `write_file`, …). */
  name: string
}

export interface WatcherRejection {
  /**
   * Synthetic tool_use to emit through the consumer's `onToolUse` callback
   * so {@link StreamingToolExecutor} sees the rejected call and surfaces
   * an error tool_result on the next loop iteration. The shape depends on
   * which branch fired (see {@link WatcherRejection.reason}):
   *
   *   - `existing_file`: `input` carries `{filePath: <parsed path>}` — the
   *     only field we observed before aborting. `content` is intentionally
   *     absent because we cut the stream before it began streaming.
   *     `preflightError` carries the canonical "use edit_file" verdict so
   *     non-streaming execution paths (batch / orchestrated) can surface it
   *     without re-running the disk preflight.
   *
   *   - `content_before_filepath`: `input` is empty (`{}`) — we aborted
   *     before the model emitted `filePath`. `preflightError` carries the
   *     canonical educative message that the executor surfaces directly,
   *     bypassing B-grade's disk preflight (which would fail-open on the
   *     empty input).
   */
  toolUse: {
    id: string
    name: string
    input: Record<string, unknown>
    preflightError?: string
  }
  /** Canonical preflight error message (same wording as B-grade gate). */
  error: string
  /**
   * Path that triggered the rejection. For the standard (existing-file)
   * rejection this is the resolved absolute path; for the
   * `content-before-filePath` early-abort it is an empty string because
   * the watcher fired before the model emitted the path.
   */
  filePath: string
  /**
   * Diagnostic — which branch fired. Lets callers / tests distinguish the
   * two paths without string-matching the error message.
   */
  reason: 'existing_file' | 'content_before_filepath'
}

interface TrackedBlock {
  id: string
  name: string
  partialJson: string
  /** Once true, this block has produced a rejection and further deltas are dropped. */
  rejected: boolean
  /**
   * Once true, this block has been checked and confirmed safe (filePath
   * resolved, file either missing or ≤ threshold), so we can skip the
   * extractor on subsequent deltas. Massively reduces partial-JSON parse
   * work for legitimate large-`content` writes that survive preflight.
   */
  confirmedSafe: boolean
}

import {
  detectContentBeforeFilePath,
  extractFilePathFromPartialJson,
} from './partialJsonExtract'

/**
 * Hard cap on the partial-JSON buffer we accumulate per block before
 * giving up and marking the block `confirmedSafe`.
 *
 * Why this exists: when the extractor cannot resolve `filePath` AND the
 * content-before-filePath detector does not trip, we'd otherwise keep
 * `+=`-ing every delta until `content_block_stop`, which on a 10MB
 * content blob means a 10MB string copy + an O(L²) re-scan cost per
 * delta. 4 KiB is well past any realistic `filePath` length (PATH_MAX
 * is 4096 on Linux, MAX_PATH is 260 on Windows) — if we still can't
 * resolve by then, falling back to B-grade is strictly the right choice.
 *
 * The most common cap-triggering path today is the empty-`filePath`
 * model bug (`{"filePath":"","content":"…"}`): the extractor returns
 * null for `length > 0` filter and the detector returns false because
 * `"filePath":` IS present. The cap prevents memory bloat in that case.
 * Content-before-filePath ordering (DeepSeek V4 Pro et al.) no longer
 * reaches this cap — it's caught by the detector in the branch above.
 */
const PARTIAL_JSON_BAILOUT_BYTES = 4096

export class StreamWriteInputWatcher {
  private blocks = new Map<number, TrackedBlock>()
  /**
   * Reverse index for `feedInputJsonDeltaById`. Maintained in lockstep
   * with `blocks` so id-keyed lookup is O(1) instead of an O(n) Map
   * scan on every delta on the gateway path.
   */
  private idToIndex = new Map<string, number>()
  private firedRejection: WatcherRejection | null = null

  /**
   * Tell the watcher about a new tool_use content block. Must be called
   * before any `feedInputJsonDelta` for that block index. Non-Write tools
   * are still tracked (cheaply) so that an out-of-order delta with an
   * unexpected index doesn't silently no-op — see {@link feedInputJsonDelta}.
   */
  registerToolUseBlock(blockIndex: number, info: WatcherToolUseInfo): void {
    if (this.firedRejection) return
    if (!Number.isInteger(blockIndex) || blockIndex < 0) return
    if (!info || typeof info.id !== 'string' || typeof info.name !== 'string') return
    // Reject empty `id` specifically: `idToIndex.set('', i)` would let
    // multiple empty-id blocks collide on the same reverse-index key,
    // making `feedInputJsonDeltaById('', …)` route nondeterministically.
    // (Pre-existing `typeof info.name !== 'string'` check is left alone
    // — empty string name is currently tolerated and outside this diff.)
    if (info.id.length === 0) return

    // If this block index was previously released (then reused for a new
    // tool_use), the stale id→index mapping must be dropped. The same
    // applies if the id was previously associated with a different index.
    const prev = this.blocks.get(blockIndex)
    if (prev && prev.id !== info.id) {
      this.idToIndex.delete(prev.id)
    }
    const staleIdx = this.idToIndex.get(info.id)
    if (staleIdx !== undefined && staleIdx !== blockIndex) {
      this.blocks.delete(staleIdx)
    }

    this.blocks.set(blockIndex, {
      id: info.id,
      name: info.name,
      partialJson: '',
      rejected: false,
      confirmedSafe: false,
    })
    this.idToIndex.set(info.id, blockIndex)
  }

  /**
   * Accumulate a partial-JSON chunk for an open tool_use block. Returns a
   * {@link WatcherRejection} when this chunk is the one that flips the
   * verdict to "reject"; returns `null` for every other case (block
   * unknown, still incomplete, non-Write tool, already rejected, already
   * confirmed safe).
   *
   * Idempotent across blocks: once any block has produced a rejection,
   * subsequent calls — for **any** block — return `null` to prevent
   * double-emit during the small window between our `abort()` call and
   * the underlying stream actually tearing down.
   */
  feedInputJsonDelta(blockIndex: number, partialJsonDelta: string): WatcherRejection | null {
    if (this.firedRejection) return null
    if (typeof partialJsonDelta !== 'string' || partialJsonDelta.length === 0) return null
    const block = this.blocks.get(blockIndex)
    if (!block) return null
    if (block.rejected || block.confirmedSafe) return null

    block.partialJson += partialJsonDelta

    if (!isBuiltinFullFileWriteTool(block.name)) {
      // Non-Write tools never trigger this path. Mark safe so we stop
      // appending unbounded partial JSON on a tool we don't care about.
      block.confirmedSafe = true
      return null
    }

    const filePath = extractFilePathFromPartialJson(block.partialJson)
    if (!filePath) {
      // Two real-world cases land here:
      //   1. Model streamed `{"content":"…large blob…","filePath":"…"}`
      //      (key order inverted, e.g. DeepSeek V4 Pro through the
      //      Anthropic-compat gateway). The scanner walks into the
      //      unclosed `content` string and bails until the stream ends.
      //      → We mark the block safe and let the stream finish (see below);
      //        we do NOT abort, because the target path is still unknown.
      //   2. Model emitted an empty `filePath` ("" — typically a bug
      //      either in the model output or in an upstream JSON rewriter).
      //      → No safe early abort here (we don't know the target). We
      //        fall through to the bailout cap and let B-grade decide.
      if (detectContentBeforeFilePath(block.partialJson)) {
        // Do NOT abort on content-before-filePath.
        // At this point `filePath` has not streamed yet, so we cannot know
        // whether the target exists. Aborting here killed every legitimate
        // NEW-file write from models that serialize `content` before
        // `filePath` (e.g. DeepSeek V4 Pro via Anthropic-compat) — and those
        // models cannot reorder their tool-call JSON keys, so the synthetic
        // "retry with filePath first" rejection produced an infinite
        // abort→retry→abort loop. Mark the block safe and let the stream
        // finish: a new file is written normally, and a write to an EXISTING
        // file is still rejected by the in-tool disk preflight
        // (`preflightWriteToolWithDisk`) at write time. The early
        // `existing_file` token-saver below still fires for the well-behaved
        // filePath-first ordering.
        block.confirmedSafe = true
        return null
      }
      if (block.partialJson.length >= PARTIAL_JSON_BAILOUT_BYTES) {
        block.confirmedSafe = true
      }
      return null
    }

    // INVARIANT: `extractFilePathFromPartialJson` only returns a value
    // when the closing `"` of the `filePath` string has already streamed
    // AND the value is non-empty (`v.length > 0` filter in that module).
    // If that invariant ever breaks, `preflightWriteTool` will fall into
    // its fail-open branch for empty inputs and silently mark this
    // block `confirmedSafe` — losing C-grade entirely. Keep the
    // extractor's empty-filter aligned with this assumption.
    const verdict = preflightWriteTool({ filePath })
    if (verdict.ok) {
      block.confirmedSafe = true
      return null
    }

    // Build the synthetic tool_use. We intentionally only include the
    // field(s) we could parse — downstream sees a tool_use that targets
    // an existing large file but never authored any `content`, which is
    // exactly the truth at the moment we aborted.
    //
    // `preflightError` is attached here too (not just on the
    // content-before-filePath branch): the batch / orchestrated execution
    // paths (`bypassStreamingForPolicy`, sub-agents, fallback batch) never
    // run B-grade's disk preflight — without the pre-baked error their Zod
    // gate would fail this `{filePath}`-only input with a misleading
    // "missing/empty required argument(s)" message instead of the canonical
    // "use edit_file" instruction. The streaming executor keeps working as
    // before (it surfaces the prebaked error directly, same wording as the
    // disk preflight it now skips).
    const synthetic: WatcherRejection = {
      toolUse: {
        id: block.id,
        name: block.name,
        input: { filePath },
        preflightError: verdict.error,
      },
      error: verdict.error,
      filePath,
      reason: 'existing_file',
    }
    block.rejected = true
    this.firedRejection = synthetic
    return synthetic
  }

  /**
   * Remove a block from the tracker — call on `content_block_stop`. Keeps
   * the tracker small over long streams that emit many tool_use blocks.
   */
  releaseBlock(blockIndex: number): void {
    const b = this.blocks.get(blockIndex)
    if (b) {
      // Only drop the reverse-index entry if it still points at THIS
      // block. A registerToolUseBlock(id=X) → registerToolUseBlock(id=X)
      // → releaseBlock(oldIdx) sequence (rare, gateway re-binding) must
      // not orphan the still-live mapping.
      if (this.idToIndex.get(b.id) === blockIndex) {
        this.idToIndex.delete(b.id)
      }
      this.blocks.delete(blockIndex)
    }
  }

  /**
   * Convenience for adapters whose stream events carry the tool_use_id
   * but no stable per-block `index` (some OpenAI-compatible gateways).
   * Looks up the block via the {@link idToIndex} reverse map and delegates
   * to {@link feedInputJsonDelta}.
   *
   * Requires that the caller has already invoked
   * {@link registerToolUseBlock} for `toolUseId` — if not, returns `null`
   * silently (treated identically to a delta for an unknown block index).
   * The existing call sites in `compatibleClient.ts` and
   * `providers/anthropic.ts` both register-then-feed, so this contract
   * is met in production today. We intentionally do NOT auto-register
   * here: the watcher cannot synthesize a tool `name` from just an id,
   * and a misregister would silently lose the C-grade preflight.
   */
  feedInputJsonDeltaById(
    toolUseId: string,
    partialJsonDelta: string,
  ): WatcherRejection | null {
    if (this.firedRejection) return null
    const idx = this.idToIndex.get(toolUseId)
    if (idx === undefined) return null
    return this.feedInputJsonDelta(idx, partialJsonDelta)
  }

  /** Test/diagnostic accessor. */
  getRejection(): WatcherRejection | null {
    return this.firedRejection
  }
}

/**
 * Re-export so adapter code can extract the model-supplied `filePath`
 * from the resolved input field set without duplicating the alias logic.
 * The same helper handles both `filePath`, `file_path`, and `path`.
 */
export { extractWorkspaceFilePathFromToolInput }
