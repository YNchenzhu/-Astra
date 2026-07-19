/**
 * Report §5.8: two-stage bash / PowerShell classifier for `auto` permission mode.
 * Stage 1: fast static verdict from {@link validateBashCommand} / {@link validatePowerShellCommand}.
 * Stage 2: heuristic “transcript” pass ({@link transcriptStyleRiskHeuristic}); disable with
 * `ASTRA_BASH_CLASSIFIER_STAGE2=0|false|off|no`.
 */

import type { SecurityVerdict } from './bashCodes'
import { transcriptStyleRiskHeuristic } from './bashClassifierStage2Heuristics'
import { validateBashCommand } from './validateBashCommand'
import { validatePowerShellCommand } from '../powershell/validatePowerShellCommand'

export type BashClassifierShellKind = 'posix' | 'powershell'

// ---------------------------------------------------------------------------
// Common dev command whitelist — auto-approved in `auto` permission mode
// ---------------------------------------------------------------------------
//
// These are high-frequency, low-risk commands that developers run constantly.
// The whitelist checks the COMMAND PREFIX (first 1-2 tokens) against known-safe
// patterns, skipping both classifier stages for a match.
//
// Deliberately excluded (still go through the full classifier):
//   npm publish, npm unpublish, npm deprecate
//   git push, git reset, git clean, git gc, git filter-branch
//   pip uninstall
//   docker rm, docker rmi, docker system prune, docker volume rm

const COMMON_DEV_PREFIXES: ReadonlySet<string> = new Set([
  // npm — common dev workflows
  'npm test', 'npm run', 'npm install', 'npm ci', 'npm outdated',
  'npm ls', 'npm list', 'npm link', 'npm unlink', 'npm start',
  'npm stop', 'npm restart', 'npm exec', 'npm explore',
  'npm fund', 'npm help', 'npm ping', 'npm prefix',
  'npm version', 'npm view', 'npm whoami', 'npm init',
  // yarn
  'yarn test', 'yarn build', 'yarn install', 'yarn lint', 'yarn dev',
  'yarn start', 'yarn add', 'yarn remove', 'yarn upgrade', 'yarn why',
  'yarn workspaces', 'yarn info', 'yarn list', 'yarn outdated', 'yarn dlx',
  // pnpm
  'pnpm test', 'pnpm build', 'pnpm install', 'pnpm lint', 'pnpm dev',
  'pnpm start', 'pnpm add', 'pnpm remove', 'pnpm update', 'pnpm why',
  'pnpm list', 'pnpm outdated', 'pnpm dlx', 'pnpm exec',
  // npx
  'npx',
  // Cargo
  'cargo build', 'cargo test', 'cargo check', 'cargo run',
  'cargo clippy', 'cargo fmt', 'cargo doc', 'cargo bench',
  'cargo clean', 'cargo update', 'cargo add', 'cargo remove',
  'cargo tree', 'cargo audit', 'cargo install',
  // Go
  'go build', 'go test', 'go vet', 'go fmt', 'go run',
  'go mod', 'go generate', 'go install', 'go list', 'go doc', 'go env',
  // Make / CMake
  'make', 'cmake',
  // Python
  'python -m pytest', 'pytest', 'python -m unittest',
  'python -m pip install', 'pip install', 'pip3 install',
  'pip list', 'pip freeze', 'pip show', 'pip check',
  // Common build / lint tools
  'tsc', 'eslint', 'prettier', 'jest', 'vitest', 'mocha',
  // Docker info (read-only)
  'docker ps', 'docker compose ps', 'docker images', 'docker info',
  'docker compose config', 'docker compose logs',
  // Git — only the read-only / low-risk subcommands. `git push`,
  // `git reset`, `git clean`, `git gc`, `git filter-branch` are
  // deliberately NOT here so they fall through to the full classifier.
  'git status', 'git diff', 'git add', 'git commit',
  'git log', 'git branch', 'git stash', 'git show',
  'git fetch', 'git pull', 'git remote', 'git tag',
  // Version / tool checks
  'node --version', 'python --version', 'python3 --version',
  'rustc --version', 'go version', 'cargo --version',
  'npm --version', 'git --version',
])

