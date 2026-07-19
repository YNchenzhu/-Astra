/**
 * LSP configuration loader.
 *
 * Merge order (later overrides earlier):
 *   1. User global: `{userData}/lsp-config.json`
 *   2. Workspace:   `{workspace}/.lsp.json`
 *   3. Built-in defaults (only when the command exists on PATH and the scope
 *      name wasn't already taken by one of the JSON files above)
 *
 * After the merge we apply the user's disabled-servers list (from settings,
 * managed through the LSP Servers panel) so toggling a server off surfaces
 * identically to "config was never present".
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ScopedLspServerConfig, LspServerConfig } from './types'
import { getDisabledLspServers } from './disabledServers'
import { getAllSkills } from '../skills/skillTool'
import { bundledLspPackagePresent } from './bundledLspLaunch'

interface LspConfigFile {
  servers?: Record<string, LspServerConfig>
}

/**
 * Load all LSP server configurations from workspace and user directories.
 */
export async function loadLspConfigs(
  workspacePath?: string,
  userDataPath?: string,
): Promise<Record<string, ScopedLspServerConfig>> {
  const allConfigs: Record<string, ScopedLspServerConfig> = {}

  // Skill-scoped `.lsp.json` files live next to each SKILL.md file. We only
  // merge them when a trusted workspace path is set, matching the same gate
  // that `mergeSkillLspConfigs` in the original upstream port used — a
  // bare invocation (no workspace yet) deliberately does not run any
  // language server to avoid spawning subprocesses before workspace trust.
  if (workspacePath?.trim()) {
    mergeSkillLspConfigs(allConfigs, workspacePath.trim())
  }

  if (userDataPath) {
    const userConfigPath = path.join(userDataPath, 'lsp-config.json')
    const userConfigs = loadConfigFile(userConfigPath)
    for (const [name, config] of Object.entries(userConfigs)) {
      allConfigs[name] = { scope: name, ...config }
    }
  }

  if (workspacePath) {
    const workspaceConfigPath = path.join(workspacePath, '.lsp.json')
    const workspaceConfigs = loadConfigFile(workspaceConfigPath)
    for (const [name, config] of Object.entries(workspaceConfigs)) {
      allConfigs[name] = {
        scope: name,
        workspaceFolder: workspacePath,
        ...config,
      }
    }
  }

  addDefaults(allConfigs, workspacePath)

  // User-controlled disable list (managed through the LSP Settings panel).
  // Matches by full scope OR leaf name so future skill-scoped configs (e.g.
  // "skill:foo:typescript") can also be toggled via the same "typescript"
  // switch without duplicating UI.
  const disabled = getDisabledLspServers()
  if (disabled.length > 0) {
    for (const scope of Object.keys(allConfigs)) {
      const leaf = scope.split(':').pop() ?? scope
      if (disabled.includes(scope) || disabled.includes(leaf)) {
        delete allConfigs[scope]
      }
    }
  }

  return allConfigs
}

function loadConfigFile(
  configPath: string,
): Record<string, LspServerConfig> {
  const configs: Record<string, LspServerConfig> = {}

  if (!fs.existsSync(configPath)) return configs

  try {
    const content = fs.readFileSync(configPath, 'utf-8')
    const data: LspConfigFile = JSON.parse(content)

    if (data.servers) {
      for (const [name, config] of Object.entries(data.servers)) {
        if (config.command && config.extensionToLanguage) {
          configs[name] = config
        } else {
          console.warn(
            `[LSP] Skipping invalid server config '${name}': missing 'command' or 'extensionToLanguage'`,
          )
        }
      }
    }
  } catch (error) {
    console.warn(
      `[LSP] Failed to load config from ${configPath}: ${(error as Error).message}`,
    )
  }

  return configs
}

/**
 * Merge `.lsp.json` files that ship alongside loaded skills. Each merged
 * entry uses the scope key `skill:<skillName>:<serverName>` so two skills
 * bringing their own `typescript` LSP don't collide, and the Settings panel
 * can present them as distinct rows. The workspace path propagates down so
 * the server is rooted at the project, not at the skill directory.
 */
