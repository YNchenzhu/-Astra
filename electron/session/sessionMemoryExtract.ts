/**
 * Fork-style session memory extract — upstream §3 structured sections.
 *
 * Produces a structured session markdown with 9 predefined sections:
 * - Session Title
 * - Current State
 * - Task Specification
 * - Files and Functions
 * - Workflow
 * - Errors & Corrections
 * - Codebase Documentation
 * - Learnings
 * - Key Results
 * - Worklog
 */

import fs from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'

import { emitSubAgentStreamEvent } from '../agents/agentTool'
import { SESSION_MEMORY_INTERNAL_AGENT } from '../agents/builtInAgents'
import type { AgentContext } from '../agents/agentContext'
import { runForkedQueryContext } from '../agents/runForkedQueryContext'
import { runSubAgent } from '../agents/subAgentRunner'
import { ensureSessionMemoryTree, getSessionMemoryMarkdownPath } from './sessionMemoryPaths'
import {
  endSessionMemoryExtract,
  tryBeginSessionMemoryExtract,
} from './sessionMemoryExtractInFlight'
import { getWorkspacePath } from '../tools/workspaceState'
import { SIDE_CHANNEL_KIND, type SideChannelKind } from '../constants/sideChannelKinds'

const MAX_SECTION_LENGTH = 2_000
const MAX_TOTAL_SESSION_MEMORY_TOKENS = 12_000

/**
 * Hard byte cap enforced AFTER the scribe writes (audit S1). The token /
 * section limits above are only instructions in the fork directive — a
 * misbehaving model can ignore them and grow the notes file without bound,
 * which then re-enters context every session. Derived from the token budget
 * at a conservative ~4 chars/token, with headroom for the multi-byte CJK the
 * notes frequently contain. Anything beyond this is truncated to the last
 * clean line boundary and annotated.
 */
const MAX_SESSION_MEMORY_BYTES = MAX_TOTAL_SESSION_MEMORY_TOKENS * 4

export type SessionMemorySection =
  | 'Session Title'
  | 'Current State'
  | 'Task Specification'
  | 'Files and Functions'
  | 'Workflow'
  | 'Errors & Corrections'
  | 'Codebase Documentation'
  | 'Learnings'
  | 'Key Results'
  | 'Worklog'

function buildSessionMemoryForkDirective(memoryFilePath: string, conversationId: string): string {
  return [
    '## Session memory extract (host)',
    '',
    `Update **only** the markdown file at this absolute path:`,
    '',
    `\`${memoryFilePath}\``,
    '',
    `Conversation id: \`${conversationId}\``,
    '',
    'HARD CONSTRAINTS — the host will reject violations:',
    `- The ONLY writable file path for this run is the one above. Do NOT write to any other file. Do NOT create siblings such as \`*-new.md\`, \`*-test.md\`, \`*.bak\`, \`_test.md\`, or a "v2" copy. The host gate rejects any other target.`,
    '- The host has already pre-created the target file. Always `Read` it first to learn the exact current contents, then issue ONE `MultiEdit` call against the SAME path with one `{old_string, new_string}` entry per section that needs updating. `MultiEdit` is atomic — if any single replacement fails the whole call fails, which is what you want; you can fix the bad entry and retry once. Never `Write` a fresh copy over the file.',
    '- If `MultiEdit` (or `Edit`) returns an error (e.g. `old_string` not found), re-read the file ONCE and retry the **same target path** with corrected `old_string` values. After that single retry, stop and produce your final output even if some sections were skipped — do NOT keep looping, and never switch to a different filename, suffix, or tool to work around the failure.',
    '',
    'Use the inherited chat above. Write durable structured notes following this template:',
    '',
    '```markdown',
    '# Session Title',
    '*(one-line summary of what this session is about)*',
    '',
    '## Current State',
    '*(what is the current status of the work — what was just done / what is pending)*',
    '',
    '## Task Specification',
    '*(what was the user trying to accomplish — the definitive goal)*',
    '',
    '## Files and Functions',
    '*(key files and functions involved, with brief notes on their roles)*',
    '',
    '## Workflow',
    '*(steps taken so far and next steps — include exact shell commands where useful)*',
    '',
    '## Errors & Corrections',
    '*(mistakes made and how they were corrected — include exact error messages)*',
    '',
    '## Codebase Documentation',
    '*(system components and their relationships — architecture diagram hints)*',
    '',
    '## Learnings',
    '*(important insights discovered during this session)*',
    '',
    '## Key Results',
    '*(complete outputs the user asked for — deliverables and their status)*',
    '',
    '## Worklog',
    '*(step-level operation log — timestamps, actions, outcomes)*',
    '```',
    '',
    'Rules:',
    '- Keep ALL section headers and italic descriptions intact — only update body content below them.',
    '- Do NOT add new sections beyond those listed above. Skip sections that have no content.',
    `- Each section body must not exceed ${MAX_SECTION_LENGTH} characters.`,
    `- Total content must stay under ~${MAX_TOTAL_SESSION_MEMORY_TOKENS} tokens.`,
    '- Write durable notes (goals, decisions, paths, open tasks, errors) — not a transcript.',
    '- Include specific file paths, function names, error messages, and exact commands.',
    '- Do NOT repeat information already present in CLAUDE.md / AGENTS.md.',
    '- Strongly prefer a SINGLE `MultiEdit` call covering every section that needs an update over multiple `Edit` calls. Stop immediately after the file is updated — emit your one-line confirmation and end the turn.',
  ].join('\n')
}

