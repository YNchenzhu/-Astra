/**
 * upstream-style canonical tool names — single source of truth.
 *
 * Every tool that exists in both upstream and cursor-ui-clone is listed
 * here. Legacy snake_case aliases are accepted at execute/Zod time.
 */

// ── Filesystem ──
export const READ_TOOL_NAME = 'Read'
export const WRITE_TOOL_NAME = 'Write'
export const EDIT_TOOL_NAME = 'Edit'
export const MULTI_EDIT_TOOL_NAME = 'MultiEdit'

// ── Search / Discovery ──
export const GLOB_TOOL_NAME = 'Glob'
export const GREP_TOOL_NAME = 'Grep'
export const TOOL_SEARCH_TOOL_NAME = 'ToolSearch'

// ── Web ──
export const WEB_FETCH_TOOL_NAME = 'WebFetch'
export const WEB_SEARCH_TOOL_NAME = 'WebSearch'

// ── Shell ──
export const BASH_TOOL_NAME = 'Bash'

// ── Agent / multi-agent ──
export const AGENT_TOOL_NAME = 'Agent'
export const SEND_MESSAGE_TOOL_NAME = 'SendMessage'
export const TEAM_CREATE_TOOL_NAME = 'TeamCreate'
export const TEAM_DELETE_TOOL_NAME = 'TeamDelete'

// ── Task management ──
export const TASK_OUTPUT_TOOL_NAME = 'TaskOutput'
export const TASK_STOP_TOOL_NAME = 'TaskStop'
export const TASK_LIST_TOOL_NAME = 'TaskList'
export const TASK_CREATE_TOOL_NAME = 'TaskCreate'
export const TASK_GET_TOOL_NAME = 'TaskGet'
export const TASK_UPDATE_TOOL_NAME = 'TaskUpdate'
export const TODO_WRITE_TOOL_NAME = 'TodoWrite'

// ── Interaction / mode ──
export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'
export const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode'
export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode'
export const BRIEF_TOOL_NAME = 'SendUserMessage'

// ── File-type editing ──
export const NOTEBOOK_EDIT_TOOL_NAME = 'NotebookEdit'

// ── Config / skills ──
export const CONFIG_TOOL_NAME = 'Config'
export const SKILL_TOOL_NAME = 'Skill'

// ── Worktree ──
export const ENTER_WORKTREE_TOOL_NAME = 'EnterWorktree'
export const EXIT_WORKTREE_TOOL_NAME = 'ExitWorktree'

// ── LSP / REPL ──
export const LSP_TOOL_NAME = 'LSP'
export const REPL_TOOL_NAME = 'REPL'

// ── MCP resource tools ──
export const LIST_MCP_RESOURCES_TOOL_NAME = 'ListMcpResourcesTool'
export const READ_MCP_RESOURCE_TOOL_NAME = 'ReadMcpResourceTool'

// ═══════════════════════════════════════════════════════════════════
// Legacy name → canonical name mapping (only for names that differ)
// ═══════════════════════════════════════════════════════════════════

const LEGACY_TO_CANONICAL: Record<string, string> = {
  // Filesystem (snake_case → PascalCase)
  read_file: READ_TOOL_NAME,
  write_file: WRITE_TOOL_NAME,
  edit_file: EDIT_TOOL_NAME,
  multi_edit_file: MULTI_EDIT_TOOL_NAME,

  // Search (lower → Pascal)
  glob: GLOB_TOOL_NAME,
  grep: GREP_TOOL_NAME,
  tool_search: TOOL_SEARCH_TOOL_NAME,

  // Web
  web_fetch: WEB_FETCH_TOOL_NAME,
  web_search: WEB_SEARCH_TOOL_NAME,

  // Shell
  bash: BASH_TOOL_NAME,

  // MCP (old names without Tool suffix)
  ListMcpResources: LIST_MCP_RESOURCES_TOOL_NAME,
  ReadMcpResource: READ_MCP_RESOURCE_TOOL_NAME,

  ExitPlanModeV2: 'ExitPlanMode',

  /** upstream coordinator/async docs name — routed to {@link TASK_OUTPUT_TOOL_NAME}; not upstream StructuredOutput. */
  SyntheticOutput: TASK_OUTPUT_TOOL_NAME,

  // upstream `ASYNC_AGENT_ALLOWED_TOOLS` accepts these PascalCase aliases.
  // Without an explicit mapping `resolveAgentTools` would filter them out
  // (no tool registered under these literal names).
  FileEdit: EDIT_TOOL_NAME,
  FileWrite: WRITE_TOOL_NAME,
  GlobFileSearch: GLOB_TOOL_NAME,
  glob_file_search: GLOB_TOOL_NAME,
}

