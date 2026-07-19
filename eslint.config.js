import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // `dist` / `dist-electron` — build outputs.
  // `.claude/worktrees` — git worktree snapshots checked in by the AI agent
  //   scaffolding; linting them double-counts every issue in the live tree
  //   and also ties rule changes to stale source copies that no human edits.
  // `release` — electron-builder artefacts.
  // `bundled-lsp` — vendored LSP binaries + their install cache.
  // `node_modules` — ignored by default but listed for clarity.
  globalIgnores([
    'dist',
    'dist-electron',
    '.claude/worktrees',
    'release',
    'bundled-lsp',
    'node_modules',
    // `adapters` — standalone Bun IM-adapter package with its own toolchain
    // (bun-types, separate tsconfig). Linting it with the app's flat config
    // floods errors over Bun globals it doesn't share.
    'adapters',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Leading underscore → intentionally unused (catches TS's `_` convention
      // for destructured-but-ignored values, IPC handler signature parameters,
      // and similar "documented on purpose" dead names). Matches the pattern
      // already in use across `src/` (e.g. `_state`, `_dropDraft`) and keeps
      // `tsconfig.*.json noUnusedParameters: false` intent in sync.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // Component files may legitimately co-locate a handful of constants
      // (type tokens, lookup maps) next to the component. The default rule
      // breaks HMR for those files without affecting runtime correctness,
      // so we allow constant + type exports and restrict the hard failure
      // to mixed `function` / `class` helpers, which is the real HMR
      // hazard. Set `allowExportNames` to cover React-patterned named
      // exports that are not components (e.g. `action`, `loader` in file
      // based routers) should the project adopt them later.
      'react-refresh/only-export-components': [
        'error',
        { allowConstantExport: true },
      ],
      // React Compiler suggestion, not a runtime bug — downgrading to
      // `warn` keeps it visible in editors while unblocking CI. Fix the
      // underlying pattern when convenient, don't let it gate the merge.
      'react-hooks/preserve-manual-memoization': 'warn',
    },
  },
])