export function generateEmptySessionMemoryTemplate(title?: string): string {
  return [
    `# ${title || 'New Session'}`,
    '',
    '## Current State',
    '',
    '',
    '## Task Specification',
    '',
    '',
    '## Files and Functions',
    '',
    '',
    '## Workflow',
    '',
    '',
    '## Errors & Corrections',
    '',
    '',
    '## Codebase Documentation',
    '',
    '',
    '## Learnings',
    '',
    '',
    '## Key Results',
    '',
    '',
    '## Worklog',
    '',
    '',
  ].join('\n')
}

/**
 * Pre-create the session-memory target file with an empty template if it does
 * not exist yet. The scribe directive forbids using `Write` to create siblings
 * (see {@link buildSessionMemoryForkDirective}); pre-creating gives the scribe
 * a stable file to `Edit` against on first run.
 *
 * Properties (all enforced by this helper, exposed for unit testing):
 *
 * 1. **Does not clobber existing content** — only writes when `fs.access`
 *    reports `ENOENT`. Any other access error (`EACCES`, etc.) is re-thrown
 *    so a transient permission glitch never overwrites real notes.
 * 2. **TOCTOU-safe** — uses `{ flag: 'wx' }` so a concurrent extract fork
 *    that wrote the file first wins; the loser's `EEXIST` is swallowed.
 * 3. **Title placeholder matches the directive's example template**
 *    (`# Session Title`) so the scribe's first `Edit("# Session Title", ...)`
 *    always finds its `old_string`.
 */
export async function ensureSessionMemoryTargetFile(memPath: string): Promise<void> {
  try {
    await fs.access(memPath)
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw err
    }
  }
  try {
    await fs.writeFile(
      memPath,
      generateEmptySessionMemoryTemplate('Session Title'),
      { encoding: 'utf8', flag: 'wx' },
    )
  } catch (writeErr) {
    if ((writeErr as NodeJS.ErrnoException)?.code !== 'EEXIST') {
      throw writeErr
    }
  }
}

/**
 * Audit S1: enforce a hard size cap on the session-memory file after the
 * scribe has written it. The fork directive only *asks* the model to stay
 * within {@link MAX_TOTAL_SESSION_MEMORY_TOKENS}; nothing stopped it from
 * blowing past that. Unlike MEMORY.md (which is regenerated), this file is
 * the durable narrative re-injected every session, so an unbounded one
 * permanently bloats context. Truncate to the last newline before the byte
 * budget and append a marker. Best-effort: any IO error is swallowed (the
 * notes are still usable, just oversized).
 *
 * Exported for unit testing.
 */
