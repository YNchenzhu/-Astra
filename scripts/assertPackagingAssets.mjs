#!/usr/bin/env node
/**
 * Pre-electron-builder gate: fail the packaging run loudly when a runtime
 * asset is missing, instead of letting electron-builder silently ship an
 * installer with dead features (missing embeddings → no local index, missing
 * bundled-lsp → no TS/Python LSP, missing worker bundles → silent fallbacks).
 *
 * Runs as `npm run assert-packaging-assets` inside the `electron:build`
 * chain, after `vite build` + `build:adapter`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

function requireFile(rel, why) {
  const p = path.join(root, rel)
  if (!fs.existsSync(p)) problems.push(`missing ${rel} — ${why}`)
}

function requireDir(rel, why) {
  const p = path.join(root, rel)
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
    problems.push(`missing directory ${rel} — ${why}`)
  }
}

// ── Renderer + main bundles ──
requireFile('dist/index.html', 'renderer bundle (vite build)')
requireFile('dist-electron/main.js', 'electron main bundle')
requireFile('dist-electron/preload.js', 'preload bundle')

// Worker / subprocess entries spawned by path at runtime. If one of these
// is dropped from vite.config.ts the app "works" in dev-ish smoke tests but
// the corresponding subsystem silently degrades in production.
for (const worker of [
  'embeddingWorker.js',
  'memoryWorker.js',
  'cronWorker.js',
  'subAgentWorker.js',
  'sessionWorker.js',
  'toolWorkerEntry.js',
  'fileWatcherWorker.js',
  'hookLlmWorkerEntry.js',
]) {
  requireFile(`dist-electron/${worker}`, 'worker entry (vite.config.ts electron entries)')
}

// ── extraResources sources ──
for (const pkg of ['pyright', 'typescript-language-server', 'vscode-langservers-extracted']) {
  requireFile(`bundled-lsp/node_modules/${pkg}/package.json`, 'bundled LSP (npm run bundled-lsp:install)')
}

// bundled-mcp: every dependency declared in bundled-mcp/package.json must be
// installed — these back the packaged-npx rewrite in electron/mcp/transport.ts.
const bundledMcpManifest = path.join(root, 'bundled-mcp', 'package.json')
if (!fs.existsSync(bundledMcpManifest)) {
  problems.push('missing bundled-mcp/package.json — MCP preset vendoring manifest')
} else {
  const deps = Object.keys(JSON.parse(fs.readFileSync(bundledMcpManifest, 'utf8')).dependencies ?? {})
  for (const pkg of deps) {
    requireFile(`bundled-mcp/node_modules/${pkg}/package.json`, 'bundled MCP preset (npm run bundled-mcp:install)')
  }
}

requireFile('resources/embeddings/bge-m3/model.onnx', 'local embedding model (~570 MB, not in git — copy it in before packaging)')
requireFile('resources/embeddings/bge-m3/tokenizer.json', 'embedding tokenizer')
requireFile('resources/embeddings/bge-m3/config.json', 'embedding model config')

requireFile('dist-adapter/wechat-adapter.cjs', 'WeChat sidecar (npm run build:adapter)')
requireDir('electron/agents/bundles/presets', 'bundle presets (extraResources)')

// ── Shipped node_modules that are resolved at runtime ──
const rgPlatformPkg = `@vscode/ripgrep-${process.platform}-${process.arch}`
const rgBin = process.platform === 'win32' ? 'rg.exe' : 'rg'
requireFile(`node_modules/${rgPlatformPkg}/bin/${rgBin}`, 'bundled ripgrep binary (npm install)')

if (problems.length > 0) {
  console.error('[assert-packaging-assets] packaging aborted, missing assets:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('[assert-packaging-assets] OK — all runtime assets present')
