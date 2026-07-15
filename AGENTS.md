# Repository Guidance for AI Agents

This project is an Electron + React + TypeScript IDE. Before you run anything, read this file so you pick the right command.

## Stack at a glance

- **Renderer**: React 19 + Vite + Monaco editor (`src/`)
- **Main / preload / worker**: Electron main process (`electron/`) — bundled by `vite-plugin-electron`
- **Language servers**: shipped under `bundled-lsp/node_modules/` (pyright, typescript-language-server, vscode-langservers-extracted)
- **Vector model**: bge-m3 ONNX bundled under `resources/embeddings/bge-m3/`
- Node ≥ 20, uses TypeScript **Project References** (`tsconfig.json` is a solution dispatcher).

## Canonical commands (always prefer these over raw tools)

| Task | Command | Notes |
|---|---|---|
| **Typecheck** | `npm run typecheck` | Equivalent to `tsc -b`. Bare `tsc` will fail with hundreds of bogus errors — see below. |
| **Lint** | `npm run lint` | ESLint flat config in `eslint.config.js`. |
| **Dev** (Electron hot reload) | `npm run electron:dev` | Starts Vite dev server and auto-launches Electron. |
| **Build renderer + main only** | `npm run build` | No installer, just `dist/` + `dist-electron/`. |
| **Full packaged app** | `npm run electron:build` | Cleans, reinstalls bundled LSPs, runs `vite build`, then `electron-builder`. Outputs to `release/`. |
| **Unit tests** | `npx vitest run [file]` | Vitest 4, see `vitest.config.ts`. Use `npx vitest run path/to/foo.test.ts` to run a single file. |
| **E2E build** | `npm run build:e2e` | Vite build with `VITE_E2E_HOOKS=1` so `src/e2e/testHooks.ts` is bundled. Required before E2E tests. |
| **E2E tests** | `npm run test:e2e` | Builds with E2E hooks then runs Playwright in Electron mode. See `e2e/fork-team-ui.spec.ts`. |
| **Install bundled LSPs** | `npm run bundled-lsp:install` | Only needed before packaging — dev already reads from `bundled-lsp/node_modules/`. |

## Why bare `tsc` fails in this repo

`tsconfig.json` at the repo root has `"files": []` and only `references`. That's the TypeScript "solution" pattern. It works **only** with `tsc -b` / `tsc --build`.

If you run `tsc` (no flags) or `npx tsc --noEmit`, TypeScript falls back to its built-in defaults (`target: ES3`, no `jsx`, no `esModuleInterop`, no `skipLibCheck`, no `lib`) and scans `src/` + transitively-imported `node_modules/**/*.d.ts`. You will see a flood of `TS17004` (no JSX flag), `TS1259` (no esModuleInterop), `TS2802` (Set/Map iteration), `TS1343` (import.meta), plus errors inside `monaco-editor` and `zod` .d.ts files.

**Don't**: `tsc`, `npx tsc`, `tsc --noEmit`, `tsc src/App.tsx`

**Do**: `npm run typecheck` (preferred) or `npx tsc -b` (equivalent)

If you need to typecheck a single project only:

- Renderer only: `npx tsc -b tsconfig.app.json`
- Electron only: `npx tsc -b tsconfig.electron.json`

## Running single tests

`vitest` config is at `vitest.config.ts`. Examples:

```bash
npx vitest run electron/tools/fileToolValidation.test.ts
npx vitest run electron/agents                     # runs every *.test.ts under electron/agents/
npx vitest run --reporter=verbose electron/lsp
```

Don't use `npm test` — this repo doesn't define one.

## Running E2E tests (`e2e/fork-team-ui.spec.ts`)

E2E uses Playwright in **Electron mode** — it launches the real packaged app
window from `dist-electron/main.js`. To make UI state injectable from tests
without polluting production, the renderer conditionally mounts
`window.__e2eInject*` helpers when built with `VITE_E2E_HOOKS=1` (see
`src/e2e/testHooks.ts` and the guard at the top of `src/main.tsx`).

```bash
# One-shot: build with hooks then run all E2E tests
npm run test:e2e

# Forward args to playwright (filter, list, etc.)
npm run test:e2e -- -g "U-01"
npm run test:e2e -- --reporter=list

# Just rebuild dist with hooks (skip Playwright)
npm run build:e2e

# Or run Playwright directly against an existing E2E build
npx playwright test e2e/fork-team-ui.spec.ts -g "U-18"
```

Important notes:

