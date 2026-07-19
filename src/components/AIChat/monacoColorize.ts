/**
 * Shared lazy accessor for `monaco.editor.colorize` — used by the chat
 * `CodeBlock` (fenced code highlighting) and `WriteEditProgressView`
 * (write/edit streaming progress card).
 *
 * Monaco is already a workspace dependency (loaded async via
 * `monacoReadyPromise`); reusing its tokenizer avoids adding shiki / hljs.
 * The colorize output is HTML with `mtk*` token classes whose colour rules
 * Monaco injects globally once an editor instance has been created — see
 * {@link bootstrapMonacoThemeStyles}.
 */

let colorizeFnPromise: Promise<
  (text: string, languageId: string, options: { tabSize: number }) => Promise<string>
> | null = null

async function bootstrapMonacoThemeStyles(
  monaco: typeof import('monaco-editor'),
): Promise<void> {
  // Idempotent: a second call returns immediately. We don't bother
  // probing the DOM stylesheet to detect prior injection because
  // mounting + disposing an empty hidden editor is < 30ms even on
  // cold-start, and Monaco internally short-circuits CSS injection
  // once its global token-style cache is populated.
  if (typeof document === 'undefined') return
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;visibility:hidden;pointer-events:none;'
  document.body.appendChild(probe)
  try {
    const ed = monaco.editor.create(probe, {
      value: '',
      language: 'plaintext',
      automaticLayout: false,
      readOnly: true,
      minimap: { enabled: false },
      lineNumbers: 'off',
      glyphMargin: false,
      folding: false,
      renderLineHighlight: 'none',
      scrollbar: { vertical: 'hidden', horizontal: 'hidden' },
    })
    await Promise.resolve()
    ed.dispose()
  } finally {
    probe.remove()
  }
}

export function getColorize(): Promise<
  (text: string, languageId: string, options: { tabSize: number }) => Promise<string>
> {
  if (!colorizeFnPromise) {
    colorizeFnPromise = import('../../configureMonaco').then(
      async ({ monacoReadyPromise }) => {
        const monaco = await monacoReadyPromise
        try {
          await bootstrapMonacoThemeStyles(monaco)
        } catch {
          /* fall through — colorize remains functional */
        }
        return monaco.editor.colorize.bind(monaco.editor)
      },
    )
  }
  return colorizeFnPromise
}

/**
 * Markdown fence tag → Monaco languageId aliases. Anything not listed is
 * passed through as-is (Monaco silently tokenizes unknown ids as plaintext).
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps: 'powershell',
  ps1: 'powershell',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
  cs: 'csharp',
  'c#': 'csharp',
  kt: 'kotlin',
  rs: 'rust',
  golang: 'go',
  dockerfile: 'dockerfile',
  jsonc: 'json',
}

export function resolveMonacoLanguageId(fenceLang: string): string {
  const lang = fenceLang.trim().toLowerCase()
  if (!lang) return 'plaintext'
  return LANGUAGE_ALIASES[lang] ?? lang
}
