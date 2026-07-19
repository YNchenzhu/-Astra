/**
 * Hand-crafted Tool Use Examples for the highest-value built-in tools.
 *
 * Why these tools: `edit_file`, `grep`, `write_file`, `bash`/`powershell`, and
 * `TodoWrite` are the five tools where the loop guard
 * ({@link createToolCallHistory}) historically records the most `consecutive
 * failures`. The Anthropic "Advanced tool use" report (2025-11-24) shows a 72%
 * → 90% jump in complex parameter accuracy when examples are attached to
 * tools like these.
 *
 * On the `anthropic` wire (+ eligible model) these examples are emitted
 * verbatim as `input_examples`. On every other wire, the sanitizer folds them
 * into the tool description (see
 * {@link renderExamplesAsDescriptionAppendix}) so the accuracy bump still
 * applies even against OpenAI / Gemini / Zhipu / Kimi / DeepSeek endpoints.
 *
 * Curation principles (from Anthropic best practices):
 *   - realistic data (real paths, real flag combinations — never `"foo"`)
 *   - 1–5 per tool covering minimal / typical / full-spec shapes
 *   - focus on patterns the schema alone cannot express
 *   - NO destructive examples (nothing that would mutate the workspace)
 */

/**
 * Canonical examples keyed by primary tool name. Keys must match
 * {@link Tool.name} exactly — the registry looks them up by identity.
 *
 * Each example value MUST structurally satisfy the tool's `input_schema`
 * (Anthropic enforces this at request time when emitted natively).
 */
export const BUILTIN_TOOL_EXAMPLES: Readonly<
  Record<string, ReadonlyArray<Record<string, unknown>>>
> = {
  // ── Filesystem ──────────────────────────────────────────────────────

  read_file: [
    // Typical: read a whole source file.
    { filePath: 'src/index.ts' },
    // Line-window read on a large generated file — prefer window over bumping maxSizeBytes.
    { filePath: 'docs/reference/api.md', offset: 400, limit: 200 },
    // Absolute path (Windows + POSIX both supported).
    { filePath: 'C:/Users/me/project/package.json' },
  ],

  edit_file: [
    // Small localised replacement (most common shape).
    {
      filePath: 'src/utils/logger.ts',
      oldString: 'console.log(message)',
      newString: 'logger.info(message)',
    },
    // Multi-line replacement with extra surrounding context for uniqueness.
    {
      filePath: 'src/server.ts',
      oldString:
        "app.listen(port, () => {\n  console.log(`listening on ${port}`)\n})",
      newString:
        "app.listen(port, '0.0.0.0', () => {\n  logger.info(`listening on ${port}`)\n})",
    },
    // Rename every occurrence (must pass replace_all: true — otherwise the
    // tool errors out when old_string appears more than once).
    {
      filePath: 'src/types.ts',
      oldString: 'OldTypeName',
      newString: 'NewTypeName',
      replaceAll: true,
    },
  ],

  write_file: [
    // Creating a brand-new file (most common shape).
    {
      filePath: '.github/CODEOWNERS',
      content: '* @team/backend\n/packages/web/ @team/frontend\n',
    },
    // Regenerating a generated manifest.
    {
      filePath: 'src/generated/routes.json',
      content: '{\n  "routes": []\n}\n',
    },
  ],

  list_files: [
    // Workspace root.
    { dirPath: '.' },
    // Sub-directory inspection.
    { dirPath: 'src/components' },
  ],

  // ── Search ──────────────────────────────────────────────────────────

  glob: [
    // All TypeScript files in the workspace.
    { pattern: '**/*.ts' },
    // Scoped search — TS + TSX under a sub-tree.
    { pattern: 'src/**/*.{ts,tsx}', maxResults: 200 },
    // Test fixtures with a specific nesting depth.
    { pattern: 'tests/*/fixtures/*.json' },
  ],

  grep: [
    // Default content search.
    { pattern: 'TODO', path: 'src' },
    // File-only listing with a type filter — very common "find where X is used".
    {
      pattern: '\\bfromEnv\\b',
      path: 'src',
      type: 'ts',
      outputMode: 'files_with_matches',
    },
    // Match counts with case-insensitivity for a README sweep.
    {
      pattern: 'deprecated',
      caseInsensitive: true,
      outputMode: 'count',
    },
    // Pagination — skip the first 100 hits, then take the next 50.
    {
      pattern: 'import',
      path: 'src',
      outputMode: 'content',
      offset: 100,
      headLimit: 50,
      context: 1,
    },
    // Multi-line search — use \s when you need a newline.
    {
      pattern: 'struct\\s+Server\\s*\\{[\\s\\S]*?config',
      multiline: true,
      type: 'go',
    },
  ],

  // ── Shell ───────────────────────────────────────────────────────────

  Bash: [
    // Quick filesystem inspection.
    { command: 'ls -la src' },
    // Test run with a reasonable timeout ceiling.
    {
      command: 'npm test --silent',
      description: 'Run unit tests',
      timeoutMs: 120_000,
    },
    // Long-running dev server: background it so the loop doesn't block.
    {
      command: 'npm run dev',
      description: 'Start dev server',
      runInBackground: true,
    },
  ],

  PowerShell: [
    { command: 'Get-ChildItem -Path src -Recurse -Filter *.ts | Measure-Object' },
    {
      command: 'npm test',
      description: 'Run unit tests',
      timeoutMs: 120_000,
    },
  ],

  // ── Orchestration ───────────────────────────────────────────────────

  TodoWrite: [
    // Typical 3-task plan kicked off at the start of a medium task.
    {
      todos: [
        { id: '1', content: 'Inspect current auth flow', status: 'in_progress' },
        { id: '2', content: 'Add JWT refresh endpoint', status: 'pending' },
        { id: '3', content: 'Update tests + docs', status: 'pending' },
      ],
    },
    // Partial update — only the status of one task changes; retain others.
    {
      todos: [
        { id: '1', content: 'Inspect current auth flow', status: 'completed' },
        { id: '2', content: 'Add JWT refresh endpoint', status: 'in_progress' },
        { id: '3', content: 'Update tests + docs', status: 'pending' },
      ],
    },
  ],

  // ── User questions ─────────────────────────────────────────────────

  AskUserQuestion: [
    // Single-question, single-select: framework choice.
    {
      questions: [
        {
          id: 'framework',
          prompt: 'Which framework should the new service use?',
          options: [
            { id: 'express', label: 'Express.js' },
            { id: 'fastify', label: 'Fastify' },
            { id: 'hono', label: 'Hono' },
          ],
        },
      ],
    },
    // Multi-question form: one single-select + one multi-select.
    {
      title: 'Project setup',
      questions: [
        {
          id: 'language',
          prompt: 'Primary language?',
          options: [
            { id: 'ts', label: 'TypeScript' },
            { id: 'py', label: 'Python' },
          ],
        },
        {
          id: 'features',
          prompt: 'Which features to include?',
          allow_multiple: true,
          options: [
            { id: 'auth', label: 'Auth' },
            { id: 'db', label: 'Database' },
            { id: 'queue', label: 'Queue' },
            { id: 'telemetry', label: 'Telemetry' },
          ],
        },
      ],
    },
  ],
}

/**
 * Look up examples for a tool by its primary name. Returns `undefined` when
 * no examples are registered (most built-ins have no examples by design).
 */
export function getBuiltinToolExamples(
  name: string,
): ReadonlyArray<Record<string, unknown>> | undefined {
  return BUILTIN_TOOL_EXAMPLES[name]
}
