#!/usr/bin/env node
/**
 * Cross-platform E2E entry: build with E2E hooks then run Playwright.
 *
 * Two stages so the hook flag is baked into the renderer bundle before
 * Playwright launches Electron.
 *
 * Usage:
 *   npm run test:e2e
 *   npm run test:e2e:worker   — same, but with ASTRA_TOOL_WORKER=1 so the
 *     utilityProcess tool-dispatch path (default-ON in packaged builds,
 *     default-OFF in dev) gets exercised before shipping.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// `--tool-worker` is our own flag — strip it before forwarding the rest to
// Playwright and turn it into the env var the app reads.
const args = process.argv.slice(2)
const toolWorkerIdx = args.indexOf('--tool-worker')
if (toolWorkerIdx !== -1) {
  args.splice(toolWorkerIdx, 1)
  process.env.ASTRA_TOOL_WORKER = '1'
  console.log('[e2e] ASTRA_TOOL_WORKER=1 (packaged-style utilityProcess tool dispatch)')
}

// npm on Windows can consume Playwright's short `-g` as npm's own global
// switch even after `--`, leaving only the grep expression in argv. Recover
// that documented invocation without misclassifying a real existing test path.
const hasExplicitGrep = args.some((arg) => arg === '-g' || arg === '--grep')
const npmConsumedShortG = ['1', 'true'].includes(
  String(process.env.npm_config_global ?? '').toLowerCase(),
)
if (
  !hasExplicitGrep &&
  args[0] &&
  !args[0].startsWith('-') &&
  !fs.existsSync(path.resolve(args[0])) &&
  (npmConsumedShortG || args[0].includes('|'))
) {
  args.unshift('--grep')
}

// Execute the installed JavaScript CLIs through the current Node binary.
// This keeps argv structured on Windows; `shell:true` would interpret a grep
// expression such as `orchestration|AgentLoop` as a cmd.exe pipeline.
const SPAWN_OPTS = { stdio: 'inherit', shell: false }
const viteCli = path.resolve('node_modules/vite/bin/vite.js')
const playwrightCli = path.resolve('node_modules/@playwright/test/cli.js')

console.log('[e2e] Building with VITE_E2E_HOOKS=1...')
const build = spawnSync(process.execPath, [viteCli, 'build'], {
  ...SPAWN_OPTS,
  env: { ...process.env, VITE_E2E_HOOKS: '1' },
})
if (build.status !== 0) {
  console.error('[e2e] Build failed; aborting Playwright run.')
  process.exit(build.status ?? 1)
}

console.log('[e2e] Build OK. Launching Playwright...')
const test = spawnSync(process.execPath, [playwrightCli, 'test', ...args], {
  ...SPAWN_OPTS,
  env: process.env,
})
process.exit(test.status ?? 1)
