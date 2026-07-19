/**
 * Monaco Inline Completion Provider for Tab auto-completion.
 *
 * Provides ghost-text suggestions as the user types, rendered as gray inline text.
 * Press Tab to accept. Implements:
 *   - Debounce (150ms)
 *   - AbortController for in-flight request cancellation
 *   - Trigger filtering (skip delete triggers)
 *   - Context collection (prefix / suffix / recent snippets extraction)
 */

import type * as monaco from 'monaco-editor'

// ---------- Types ----------

export interface CompletionConfig {
  enabled: boolean
  /** Debounce delay in ms */
  debounceMs: number
}

const DEFAULT_CONFIG: CompletionConfig = {
  enabled: true,
  debounceMs: 150,
}

// ---------- Provider Registration ----------

let disposable: monaco.IDisposable | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let currentAbortController: AbortController | null = null
let lastEditWasDelete = false
let editListener: monaco.IDisposable | null = null

/** Monaco / VS Code 在取消异步操作时常见，不应当作错误 */
function isCanceledError(e: unknown): boolean {
  if (e == null) return false
  if (typeof e === 'string') return e === 'Canceled' || e === 'canceled'
  const err = e as { name?: string; message?: string }
  return (
    err.name === 'Canceled' ||
    err.message === 'Canceled' ||
    err.message === 'canceled'
  )
}

/**
 * Register the tab auto-completion inline provider with Monaco.
 */
export function registerTabCompletionProvider(
  editor: monaco.editor.IStandaloneCodeEditor,
  monacoInstance: typeof monaco,
  config: Partial<CompletionConfig> = {}
): monaco.IDisposable {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  // Dispose previous provider if exists
  if (disposable) {
    disposable.dispose()
  }
  if (editListener) {
    editListener.dispose()
  }

  // Track whether the last edit was a deletion so we can skip triggering
  editListener = editor.onDidChangeModelContent((e) => {
    lastEditWasDelete = e.changes.every(
      (c) => c.text === '' && c.rangeLength > 0,
    )
  })

  const provider: monaco.languages.InlineCompletionsProvider = {
    provideInlineCompletions: async (
      model: monaco.editor.ITextModel,
      position: monaco.Position,
      _context: monaco.languages.InlineCompletionContext,
      token: monaco.CancellationToken
    ) => {
      if (!cfg.enabled) {
        return { items: [] }
      }

      // Skip completions triggered by pure deletions (backspace / delete key)
      if (lastEditWasDelete) {
        return { items: [] }
      }

      // Cancel any in-flight request
      cancelInFlight()
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }

      if (token.isCancellationRequested) {
        return { items: [] }
      }

      return await new Promise<monaco.languages.InlineCompletions>((resolve) => {
        let settled = false
        const finish = (result: monaco.languages.InlineCompletions) => {
          if (settled) return
          settled = true
          resolve(result)
        }

        const cancelSub = token.onCancellationRequested(() => {
          if (debounceTimer) {
            clearTimeout(debounceTimer)
            debounceTimer = null
          }
          cancelInFlight()
          finish({ items: [] })
        })

        debounceTimer = setTimeout(async () => {
          debounceTimer = null
          cancelSub.dispose()
          if (token.isCancellationRequested) {
            finish({ items: [] })
            return
          }
          try {
            const result = await fetchCompletion(model, position, monacoInstance)
            finish(result)
          } catch (error) {
            if (isCanceledError(error)) {
              finish({ items: [] })
            } else if ((error as Error).name !== 'AbortError') {
              console.warn('[TabCompletion] Error:', error)
              finish({ items: [] })
            } else {
              finish({ items: [] })
            }
          }
        }, cfg.debounceMs)
      })
    },

    disposeInlineCompletions(_completions, _reason) {
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      cancelInFlight()
    },
  }

  disposable = monacoInstance.languages.registerInlineCompletionsProvider(
    { pattern: '**' },
    provider
  )

  return disposable
}

/**
 * Unregister the tab completion provider and clean up timers.
 */
export function unregisterTabCompletionProvider(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  cancelInFlight()
  if (editListener) {
    editListener.dispose()
    editListener = null
  }
  if (disposable) {
    disposable.dispose()
    disposable = null
  }
}

function cancelInFlight(): void {
  if (currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
    // Also signal the main process to cancel its in-flight AI call
    try {
      window.electronAPI?.tabAutocomplete?.cancel()
    } catch { /* noop */ }
  }
}

// ---------- Context Collection ----------

const PREFIX_MAX_CHARS = 1500
const SUFFIX_MAX_CHARS = 800

