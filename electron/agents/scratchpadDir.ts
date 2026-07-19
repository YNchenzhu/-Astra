/**
 * Scratchpad shared directory — durable cross-sub-agent knowledge surface.
 *
 * upstream parity: their coordinator user-context advertises a workspace-
 * relative directory the workers can read and write without per-tool
 * permission prompts. The motivation is the parallel-implementer pattern:
 * worker A drops a findings note (`scratch/auth-findings.md`), worker B
 * picks it up. The mailbox / SendMessage path is for transient one-shot
 * messages; the scratchpad is for durable, file-shaped artefacts that
 * outlive a single sub-agent's lifetime.
 *
 * ## What this module does
 *
 *   - Resolves the canonical scratchpad path for a workspace
 *     (`<workspace>/.astra/scratch` by default; override via
 *     `ASTRA_SCRATCHPAD_DIR`).
 *   - Eagerly creates the directory so workers don't fight over a race in
 *     `mkdir -p` on first write.
 *   - Emits a {@link PermissionRulePayload}-shaped rule list that
 *     auto-allows file-targeting tools (Read / Edit / Write / Glob /
 *     Grep) inside the scratchpad subtree only.
 *
 * Wiring policy:
 *   - The `<scratchpad>` user-context block is injected from the existing
 *     {@link getCoordinatorUserContext} (coordinatorMode.ts) when the
 *     resolver returns a path.
 *   - The auto-allow rules ride on the `policy` layer (highest precedence)
 *     of {@link mergeOpenClaudeStylePermissionRules} so they can't be
 *     overridden by a stricter user/session deny later. Without that
 *     ordering, a user with a workspace-wide "ask before Edit" rule would
 *     defeat the scratchpad's no-prompt promise.
 *
 * Disabled state: when {@link getScratchpadDir} returns `undefined` (env
 * resolved to empty / no workspace) the rest of the system falls back to
 * the legacy "no scratchpad" path with no behaviour change.
 */

import fs from 'node:fs'
import path from 'node:path'

import type { PermissionRulePayload } from '../ai/permissionRuleMatch'

/**
 * Workspace-relative default (`.astra/scratch`) — sub-directory of
 * the existing `.astra/` convention used by session / orchestration
 * artefacts. Kept under `.astra/` so a single `.gitignore` rule on
 * that prefix covers everything the project generates at runtime.
 */
export const DEFAULT_SCRATCHPAD_RELATIVE = path.join('.astra', 'scratch')

/** Env override key — when set to a non-empty trimmed path, that wins. */
export const SCRATCHPAD_ENV_KEY = 'ASTRA_SCRATCHPAD_DIR'

/**
 * Resolve the active scratchpad directory.
 *
 *   1. If `ASTRA_SCRATCHPAD_DIR` is set to a non-empty trimmed value,
 *      return that verbatim (absolute or relative — caller's job to make
 *      it absolute if needed). This lets ops override the path without
 *      changing workspace layout.
 *   2. If a workspace path is provided, return
 *      `<workspace>/.astra/scratch`.
 *   3. Otherwise return `undefined` — the feature degrades gracefully.
 */
export function getScratchpadDir(workspacePath: string | null | undefined): string | undefined {
  const envOverride = process.env[SCRATCHPAD_ENV_KEY]?.trim()
  if (envOverride && envOverride.length > 0) return envOverride

  const ws = workspacePath?.trim()
  if (!ws) return undefined
  return path.join(ws, DEFAULT_SCRATCHPAD_RELATIVE)
}

/**
 * Best-effort `mkdir -p` for the resolved scratchpad. Returns the absolute
 * path when the directory exists (or was successfully created), or
 * `undefined` on resolution / IO failure — callers must handle the absent
 * case (the feature is optional).
 *
 * Idempotent and cheap; safe to invoke per-turn.
 */
export function ensureScratchpadDir(
  workspacePath: string | null | undefined,
): string | undefined {
  const dir = getScratchpadDir(workspacePath)
  if (!dir) return undefined
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    // Common failure modes: read-only mount, permission denied. Don't
    // crash the coordinator — just log and degrade.
    console.warn(`[scratchpad] failed to ensure ${dir}:`, err)
    return undefined
  }
  return dir
}

/**
 * Build the auto-allow permission rules for the scratchpad subtree.
 *
 * Why these specific patterns:
 *   - `pathPattern` is gitignore-style; `.astra/scratch/**` matches
 *     every nested file and directory under the scratchpad. The
 *     {@link resolveToolPermissionMode} matcher normalises file paths to
 *     workspace-relative POSIX before testing, so an absolute path
 *     `<workspace>/.astra/scratch/foo.md` round-trips correctly.
 *   - Tool patterns enumerate the file-targeting tools the workers
 *     realistically use; `Bash` is intentionally NOT included so shell
 *     commands still go through their own gate even when they happen to
 *     `cat` a scratchpad file. The user can still allow Bash globally if
 *     they want; the scratchpad just doesn't *implicitly* bypass it.
 *   - Mode is `'allow'`: when the rule matches, the tool runs without a
 *     permission prompt regardless of the global default mode.
 *
 * When `workspacePath` is unset, returns an empty array — the feature is
 * a no-op. Same for `POLE_SCRATCHPAD=0` / `false` env disable.
 */