/** All canonical names (values of the mapping + all explicit constants) */
export const CANONICAL_BUILTIN_TOOL_NAMES = new Set([
  READ_TOOL_NAME, WRITE_TOOL_NAME, EDIT_TOOL_NAME, MULTI_EDIT_TOOL_NAME,
  GLOB_TOOL_NAME, GREP_TOOL_NAME, TOOL_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME,
  BASH_TOOL_NAME,
  AGENT_TOOL_NAME, SEND_MESSAGE_TOOL_NAME,
  TEAM_CREATE_TOOL_NAME, TEAM_DELETE_TOOL_NAME,
  TASK_OUTPUT_TOOL_NAME, TASK_STOP_TOOL_NAME,
  TASK_LIST_TOOL_NAME, TASK_CREATE_TOOL_NAME, TASK_GET_TOOL_NAME, TASK_UPDATE_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME, ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME, BRIEF_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  CONFIG_TOOL_NAME, SKILL_TOOL_NAME,
  ENTER_WORKTREE_TOOL_NAME, EXIT_WORKTREE_TOOL_NAME,
  LSP_TOOL_NAME, REPL_TOOL_NAME,
  LIST_MCP_RESOURCES_TOOL_NAME, READ_MCP_RESOURCE_TOOL_NAME,
  'MemdirScan',
])

/**
 * Resolve incoming tool call name to the registry primary name.
 * Unknown names are returned unchanged (MCP server tools, etc.).
 */
export function canonicalBuiltinToolName(toolName: string): string {
  return LEGACY_TO_CANONICAL[toolName] ?? toolName
}

/**
 * Map model / Zod canonical / legacy aliases → actual {@link toolRegistry} `Tool.name`.
 * MCP tools (`mcp__…`) pass through unchanged.
 */
const REGISTRY_PRIMARY_TOOL_NAME: Record<string, string> = (() => {
  const m: Record<string, string> = {}
  for (const [legacy, canonical] of Object.entries(LEGACY_TO_CANONICAL)) {
    let reg: string
    if (legacy === 'web_search' || legacy === 'tool_search') reg = canonical
    else if (legacy === 'bash') reg = 'bash'
    else if (legacy === 'glob' || legacy === 'grep') reg = legacy
    else if (legacy.includes('_')) reg = legacy
    else reg = canonical
    m[legacy] = reg
    m[canonical] = reg
  }
  const id = (n: string) => {
    m[n] = n
  }
  id('list_files')
  id('PowerShell')
  // Non-canonical PowerShell spellings — OpenAI / Gemini models frequently
  // emit these when asked to run a Windows command. Mapping them to the
  // canonical registry id prevents `Unknown tool` dispatch errors.
  m['powershell'] = 'PowerShell'
  m['pwsh'] = 'PowerShell'
  m['power_shell'] = 'PowerShell'
  m['PowerShellTool'] = 'PowerShell'
  id('Agent')
  id('SendMessage')
  id('EnterPlanMode')
  id('ExitPlanMode')
  id('AskUserQuestion')
  id('TodoWrite')
  id('NotebookEdit')
  id('Config')
  id('SendUserMessage')
  id('TaskList')
  id('TaskCreate')
  id('TaskGet')
  id('TaskUpdate')
  id('TaskStop')
  id('TeamCreate')
  id('TeamDelete')
  id('TeamStatus')
  id('LSP')
  id('TaskOutput')
  id('Skill')
  id('EnterWorktree')
  id('ExitWorktree')
  id('ListMcpResourcesTool')
  id('ReadMcpResourceTool')
  id('ListMcpResources')
  id('ReadMcpResource')
  id('REPL')
  // `REP` / `rep` / `repl` are aliases for the registered `REPL` tool
  // (REPLTool.ts has a factory for both names but only `REPL` is exported
  // and registered). The Debug agent whitelist still references `REP`.
  m['REP'] = 'REPL'
  m['rep'] = 'REPL'
  m['repl'] = 'REPL'
  // upstream `FileEdit / FileWrite / GlobFileSearch / glob_file_search` aliases
  // — the loop above re-wrote `m['Edit'] = 'Edit'` etc. because those
  // legacy names have no underscore and inherit `reg = canonical`. The
  // registry tools are still the snake_case ones, so fix the mapping
  // here (also covers the legacy alias keys themselves).
  m['FileEdit'] = 'edit_file'
  m['FileWrite'] = 'write_file'
  m['GlobFileSearch'] = 'glob'
  m['glob_file_search'] = 'glob'
  m['Edit'] = 'edit_file'
  m['Write'] = 'write_file'
  m['Glob'] = 'glob'
  id('Debug')
  id('CronCreate')
  id('CronList')
  id('CronDelete')
  id('RemoteTrigger')
  id('MemdirScan')
  id('Brief')
  m.Brief = 'SendUserMessage'
  return m
})()

export function registryPrimaryToolName(toolName: string): string {
  const t = toolName.trim()
  if (t.startsWith('mcp__')) return t
  const c = canonicalBuiltinToolName(t)
  return REGISTRY_PRIMARY_TOOL_NAME[t] ?? REGISTRY_PRIMARY_TOOL_NAME[c] ?? t
}

