/**
 * LSPTool — Language Server Protocol operations.
 *
 * Provides code intelligence features using real LSP servers:
 * - goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation
 * - prepareCallHierarchy, incomingCalls, outgoingCalls
 * - codeAction, completion, signatureHelp, formatting, rename, foldingRange, semanticTokens
 *
 * Ported from upstream's LSPTool with Electron adaptations:
 * - Uses the LSP manager singleton instead of direct imports
 * - No regex fallback: operations require a real LSP server (baseline A / doc §8.2)
 * - Formatter functions ported to LSPToolFormatters.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { lspToolInputZod } from './toolInputZod'
import { buildTool } from './buildTool'
import {
  getLspServerManager,
  getInitializationStatus,
  isLspConnected,
  waitForInitialization,
} from '../lsp/manager'
import { getWorkspacePath } from './workspaceState'
import { createLocationGitignoreFilter } from '../lsp/gitIgnoreFilter'
import {
  formatResult,
  filterLspResultByGitignore,
  noLspServerResult,
} from './LSPToolFormatters'

const MAX_FILE_SIZE = 10_000_000 // 10 MB

/**
 * Directories never worth descending into when hunting for a seed file.
 * Mirrors the pre-warm hard-ignore list (workspacePreWarm.ts) minus the
 * exotic entries — this walk is bounded anyway.
 */
const SEED_IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.vscode', '.idea', '.cursor',
  '.claude', 'dist', 'dist-electron', 'build', 'out', '.next', '.cache',
  'coverage', '__pycache__', '.venv', 'venv', 'target',
])

/**
 * Bounded breadth-first walk for the first workspace file matching one of
 * `extensions` (lowercase, with leading dot). Used to seed an LSP server
 * with a didOpen before a workspace-wide query — tsserver refuses navto
 * ("No Project") until at least one file is open.
 */
function findSeedFile(
  root: string,
  extensions: Set<string>,
  maxEntries = 2000,
): string | undefined {
  const queue: string[] = [root]
  let visited = 0
  while (queue.length > 0 && visited < maxEntries) {
    const dir = queue.shift()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++visited >= maxEntries) break
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (SEED_IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        queue.push(path.join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      if (extensions.has(path.extname(entry.name).toLowerCase())) {
        return path.join(dir, entry.name)
      }
    }
  }
  return undefined
}

export type LSPOperation =
  | 'goToDefinition'
  | 'findReferences'
  | 'hover'
  | 'documentSymbol'
  | 'workspaceSymbol'
  | 'goToImplementation'
  | 'prepareCallHierarchy'
  | 'incomingCalls'
  | 'outgoingCalls'
  | 'codeAction'
  | 'completion'
  | 'signatureHelp'
  | 'formatting'
  | 'rename'
  | 'foldingRange'
  | 'semanticTokens'

/** Optional fields for range-based or parameterized LSP operations (1-based lines/characters). */
export interface LspToolExtras {
  endLine?: number
  endCharacter?: number
  newName?: string
  /** For `workspaceSymbol` only. */
  query?: string
  /** For `semanticTokens`: full document (default) or explicit range (needs endLine/endCharacter). */
  semanticTokensMode?: 'full' | 'range'
}

type MethodParams =
  | { ok: true; method: string; params: unknown }
  | { ok: false; error: string }

