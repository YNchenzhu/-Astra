/**
 * Sub-agent system prompt enhancement — aligned with upstream
 * `enhanceSystemPromptWithEnvDetails` + `computeEnvInfo` (restored-src/src/constants/prompts.ts).
 *
 * Typed sub-agents (Explore, Plan, …) receive:
 *   agent base prompt + Notes block + environment block (same wording/order as upstream).
 * Fork children do not use this file; they use the parent's full system prompt byte-for-byte.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readDefaultShellId } from '../settings/settingsAccess'
import type { DefaultShellId } from '../utils/defaultShellSpawn'
import { EDIT_FILE_CONTRACT_BLOCK } from '../constants/prompts/systemDirectives'
import {
  ANTI_ACTION_HALLUCINATION_BLOCK,
  ANTI_ACTION_HALLUCINATION_MARKER,
  HOST_RUNTIME_CONTRACT_BLOCK,
  HOST_RUNTIME_CONTRACT_MARKER_RECALL,
  formatToolUseConventions,
} from '../ai/systemPrompt'

/**
 * Idempotency marker used to detect whether a base prompt already carries the
 * edit_file / multi_edit_file contract (e.g. fork sub-agents inheriting the
 * main chat's system prompt, which is injected by
 * `buildMainSystemPromptLayersFromOrchestration`).
 *
 * Keep this string as a stable substring of {@link EDIT_FILE_CONTRACT_BLOCK}
 * so re-injection is detected regardless of surrounding wording changes —
 * the current contract heading is
 * "# edit_file / multi_edit_file contract (MANDATORY — host will reject bad calls)".
 * We anchor on the "contract (MANDATORY — host will reject bad calls)" tail
 * so both legacy (single-edit only) and current (edit + multi-edit) headings
 * are detected, and the dedup survives future tool-name additions to the
 * heading without code changes here.
 */
const EDIT_FILE_CONTRACT_MARKER = 'contract (MANDATORY — host will reject bad calls)'

/**
 * Notes 与 upstream 对齐思路，但 **Bash 工具**在本产品中由「设置 → 默认终端」决定实际解释器
 *（PowerShell / cmd / bash / zsh），故不写死 “bash”。
 * @see upstream prompts.ts — enhanceSystemPromptWithEnvDetails
 */
const SUBAGENT_NOTES = `Notes:
- The **Bash** tool runs your command in the shell selected under **Settings → 默认终端** (see "Default terminal" and the syntax block in <env> below). cwd may reset between invocations; use absolute paths in commands.
- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.
- **Final message to the parent:** lead with structured sections (headings, fenced checks, VERDICT) — not a prose recap of what you "will" or "did" before those sections. (During the run, short lines before a tool call are fine; the parent is graded on the last text block.)
- **TodoWrite scope.** TodoWrite is a runtime-protocol tool that is **always available** to you even when it is not listed in your tool whitelist. Its list is **scoped to this sub-agent run** — the UI renders it inside your sub-agent block (a mini task panel), **not** on the main conversation's top-level task panel. Use it to show the user your internal plan/progress when the task is non-trivial; the list is cleared when your run ends. Do not expect the parent agent or other sub-agents to read or write your todos.
- For clear communication with the user the assistant MUST avoid using emojis.
- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.
- **No repeated acknowledgment.** Acknowledge a critique / correction / instruction AT MOST ONCE, in your first response text. Do NOT begin subsequent reasoning steps or tool-loop iterations with "You're right", "你说得对", "收到", "我明白了", "好的", "Got it", or any agreement-phrase equivalent. Every later step leads with the concrete next action (e.g. "Searching …", "Reading …", "Running …"), not another apology.`

/** Mirrors upstream `getUnameSR` / `getShellInfoLine` in prompts.ts */
function getUnameSR(): string {
  if (process.platform === 'win32') {
    try {
      const ver = os.version?.() ?? `${os.type()} ${os.release()}`
      return ver
    } catch {
      return `${os.type()} ${os.release()}`
    }
  }
  return `${os.type()} ${os.release()}`
}

/**
 * Rich cheat sheet for the **Bash** tool — must stay aligned with
 * `getToolShellSpawnSpec(readDefaultShellId(), command)` (Settings → 默认终端).
 */
