/**
 * Lexical workspace retriever.
 *
 * Despite the file name (kept for backwards-compat with importers), this module
 * does **not** perform embedding/vector retrieval — it extracts identifiers,
 * filenames, and quoted strings from the user message, runs ripgrep for each
 * term, and ranks matching files by hit count. See
 * {@link ../stores/chat/retrievalBudget.ts#retrieveWithBudget} for the
 * sibling embedding-based workspace retrieval step (gated by a configured
 * embedding model + a built workspace index) that runs in parallel with
 * this one and merges its hits into the same snippet pool.
 */
import { searchWorkspace, readFile } from './fileSystem'
import { toWorkspaceAbsoluteFilePath } from './pathUtils'

export interface RetrievedSnippet {
  filePath: string
  relativePath: string
  lines: string
  matchCount: number
}

export interface RetrievalResult {
  snippets: RetrievedSnippet[]
  searchTerms: string[]
  durationMs: number
}

const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.wav', '.webm',
  '.zip', '.tar', '.gz', '.rar',
  '.lock', '.log',
])

const SKIP_DIRS = /[/\\](node_modules|\.git|dist|dist-electron|\.next|\.cache|\.cursor|release)[/\\]/

/**
 * Extract meaningful search terms from a user message.
 * Targets: identifiers, file paths, technical keywords.
 */