function getMethodAndParams(
  operation: LSPOperation,
  absolutePath: string,
  line: number,
  character: number,
  extras: LspToolExtras,
): MethodParams {
  const uri = pathToFileURL(absolutePath).href
  const position = { line: line - 1, character: character - 1 }
  const formatOpts = { tabSize: 4, insertSpaces: true, trimTrailingWhitespace: false }

  switch (operation) {
    case 'goToDefinition':
      return { ok: true, method: 'textDocument/definition', params: { textDocument: { uri }, position } }
    case 'findReferences':
      return {
        ok: true,
        method: 'textDocument/references',
        params: { textDocument: { uri }, position, context: { includeDeclaration: true } },
      }
    case 'hover':
      return { ok: true, method: 'textDocument/hover', params: { textDocument: { uri }, position } }
    case 'documentSymbol':
      return { ok: true, method: 'textDocument/documentSymbol', params: { textDocument: { uri } } }
    case 'workspaceSymbol':
      return { ok: true, method: 'workspace/symbol', params: { query: extras.query ?? '' } }
    case 'goToImplementation':
      return { ok: true, method: 'textDocument/implementation', params: { textDocument: { uri }, position } }
    case 'prepareCallHierarchy':
      return { ok: true, method: 'textDocument/prepareCallHierarchy', params: { textDocument: { uri }, position } }
    case 'incomingCalls':
    case 'outgoingCalls':
      return { ok: true, method: 'textDocument/prepareCallHierarchy', params: { textDocument: { uri }, position } }
    case 'codeAction': {
      let range: { start: typeof position; end: { line: number; character: number } }
      if (extras.endLine != null && extras.endCharacter != null) {
        range = {
          start: position,
          end: { line: extras.endLine - 1, character: extras.endCharacter - 1 },
        }
      } else {
        range = {
          start: position,
          end: { line: position.line, character: position.character + 1 },
        }
      }
      return {
        ok: true,
        method: 'textDocument/codeAction',
        params: {
          textDocument: { uri },
          range,
          context: { diagnostics: [] },
        },
      }
    }
    case 'completion':
      return {
        ok: true,
        method: 'textDocument/completion',
        params: {
          textDocument: { uri },
          position,
          context: { triggerKind: 1 },
        },
      }
    case 'signatureHelp':
      return {
        ok: true,
        method: 'textDocument/signatureHelp',
        params: {
          textDocument: { uri },
          position,
          context: { triggerKind: 1 },
        },
      }
    case 'formatting':
      if (extras.endLine != null && extras.endCharacter != null) {
        return {
          ok: true,
          method: 'textDocument/rangeFormatting',
          params: {
            textDocument: { uri },
            range: {
              start: position,
              end: { line: extras.endLine - 1, character: extras.endCharacter - 1 },
            },
            options: formatOpts,
          },
        }
      }
      return {
        ok: true,
        method: 'textDocument/formatting',
        params: { textDocument: { uri }, options: formatOpts },
      }
    case 'rename': {
      const name = extras.newName?.trim()
      if (!name) return { ok: false, error: 'rename requires non-empty newName' }
      return {
        ok: true,
        method: 'textDocument/rename',
        params: { textDocument: { uri }, position, newName: name },
      }
    }
    case 'foldingRange':
      return { ok: true, method: 'textDocument/foldingRange', params: { textDocument: { uri } } }
    case 'semanticTokens':
      if (extras.semanticTokensMode === 'range') {
        if (extras.endLine == null || extras.endCharacter == null) {
          return {
            ok: false,
            error:
              'semanticTokens with semanticTokensMode "range" requires endLine and endCharacter (1-based)',
          }
        }
        return {
          ok: true,
          method: 'textDocument/semanticTokens/range',
          params: {
            textDocument: { uri },
            range: {
              start: position,
              end: { line: extras.endLine - 1, character: extras.endCharacter - 1 },
            },
          },
        }
      }
      return {
        ok: true,
        method: 'textDocument/semanticTokens/full',
        params: { textDocument: { uri } },
      }
  }
}

const ALL_OPERATIONS: LSPOperation[] = [
  'goToDefinition', 'findReferences', 'hover', 'documentSymbol',
  'workspaceSymbol', 'goToImplementation', 'prepareCallHierarchy',
  'incomingCalls', 'outgoingCalls',
  'codeAction', 'completion', 'signatureHelp', 'formatting', 'rename', 'foldingRange',
  'semanticTokens',
]