export function getShellSyntaxGuideForSubagent(shellId: DefaultShellId): string {
  const header = `Default terminal (Settings → 默认终端): ${shellId}`
  const win = process.platform === 'win32'

  if (win) {
    switch (shellId) {
      case 'powershell':
        return [
          header,
          'Bash-tool syntax (use ONLY PowerShell — matches your Settings choice):',
          '- List directory: Get-ChildItem; gci; ls/dir are aliases',
          "- Read file: Get-Content -LiteralPath 'C:/abs/path/file.txt'",
          "- Line count: (Get-Content -LiteralPath 'C:/abs/path/file.txt' | Measure-Object -Line).Lines",
          '- Search text in files: Get-ChildItem -Recurse -Filter *.ts | Select-String -Pattern "pattern"',
          '- Env vars: $env:USERNAME, ${env:TEMP}',
          '- Separate statements: ; (PowerShell 5: avoid bash-style && unless you use `; if ($?) { }`)',
          '- Avoid POSIX-only: wc, sed, awk, head, tail as separate binaries — wrong shell',
        ].join('\n')
      case 'cmd':
        return [
          header,
          'Bash-tool syntax (use ONLY cmd.exe — matches your Settings choice):',
          '- List: dir "C:\\abs\\path"',
          '- Print file: type "C:\\abs\\path\\file.txt"',
          '- Find string: findstr /i /n "text" "C:\\abs\\path\\file.txt"',
          '- Env: echo %TEMP%, cd /d %USERPROFILE%',
          '- Chain commands: command1 & command2',
          '- Line-count / complex text: prefer **Read**/**Grep** tools, or switch Settings to PowerShell/bash',
          '- Do not use: $env:, Get-Content, bash $(...), PowerShell pipelines',
          '- If you must use POSIX for one line ($(date), nested quotes), the app may run it via Git Bash when installed — still prefer cmd idioms when possible',
        ].join('\n')
      case 'bash':
        return [
          header,
          'Bash-tool syntax (Git Bash / bash.exe — matches your Settings choice):',
          '- POSIX/bash: ls, cat, wc -l, find, grep, head, tail',
          '- Paths: prefer absolute; Git Bash accepts /c/Users/... or "C:/Users/..."',
          '- Env: $HOME, $TMPDIR, export VAR=value',
          '- Redirection: > >> 2>&1',
          '- Avoid: PowerShell cmdlets, cmd-only like findstr unless you invoke cmd /c explicitly',
        ].join('\n')
      case 'zsh':
        return [
          header,
          'Bash-tool syntax (zsh — matches your Settings choice):',
          '- zsh/POSIX: same family as bash for typical read-only commands',
          '- Use absolute paths; prefer single-quoted paths when they contain spaces',
        ].join('\n')
      default:
        return `${header}\nTreat commands as ${shellId}; match Settings → 默认终端.`
    }
  }

  switch (shellId) {
    case 'powershell':
      return [
        header,
        'Bash-tool syntax (PowerShell / pwsh):',
        '- Get-ChildItem, Get-Content, Measure-Object, Select-String, $env:VAR',
        '- Avoid bash-only wc/sed/awk unless you know the backend is bash',
      ].join('\n')
    case 'zsh':
      return [
        header,
        'Bash-tool syntax (zsh): zsh builtins + POSIX; absolute paths.',
      ].join('\n')
    case 'cmd':
      return [
        header,
        'Bash-tool: cmd choice on Unix maps to a POSIX shell for one-shot exec — avoid cmd.exe-only syntax.',
      ].join('\n')
    case 'bash':
    default:
      return [
        header,
        'Bash-tool syntax (bash): POSIX — ls, cat, wc -l, find, grep; absolute paths; $VAR',
      ].join('\n')
  }
}

function getKnowledgeCutoff(modelId: string): string | null {
  const canonical = modelId.toLowerCase()
  if (canonical.includes('claude-sonnet-4-6')) return 'August 2025'
  if (canonical.includes('claude-opus-4-6')) return 'May 2025'
  if (canonical.includes('claude-opus-4-5')) return 'May 2025'
  if (canonical.includes('claude-haiku-4')) return 'February 2025'
  if (canonical.includes('claude-opus-4') || canonical.includes('claude-sonnet-4')) return 'January 2025'
  return null
}

function isGitRepo(cwd: string): boolean {
  try {
    const git = path.join(cwd, '.git')
    return fs.existsSync(git)
  } catch {
    return false
  }
}

/**
 * Mirrors upstream `computeEnvInfo` (async parts inlined synchronously: git = fs check).
 */