export function extractSearchTerms(message: string): string[] {
  const terms = new Set<string>()
  const homeDirectoryNames = new Set(
    Array.from(
      message.matchAll(/(?:[A-Za-z]:[\\/]|\/)Users[\\/]([^\\/\s"'`]+)/gi),
      (match) => match[1].toLowerCase(),
    ),
  )

  // 1. Explicit file paths / names (e.g. "ChatInput.tsx", "src/services/foo.ts")
  const filePatterns = message.match(/[\w./\\-]+\.\w{1,6}/g) || []
  for (const fp of filePatterns) {
    const basename = fp.split(/[/\\]/).pop()!
    if (basename.length >= 3) terms.add(basename)
  }

  // 2. Code identifiers: camelCase, PascalCase, snake_case, UPPER_CASE
  const identifiers = message.match(/\b[A-Za-z_$][A-Za-z0-9_$]{2,}\b/g) || []
  for (const id of identifiers) {
    if (isStopWord(id)) continue
    terms.add(id)
  }

  // 3. Quoted strings (e.g. "useChatStore", 'buildContext')
  const quoted = message.match(/["'`]([\w./-]{3,})["'`]/g) || []
  for (const q of quoted) {
    terms.add(q.slice(1, -1))
  }

  // Deduplicate case-insensitively but keep original casing
  const seen = new Set<string>()
  const result: string[] = []
  for (const t of terms) {
    const lower = t.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    result.push(t)
  }

  // Drop path / generic noise, including the account segment of a home path.
  const filtered = result.filter(
    (t) => !homeDirectoryNames.has(t.toLowerCase()) && !isNoiseSearchTerm(t),
  )

  // Prioritize longer / more specific terms, limit to top 5
  filtered.sort((a, b) => b.length - a.length)
  return filtered.slice(0, 5)
}

const STOP_WORDS = new Set([
  'the', 'this', 'that', 'with', 'from', 'have', 'been', 'will', 'would',
  'could', 'should', 'what', 'when', 'where', 'which', 'while', 'about',
  'there', 'their', 'they', 'them', 'then', 'than', 'these', 'those',
  'into', 'some', 'such', 'each', 'every', 'other', 'only', 'also',
  'just', 'more', 'most', 'very', 'much', 'many', 'well', 'back',
  'like', 'make', 'over', 'after', 'before', 'between', 'under',
  'here', 'does', 'done', 'need', 'want', 'know', 'think', 'look',
  'help', 'tell', 'show', 'find', 'give', 'take', 'come', 'keep',
  'let', 'use', 'try', 'ask', 'any', 'all', 'new', 'now', 'how',
  'can', 'may', 'not', 'but', 'and', 'for', 'are', 'was', 'has',
  'had', 'did', 'get', 'got', 'put', 'say', 'see', 'way', 'who',
  'its', 'yes', 'yet', 'too', 'our', 'out', 'own', 'why', 'few',
  // Chinese stop words
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都',
  '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你',
  '会', '着', '没有', '看', '好', '自己', '这', '他', '她', '它',
  '吗', '什么', '怎么', '如何', '这个', '那个', '可以', '帮我',
  '请', '谢谢', '能', '把', '让', '给', '用', '做', '对', '被',
  'undefined', 'null', 'true', 'false', 'return', 'const', 'function',
  'import', 'export', 'default', 'class', 'interface', 'type', 'void',
  'string', 'number', 'boolean', 'async', 'await', 'Promise',
])

/** Segments from Windows/macOS paths that match almost every tree — useless as code-search terms. */
const PATH_SEGMENT_NOISE = new Set(
  [
    'users', 'desktop', 'documents', 'downloads', 'pictures', 'videos', 'music',
    'appdata', 'local', 'locallow', 'roaming', 'public', 'library', 'volumes',
    'programfiles', 'programfiles(x86)', 'programdata', 'windows', 'system32',
    'syswow64', 'onedrive', 'temp', 'tmp', 'cache', 'workspace', 'projects',
    'administrator', 'default', 'home',
  ].map((s) => s.toLowerCase()),
)

/** Standalone tokens that are too generic for workspace grep (match everywhere). */
const GENERIC_SEARCH_NOISE = new Set([
  'txt', 'log', 'tmp', 'bak', 'old', 'new', 'bin', 'obj', 'out',
])

function isNoiseSearchTerm(term: string): boolean {
  const lower = term.toLowerCase()
  if (PATH_SEGMENT_NOISE.has(lower)) return true
  if (GENERIC_SEARCH_NOISE.has(lower)) return true
  return false
}

function isStopWord(word: string): boolean {
  return STOP_WORDS.has(word) || STOP_WORDS.has(word.toLowerCase()) || word.length < 3
}

function shouldSkipFile(filePath: string): boolean {
  if (SKIP_DIRS.test(filePath)) return true
  const ext = filePath.slice(filePath.lastIndexOf('.'))
  return SKIP_EXTENSIONS.has(ext.toLowerCase())
}

/**
 * Search the workspace and retrieve relevant code snippets.
 * Called before building the AI context.
 */
export async function retrieveSemanticContext(
  workspacePath: string,
  userMessage: string,
  excludePaths: string[] = [],
): Promise<RetrievalResult> {
  const start = Date.now()
  const searchTerms = extractSearchTerms(userMessage)

  if (searchTerms.length === 0 || !workspacePath) {
    return { snippets: [], searchTerms: [], durationMs: Date.now() - start }
  }

  const excludeSet = new Set(excludePaths.map((p) => normalizePath(p)))

  // Search for each term in parallel, with a global timeout
  const fileScores = new Map<string, { relativePath: string; score: number; matchLines: Map<number, string> }>()

  const searchPromises = searchTerms.map(async (term, termIndex) => {
    try {
      const { results } = await searchWorkspace({
        dirPath: workspacePath,
        query: term,
        maxResults: 8,
        maxMatchesPerFile: 5,
      })

      for (const result of results) {
        if (shouldSkipFile(result.path)) continue
        const normalizedPath = normalizePath(result.path)
        if (excludeSet.has(normalizedPath)) continue

        const existing = fileScores.get(normalizedPath) || {
          relativePath: result.path,
          score: 0,
          matchLines: new Map<number, string>(),
        }

        // Earlier search terms (more specific) contribute more score
        const termWeight = searchTerms.length - termIndex
        existing.score += result.matches.length * termWeight

        for (const match of result.matches) {
          existing.matchLines.set(match.line, match.text)
        }

        fileScores.set(normalizedPath, existing)
      }
    } catch {
      // Search failure for one term shouldn't break the whole retrieval
    }
  })

  // Race against a 3-second timeout
  await Promise.race([
    Promise.allSettled(searchPromises),
    new Promise<void>((r) => setTimeout(r, 3000)),
  ])

  // Rank files by score, take top 4
  const ranked = Array.from(fileScores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)

  // Read relevant portions of top files
  const snippets: RetrievedSnippet[] = []

  await Promise.allSettled(
    ranked.map(async (entry) => {
      try {
        // Defensive: `entry.relativePath` normally comes from the ripgrep
        // search result and is genuinely workspace-relative. If any producer
        // ever emits an already-absolute path, this helper leaves it intact
        // instead of producing `C:\ws\C:\...` which would fail on Windows.
        const fullPath = toWorkspaceAbsoluteFilePath(entry.relativePath, workspacePath)
        const content = await readFile(fullPath)
        const allLines = content.split('\n')

        // Expand around match lines to provide context (±5 lines)
        const targetLines = new Set<number>()
        for (const lineNum of entry.matchLines.keys()) {
          for (let i = Math.max(0, lineNum - 6); i <= Math.min(allLines.length - 1, lineNum + 4); i++) {
            targetLines.add(i)
          }
        }

        // Group into contiguous ranges
        const sortedLines = Array.from(targetLines).sort((a, b) => a - b)
        const ranges: Array<[number, number]> = []
        let rangeStart = sortedLines[0]
        let rangeEnd = sortedLines[0]

        for (let i = 1; i < sortedLines.length; i++) {
          if (sortedLines[i] <= rangeEnd + 2) {
            rangeEnd = sortedLines[i]
          } else {
            ranges.push([rangeStart, rangeEnd])
            rangeStart = sortedLines[i]
            rangeEnd = sortedLines[i]
          }
        }
        if (sortedLines.length > 0) {
          ranges.push([rangeStart, rangeEnd])
        }

        // Build snippet text (max ~80 lines total per file)
        let totalLines = 0
        const parts: string[] = []
        for (const [start, end] of ranges) {
          if (totalLines >= 80) break
          const slice = allLines.slice(start, end + 1)
          totalLines += slice.length
          const numbered = slice.map((line, i) => `${start + i + 1} | ${line}`).join('\n')
          parts.push(numbered)
        }

        if (parts.length > 0) {
          snippets.push({
            filePath: fullPath,
            relativePath: entry.relativePath,
            lines: parts.join('\n...\n'),
            matchCount: entry.matchLines.size,
          })
        }
      } catch {
        // File read failure is non-fatal
      }
    }),
  )

  // Sort snippets by match count descending
  snippets.sort((a, b) => b.matchCount - a.matchCount)

  return {
    snippets,
    searchTerms,
    durationMs: Date.now() - start,
  }
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}