- **A real Electron window pops up** (Playwright Electron mode does not
  support headless). Iterate on a machine where that's acceptable.
- **First test of the suite presses `Ctrl+L`** to open the AI chat panel —
  the renderer boots into the welcome page otherwise and no chat surface
  is mounted.
- **Tests that assert on AgentBlock body content (output / todos /
  structured summary) must call `expandAgentBlock(agentId)` first** —
  `ActivityRow` defaults to collapsed and only renders its body when
  expanded. See helper in `e2e/fork-team-ui.spec.ts`.
- **Skipped (`test.fixme`) tests carry a FIXME comment** explaining why
  they're not yet implemented (typically: missing inject hook, or
  RunningAgents IPC mock needed).
- **The 0.73 kB `testHooks` chunk only ships in E2E builds** —
  `import.meta.env.VITE_E2E_HOOKS` is read at build time and tree-shaken
  out otherwise. Production / dev builds carry zero E2E baggage.

## Important conventions

- **Never edit compiled output**. `dist/`, `dist-electron/`, `release/` are generated.
- **Don't run dev servers unattended**. `npm run electron:dev` launches a GUI window.
- **Prefer `Edit` over `Write`** when modifying existing files; `Write` replaces the whole file.
- **Never commit**: `.env`, `credentials.json`, built artifacts, or `node_modules/`.
- **Agents in `electron/agents/`**: each agent has `maxTurns` and a `tools` whitelist. Respect them — tools not in the whitelist are stripped before the model sees them.
- **Session-memory-internal agent** runs under a hard sandbox — see `electron/tools/fileToolValidation.ts#gateSessionMemoryInternalAgentToolUse`. It can ONLY touch `~/.claude/session-memory/*.md`.

## Packaging checklist

Before `npm run electron:build`, make sure:

1. `bundled-lsp/node_modules/` exists (`npm run bundled-lsp:install` repopulates it).
2. `bundled-mcp/node_modules/` exists (`npm run bundled-mcp:install` repopulates it) — ships to `resources/node_modules` so MCP `npx` presets work on machines without Node (see `electron/mcp/transport.ts#resolvePackagedNpxStdio`). Keep `bundled-mcp/package.json` in sync with `MCP_PRESETS` (enforced by `electron/packagingConsistency.test.ts`).
3. `resources/embeddings/bge-m3/` has `model.onnx` (~570 MB) + `tokenizer.json` + `config.json`.
4. `electron-builder.json` `extraResources` maps these directories into the installer.
5. All files are valid UTF-8 — rolldown rejects mixed-encoding files. If you ever see `stream did not contain valid UTF-8`, scan for GBK bytes `0xA1 0xAA` that should be the UTF-8 em dash `0xE2 0x80 0x94`.

`npm run electron:build` runs `scripts/assertPackagingAssets.mjs` right before `electron-builder` and aborts loudly when any of the above (or a worker bundle like `dist-electron/hookLlmWorkerEntry.js`) is missing.

When adding a package to the electron externals: edit `viteElectronExternals.ts` (single source of truth, imported by `vite.config.ts`) **and** the `files` / `asarUnpack` lists in `electron-builder.json` — `electron/packagingConsistency.test.ts` fails otherwise.

## Key directories