export function computeSubagentEnvInfo(
  modelId: string,
  cwd: string,
  additionalWorkingDirectories?: string[],
  opts?: { compactEnv?: boolean },
): string {
  const isGit = isGitRepo(cwd)
  const unameSR = getUnameSR()

  const modelDescription = `You are powered by the model ${modelId}.`

  const additionalDirsInfo =
    additionalWorkingDirectories && additionalWorkingDirectories.length > 0
      ? `Additional working directories: ${additionalWorkingDirectories.join(', ')}\n`
      : ''

  const cutoff = getKnowledgeCutoff(modelId)
  const knowledgeCutoffMessage = cutoff ? `\n\nAssistant knowledge cutoff is ${cutoff}.` : ''
  const shellId = readDefaultShellId()
  const shellGuide = getShellSyntaxGuideForSubagent(shellId)
  const gitLine =
    opts?.compactEnv === true
      ? ''
      : `Is directory a git repo: ${isGit ? 'Yes' : 'No'}\n`

  return `Here is useful information about the environment you are running in:
<env>
Working directory: ${cwd}
${gitLine}${additionalDirsInfo}Platform: ${process.platform}
${shellGuide}
OS Version: ${unameSR}
</env>
${modelDescription}${knowledgeCutoffMessage}`
}

export interface EnhanceSubagentOptions {
  cwd: string
  additionalWorkingDirectories?: string[]
  /** Explore/Plan `omitClaudeMd`: omit git-repo line from the env block (upstream §7.12). */
  compactEnv?: boolean
  /**
   * Inject {@link EDIT_FILE_CONTRACT_BLOCK} when this sub-agent's tool surface
   * includes Edit/edit_file/FileEdit. Without it, typed sub-agents (Debug,
   * general-purpose, Coordinator-dispatched workers, …) construct `old_string`
   * from memory instead of the latest read and trip "old_string was not found"
   * errors repeatedly. Callers should derive this from `resolveAgentTools`.
   *
   * Idempotent: if `basePrompt` already contains the contract (e.g. fork
   * sub-agents inheriting the main chat prompt), the block is not re-injected.
   */
  includeEditFileContract?: boolean
}

/**
 * Same composition as upstream `enhanceSystemPromptWithEnvDetails` for subagents
 * (without optional DiscoverSkills guidance — not present in this product).
 */
export function enhanceSubagentSystemPrompt(
  basePrompt: string,
  model: string,
  options: EnhanceSubagentOptions,
): string {
  const env = computeSubagentEnvInfo(model, options.cwd, options.additionalWorkingDirectories, {
    compactEnv: options.compactEnv,
  })
  const trimmedBase = basePrompt.trim()
  const parts: string[] = []
  // Stage 5 audit gap fix — host runtime contract must travel with EVERY
  // prompt, including typed sub-agents that build from `agentDef.getSystemPrompt()`
  // and never see the main-chat default. Without this, sub-agents read
  // `<system-reminder>` / `<historical-snapshot>` / `<recall-pointer>`
  // tags as fresh content instead of host-injected runtime context, and
  // miss the recall ladder that prevents them from re-doing summarized
  // work. Idempotent against fork sub-agents (whose `basePrompt` is the
  // parent's full system prompt and already carries both markers) and
  // bundle authors who choose to inline a different phrasing.
  // Audit fix R1-H2 (2026-05) — `HOST_RUNTIME_CONTRACT_MARKER_SYSTEM` was
  // the literal string `'# System'`, which any bundle prompt containing a
  // `# System Architecture` / `# System Overview` heading would match,
  // silently suppressing the entire host runtime contract. The recall
  // section header is uniquely identifying — use it alone.
  const carriesHostContract = trimmedBase.includes(HOST_RUNTIME_CONTRACT_MARKER_RECALL)
  if (!carriesHostContract) {
    parts.push(HOST_RUNTIME_CONTRACT_BLOCK)
  }
  if (!trimmedBase.includes('# Tool-use conventions')) {
    parts.push(formatToolUseConventions(process.platform))
  }
  parts.push(trimmedBase, SUBAGENT_NOTES)
  if (options.includeEditFileContract && !trimmedBase.includes(EDIT_FILE_CONTRACT_MARKER)) {
    parts.push(EDIT_FILE_CONTRACT_BLOCK)
  }
  // Behavioural floor — typed sub-agents (Explore / Plan / Debug /
  // Verification / custom agents from a bundle workpack) build their
  // prompt from their own `agentDef.getSystemPrompt()` and do NOT
  // inherit the main chat's default 星构Astra prompt, so without this
  // injection the anti-action-hallucination guardrail is missing
  // exactly where the user is most likely to delegate task execution.
  // Idempotent against fork sub-agents and bundles that already inline
  // the block.
  if (!trimmedBase.includes(ANTI_ACTION_HALLUCINATION_MARKER)) {
    parts.push(ANTI_ACTION_HALLUCINATION_BLOCK)
  }
  parts.push(env)
  return parts.join('\n\n')
}