/**
 * Map registry / model tool name → stable key for renderer inline diff (still snake_case).
 */
export function toRendererFileToolName(toolName: string): 'write_file' | 'edit_file' {
  if (toolName === WRITE_TOOL_NAME || toolName === 'write_file') return 'write_file'
  if (toolName === EDIT_TOOL_NAME || toolName === 'edit_file') return 'edit_file'
  // multi_edit_file mutates the same way edit_file does — surface it under the
  // same inline-diff key so the renderer doesn't need a new code path for the
  // diff preview. The diff itself is computed against pre/post-batch content
  // exactly like a single edit.
  if (toolName === MULTI_EDIT_TOOL_NAME || toolName === 'multi_edit_file') return 'edit_file'
  const suf = getMcpBridgedToolSuffix(toolName)
  if (suf?.toLowerCase() === 'write_file') return 'write_file'
  if (suf?.toLowerCase() === 'edit_file') return 'edit_file'
  if (suf?.toLowerCase() === 'multi_edit_file') return 'edit_file'
  return 'edit_file'
}

export function isBuiltinFullFileWriteTool(name: string): boolean {
  return name === WRITE_TOOL_NAME || name === 'write_file'
}

export function isBuiltinFileMutationTool(name: string): boolean {
  return (
    name === WRITE_TOOL_NAME ||
    name === 'write_file' ||
    name === EDIT_TOOL_NAME ||
    name === 'edit_file' ||
    name === MULTI_EDIT_TOOL_NAME ||
    name === 'multi_edit_file'
  )
}

/** `mcp__{server}__{tool}` → MCP tool id from the server (e.g. `write_file`). */
export function getMcpBridgedToolSuffix(registryName: string): string | null {
  if (!registryName.startsWith('mcp__')) return null
  const rest = registryName.slice(5)
  const sep = rest.indexOf('__')
  if (sep < 0) return null
  const suffix = rest.slice(sep + 2).trim()
  return suffix.length > 0 ? suffix : null
}

/** Names commonly used by @modelcontextprotocol/server-filesystem and similar MCP servers. */
const MCP_WORKSPACE_MUTATION_TOOL_NAMES = new Set([
  'write_file',
  'edit_file',
  'multi_edit_file',
  'move_file',
  'delete_file',
  'create_directory',
])

const MCP_WORKSPACE_DIFF_TOOL_NAMES = new Set(['write_file', 'edit_file', 'multi_edit_file'])

/** True for MCP server tool ids like `write_file` (not the bridged `mcp__…__` name). */
export function isMcpServerToolIdWorkspaceMutating(mcpToolId: string): boolean {
  return MCP_WORKSPACE_MUTATION_TOOL_NAMES.has(mcpToolId.toLowerCase())
}

export function isMcpWorkspaceMutationTool(registryName: string): boolean {
  const s = getMcpBridgedToolSuffix(registryName)
  if (!s) return false
  return MCP_WORKSPACE_MUTATION_TOOL_NAMES.has(s.toLowerCase())
}

/** MCP tools whose inputs match builtin write/edit enough to build an inline diff preview. */
export function isMcpWorkspaceFileDiffTool(registryName: string): boolean {
  const s = getMcpBridgedToolSuffix(registryName)
  if (!s) return false
  return MCP_WORKSPACE_DIFF_TOOL_NAMES.has(s.toLowerCase())
}

export function isMcpWorkspaceFullWriteTool(registryName: string): boolean {
  const s = getMcpBridgedToolSuffix(registryName)
  return s !== null && s.toLowerCase() === 'write_file'
}

/** File mutations that participate in diff-permission / inline diff (builtins + filesystem MCP). */
export function isAgenticWorkspaceFileMutationTool(registryName: string): boolean {
  return isBuiltinFileMutationTool(registryName) || isMcpWorkspaceMutationTool(registryName)
}

export function isAgenticWorkspaceFileDiffTool(registryName: string): boolean {
  return isBuiltinFileMutationTool(registryName) || isMcpWorkspaceFileDiffTool(registryName)
}

export function isAgenticFullFileReplaceTool(registryName: string): boolean {
  return isBuiltinFullFileWriteTool(registryName) || isMcpWorkspaceFullWriteTool(registryName)
}

/** Resolve path keys used by builtins and typical MCP filesystem tools. */
export function extractWorkspaceFilePathFromToolInput(input: Record<string, unknown>): string {
  const candidates = [input.filePath, input.file_path, input.path]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return ''
}

export function isBuiltinEditTool(name: string): boolean {
  return name === EDIT_TOOL_NAME || name === 'edit_file'
}

/** Built-in multi-edit batch tool (substring batch refactor of an existing file). */
export function isBuiltinMultiEditTool(name: string): boolean {
  return name === MULTI_EDIT_TOOL_NAME || name === 'multi_edit_file'
}
