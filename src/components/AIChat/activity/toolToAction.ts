/**
 * Tool → activity-row / command-chip display mapping.
 *
 * Every known tool maps to either:
 *   - `{ kind: 'activity', ... }` — a single-line feed entry rendered
 *     by `ActivityRow`. The row shows an action verb ("Read", "Edited",
 *     "Grepped", ...) followed by a muted subject (file path, query
 *     string) and optional trailing metadata (line range, diff size).
 *   - `{ kind: 'command', ... }` — a shell/PowerShell invocation rendered
 *     by `CommandChip` with a subtle bordered container (the only visual
 *     container in the feed, reserved for user-auditable executables).
 *
 * Unknown tools return `null`; callers should fall back to the legacy
 * `BaseCard` rendering so new / MCP / plugin tools stay visible during
 * incremental migration.
 */

export interface ActivityDisplay {
  kind: 'activity'
  /** Short verb rendered in main text colour (e.g. "Read", "Edited"). */
  actionWord: string
  /** File path / pattern / query — rendered muted next to the verb. */
  subject?: string
  /** Trailing metadata — `L1-120`, `+7 -0`, `42 results`, etc. */
  meta?: string
}

export interface CommandDisplay {
  kind: 'command'
  shell: 'bash' | 'powershell'
  command: string
}

export type ToolDisplay = ActivityDisplay | CommandDisplay

/** Safe string reader: returns trimmed non-empty string or `undefined`. */
function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key]
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t.length > 0 ? t : undefined
}