function mergeSkillLspConfigs(
  allConfigs: Record<string, ScopedLspServerConfig>,
  workspacePath: string,
): void {
  let skills: ReturnType<typeof getAllSkills>
  try {
    skills = getAllSkills()
  } catch {
    // `getAllSkills()` may throw before the skill system has been initialized
    // (e.g. very early LSP boot). That's expected — skip silently.
    return
  }
  for (const skill of skills) {
    if (!skill.resolvedPath) continue
    const skillDir = path.dirname(skill.resolvedPath)
    const configPath = path.join(skillDir, '.lsp.json')
    if (!fs.existsSync(configPath)) continue
    const servers = loadConfigFile(configPath)
    for (const [serverName, config] of Object.entries(servers)) {
      const scope = `skill:${skill.name}:${serverName}`
      allConfigs[scope] = {
        ...config,
        scope,
        workspaceFolder: workspacePath,
      }
    }
  }
}

/**
 * Add built-in default configurations for common language servers.
 * Only added if the command is available on the system PATH.
 *
 * The `initializationOptions` for `typescript` and `python` are deliberately
 * tuned to match VS Code's own TypeScript + Pylance defaults so the Problems
 * panel accuracy ceiling matches what a user would get in VS Code:
 *
 *   - typescript-language-server:
 *       tsserver.useSyntaxServer = 'never' → always use the semantic server
 *         (the syntax-only server skips project-wide type checks and is the
 *         #1 reason third-party clones under-report errors compared to tsc)
 *       preferences.includePackageJsonAutoImports = 'on' → auto-imports align
 *         with VS Code's default completion behaviour (paves the way for
 *         future Quick Fix / codeAction integrations)
 *       tsserver.maxTsServerMemory = 4096 → match VS Code defaults for medium
 *         repos; otherwise pyright-sized projects trigger OOM restarts
 *
 *   - pyright:
 *       python.analysis.diagnosticMode = 'workspace' → the only way to get
 *         project-wide errors (the out-of-the-box default is 'openFilesOnly',
 *         which is what makes vanilla pyright feel dumber than Pylance)
 *       useLibraryCodeForTypes = true → infer types through third-party libs
 *         (Pylance ships this on; vanilla pyright doesn't)
 *       typeCheckingMode = 'off' → conservative baseline. In vanilla pyright
 *         the default mode is 'basic', which eagerly runs opinionated rules
 *         like `reportArgumentType`, `reportOptionalMemberAccess`,
 *         `reportCallIssue` etc. In a language whose type system is opt-in
 *         (most Python repos don't ship a `pyrightconfig.json` or
 *         `[tool.pyright]` block), surfacing those as errors on every file
 *         scan fills the Problems panel with noise the user's own toolchain
 *         never flagged. Workspaces that DO want strict checking still get
 *         it: `pyrightconfig.json` / `pyproject.toml[tool.pyright]` take
 *         precedence over LSP `initializationOptions` in pyright, so this
 *         'off' default is only a floor, not a ceiling. Users who want to
 *         force basic/strict without a pyright config file can override via
 *         workspace `.lsp.json` (see `loadLspConfigs`).
 *
 *         What still fires in 'off' mode: syntax errors, undefined names
 *         (`reportUndefinedVariable`), unresolved imports
 *         (`reportMissingImports`), invalid type forms — i.e. the errors
 *         that are unambiguous bugs regardless of project conventions.
 */