export async function enforceSessionMemorySizeCap(memPath: string): Promise<void> {
  let content: string
  try {
    content = await fs.readFile(memPath, 'utf8')
  } catch {
    return
  }
  if (Buffer.byteLength(content, 'utf8') <= MAX_SESSION_MEMORY_BYTES) return

  // Decode only the COMPLETE UTF-8 characters within the byte budget:
  // StringDecoder buffers any trailing incomplete multi-byte sequence and does
  // not emit it, so we never get a stray U+FFFD even when there is no newline
  // to back up to. Then prefer cutting at the last line boundary for tidiness.
  const buf = Buffer.from(content, 'utf8')
  let sliced = new StringDecoder('utf8').write(buf.subarray(0, MAX_SESSION_MEMORY_BYTES))
  const lastNl = sliced.lastIndexOf('\n')
  if (lastNl > 0) sliced = sliced.slice(0, lastNl)
  const trimmed = `${sliced.trimEnd()}\n\n> Note: session memory was truncated to stay within the size budget.\n`
  try {
    await fs.writeFile(memPath, trimmed, 'utf8')
    console.warn(
      `[SessionMemory] truncated ${memPath} — exceeded ${MAX_SESSION_MEMORY_BYTES} bytes`,
    )
  } catch {
    /* best-effort */
  }
}

/**
 * Check if session memory content is effectively empty (template with no real content).
 */
export function isSessionMemoryEmpty(content: string): boolean {
  const stripped = content
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return (
        trimmed.length > 0 &&
        !trimmed.startsWith('#') &&
        !trimmed.startsWith('---')
      )
    })
    .join('')
    .trim()

  return stripped.length < 20
}

/**
 * Build a sanitised context for the session-memory sub-agent.
 * Strips tool_use / tool_result blocks from the parent transcript so the agent
 * sees only user intents and assistant conclusions — not the detailed code-editing
 * tool calls that would confuse it into thinking it should also edit code.
 *
 * Both sides of the tool_use ↔ tool_result pair must be removed together:
 * stripping only tool_use but keeping tool_result leaves orphan tool_use_id
 * references in user messages, which causes DeepSeek's Anthropic-compat
 * gateway to return HTTP 400 ("unexpected tool_use_id found in tool result
 * blocks") when the session-memory agent re-sends the transcript on turn 2+.
 */
/**
 * Durable-narrative side-channel kinds — these messages carry the conversation's
 * authoritative recap prose (post-compact summary, offline-folded segments) and
 * are the ONLY remaining transcript after auto-compact runs. They are tagged
 * `_convertedFromSystem: true` + `_sideChannelKind: <kind>` like every other
 * side-channel envelope, but unlike the rest they MUST be forwarded to the
 * memory scribe — they ARE the transcript we want notes from.
 *
 * Mirrors `PRE_SUMMARISED_KINDS` in `electron/context/compact.ts` (which also
 * recognises these three as "already-summarised, don't re-LLM-summarise");
 * deliberately omits `toolUseSummary` / `toolBatchLedger` from that wider set
 * — those are tool-call accounting, not user/assistant narrative, and the
 * original "no machine reminders in memory.md" rule still applies to them.
 */
const DURABLE_TRANSCRIPT_SUMMARY_KINDS: ReadonlySet<SideChannelKind> = new Set([
  SIDE_CHANNEL_KIND.compactSummary,
  SIDE_CHANNEL_KIND.contextCollapseAuto,
  SIDE_CHANNEL_KIND.contextCollapseDrain,
])

function readDurableSummaryKind(msg: Record<string, unknown>): SideChannelKind | null {
  const tagged = (msg as { _sideChannelKind?: unknown })._sideChannelKind
  if (typeof tagged !== 'string') return null
  if (!DURABLE_TRANSCRIPT_SUMMARY_KINDS.has(tagged as SideChannelKind)) return null
  return tagged as SideChannelKind
}

/**
 * Strip the `<system-reminder>` / `<system_reminder>` envelope that
 * {@link wrapSideChannelBody} adds around durable-summary bodies. Tolerant of
 * attribute forms (e.g. `<system-reminder type="...">`) and idempotent — a
 * body that isn't wrapped is returned trimmed but otherwise unchanged.
 */
function unwrapSystemReminderEnvelope(text: string): string {
  let s = text.trim()
  s = s.replace(/^<system[-_]reminder\b[^>]*>\s*/i, '')
  s = s.replace(/\s*<\/system[-_]reminder>\s*$/i, '')
  return s.trim()
}