/** Strip environment variable assignments from the beginning of a command
 *  (e.g. "CI=true NODE_ENV=test npm test" → "npm test") */
function stripEnvPrefix(command: string): string {
  return command.replace(/^(?:\w+=\S+\s+)+/, '').trim()
}

/** Check whether the command starts with a known-safe dev prefix. */
export function matchesDevCommandWhitelist(command: string): boolean {
  const trimmed = stripEnvPrefix(command).trim()
  if (!trimmed) return false

  // Match longest known prefix first, then fall back. Without the 3-token
  // step, entries like `python -m pytest` / `python -m pip install` /
  // `python -m unittest` could never hit (the 2-token `python -m` is not
  // in the set, and the 1-token `python` is also intentionally absent —
  // bare `python script.py` should NOT auto-pass).
  const tokens = trimmed.split(/\s+/)
  if (tokens.length >= 3) {
    const threeToken = `${tokens[0]} ${tokens[1]} ${tokens[2]}`
    if (COMMON_DEV_PREFIXES.has(threeToken)) return true
  }
  if (tokens.length >= 2) {
    const twoToken = `${tokens[0]} ${tokens[1]}`
    if (COMMON_DEV_PREFIXES.has(twoToken)) return true
  }
  if (tokens.length >= 1) {
    if (COMMON_DEV_PREFIXES.has(tokens[0])) return true
  }
  return false
}

export type BashClassifierStage1Result = {
  /**
   * upstream-style: `true` means the command matched risk heuristics and should not be auto-approved
   * under `auto` permission mode (user confirmation required).
   */
  matches: boolean
  verdict: SecurityVerdict
  isReadOnly: boolean
}

export function classifyBashCommandStage1(
  command: string,
  shellKind: BashClassifierShellKind,
  opts?: { cwd?: string },
): BashClassifierStage1Result {
  const trimmed = command.trim()
  if (!trimmed) {
    return { matches: true, verdict: 'deny', isReadOnly: true }
  }

  const analysis =
    shellKind === 'powershell'
      ? validatePowerShellCommand(command, { cwd: opts?.cwd })
      : validateBashCommand(command, { defaultShell: 'bash', cwd: opts?.cwd })

  if (analysis.verdict === 'deny' || analysis.verdict === 'warn') {
    return {
      matches: true,
      verdict: analysis.verdict,
      isReadOnly: analysis.isReadOnly,
    }
  }
  if (analysis.isReadOnly) {
    return { matches: false, verdict: 'allow', isReadOnly: true }
  }
  return { matches: true, verdict: 'allow', isReadOnly: false }
}

/** Heuristic “transcript classifier” pass (report §5.8 Stage 2 等价物). */
export async function classifyBashCommandStage2(
  command: string,
  shellKind: BashClassifierShellKind,
): Promise<{ matches: boolean }> {
  return { matches: transcriptStyleRiskHeuristic(command, shellKind) }
}

export type BashClassifierFullResult = BashClassifierStage1Result & { stage2Ran: boolean }

function isBashClassifierStage2Disabled(): boolean {
  const v = process.env.ASTRA_BASH_CLASSIFIER_STAGE2?.trim().toLowerCase()
  return v === '0' || v === 'false' || v === 'off' || v === 'no'
}

/**
 * Runs stage 1, then heuristic stage 2 unless `ASTRA_BASH_CLASSIFIER_STAGE2=0|false|off|no`.
 * Final `matches` is `stage1.matches || stage2.matches`.
 */
export async function classifyBashCommand(
  command: string,
  shellKind: BashClassifierShellKind,
  opts?: { cwd?: string },
): Promise<BashClassifierFullResult> {
  // Fast path: known-safe dev commands skip both classifier stages
  if (matchesDevCommandWhitelist(command)) {
    return {
      matches: false,
      verdict: 'allow',
      isReadOnly: false,
      stage2Ran: false,
    }
  }

  const s1 = classifyBashCommandStage1(command, shellKind, opts)
  if (isBashClassifierStage2Disabled()) {
    return { ...s1, stage2Ran: false }
  }
  const s2 = await classifyBashCommandStage2(command, shellKind)
  return {
    ...s1,
    matches: s1.matches || s2.matches,
    stage2Ran: true,
  }
}