function addDefaults(
  configs: Record<string, ScopedLspServerConfig>,
  workspacePath?: string,
): void {
  const defaults: Array<{
    name: string
    command: string
    args: string[]
    extensionToLanguage: Record<string, string>
    initializationOptions?: Record<string, unknown>
    /**
     * Name of the npm package under `bundled-lsp/node_modules/` that ships
     * this server. When set, `isCommandAvailable` treats "bundled present"
     * as equivalent to "on PATH", and `LSPServerInstance` launches the
     * bundled script via Electron-as-Node at spawn time.
     */
    bundledPackage?: string
  }> = [
    {
      name: 'typescript',
      command: 'typescript-language-server',
      args: ['--stdio'],
      bundledPackage: 'typescript-language-server',
      extensionToLanguage: {
        '.ts': 'typescript',
        '.tsx': 'typescriptreact',
        '.js': 'javascript',
        '.jsx': 'javascriptreact',
        '.mjs': 'javascript',
        '.cjs': 'javascript',
        '.mts': 'typescript',
        '.cts': 'typescript',
      },
      initializationOptions: {
        hostInfo: 'astra',
        preferences: {
          includePackageJsonAutoImports: 'on',
          includeCompletionsForModuleExports: true,
          includeCompletionsWithInsertText: true,
          allowIncompleteCompletions: true,
        },
        tsserver: {
          useSyntaxServer: 'never',
          maxTsServerMemory: 4096,
          logVerbosity: 'off',
        },
      },
    },
    {
      name: 'python',
      command: 'pyright-langserver',
      args: ['--stdio'],
      bundledPackage: 'pyright',
      extensionToLanguage: {
        '.py': 'python',
        '.pyi': 'python',
      },
      initializationOptions: {
        python: {
          analysis: {
            diagnosticMode: 'workspace',
            useLibraryCodeForTypes: true,
            autoSearchPaths: true,
            autoImportCompletions: true,
            // Conservative default: pyright's built-in 'basic' mode fires
            // opinionated rules (reportArgumentType / reportOptionalMemberAccess
            // / reportCallIssue …) that many Python projects consider noise.
            // Workspaces with `pyrightconfig.json` or
            // `pyproject.toml[tool.pyright]` override this via pyright's
            // own precedence rules, so this floor only applies to
            // unconfigured projects. See the block comment above.
            typeCheckingMode: 'off',
            // Belt-and-suspenders. These rules are the ones users
            // consistently report as "false positives" (they are technically
            // correct per PEP 484 but flagrantly idiomatic in real-world
            // Python). Setting them to 'none' via the per-rule override
            // channel means they stay silenced EVEN WHEN the project's
            // `pyrightconfig.json` bumps `typeCheckingMode` up to basic —
            // project configs can always override these back by naming the
            // rule explicitly at their own level (Pyright precedence: rule
            // settings in the project config win over rule settings from
            // the LSP initialisation channel).
            diagnosticSeverityOverrides: {
              // Arguably the #1 noise source: `d: dict = None` defaults.
              reportArgumentType: 'none',
              // `_prefix` unused variables are conventionally intentional.
              reportUnusedVariable: 'none',
              // Optional/None-related checks that fire constantly on
              // pre-PEP-484 codebases.
              reportOptionalMemberAccess: 'none',
              reportOptionalSubscript: 'none',
              reportOptionalCall: 'none',
              reportOptionalIterable: 'none',
              reportOptionalContextManager: 'none',
              reportOptionalOperand: 'none',
              // Broad "call does not match signature" — frequently wrong
              // when the call site uses **kwargs-passing idioms.
              reportCallIssue: 'none',
              // Untyped attribute access — too aggressive for scientific /
              // scripting code.
              reportAttributeAccessIssue: 'none',
              // `x: int = None` style — same pattern as reportArgumentType
              // but at declaration rather than call.
              reportAssignmentType: 'none',
            },
          },
        },
      },
    },
    {
      // Shipped inside `vscode-langservers-extracted` (already vendored under
      // `bundled-lsp/` and mapped in bundledLspLaunch.ts BUNDLED_ENTRY), but
      // previously never registered as a default — so documentSymbol & co on
      // .json files always failed with "No LSP server available".
      name: 'json',
      command: 'vscode-json-language-server',
      args: ['--stdio'],
      bundledPackage: 'vscode-langservers-extracted',
      extensionToLanguage: {
        '.json': 'json',
        '.jsonc': 'jsonc',
      },
      initializationOptions: {
        provideFormatter: true,
      },
    },
    {
      name: 'gopls',
      command: 'gopls',
      args: [],
      extensionToLanguage: {
        '.go': 'go',
      },
    },
    {
      name: 'rust-analyzer',
      command: 'rust-analyzer',
      args: [],
      extensionToLanguage: {
        '.rs': 'rust',
      },
    },
  ]

  for (const def of defaults) {
    if (configs[def.name]) continue

    if (isCommandAvailable(def.command, def.bundledPackage)) {
      configs[def.name] = {
        scope: def.name,
        command: def.command,
        args: def.args,
        extensionToLanguage: def.extensionToLanguage,
        workspaceFolder: workspacePath,
        initializationOptions: def.initializationOptions,
        bundledPackage: def.bundledPackage,
      }
    }
  }
}

/**
 * Check if a command is available on the system PATH, OR if a bundled npm
 * package shipped under `bundled-lsp/node_modules/<bundledPackage>` is
 * present. The bundled check short-circuits the PATH check so end users
 * with no global `typescript-language-server` / `pyright-langserver`
 * install still get the default servers registered.
 */
function isCommandAvailable(command: string, bundledPackage?: string): boolean {
  if (bundledPackage && bundledLspPackagePresent(bundledPackage)) return true
  try {
    const isWin = process.platform === 'win32'
    const checkCmd = isWin ? `where ${command}` : `which ${command}`
    execSync(checkCmd, { stdio: 'pipe', timeout: 3000 })
    return true
  } catch {
    return false
  }
}