export function buildScratchpadPermissionRules(
  workspacePath: string | null | undefined,
): PermissionRulePayload[] {
  if (!isScratchpadPermissionAutoAllowEnabled()) return []
  const ws = workspacePath?.trim() ? workspacePath.trim() : undefined
  const dir = getScratchpadDir(ws)
  if (!dir) return []

  // Decide pathPattern shape. The matcher (`pathMatchesPathPattern` in
  // permissionRuleMatch.ts) normalises the file path to workspace-relative
  // POSIX via `path.relative(ws, filePath)` before evaluating the gitignore
  // line. A scratchpad that lives OUTSIDE the workspace would normalise to
  // `../../tmp/scratch/foo.md` style relatives — gitignore semantics can't
  // express those reliably (a literal `/tmp/scratch/**` line is anchored
  // and won't match a `..`-prefixed path; a literal `../../tmp/scratch/**`
  // line is interpreted as a directory literally named `..`). Rather than
  // ship a rule the matcher silently refuses to honour, we degrade: return
  // [] so the user gets the normal per-tool permission prompts. The
  // user-context block from coordinatorMode still advertises the path so
  // workers can use it; they just have to live with prompts.
  const pattern = computeScratchpadPathPattern(ws, dir)
  if (pattern === undefined) {
    console.warn(
      `[scratchpad] auto-allow rules disabled: scratchpad ${dir} is outside workspace ${
        ws ?? '(none)'
      }; the permission matcher cannot express that with gitignore-style patterns. ` +
        `Add explicit workspace-level allow rules if you want no-prompt access.`,
    )
    return []
  }

  // File-targeting tools that workers realistically use against the
  // scratchpad. Keep this list narrow — implicit allow lists are a
  // standing security risk surface.
  const allowedTools = ['Read', 'Edit', 'Write', 'edit_file', 'read_file', 'Glob', 'Grep']

  return allowedTools.map((tool, idx) => ({
    id: `scratchpad-allow-${tool.toLowerCase()}-${idx}`,
    pattern: tool,
    mode: 'allow' as const,
    pathPattern: pattern,
  }))
}

/**
 * Decide the workspace-relative `pathPattern` for the scratchpad.
 *
 * Returns:
 *   - `'**'` when the scratchpad path equals the workspace root.
 *   - `'<rel>/**'` when the scratchpad is *inside* the workspace.
 *   - `undefined` when the scratchpad is outside the workspace (caller
 *     should fall back to "no auto-allow rules") OR when no workspace is
 *     known (we can't anchor a relative gitignore line without one).
 *
 * The matcher always normalises file paths to workspace-relative POSIX,
 * so absolute patterns can never match — see the long-form comment in
 * {@link buildScratchpadPermissionRules}.
 */
function computeScratchpadPathPattern(
  workspacePath: string | undefined,
  scratchDir: string,
): string | undefined {
  if (!workspacePath) return undefined

  const posixScratch = toPosixGitignorePrefix(scratchDir)
  const posixWorkspace = toPosixGitignorePrefix(workspacePath)

  if (posixScratch === posixWorkspace) return '**'
  if (posixScratch.startsWith(`${posixWorkspace}/`)) {
    const rel = posixScratch.slice(posixWorkspace.length).replace(/^\/+/, '')
    return rel.length > 0 ? `${rel}/**` : '**'
  }
  return undefined
}

/**
 * Feature toggle for the **permission auto-allow** side of the scratchpad.
 * The user-context block (which simply informs the model the directory
 * exists) is always rendered when {@link getCoordinatorUserContext} sees a
 * directory; the rules layer is the part that materially changes
 * permission behaviour and therefore lives behind an explicit env opt-in.
 *
 *   - Default: enabled (`POLE_SCRATCHPAD_ALLOW_RULES=1`).
 *   - Disable explicitly with `POLE_SCRATCHPAD_ALLOW_RULES=0` / `false`.
 */
export function isScratchpadPermissionAutoAllowEnabled(): boolean {
  const raw = process.env.POLE_SCRATCHPAD_ALLOW_RULES?.trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
    return false
  }
  return true
}

/**
 * Normalise an OS path (POSIX or Windows) into a gitignore-style prefix
 * suitable for `pathPattern`. The `ignore` package treats `\` as escape;
 * a Windows-style `C:\foo\bar` would otherwise be parsed wrong.
 */
function toPosixGitignorePrefix(p: string): string {
  let s = p.replace(/\\/g, '/')
  // Drop trailing slash if present so `${s}/**` doesn't become `//.**`.
  while (s.endsWith('/')) s = s.slice(0, -1)
  return s
}
