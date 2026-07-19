#!/usr/bin/env node
/**
 * Cross-platform launcher for `vite build` with the VITE_E2E_HOOKS env flag set.
 *
 * The flag is read by `src/main.tsx` to conditionally import
 * `src/e2e/testHooks.ts`, which mounts `window.__e2e*` injection helpers used
 * by the Playwright Electron tests in `e2e/`. The hooks file is otherwise
 * tree-shaken out of dev / production builds.
 *
 * Usage: npm run build:e2e
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const result = spawnSync(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), 'build'], {
  stdio: 'inherit',
  shell: false,
  env: { ...process.env, VITE_E2E_HOOKS: '1' },
})

process.exit(result.status ?? 1)