const DURABLE_SUMMARY_SCRIBE_PREFACE =
  '[Prior conversation summary — host-generated authoritative recap of work already done in this session. ' +
  'Treat this as your primary source of truth when filling out the session-memory template below. ' +
  'It is NOT a fresh user instruction; do not respond to it as if the user just narrated it.]'

/**
 * P0: messages flagged as machine-injected context (host-side reminders, post-
 * compact attachments) wear `_convertedFromSystem: true` or
 * `_type: 'post_compact_attachment'`. They are NOT user intents — feeding them
 * to the memory scribe causes scribe → memory.md → next-turn recall → main
 * agent re-reads its own machine reminders as if the user had said them, which
 * is the worst kind of context contamination (the model thinks the user issued
 * a "PROTOCOL VIOLATION" rebuke etc.).
 *
 * Exception: messages whose `_sideChannelKind` is in
 * {@link DURABLE_TRANSCRIPT_SUMMARY_KINDS} ARE the post-compact transcript and
 * MUST be forwarded. That exception is handled at the top of
 * {@link buildSessionMemoryContext} before this filter runs.
 */
function isMachineInjectedMessage(msg: Record<string, unknown>): boolean {
  if ((msg as { _convertedFromSystem?: unknown })._convertedFromSystem === true) {
    return true
  }
  // Typed side-channel kind (dictionary-driven) is authoritative. We deliberately
  // accept it independently of `_convertedFromSystem` so hybrid carriers like
  // `forkBoilerplate` (which carry the envelope but a real user task) remain
  // filtered into "machine-injected" — session-memory must not absorb fork
  // directives as user intents.
  if (typeof (msg as { _sideChannelKind?: unknown })._sideChannelKind === 'string') {
    return true
  }
  const meta = (msg as { _type?: unknown })._type
  if (typeof meta === 'string' && meta === 'post_compact_attachment') {
    return true
  }
  return false
}

/**
 * P0: even on real user/assistant messages, individual text blocks may carry
 * `<system-reminder>` envelopes (workspace state, session-context, skill
 * indices, edit-file contracts, …). Those are side-channel guidance for the
 * model, not durable user intent. Drop them at the block level so we still
 * keep any sibling real-user text in the same message.
 */
function isSystemReminderTextBlock(block: Record<string, unknown>): boolean {
  if (block.type !== 'text') return false
  const text = block.text
  if (typeof text !== 'string') return false
  return text.includes('<system-reminder>') || text.includes('<system_reminder>')
}

function keepableTextBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return []
  return content.filter(
    (block: unknown): block is Record<string, unknown> =>
      typeof block === 'object' &&
      block !== null &&
      (block as Record<string, unknown>).type === 'text' &&
      !isSystemReminderTextBlock(block as Record<string, unknown>),
  )
}

/**
 * Exported for unit tests — verifies that durable-summary side-channel
 * messages survive the filter (regression for the "post-compact scribe sees
 * an empty transcript" bug).
 */
export function buildSessionMemoryContext(
  parentMessages: Array<Record<string, unknown>>,
  directive: string,
): Array<Record<string, unknown>> {
  const filtered: Array<Record<string, unknown>> = []

  for (const msg of parentMessages) {
    // Durable narrative summaries (compactSummary / contextCollapseAuto /
    // contextCollapseDrain) ARE the transcript record we want the scribe to
    // summarise — post-compact they are often the *only* surviving narrative.
    // Unwrap the <system-reminder> envelope and forward as a plain user-role
    // message prefaced with a "this is the prior summary" note so the scribe
    // treats it as source-of-truth rather than a fresh user instruction.
    const summaryKind = readDurableSummaryKind(msg)
    if (summaryKind !== null) {
      const raw = typeof msg.content === 'string' ? msg.content : ''
      const unwrapped = unwrapSystemReminderEnvelope(raw)
      if (unwrapped.length > 0) {
        filtered.push({
          role: 'user',
          content: `${DURABLE_SUMMARY_SCRIBE_PREFACE}\n\n${unwrapped}`,
        })
      }
      continue
    }

    if (isMachineInjectedMessage(msg)) continue
    const role = msg.role as string | undefined
    if (role === 'user') {
      const content = msg.content
      if (typeof content === 'string') {
        // Plain text user message — keep unless the whole string is itself a
        // machine reminder envelope (rare but possible after compact passes).
        if (content.includes('<system-reminder>') || content.includes('<system_reminder>')) {
          continue
        }
        filtered.push(msg)
      } else if (Array.isArray(content)) {
        // Strip tool_result, binary attachment, and `<system-reminder>` text
        // blocks. Session memory only needs durable intent/state notes;
        // forwarding historical image bytes makes the background scribe
        // re-process old screenshots every turn, and forwarding system
        // reminders pollutes memory.md.
        const textBlocks = keepableTextBlocks(content)
        if (textBlocks.length > 0) {
          filtered.push({ ...msg, content: textBlocks })
        }
      }
      // Drop user messages that contain only tool_result / binary attachment blocks
      // (no text intent for the memory scribe).
    } else if (role === 'assistant') {
      const content = msg.content
      if (typeof content === 'string') {
        // Plain text assistant — keep as-is
        filtered.push(msg)
      } else if (Array.isArray(content)) {
        // Only keep real text blocks; drop tool_use / thinking / server_tool_use
        // blocks AND any `<system-reminder>` text the model may have echoed.
        const textBlocks = keepableTextBlocks(content)
        if (textBlocks.length > 0) {
          filtered.push({ ...msg, content: textBlocks })
        }
      }
      // Drop assistant messages that contain only tool_use blocks (no text)
    }
    // Drop all other message roles
  }

  // Append the directive as the final user message
  filtered.push({ role: 'user', content: directive })

  return filtered
}

