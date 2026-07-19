import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import electron, { type ElectronOptions } from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { isElectronExternal } from './viteElectronExternals.ts'

/**
 * Rewrite static `import { ... } from 'electron'` statements in
 * worker_threads bundles into a lazy, try/catch-guarded require. This
 * is the only reliable place to do it — `vite-plugin-electron`
 * unconditionally externalizes `'electron'` for every entry it builds
 * (see `node_modules/vite-plugin-electron/dist/index.mjs#withExternalBuiltins`),
 * so neither `resolve.alias` nor a plugin `resolveId` hook can swap
 * the module: the external check fires before plugin resolution.
 *
 * Background — why workers can't load `electron`:
 *   In a packaged Electron build, `worker_threads.Worker` cannot
 *   resolve `require('electron')`. The `electron` npm package is a
 *   build-time-only dep that is *not* shipped to production
 *   `node_modules`, and Electron's main-process module-loader
 *   monkey-patch is not propagated into worker contexts. A bundled
 *   chunk's top-level `let S = require('electron')` (the lowered form
 *   of `import { app } from 'electron'`) therefore throws
 *   `Cannot find module 'electron'` before the worker's
 *   `parentPort.on(...)` handler ever registers, killing the worker
 *   on launch.
 *
 *   Every site in the worker chain that actually calls into Electron
 *   APIs (telemetry dir, tool-result dir, BrowserWindow notify, LSP
 *   `app.getPath('userData')`, etc.) is already invoked from inside a
 *   function — typically already guarded by a try/catch, but at
 *   minimum tolerant of `app === undefined`. Replacing the static
 *   import with `const { app } = (() => { try { return
 *   require('electron') } catch { return {} } })()` lets the worker
 *   load cleanly; the lazy require still tries the real module at
 *   call time (so dev mode keeps working when Electron *does* expose
 *   it) but degrades to an empty namespace in packaged worker
 *   contexts where the require throws.
 */