export const lspTool = buildTool({
  name: 'LSP',
  zInputSchema: lspToolInputZod,
  shouldDefer: true,
  /** upstream-style: hide from tool list until at least one healthy server exists. */
  isEnabled: () => isLspConnected(),
  deferUntil: () => {
    const s = getInitializationStatus()
    return s.status === 'success' || s.status === 'failed'
  },
  description:
    'Language Server Protocol operations — fast, structured code intelligence backed by real language servers. ' +
    'PREFER THIS OVER reading multiple files when you need to locate a definition, find callers, or understand a symbol. ' +
    '\n\n' +
    'Locate symbols anywhere in the workspace (NO filePath needed): ' +
    'workspaceSymbol — pass `query` (the symbol name or fragment, REQUIRED) to get a list of ' +
    '{name, kind, file, line} matches across the whole project in one call. Use this BEFORE resorting to ' +
    'grep/glob+read loops when you know the symbol name but not its file. ' +
    '\n\n' +
    'Navigate from a known position (filePath + line + character, 1-based): ' +
    'goToDefinition, goToImplementation, findReferences, hover, documentSymbol (all symbols in one file), ' +
    'prepareCallHierarchy, incomingCalls, outgoingCalls. ' +
    '\n\n' +
    'Editing helpers (return edits — NOT applied automatically; pipe through Edit/Write to persist): ' +
    'codeAction, completion, signatureHelp, formatting (full doc, or set endLine/endCharacter for range), ' +
    'rename (requires newName), foldingRange, semanticTokens (optional semanticTokensMode full|range; range needs endLine/endCharacter). ' +
    '\n\n' +
    'Requires a configured language server for the file type (or any running server for workspaceSymbol).',
  inputSchema: [
    {
      name: 'operation',
      type: 'string',
      description: 'LSP operation to perform',
      required: true,
      enum: ALL_OPERATIONS,
    },
    {
      name: 'filePath',
      type: 'string',
      description:
        'Absolute path to the source file. Required for every operation EXCEPT workspaceSymbol (which is workspace-wide and ignores this field).',
    },
    { name: 'line', type: 'number', description: 'Line number (1-based). Required for position-based operations (goToDefinition / findReferences / hover / goToImplementation / prepareCallHierarchy / incomingCalls / outgoingCalls / rename / completion / signatureHelp / codeAction).' },
    { name: 'character', type: 'number', description: 'Character offset (1-based). Pairs with `line`.' },
    {
      name: 'endLine',
      type: 'number',
      description: 'Optional end line (1-based) for codeAction/formatting range, or semanticTokens range mode',
    },
    {
      name: 'endCharacter',
      type: 'number',
      description: 'Optional end character (1-based) for codeAction/formatting/semanticTokens range',
    },
    { name: 'newName', type: 'string', description: 'Required for rename: new symbol name' },
    { name: 'query', type: 'string', description: 'REQUIRED for workspaceSymbol — the symbol name or fragment to search for (e.g. "ToolUseCardProps", "buildSystemPrompt"). Ignored by other operations.' },
    {
      name: 'semanticTokensMode',
      type: 'string',
      description: 'For semanticTokens: full (default) or range',
      enum: ['full', 'range'],
    },
  ],
  isReadOnly: true,
  isConcurrencySafe: true,
  async call({
    operation,
    filePath,
    line,
    character,
    endLine,
    endCharacter,
    newName,
    query,
    semanticTokensMode,
  }) {
    const extras: LspToolExtras = {
      endLine,
      endCharacter,
      newName,
      query,
      semanticTokensMode,
    }

    // Base for relativizing paths in formatted output. In packaged builds
    // `process.cwd()` is the install dir (paths would render absolute);
    // prefer the open workspace and keep cwd only as the dev/test fallback.
    const cwd = getWorkspacePath()?.trim() || process.cwd()

    // Wait for LSP init before any operation.
    const status = getInitializationStatus()
    if (status.status === 'pending') {
      await waitForInitialization()
    }
    const manager = getLspServerManager()

    // ── workspaceSymbol — workspace-wide query, no specific file needed ──
    //
    // Routing the request through `getServerForFile(filePath)` would force
    // the AI to invent a placeholder file path of a language the workspace
    // happens to have a configured LSP server for, which is a clumsy gating
    // step for what should be a flat "find symbol X anywhere" query. Instead
    // pick any running server and dispatch directly. Aggregating across
    // every server is left as a future improvement — most workspaces have
    // a single dominant language server that already covers the symbol the
    // user is asking about.
    if (operation === 'workspaceSymbol') {
      if (!manager) {
        return {
          success: false,
          error:
            'No LSP server available. Configure one in .lsp.json or the Settings dialog before using workspaceSymbol.',
        }
      }
      const servers = manager.getAllServers()
      const running: Array<[string, NonNullable<ReturnType<typeof servers.get>>]> = []
      for (const [name, instance] of servers) {
        if (instance.state === 'running') running.push([name, instance])
      }
      if (running.length === 0) {
        return {
          success: false,
          error:
            'No running LSP server available for workspaceSymbol. Open a file in a configured language to start a server, or check Settings → 语言服务器 status.',
        }
      }

      // tsserver-style servers only load a project after at least one
      // didOpen; querying a running-but-empty server makes navto throw
      // "No Project". Prefer a server that already has open documents.
      // (`hasOpenFilesForServer` is optional-chained: test doubles and the
      // sub-agent worker's slim manager mock may not implement it.)
      let chosen = running.find(([name]) => manager.hasOpenFilesForServer?.(name))

      // No server has anything open (e.g. pre-warm disabled or still
      // scanning): seed the first running server with one matching
      // workspace file so it loads a project before we query it.
      if (!chosen) {
        chosen = running[0]
        try {
          const wsRoot = getWorkspacePath()
          const extensions = Object.keys(chosen[1].config?.extensionToLanguage ?? {})
          if (wsRoot && extensions.length > 0 && typeof manager.openFile === 'function') {
            const seed = findSeedFile(wsRoot, new Set(extensions.map((e) => e.toLowerCase())))
            if (seed) {
              const content = fs.readFileSync(seed, 'utf-8')
              await manager.openFile(seed, content)
            }
          }
        } catch {
          // Best-effort: fall through and let the request itself surface errors.
        }
      }

      const [chosenName, chosenInstance] = chosen
      const queryText = extras.query?.trim() ?? ''
      try {
        const rawResult = await chosenInstance.sendRequest('workspace/symbol', { query: queryText })
        const wsRoot = getWorkspacePath()
        const ignoreLoc = createLocationGitignoreFilter(wsRoot ?? undefined)
        const filtered = filterLspResultByGitignore('workspaceSymbol', rawResult, ignoreLoc)
        const formatted = formatResult('workspaceSymbol', filtered, cwd)
        return { success: true, output: formatted }
      } catch (error) {
        const message = (error as Error).message
        if (/No Project/i.test(message)) {
          return {
            success: false,
            error:
              `LSP workspaceSymbol failed (server '${chosenName}'): the server has not loaded any project yet ` +
              '(tsserver "No Project"). Open a file of that language first (or wait for the workspace pre-warm ' +
              'scan to finish), then retry.',
          }
        }
        return {
          success: false,
          error: `LSP workspaceSymbol failed (server '${chosenName}'): ${message}`,
        }
      }
    }

    // ── All other operations require a real file ──

    if (!fs.existsSync(filePath)) {
      return { success: false, error: `File not found: ${filePath}` }
    }

    const stat = fs.statSync(filePath)
    if (!stat.isFile()) {
      return { success: false, error: `Not a file: ${filePath}` }
    }

    if (stat.size > MAX_FILE_SIZE) {
      return {
        success: false,
        error: `File too large for LSP analysis (${Math.ceil(stat.size / 1_000_000)}MB exceeds 10MB limit)`,
      }
    }

    const absolutePath = path.resolve(filePath)
    const lineNum = line ?? 1
    const charNum = character ?? 1

    if (!manager || !manager.getServerForFile(absolutePath)) {
      return noLspServerResult(operation, absolutePath)
    }

    try {
      // Ensure file is open in the LSP server
      if (!manager.isFileOpen(absolutePath)) {
        const content = fs.readFileSync(absolutePath, 'utf-8')
        await manager.openFile(absolutePath, content)
      }

      const built = getMethodAndParams(operation, absolutePath, lineNum, charNum, extras)
      if (!built.ok) {
        return { success: false, error: built.error }
      }
      const { method, params } = built

      let result = await manager.sendRequest(absolutePath, method, params)

      if (result === undefined) {
        return {
          success: false,
          error: `No LSP server available for file type: ${path.extname(absolutePath)}`,
        }
      }

      // For incomingCalls/outgoingCalls, two-step process
      if (operation === 'incomingCalls' || operation === 'outgoingCalls') {
        const callItems = result as Record<string, unknown>[]
        if (!callItems || callItems.length === 0) {
          return {
            success: true,
            output: 'No call hierarchy item found at this position.',
          }
        }

        const callMethod = operation === 'incomingCalls'
          ? 'callHierarchy/incomingCalls'
          : 'callHierarchy/outgoingCalls'

        result = await manager.sendRequest(absolutePath, callMethod, {
          item: callItems[0],
        })
      }

      const wsRoot = getWorkspacePath()
      const ignoreLoc = createLocationGitignoreFilter(wsRoot ?? undefined)
      result = filterLspResultByGitignore(operation, result, ignoreLoc)

      const serverCaps = manager.getServerCapabilities(absolutePath)
      const formatted = formatResult(operation, result, cwd, serverCaps)
      return { success: true, output: formatted }
    } catch (error) {
      return {
        success: false,
        error: `LSP operation '${operation}' failed: ${(error as Error).message}`,
      }
    }
  },
})