export async function runSessionMemoryExtractFork(params: {
  conversationId: string
  parentSnapshot: AgentContext
}): Promise<void> {
  const { conversationId, parentSnapshot } = params
  const id = conversationId.trim()
  if (!id) return

  try {
    const ws = getWorkspacePath()
    await ensureSessionMemoryTree(ws)
    const memPath = getSessionMemoryMarkdownPath(id, ws)
    await ensureSessionMemoryTargetFile(memPath)
    const directive = buildSessionMemoryForkDirective(memPath, id)

    // Build sanitised context — strip tool_use/tool_result noise so the
    // session-memory agent sees only user intents + assistant text, not the
    // code-editing tool calls that would confuse its role.
    const sanitisedMessages = buildSessionMemoryContext(
      (parentSnapshot.messages ?? []) as Array<Record<string, unknown>>,
      directive,
    )

    await runForkedQueryContext(
      parentSnapshot,
      { querySource: 'session_memory', forkLabel: 'session-memory' },
      async () => {
        try {
          const result = await runSubAgent({
            config: parentSnapshot.config,
            model: parentSnapshot.model,
            agentDef: SESSION_MEMORY_INTERNAL_AGENT,
            prompt: directive,
            description: 'Session memory extract',
            name: 'session-memory',
            parentMessages: sanitisedMessages,
            appendParentPrompt: false,
            signal: parentSnapshot.signal,
            onEvent: emitSubAgentStreamEvent,
            sessionMemoryWritableTargetPath: memPath,
          })

          if (!result.success) {
            console.warn('[SessionMemory] extract sub-agent finished unsuccessfully:', result.output?.slice(0, 500))
          }
        } finally {
          // Audit S1: hard-enforce the size budget the directive only asked
          // for. In `finally` so an oversized file the scribe wrote BEFORE
          // throwing mid-run still gets trimmed rather than left unbounded.
          await enforceSessionMemorySizeCap(memPath)
        }
      },
    )
  } catch (err) {
    console.warn('[SessionMemory] runSessionMemoryExtractFork failed:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Manual session memory extraction — bypasses trigger thresholds.
 * Called by `/summary` command equivalent.
 *
 * Routes through {@link tryBeginSessionMemoryExtract} so a user-triggered
 * `/summary` cannot race the auto-extract path (which also guards via
 * `tryBegin` in `agenticLoop.ts`). When the auto path is already running for
 * the same `conversationId` the manual call no-ops silently — the in-flight
 * fork will produce the very notes the user just asked for anyway.
 */
export async function manuallyExtractSessionMemory(params: {
  conversationId: string
  parentSnapshot: AgentContext
}): Promise<void> {
  const id = params.conversationId.trim()
  if (!id) return
  if (!tryBeginSessionMemoryExtract(id)) return
  try {
    await runSessionMemoryExtractFork(params)
  } finally {
    endSessionMemoryExtract(id)
  }
}