const STATIC_ELECTRON_IMPORT_RE =
  /^[ \t]*import[ \t]+(\{[^}]*\})[ \t]+from[ \t]+['"]electron['"][ \t]*;?[ \t]*$/gm

function rewriteStaticElectronImport(specifierGroup: string): string {
  // Strip inline `type X` entries (TypeScript erases those at compile
  // time anyway, but this transform runs on the raw .ts source before
  // ts-erasure, so we must drop them ourselves).
  const names = specifierGroup
    .replace(/^[\s{]+|[\s}]+$/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('type '))
  if (names.length === 0) {
    // Nothing to bind at runtime — drop the import entirely.
    return ''
  }
  // Plain JS — the surrounding source is `.ts`, but rolldown's TS
  // transform happens *after* this `enforce: 'pre'` plugin runs, so
  // emitting JS with no type annotations is safest. The `?? {}` fallback
  // keeps each named binding `undefined` when the require throws.
  return `const __astraElectronWorkerStub__ = (() => { try { return require('electron') } catch { return {} } })(); const { ${names.join(', ')} } = __astraElectronWorkerStub__;`
}

function workerElectronStubPlugin(): Plugin {
  return {
    name: 'astra:worker-electron-stub',
    enforce: 'pre',
    transform(code, id) {
      // Only process .ts/.tsx source files (skip node_modules, css, etc.).
      if (!/\.(?:ts|tsx)$/.test(id) || id.includes('node_modules')) return null
      if (!code.includes("'electron'") && !code.includes('"electron"')) return null
      let changed = false
      const newCode = code.replace(STATIC_ELECTRON_IMPORT_RE, (_match, specifiers: string) => {
        changed = true
        return rewriteStaticElectronImport(specifiers)
      })
      if (!changed) return null
      return { code: newCode, map: null }
    },
  }
}

// Per-entry vite config slice that lazifies `electron` imports.
const workerElectronStub = {
  plugins: [workerElectronStubPlugin()],
}

function isWindowsTaskkillProcessMissingError(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  const err = error as { message?: unknown; stderr?: unknown }
  const message = [
    typeof err?.message === 'string' ? err.message : String(error),
    Buffer.isBuffer(err?.stderr) ? err.stderr.toString('utf8') : '',
    typeof err?.stderr === 'string' ? err.stderr : '',
  ].join('\n')
  return message.includes('taskkill') && message.includes('not found')
}

const safeElectronDevOnStart: ElectronOptions['onstart'] = async ({ startup }) => {
  try {
    await startup()
  } catch (error) {
    if (!isWindowsTaskkillProcessMissingError(error)) throw error
    console.warn(
      '[vite] Previous Electron dev process was already gone during restart; starting a fresh app.',
    )
    ;(process as typeof process & { electronApp?: unknown }).electronApp = undefined
    await startup()
  }
}

function withSafeElectronDevStartup(
  entries: ReadonlyArray<ElectronOptions>,
): ElectronOptions[] {
  return entries.map((entry) => ({
    ...entry,
    onstart: safeElectronDevOnStart,
  }))
}

export default defineConfig({
  server: {
    open: false,
    // 让 Vite 启动瞬间就在后台 transform 首屏 shell 文件，
    // 避免 Electron 窗口打开后浏览器才串行 fetch + transform 全链路。
    // Dev 模式下这是把"4 秒空白"压下去最直接的手段。
    warmup: {
      clientFiles: [
        './index.html',
        './src/main.tsx',
        './src/App.tsx',
        './src/configureMonaco.ts',
        './src/components/TitleBar/**/*.tsx',
        './src/components/ActivityBar/**/*.tsx',
        './src/components/Sidebar/Sidebar.tsx',
        './src/components/Sidebar/FileTree.tsx',
        './src/components/StatusBar/**/*.tsx',
        './src/components/Editor/EditorShell.tsx',
        './src/components/Editor/EditorWelcome.tsx',
        './src/stores/useLayoutStore.ts',
        './src/stores/useSettingsStore.ts',
        './src/stores/useWorkspaceStore.ts',
        './src/stores/useFileStore.ts',
        './src/stores/useDiagnosticStore.ts',
        './src/context/MCPConnectionContext.tsx',
      ],
    },
  },
  // 显式把首屏 shell 涉及的 node_modules 塞进 depsOptimize 入口，确保冷启动
  // 时 Vite 一次性批量预打包，而不是按请求逐包懒优化再中断服务器流。
  optimizeDeps: {
    entries: ['./index.html', './src/main.tsx'],
    include: [
      'react',
      'react-dom/client',
      'zustand',
      'lucide-react',
    ],
    // 主进程专用的大型 SDK 不应被 renderer 的 depsOptimize 扫到；这里显式排除
    // 作为保险（即使 renderer 没 import，某些 plugin 扫描路径也可能误拉进来）。
    exclude: [
      '@anthropic-ai/sdk',
      '@anthropic-ai/bedrock-sdk',
      '@anthropic-ai/vertex-sdk',
      '@anthropic-ai/foundry-sdk',
      '@anthropic-ai/sandbox-runtime',
      '@google/generative-ai',
      '@modelcontextprotocol/sdk',
      'openai',
      'chokidar',
      'simple-git',
      'node-pty',
      'sharp',
      'adm-zip',
      'vscode-jsonrpc',
      'vscode-languageserver-protocol',
      'vscode-languageserver-types',
    ],
  },
  plugins: [
    react(),
    electron(withSafeElectronDevStartup([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            rollupOptions: {
              // Per-package rationale + electron-builder shipping contract:
              // see viteElectronExternals.ts (enforced by
              // electron/packagingConsistency.test.ts).
              external: isElectronExternal,
            },
          },
          define: {
            'import.meta.dirname': '__dirname',
          },
        },
      },
      {
        entry: 'electron/preload.ts',
      },
      {
        // Dedicated embedding worker. Runs transformers.js + ONNX Runtime
        // off the main process event loop so the UI doesn't freeze during
        // long index builds. Must use the same native-module externals as
        // the main bundle — worker_threads share the same node_modules.
        entry: 'electron/embedding/embeddingWorker.ts',
        vite: {
          build: {
            rollupOptions: {
              external: isElectronExternal,
            },
          },
          define: {
            'import.meta.dirname': '__dirname',
          },
        },
      },
      {
        // Memory consolidation worker (P3). Runs the 5-pass dedup/prune/compress
        // pipeline in a dedicated worker_threads process so the Electron main
        // process event loop stays free.
        entry: 'electron/memory/memoryWorker.ts',
        vite: {
          build: {
            rollupOptions: {
              external: isElectronExternal,
            },
          },
          define: {
            'import.meta.dirname': '__dirname',
          },
        },
      },
      {
        // Cron scheduler worker (P4). Runs the 1-second poll loop, cron
        // expression parsing, file store management, jitter, and missed-task
        // detection in a dedicated worker_threads process.
        entry: 'electron/tools/cronWorker.ts',
        vite: {
          build: {
            rollupOptions: {
              external: isElectronExternal,
            },
          },
          define: {
            'import.meta.dirname': '__dirname',
          },
        },
      },
      {
        // Sub-agent worker (P5). Runs sub-agents in an isolated worker_threads
        // process with local tool execution (Read/Glob/Grep/Bash/WebFetch/WebSearch)
        // and RPC delegation for main-process-only tools (Agent, MCP, etc.).
        entry: 'electron/agents/subAgentWorker.ts',
        vite: {
          ...workerElectronStub,
          build: {
            rollupOptions: {
              external: isElectronExternal,
            },
          },
          define: {
            'import.meta.dirname': '__dirname',
          },
        },
      },
      {
        // Bridge session worker (P1-A). Runs `runAgenticLoopAsync` in an
        // isolated worker_threads process so a runaway sub-agent / native
        // tool crash can't take down the Electron main process. Same
        // native-module externals as the main bundle (the worker shares
        // node_modules with main).
        entry: 'electron/bridge/sessionWorker.ts',
        vite: {
          ...workerElectronStub,
          build: {
            rollupOptions: {
              external: isElectronExternal,
            },
          },
          define: {
            'import.meta.dirname': '__dirname',
          },
        },
      },
      {
        // Prompt/agent hook LLM subprocess (§9.2). Spawned as
        // Electron-as-Node (`ELECTRON_RUN_AS_NODE=1`) by
        // `electron/tools/hooks/hookLlmSubprocess.ts`, which looks for
        // `dist-electron/hookLlmWorkerEntry.js` next to `main.js` and
        // silently falls back to in-process execution when the bundle is
        // missing — this entry is what makes the subprocess isolation
        // actually exist in built apps. Needs `workerElectronStub`
        // because its import chain (hookLlmExecution → toolRegistry →
        // settings/…) contains static `import from 'electron'` sites
        // that would throw under plain-Node execution.
        entry: 'electron/tools/hooks/hookLlmWorkerEntry.ts',
        vite: {
          ...workerElectronStub,
          build: {
            rollupOptions: {
              external: isElectronExternal,
            },
          },
          define: {
            'import.meta.dirname': '__dirname',
          },
        },
      },
      {
        // Tool execution utilityProcess (Phase 1). Hosts pure tool
        // executors (Read/Glob/Grep/WebFetch/WebSearch/Write/Edit/...)
        // in an isolated V8 so destructive tools can't take down the
        // main process. Spawned by `electron/tools/workerProcess/
        // toolWorkerHost.ts`; emitted as `dist-electron/toolWorkerEntry.js`.
        // No `workerElectronStub` here — the entry has no static
        // `import 'electron'` so the lazy-require rewrite isn't needed.
        entry: 'electron/tools/workerProcess/toolWorkerEntry.ts',
        vite: {
          build: {
            rollupOptions: {
              external: isElectronExternal,
            },
          },
          define: {
            'import.meta.dirname': '__dirname',
          },
        },
      },
      {
        // File watcher worker (P1). Runs all chokidar file system watchers
        // in a dedicated worker_threads process so the Electron main process
        // event loop stays responsive. Shared by workspace-index, skills,
        // workspace-explorer, and custom-agents watchers.
        entry: 'electron/watchers/fileWatcherWorker.ts',
        vite: {
          build: {
            rollupOptions: {
              external: isElectronExternal,
            },
          },
          define: {
            'import.meta.dirname': '__dirname',
          },
        },
      },
    ])),
    renderer(),
    // `vite-plugin-electron-renderer@0.14.6` still injects the Rollup-era
    // `output.freeze = false` option to work around its Object.freeze of ESM
    // namespace imports. rolldown-vite (Vite 8+) dropped that option and its
    // schema validator prints:
    //   Warning: Invalid output options (1 issue found)
    //   - For the "freeze". Invalid key: Expected never but received "freeze".
    // The warning is cosmetic — the build still succeeds — but noisy in CI
    // logs. Strip the key after the renderer plugin has had its say. This
    // plugin is safe to remove once upstream ships a rolldown-aware release.
    {
      name: 'astra:strip-rollup-legacy-freeze',
      enforce: 'post',
      config(config) {
        const out = config?.build?.rollupOptions?.output
        if (!out) return
        const strip = (o: unknown): void => {
          if (o && typeof o === 'object') {
            delete (o as Record<string, unknown>).freeze
          }
        }
        if (Array.isArray(out)) out.forEach(strip)
        else strip(out)
      },
    },
  ],
})