function extractContext(
  model: monaco.editor.ITextModel,
  position: monaco.Position
): { prefix: string; suffix: string; language: string } {
  const lineCount = model.getLineCount()
  const currentLine = position.lineNumber
  const currentColumn = position.column

  const prefixStartLine = Math.max(1, currentLine - 40)
  const prefixRange = {
    startLineNumber: prefixStartLine,
    startColumn: 1,
    endLineNumber: currentLine,
    endColumn: currentColumn,
  }
  let prefix = model.getValueInRange(prefixRange)
  if (prefix.length > PREFIX_MAX_CHARS) {
    prefix = prefix.slice(-PREFIX_MAX_CHARS)
  }

  const suffixEndLine = Math.min(lineCount, currentLine + 20)
  const suffixRange = {
    startLineNumber: currentLine,
    startColumn: currentColumn,
    endLineNumber: suffixEndLine,
    endColumn: model.getLineMaxColumn(suffixEndLine),
  }
  let suffix = model.getValueInRange(suffixRange)
  if (suffix.length > SUFFIX_MAX_CHARS) {
    suffix = suffix.slice(0, SUFFIX_MAX_CHARS)
  }

  const uri = model.uri.toString()
  const language = detectLanguage(uri)

  return { prefix, suffix, language }
}

/**
 * Collect snippets from other open models (recently edited files) to give
 * the completion model cross-file context.
 */
function collectRecentSnippets(
  monacoInstance: typeof monaco,
  currentUri: string,
): Array<{ path: string; content: string }> {
  const snippets: Array<{ path: string; content: string }> = []
  try {
    const models = monacoInstance.editor.getModels()
    for (const m of models) {
      if (m.uri.toString() === currentUri) continue
      const value = m.getValue()
      if (!value || value.length < 20) continue
      snippets.push({
        path: m.uri.path,
        content: value.slice(-300),
      })
      if (snippets.length >= 3) break
    }
  } catch { /* noop */ }
  return snippets
}

const LANG_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  cs: 'csharp',
  fs: 'fsharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  dart: 'dart',
  r: 'r',
  R: 'r',
  lua: 'lua',
  zig: 'zig',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  ml: 'ocaml',
  clj: 'clojure',
  tf: 'terraform',
  proto: 'protobuf',
  graphql: 'graphql',
  gql: 'graphql',
  dockerfile: 'dockerfile',
}

function detectLanguage(uri: string): string {
  const filename = uri.split('/').pop()?.toLowerCase() || ''
  if (filename === 'dockerfile') return 'dockerfile'
  const ext = filename.split('.').pop() || ''
  return LANG_MAP[ext] || 'plaintext'
}

// ---------- Completion Request ----------

async function fetchCompletion(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  monacoInstance: typeof monaco,
): Promise<monaco.languages.InlineCompletions> {
  const { prefix, suffix, language } = extractContext(model, position)

  const lastLine = prefix.split('\n').pop() || ''
  if (lastLine.trim().length < 2) {
    return { items: [] }
  }

  const filePath = model.uri.path
  const recentSnippets = collectRecentSnippets(monacoInstance, model.uri.toString())

  const abortController = new AbortController()
  currentAbortController = abortController

  try {
    // Match the optional-chain style used elsewhere in this file
    // (e.g. `cancelInFlight` at L~182, `hooks.fireFileSuggestion` at L~374).
    // Without `?.` the renderer crashes in non-Electron environments
    // (browser dev / unit tests) instead of just returning no completion.
    const requestCompletion = window.electronAPI?.tabAutocomplete?.requestCompletion
    if (!requestCompletion) {
      return { items: [] }
    }
    const completionPromise = requestCompletion({
      prefix,
      suffix,
      language,
      filePath,
      recentSnippets,
    })

    // If aborted while waiting, bail out
    const result = await Promise.race([
      completionPromise,
      new Promise<null>((resolve) => {
        abortController.signal.addEventListener('abort', () => resolve(null), { once: true })
      }),
    ])

    if (!result || abortController.signal.aborted) {
      return { items: [] }
    }

    if (!result.completion) {
      return { items: [] }
    }

    try {
      const preview = result.completion.length > 200 ? `${result.completion.slice(0, 200)}…` : result.completion
      void window.electronAPI?.hooks?.fireFileSuggestion?.({
        filePath,
        language,
        completionPreview: preview,
        completionLength: result.completion.length,
        latencyMs: typeof result.latencyMs === 'number' ? result.latencyMs : 0,
      })
    } catch {
      /* non-blocking */
    }

    return {
      items: [
        {
          insertText: result.completion,
          range: {
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          },
        },
      ],
    }
  } finally {
    if (currentAbortController === abortController) {
      currentAbortController = null
    }
  }
}
