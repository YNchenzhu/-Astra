/**
 * Slash-command registry for the chat input. Phase G of the Claude
 * Code alignment — provides `/context`, `/clear`, `/compact`,
 * `/memory`, `/diagnostics`. Each command is described declaratively
 * so the popup component and tests share a single source of truth.
 */

export type SlashCommandRender =
  /** Inline message (rendered as an assistant-style note in the chat). */
  | { kind: 'inline'; text: string }
  /** Open a modal/dialog by id (consumer wires the actual UI). */
  | { kind: 'openDialog'; dialogId: 'diagnostics' | 'memory' }
  /** Pure side-effect command with no on-screen output. */
  | { kind: 'silent' }

export interface SlashCommandHandlerContext {
  workspacePath?: string
  conversationId?: string
  /** Renderer-side hooks the registry can use without importing stores. */
  ports: {
    /** Open the prompt-diagnostics drawer / overlay. */
    openDiagnosticsView: () => void
    /** Trigger the existing `clearConversationContext` store action. */
    clearConversation: () => Promise<void> | void
    /** Trigger main-process auto/manual compact for this chat. */
    triggerCompact: () => Promise<void>
    /** Persist a user-level memory entry. */
    writeUserMemory: (body: string) => Promise<{ filename?: string; error?: string }>
    /** Render the formatted `analyzeLive` text. */
    renderContextReport: () => Promise<string>
    /** Push an inline assistant-style note into the current chat. */
    appendInlineNote: (markdown: string) => void
  }
}

export interface SlashCommandDefinition {
  /** Lower-case id (no leading `/`). Used for matching and tests. */
  id: string
  /** Display label (typically `/id`). */
  label: string
  description: string
  /** Optional argument hint (e.g. `<text>` for `/memory`). */
  argumentHint?: string
  /** Whether this command needs an argument. `true` = required, `false` = optional. */
  takesArgument: boolean
  /** Run the command. `args` is everything after the first space (`"/memory always use ESM"` → `"always use ESM"`). */
  run(args: string, ctx: SlashCommandHandlerContext): Promise<SlashCommandRender>
}

const HANDLERS: SlashCommandDefinition[] = [
  {
    id: 'context',
    label: '/context',
    description: '显示当前会话的上下文用量明细',
    takesArgument: false,
    async run(_args, ctx) {
      const text = await ctx.ports.renderContextReport()
      ctx.ports.appendInlineNote(text || '(no context data yet)')
      return { kind: 'inline', text }
    },
  },
  {
    id: 'clear',
    label: '/clear',
    description: '清空当前会话上下文,从头开始',
    takesArgument: false,
    async run(_args, ctx) {
      await ctx.ports.clearConversation()
      return { kind: 'silent' }
    },
  },
  {
    id: 'compact',
    label: '/compact',
    description: '手动触发对话压缩',
    takesArgument: false,
    async run(_args, ctx) {
      await ctx.ports.triggerCompact()
      ctx.ports.appendInlineNote('Compact triggered — the next turn will see a summarized transcript.')
      return { kind: 'inline', text: 'Compact triggered' }
    },
  },
  {
    id: 'memory',
    label: '/memory',
    description: '写入一条用户记忆',
    argumentHint: '<text>',
    takesArgument: true,
    async run(args, ctx) {
      const body = args.trim()
      if (!body) {
        ctx.ports.appendInlineNote('Usage: `/memory <text>` — provide the memory body to write.')
        return { kind: 'inline', text: 'no body' }
      }
      const result = await ctx.ports.writeUserMemory(body)
      if (result.error) {
        ctx.ports.appendInlineNote(`Memory write failed: ${result.error}`)
      } else if (result.filename) {
        ctx.ports.appendInlineNote(`Memory written: \`${result.filename}\``)
      }
      return { kind: 'silent' }
    },
  },
  {
    id: 'diagnostics',
    label: '/diagnostics',
    description: '打开最近请求诊断面板',
    takesArgument: false,
    async run(_args, ctx) {
      ctx.ports.openDiagnosticsView()
      return { kind: 'openDialog', dialogId: 'diagnostics' }
    },
  },
]

export function listSlashCommands(): readonly SlashCommandDefinition[] {
  return HANDLERS
}

/**
 * Parse a raw input string like `"/memory always use ESM"` into the
 * command + argument tuple. Returns `null` when the input is not a
 * slash command at all, or `{ command: null }` when the prefix matches
 * `/` but the id is unknown (caller falls back to skill popup).
 */
export function parseSlashCommandInput(
  input: string,
): { command: SlashCommandDefinition | null; args: string } | null {
  const trimmed = input.trimStart()
  if (!trimmed.startsWith('/')) return null
  const body = trimmed.slice(1)
  const spaceIdx = body.indexOf(' ')
  const id = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase()
  const args = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1)
  const command = HANDLERS.find((h) => h.id === id) ?? null
  return { command, args }
}

/**
 * Filter the command list against the user's current query (the bit
 * after `/`). Used by the popup as you type.
 *
 * Audit fix (P0): the previous implementation matched on description
 * text too, so any `/c` would surface every command and pre-empt the
 * SkillPopup path users rely on for `/commit`, `/clear-skill`, etc.
 * Strict id-prefix matching keeps the host commands out of the way
 * unless the user typed something that genuinely starts with one of
 * their ids. An empty query still returns the full list — that's a
 * deliberate UX choice for the bare `/` trigger.
 */
export function filterSlashCommands(query: string): SlashCommandDefinition[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...HANDLERS]
  return HANDLERS.filter((h) => h.id.startsWith(q))
}