function num(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * Truncate a long subject (file path, query) to fit a single visual row.
 * Paths keep their tail (most informative part); generic strings get a
 * head-ellipsis style truncation.
 */
function truncateSubject(s: string, max = 72): string {
  if (s.length <= max) return s
  const looksLikePath = /[\\/]/.test(s)
  if (looksLikePath) {
    return '…' + s.slice(-(max - 1))
  }
  return s.slice(0, max - 1) + '…'
}

/** `read_file` → "Read foo/bar.ts L10-60" */
function mapRead(input: Record<string, unknown>): ActivityDisplay {
  const filePath = str(input, 'filePath') ?? str(input, 'file_path') ?? '?'
  const offset = num(input, 'offset')
  const limit = num(input, 'limit')
  let meta: string | undefined
  if (typeof offset === 'number' && typeof limit === 'number') {
    meta = `L${offset}-${offset + limit}`
  } else if (typeof offset === 'number') {
    meta = `L${offset}+`
  } else if (typeof limit === 'number') {
    meta = `${limit} lines`
  }
  return { kind: 'activity', actionWord: 'Read', subject: truncateSubject(filePath), meta }
}

function mapWrite(input: Record<string, unknown>): ActivityDisplay {
  const filePath = str(input, 'filePath') ?? str(input, 'file_path') ?? '?'
  const content = str(input, 'content') ?? ''
  const meta = content.length > 0 ? `${content.split(/\r?\n/).length} lines` : undefined
  return { kind: 'activity', actionWord: 'Wrote', subject: truncateSubject(filePath), meta }
}

function mapEdit(input: Record<string, unknown>): ActivityDisplay {
  const filePath = str(input, 'filePath') ?? str(input, 'file_path') ?? '?'
  const oldS = str(input, 'oldString') ?? str(input, 'old_string') ?? ''
  const newS = str(input, 'newString') ?? str(input, 'new_string') ?? ''
  // Approximate diff size without building a full diff — cheap heuristic
  // that's "good enough" for a one-line summary.
  const oldLines = oldS ? oldS.split(/\r?\n/).length : 0
  const newLines = newS ? newS.split(/\r?\n/).length : 0
  const added = Math.max(0, newLines - oldLines)
  const removed = Math.max(0, oldLines - newLines)
  const meta =
    added + removed > 0
      ? `${added > 0 ? `+${added}` : ''}${added > 0 && removed > 0 ? ' ' : ''}${removed > 0 ? `-${removed}` : ''}`
      : undefined
  return { kind: 'activity', actionWord: 'Edited', subject: truncateSubject(filePath), meta }
}

/**
 * `multi_edit_file` is the batch form of `edit_file`: one file, N
 * `{oldString, newString, replaceAll}` entries applied atomically. Mirror
 * `mapEdit`'s visual contract so the two never visually diverge — same
 * actionWord ("Edited"), same path subject, with the meta enriched to
 * surface the batch size *and* the aggregate diff approximation across
 * all entries.
 *
 * Each entry's contribution to `added` / `removed` uses the same
 * line-count delta heuristic as `mapEdit`. We sum them rather than
 * compute a real per-entry diff because (a) we'd duplicate the
 * disk-side simulation and (b) the row is a one-line summary; the
 * accurate diff lives in the expanded details / approval UI.
 */
function mapMultiEdit(input: Record<string, unknown>): ActivityDisplay {
  const filePath = str(input, 'filePath') ?? str(input, 'file_path') ?? '?'
  const rawEdits = Array.isArray(input.edits) ? (input.edits as unknown[]) : []
  let totalAdded = 0
  let totalRemoved = 0
  for (const e of rawEdits) {
    if (!e || typeof e !== 'object') continue
    const rec = e as Record<string, unknown>
    const oldS =
      typeof rec.oldString === 'string'
        ? rec.oldString
        : typeof rec.old_string === 'string'
          ? rec.old_string
          : ''
    const newS =
      typeof rec.newString === 'string'
        ? rec.newString
        : typeof rec.new_string === 'string'
          ? rec.new_string
          : ''
    const oldLines = oldS ? oldS.split(/\r?\n/).length : 0
    const newLines = newS ? newS.split(/\r?\n/).length : 0
    totalAdded += Math.max(0, newLines - oldLines)
    totalRemoved += Math.max(0, oldLines - newLines)
  }
  const count = rawEdits.length
  const countLabel = count > 0 ? `${count} edit${count === 1 ? '' : 's'}` : undefined
  const diffLabel =
    totalAdded + totalRemoved > 0
      ? `${totalAdded > 0 ? `+${totalAdded}` : ''}${totalAdded > 0 && totalRemoved > 0 ? ' ' : ''}${totalRemoved > 0 ? `-${totalRemoved}` : ''}`
      : undefined
  // Join the diff approximation and the batch size on a single visual
  // line: e.g. "+7 -3 · 4 edits". When the file produced no net line
  // delta (pure same-length renames), only the batch size shows.
  const meta =
    diffLabel && countLabel
      ? `${diffLabel} · ${countLabel}`
      : (diffLabel ?? countLabel)
  return { kind: 'activity', actionWord: 'Edited', subject: truncateSubject(filePath), meta }
}

function mapList(input: Record<string, unknown>): ActivityDisplay {
  const dir = str(input, 'dirPath') ?? str(input, 'path') ?? '.'
  return { kind: 'activity', actionWord: 'Listed', subject: truncateSubject(dir) }
}

function mapGlob(input: Record<string, unknown>): ActivityDisplay {
  const pattern = str(input, 'pattern') ?? '?'
  const cwd = str(input, 'cwd')
  const subject = cwd ? `${pattern}  in  ${truncateSubject(cwd, 40)}` : pattern
  return { kind: 'activity', actionWord: 'Explored', subject }
}

function mapGrep(input: Record<string, unknown>): ActivityDisplay {
  const pattern = str(input, 'pattern') ?? '?'
  const include = str(input, 'include') ?? str(input, 'path')
  const subject = include
    ? `"${truncateSubject(pattern, 40)}"  in  ${truncateSubject(include, 30)}`
    : `"${truncateSubject(pattern, 60)}"`
  return { kind: 'activity', actionWord: 'Grepped', subject }
}

function mapWebFetch(input: Record<string, unknown>): ActivityDisplay {
  const url = str(input, 'url') ?? '?'
  return { kind: 'activity', actionWord: 'Fetched', subject: truncateSubject(url, 80) }
}

function mapWebSearch(input: Record<string, unknown>): ActivityDisplay {
  const query = str(input, 'search_term') ?? str(input, 'query') ?? '?'
  const engine = str(input, 'engine')
  const subject = engine ? `"${truncateSubject(query, 50)}" · ${engine}` : `"${truncateSubject(query, 60)}"`
  return { kind: 'activity', actionWord: 'Searched', subject }
}

// When the model emits a bash / PowerShell tool call without a `command`
// (malformed tool-call, or a record that lost the field through some
// persistence path), we MUST NOT fall through to `CommandChip` with an
// empty string — the chip collapses to just its border + glyphs and the
// sub-agent feed shows a column of phantom thin lines (see issue: empty
// command chips at the bottom of the agent tool feed). Fall back to a
// normal `ActivityRow` so the entry has visible text and matches the
// chrome of its neighbours.
function mapBash(input: Record<string, unknown>): ToolDisplay {
  const command = str(input, 'command')
  if (!command) {
    return { kind: 'activity', actionWord: 'Bash', subject: '(missing command)' }
  }
  return { kind: 'command', shell: 'bash', command }
}

function mapPowerShell(input: Record<string, unknown>): ToolDisplay {
  const command = str(input, 'command')
  if (!command) {
    return { kind: 'activity', actionWord: 'PowerShell', subject: '(missing command)' }
  }
  return { kind: 'command', shell: 'powershell', command }
}

// ─── Phase 4: broader activity coverage ─────────────────────────────
// Every tool below returns an ActivityRow descriptor. Subjects are kept
// short and informational; callers can click a row to see full input /
// output in the details drawer.

function mapTodoWrite(input: Record<string, unknown>): ActivityDisplay {
  const raw = input.todos
  const items = Array.isArray(raw) ? raw : []
  const total = items.length
  let inProgress = 0
  let completed = 0
  let pending = 0
  for (const item of items) {
    if (item && typeof item === 'object') {
      const s = (item as { status?: unknown }).status
      if (s === 'in_progress') inProgress++
      else if (s === 'completed') completed++
      else pending++
    }
  }
  const parts: string[] = []
  if (inProgress > 0) parts.push(`${inProgress} in progress`)
  if (completed > 0) parts.push(`${completed} done`)
  if (pending > 0) parts.push(`${pending} pending`)
  const subject = parts.length > 0 ? parts.join(', ') : `${total} item${total === 1 ? '' : 's'}`
  // P2-OBS: surface the captured underlying objective (the *why*) so the
  // user can catch an intent misread — not just the step counts. When set,
  // it is more informative than the raw total, so it takes the meta slot.
  const objective = str(input, 'objective')
  const meta = objective
    ? `目标: ${truncateSubject(objective, 80)}`
    : total > 0
      ? `${total} total`
      : undefined
  return {
    kind: 'activity',
    actionWord: 'Updated todos',
    subject,
    meta,
  }
}

function mapNotebookEdit(input: Record<string, unknown>): ActivityDisplay {
  const nb =
    str(input, 'target_notebook') ??
    str(input, 'notebookPath') ??
    str(input, 'notebook_path') ??
    '?'
  const cellIdx = num(input, 'cell_idx')
  const isNewCell = input.is_new_cell === true
  const actionWord = isNewCell ? 'Added cell' : 'Edited cell'
  const meta = typeof cellIdx === 'number' ? `#${cellIdx}` : undefined
  return { kind: 'activity', actionWord, subject: truncateSubject(nb), meta }
}

function mapLsp(input: Record<string, unknown>): ActivityDisplay {
  // `operation` is the LSP verb (goToDefinition, findReferences, hover, …).
  // Convert PascalCase → readable phrase only when we recognise it; fall
  // back to the raw value so new operations still render.
  const op = str(input, 'operation') ?? 'query'
  const filePath = str(input, 'filePath') ?? str(input, 'file_path')
  const subject = filePath
    ? `${op} · ${truncateSubject(filePath, 50)}`
    : op
  return { kind: 'activity', actionWord: 'LSP', subject }
}

function mapSkill(input: Record<string, unknown>): ActivityDisplay {
  const name = str(input, 'skill') ?? str(input, 'name') ?? '?'
  return { kind: 'activity', actionWord: 'Used skill', subject: truncateSubject(name, 50) }
}

function mapMemdirScan(input: Record<string, unknown>): ActivityDisplay {
  const q = str(input, 'pattern') ?? str(input, 'query')
  return {
    kind: 'activity',
    actionWord: 'Scanned memory',
    subject: q ? `"${truncateSubject(q, 50)}"` : undefined,
  }
}

function mapEnterPlanMode(): ActivityDisplay {
  return { kind: 'activity', actionWord: 'Entered plan mode' }
}
function mapExitPlanMode(): ActivityDisplay {
  return { kind: 'activity', actionWord: 'Exited plan mode' }
}

function mapEnterWorktree(input: Record<string, unknown>): ActivityDisplay {
  const branch = str(input, 'branch') ?? str(input, 'name')
  return {
    kind: 'activity',
    actionWord: 'Entered worktree',
    subject: branch ? truncateSubject(branch, 50) : undefined,
  }
}
function mapExitWorktree(): ActivityDisplay {
  return { kind: 'activity', actionWord: 'Exited worktree' }
}

function mapAskUser(input: Record<string, unknown>): ActivityDisplay {
  const raw = input.questions
  const qs = Array.isArray(raw) ? raw : []
  const firstPrompt =
    qs[0] && typeof qs[0] === 'object' && typeof (qs[0] as { prompt?: unknown }).prompt === 'string'
      ? (qs[0] as { prompt: string }).prompt
      : undefined
  const subject = firstPrompt
    ? truncateSubject(firstPrompt, 70)
    : `${qs.length} question${qs.length === 1 ? '' : 's'}`
  return { kind: 'activity', actionWord: 'Asked user', subject }
}

function mapMagicDocs(input: Record<string, unknown>): ActivityDisplay {
  const q = str(input, 'query') ?? str(input, 'topic')
  return {
    kind: 'activity',
    actionWord: 'Looked up docs',
    subject: q ? `"${truncateSubject(q, 60)}"` : undefined,
  }
}

function mapToolSearch(input: Record<string, unknown>): ActivityDisplay {
  const q = str(input, 'query') ?? str(input, 'pattern')
  return {
    kind: 'activity',
    actionWord: 'Searched tools',
    subject: q ? `"${truncateSubject(q, 60)}"` : undefined,
  }
}

/**
 * The `Task*` family (`TaskList`, `TaskGet`, `TaskOutput`, `TaskStop`,
 * `TaskCreate`, `TaskUpdate`) all receive a `task_id` / `taskId`; we
 * surface the verb + the id so the feed reads as a ledger of background
 * task management.
 */
function mapTask(name: string, input: Record<string, unknown>): ActivityDisplay {
  const verb = name.slice('Task'.length).toLowerCase() // 'list' / 'get' / 'output' / …
  const id = str(input, 'task_id') ?? str(input, 'taskId')
  return {
    kind: 'activity',
    actionWord: `Task ${verb}`,
    subject: id ? truncateSubject(id, 40) : undefined,
  }
}

/** `KillAgentTasks` / `KillAllTasks` — aggregate kill actions. */
function mapKill(name: string): ActivityDisplay {
  const scope = name === 'KillAllTasks' ? 'all tasks' : 'agent tasks'
  return { kind: 'activity', actionWord: 'Killed', subject: scope }
}

// ─── Newly-unified tools (P5: remove BaseCard fallthrough for built-ins) ──
// Every tool below registers a registry entry but used to fall through to
// the legacy BaseCard renderer because it had no mapper. The goal is a
// fully unified feed: every non-terminal tool reads as a single muted
// row, matching `Edited`, `Read`, `Grepped`, etc. Bash / PowerShell keep
// the bordered CommandChip — that's the only intentionally distinct
// chrome (user-auditable shell exec).

function mapConfig(input: Record<string, unknown>): ActivityDisplay {
  const setting = str(input, 'setting') ?? '?'
  const value = str(input, 'value')
  const isWrite = value !== undefined && value.length > 0
  return {
    kind: 'activity',
    actionWord: isWrite ? 'Set config' : 'Read config',
    subject: truncateSubject(setting, 60),
    meta: isWrite ? `→ ${truncateSubject(value!, 40)}` : undefined,
  }
}

/** `CronCreate` / `CronList` / `CronDelete` — natural family, single dispatcher. */
function mapCron(name: string, input: Record<string, unknown>): ActivityDisplay {
  if (name === 'CronList') {
    return { kind: 'activity', actionWord: 'Listed crons' }
  }
  if (name === 'CronDelete') {
    const id = str(input, 'id')
    return {
      kind: 'activity',
      actionWord: 'Deleted cron',
      subject: id ? truncateSubject(id, 40) : undefined,
    }
  }
  // CronCreate
  const expr = str(input, 'cron')
  const prompt = str(input, 'prompt')
  const subject = expr ? `\`${expr}\`` : undefined
  const meta = prompt ? truncateSubject(prompt, 40) : undefined
  return { kind: 'activity', actionWord: 'Scheduled cron', subject, meta }
}

function mapDiscoverSkills(input: Record<string, unknown>): ActivityDisplay {
  const query = str(input, 'query')
  return {
    kind: 'activity',
    actionWord: 'Discovered skills',
    subject: query ? `"${truncateSubject(query, 60)}"` : undefined,
  }
}

function mapReadDiagnostics(input: Record<string, unknown>): ActivityDisplay {
  const file = str(input, 'file') ?? str(input, 'filePath') ?? str(input, 'file_path')
  const severity = str(input, 'severity')
  return {
    kind: 'activity',
    actionWord: 'Read diagnostics',
    subject: file ? truncateSubject(file) : 'all files',
    meta: severity && severity !== 'all' ? severity : undefined,
  }
}

function mapAwaySummary(): ActivityDisplay {
  return { kind: 'activity', actionWord: 'Generated away summary' }
}

function mapAwait(input: Record<string, unknown>): ActivityDisplay {
  const raw = input.task_ids
  const ids = Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []
  const waitFor = str(input, 'wait_for')
  const subject =
    ids.length === 1
      ? truncateSubject(String(ids[0]), 40)
      : `${ids.length} task${ids.length === 1 ? '' : 's'}`
  return {
    kind: 'activity',
    actionWord: 'Awaiting',
    subject,
    meta: waitFor ? `/${truncateSubject(waitFor, 30)}/` : undefined,
  }
}

function mapBestOfN(input: Record<string, unknown>): ActivityDisplay {
  const task = str(input, 'task')
  const n = num(input, 'n')
  return {
    kind: 'activity',
    actionWord: 'Best-of-N',
    subject: task ? `"${truncateSubject(task, 56)}"` : undefined,
    meta: typeof n === 'number' ? `×${n}` : undefined,
  }
}

function mapPromptSuggestion(input: Record<string, unknown>): ActivityDisplay {
  const userMessage = str(input, 'userMessage')
  return {
    kind: 'activity',
    actionWord: 'Suggested prompts',
    subject: userMessage ? `"${truncateSubject(userMessage, 60)}"` : undefined,
  }
}

function mapRemoteTrigger(input: Record<string, unknown>): ActivityDisplay {
  const operation = str(input, 'operation') ?? 'invoke'
  return { kind: 'activity', actionWord: 'Remote trigger', subject: operation }
}

/**
 * `SendUserMessage` is the BriefTool: AI sends a UI-facing message back
 * to the user. The subject is a preview of `message`. Markdown is left
 * as-is; ActivityRow doesn't need to render it (the actual message
 * surfaces in the chat transcript independently).
 */
function mapSendUserMessage(input: Record<string, unknown>): ActivityDisplay {
  const message = str(input, 'message') ?? ''
  // Collapse whitespace so a multi-line Markdown chunk fits on one row.
  const preview = message.replace(/\s+/g, ' ').trim()
  const attachments = Array.isArray(input.attachments) ? (input.attachments as unknown[]).length : 0
  const meta = attachments > 0 ? `${attachments} attachment${attachments === 1 ? '' : 's'}` : undefined
  return {
    kind: 'activity',
    actionWord: 'Sent message',
    subject: preview ? `"${truncateSubject(preview, 70)}"` : undefined,
    meta,
  }
}

function mapSpawnTeammate(input: Record<string, unknown>): ActivityDisplay {
  const mode = str(input, 'mode')
  const shellCommand = str(input, 'shell_command')
  const tmuxSession = str(input, 'tmux_session')
  const subject = shellCommand
    ? truncateSubject(shellCommand, 60)
    : tmuxSession
      ? truncateSubject(tmuxSession, 50)
      : undefined
  return {
    kind: 'activity',
    actionWord: 'Spawned teammate',
    subject,
    meta: mode,
  }
}

function mapSwarmMultiplexer(input: Record<string, unknown>): ActivityDisplay {
  const operation = str(input, 'operation') ?? '?'
  const sessionName = str(input, 'session_name')
  const subject = sessionName
    ? `${operation}  ·  ${truncateSubject(sessionName, 40)}`
    : operation
  return { kind: 'activity', actionWord: 'Swarm', subject }
}

/**
 * `TeamCreate` / `TeamDelete` / `TeamStatus` / `TeamMemorySync` —
 * natural family, single dispatcher to keep the hot-path switch lean.
 * Verb comes from the suffix; subject is `team_name` when available.
 */
function mapTeam(name: string, input: Record<string, unknown>): ActivityDisplay {
  const teamName = str(input, 'team_name')
  switch (name) {
    case 'TeamCreate':
      return {
        kind: 'activity',
        actionWord: 'Created team',
        subject: teamName ? truncateSubject(teamName, 50) : undefined,
        meta: str(input, 'template'),
      }
    case 'TeamDelete':
      return {
        kind: 'activity',
        actionWord: 'Deleted team',
        subject: teamName ? truncateSubject(teamName, 50) : 'all teams',
      }
    case 'TeamStatus':
      return {
        kind: 'activity',
        actionWord: 'Team status',
        subject: teamName ? truncateSubject(teamName, 50) : undefined,
      }
    case 'TeamMemorySync':
      return { kind: 'activity', actionWord: 'Synced team memory' }
    default:
      // Defensive: future Team* tools fall back to a generic verb so the
      // feed still renders something readable. Mirrors `mapTask`'s shape.
      return {
        kind: 'activity',
        actionWord: `Team ${name.slice('Team'.length).toLowerCase()}`,
        subject: teamName ? truncateSubject(teamName, 50) : undefined,
      }
  }
}

/**
 * `REPL` is a nested sub-agent spawner, NOT a shell. Render as an
 * activity row keyed on the prompt preview so it doesn't masquerade as
 * a terminal command (those are reserved for `bash` / `PowerShell` and
 * go through `CommandChip`).
 */
function mapRepl(input: Record<string, unknown>): ActivityDisplay {
  const prompt = str(input, 'prompt') ?? ''
  const preview = prompt.replace(/\s+/g, ' ').trim()
  const agentType = str(input, 'agentType')
  return {
    kind: 'activity',
    actionWord: 'Ran REPL',
    subject: preview ? `"${truncateSubject(preview, 60)}"` : undefined,
    meta: agentType,
  }
}

// ─── MCP generic dispatcher ──────────────────────────────────────────
// MCP tools come in as `mcp__<server>__<method>`; we split and infer a
// verb from the method so the row reads naturally ("Read foo · fs").

function inferVerbFromMethod(method: string): string {
  const m = method.toLowerCase()
  if (m.includes('read')) return 'Read'
  if (m.includes('write')) return 'Wrote'
  if (m.includes('edit')) return 'Edited'
  if (m.includes('tree')) return 'Explored'
  if (m.includes('list') || m.includes('directory')) return 'Listed'
  if (m.includes('create')) return 'Created'
  if (m.includes('move') || m.includes('rename')) return 'Moved'
  if (m.includes('delete') || m.includes('remove')) return 'Deleted'
  if (m.includes('search') || m.includes('find')) return 'Searched'
  if (m.includes('info') || m.includes('get') || m.includes('stat')) return 'Inspected'
  if (m.includes('call')) return 'Called'
  return 'MCP'
}

function mapMcp(name: string, input: Record<string, unknown>): ActivityDisplay | null {
  // Strict match on the Anthropic MCP naming convention. If the format
  // changes upstream we return null so the BaseCard fallback still
  // produces something visible rather than a silently broken row.
  const m = /^mcp__([a-zA-Z0-9_-]+?)__([a-zA-Z0-9_-]+)$/.exec(name)
  if (!m) return null
  const [, server, method] = m
  const verb = inferVerbFromMethod(method)

  // Pick the "most informative" string param as the primary subject.
  let primary: string | undefined
  for (const key of ['path', 'filePath', 'file_path', 'uri', 'name', 'query', 'pattern', 'url', 'src', 'destination']) {
    const v = str(input, key)
    if (v) {
      primary = truncateSubject(v, 50)
      break
    }
  }

  const subject = primary ? `${primary}  ·  ${server}` : `${method.replace(/_/g, ' ')} · ${server}`
  return { kind: 'activity', actionWord: verb, subject }
}

/**
 * Resolve a tool invocation to its display descriptor. Returns `null`
 * when the tool isn't recognised — callers render those with the legacy
 * `BaseCard` path so nothing disappears during incremental migration.
 */
export function getToolDisplay(
  name: string,
  input: Record<string, unknown>,
): ToolDisplay | null {
  // ── Hot-path tools first (fast switch, common in transcripts) ─────
  switch (name) {
    case 'read_file':
      return mapRead(input)
    case 'write_file':
      return mapWrite(input)
    case 'edit_file':
      return mapEdit(input)
    case 'multi_edit_file':
      return mapMultiEdit(input)
    case 'list_files':
      return mapList(input)
    case 'glob':
      return mapGlob(input)
    case 'grep':
      return mapGrep(input)
    case 'web_fetch':
      return mapWebFetch(input)
    case 'WebSearch':
      return mapWebSearch(input)
    case 'bash':
      return mapBash(input)
    case 'PowerShell':
      return mapPowerShell(input)
    case 'TodoWrite':
      return mapTodoWrite(input)
    case 'NotebookEdit':
      return mapNotebookEdit(input)
    case 'LSP':
      return mapLsp(input)
    case 'Skill':
      return mapSkill(input)
    case 'DiscoverSkills':
      return mapDiscoverSkills(input)
    case 'MemdirScan':
      return mapMemdirScan(input)
    case 'EnterPlanMode':
      return mapEnterPlanMode()
    case 'ExitPlanMode':
      return mapExitPlanMode()
    case 'EnterWorktree':
      return mapEnterWorktree(input)
    case 'ExitWorktree':
      return mapExitWorktree()
    case 'AskUserQuestion':
      return mapAskUser(input)
    case 'MagicDocs':
      return mapMagicDocs(input)
    case 'ToolSearch':
      return mapToolSearch(input)
    case 'KillAgentTasks':
    case 'KillAllTasks':
      return mapKill(name)
    case 'Config':
      return mapConfig(input)
    case 'AwaySummary':
      return mapAwaySummary()
    case 'Await':
      return mapAwait(input)
    case 'BestOfN':
      return mapBestOfN(input)
    case 'PromptSuggestion':
      return mapPromptSuggestion(input)
    case 'ReadDiagnostics':
      return mapReadDiagnostics(input)
    case 'RemoteTrigger':
      return mapRemoteTrigger(input)
    case 'SendUserMessage':
      return mapSendUserMessage(input)
    case 'SpawnTeammate':
      return mapSpawnTeammate(input)
    case 'SwarmMultiplexer':
      return mapSwarmMultiplexer(input)
    case 'REPL':
      return mapRepl(input)
  }

  // ── Prefix-dispatched families ─────────────────────────────────────
  // Generic pattern matches keep the hot-path switch short while still
  // covering all variants in the Task* / Team* / Cron* / mcp__* families.
  if (name.startsWith('Task') && name.length > 4) {
    return mapTask(name, input)
  }
  if (name.startsWith('Team') && name.length > 4) {
    return mapTeam(name, input)
  }
  if (name.startsWith('Cron') && name.length > 4) {
    return mapCron(name, input)
  }
  if (name.startsWith('mcp__')) {
    return mapMcp(name, input)
  }

  return null
}