```
electron/
  ai/                       LLM client + streaming + agentic loop
                            (agenticLoop.ts is a façade; phase modules in agenticLoop/)
  agents/                   Agent definitions, sub-agent runner, fork logic
                            (subAgent* family, teammate, team, coordinator, multiAgent)
  orchestration/            OrchestrationKernel + ports + session reducer
                            (always wraps runAgenticLoop; PrepareContext +
                             CallModel + Terminal phases extracted to phases/;
                             toolRuntime/ holds PolicyEngine + scheduler +
                             cross-agent history + quota + state tracker)
  embedding/                ONNX local embeddings + vector store + workspace index
  lsp/                      Language server launcher + pre-warm + diagnostics hub
  mcp/                      MCP server manager + transport
  memory/                   Persistent user memory + recall
  context/                  Context window mgmt + compact + token budget
  session/                  Per-session notes + session-memory extract fork
  conversation/             Chat transcript persistence (JSON-on-disk per workspace)
  skills/                   SKILL.md discovery, registry, model overrides
  tools/                    Tool registry + per-tool handlers + permission gates
  tools/workerProcess/      utilityProcess host + RPC + executors (tool isolation)
  ipc/                      Aggregated IPC handlers + validatedHandle (Zod) +
                            input sanitizer + schemas; sits alongside the older
                            `electron/<domain>/handlers.ts` pattern that
                            still owns fs/mcp/memory/context/session/conversation/
                            buddy/skills/lsp/telemetry/plugins/diff/diagnostics.
  lifecycle/                appBootstrap.ts (app.whenReady orchestration) +
                            appShutdown.ts (before-quit / activate / quit)
  settings/                 Disk settings store + secrets-at-rest + worker
                            disk-settings snapshot bridge
  security/                 Workspace trust + path sandbox + tool/MCP policies
  events/                   EventDrivenNetwork (TaskManager → lifecycleEventBus)
  diff/                     DiffTransaction subsystem (WAL + stale watcher +
                            undo queue + IPC + intents)
  indexing/                 IndexerManager (cancel + state over workspaceIndex)
  diagnostics/              DiagnosticsHub (LSP + Monaco markers) + ipcBridge
  attachments/              Image / PDF / Office / text ingest + cache
  buddy/                    Companion sprite + state + prompt injection
  telemetry/                Context + provider-error ring buffer + NDJSON
  plugins/                  MCPB install + marketplace + plugin policies
  autocomplete/             Tab completion backend (FIM/chat → streamText)
  window/                   Single mainWindow lifecycle
  fs/ git/ terminal/        Renderer-facing FS/Git/PTY IPC (sandbox-gated)
  paths/                    Bundle data root + Chromium cache health
  logging/                  Bundled main.log + console mirror
  preload/                  Per-domain `build*Api` modules composed by preload.ts
src/
  components/               React UI (TitleBar, Sidebar, AIChat, Editor, Terminal, Settings, …)
  stores/                   Zustand stores (chat slices + routers, settings slices, …)
  services/                 Renderer-side helpers (path, diff, monaco bridges, electronAPI wrap)
resources/
  embeddings/               Bundled ONNX models (bge-m3 at present)
bundled-lsp/
  node_modules/             Pre-installed language servers (shipped via extraResources)
```

## Tool process model

Tool execution can run in one of two processes, selected by the `runIn`
field on the `Tool` definition and `isToolWorkerDispatchEnabled()` in
`electron/tools/workerProcess/toolWorkerEnv.ts` (also re-exported from
`electron/tools/registry.ts`):

- `runIn: 'main'` (default) — `tool.execute()` runs in the Electron
  main process. Direct access to `readFileState`, `fileLock`,
  `writeIntegrityGuard`, hooks, PermissionManager, MCP transport.
- `runIn: 'worker'` — the registry forwards the call to an isolated
  `utilityProcess` when tool-worker dispatch is enabled. **Packaged
  builds default ON** (`app.isPackaged`); **dev defaults OFF** unless you
  set `ASTRA_TOOL_WORKER=1` (set `ASTRA_TOOL_WORKER=0` to force
  off in production). Host: `electron/tools/workerProcess/toolWorkerHost.ts`.
  The worker imports the same `toolReadFile` / `toolGrep` / … modules; the
  workspace path is applied from `tool_init`, and merged settings are
  pushed on every RPC (`diskSettingsSnapshot`) plus after settings saves
  so keys like WebSearch stay aligned.

Crash semantics: when the utilityProcess exits unexpectedly, every
in-flight RPC resolves with `{success:false, error:'tool worker
crashed: …', toolErrorClass:'worker_crashed'}` and the next dispatch
spawns a fresh worker. The agentic loop treats this the same as any
other tool error — no special recovery path needed.

Tagged tools (phase 2 + 3): `read_file`, `glob`, `grep`, `web_fetch`,
`WebSearch`, `write_file`, `edit_file`, `multi_edit_file`. The `bash`
and `PowerShell` executors are registered but their tool definitions
intentionally stay on `runIn: 'main'` until stdout-stream IPC and PID
handoff (for `ShellTaskManager`) are designed.

The sub-agent worker (`electron/agents/subAgentWorker.ts`) runs its
tools in-thread inside `worker_threads`, NOT through the
utilityProcess. It shares the executor implementations via
`electron/tools/workerProcess/executors.ts` (phase 5 dedup) so there
is only one body per tool to maintain.

## When in doubt

- Build / install / package issues → read `package.json` scripts + `electron-builder.json`.
- TypeScript / JSX / import errors when running tools → you probably forgot `-b`.
- "工具加载失败" / tools not loading → check the agent's `tools` whitelist in `electron/agents/builtInAgents.ts`; some agents intentionally restrict tool access.
