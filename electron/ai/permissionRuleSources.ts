/**
 * Merge permission rules from multiple sources (upstream §5.2 PermissionRuleSource).
 *
 * {@link resolveToolPermissionMode} uses **first match wins**, so higher-precedence
 * layers must appear **earlier** in the merged array.
 *
 * Precedence (highest → lowest), aligned with report §5.2:
 * 1. policySettings — `ASTRA_POLICY_PERMISSION_RULES_JSON`
 * 2. flagSettings — `ASTRA_FLAG_PERMISSION_RULES_JSON`
 * 3. userSettings — `ASTRA_USER_PERMISSION_RULES_PATH` then `ASTRA_USER_PERMISSION_RULES_JSON`
 * 4. projectSettings — `ASTRA_PROJECT_PERMISSION_RULES_PATH` then `ASTRA_PROJECT_PERMISSION_RULES_JSON`
 * 5. localSettings — `ASTRA_LOCAL_PERMISSION_RULES_JSON`
 * 6. cliArg — `ASTRA_CLI_PERMISSION_RULES_JSON`
 * 7. command — `ASTRA_COMMAND_PERMISSION_RULES_JSON`
 * 8. experiment — `ASTRA_EXPERIMENT_PERMISSION_RULES_JSON` (remote flags / Statsig parity slot; before session)
 * 9. session — renderer / IPC (lowest; `permissionRules` from chat send)
 */

import fs from 'node:fs'
import { sanitizePermissionRules, type PermissionRulePayload } from './permissionRuleMatch'
import { buildScratchpadPermissionRules } from '../agents/scratchpadDir'
import { getWorkspacePath } from '../tools/workspaceState'

function parseJsonEnv(name: string): unknown {
  const raw = process.env[name]?.trim()
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    console.warn(`[permissionRuleSources] Invalid JSON in ${name}, ignoring`)
    return undefined
  }
}

function loadRulesFromPathEnv(envVar: string): PermissionRulePayload[] {
  const p = process.env[envVar]?.trim()
  if (!p) return []
  try {
    const raw = fs.readFileSync(p, 'utf-8')
    return sanitizePermissionRules(JSON.parse(raw) as unknown)
  } catch (e) {
    console.warn(`[permissionRuleSources] Failed to read ${envVar}=${p}`, e)
    return []
  }
}

/**
 * Merge session rules with env / file overlays (report §5.2).
 *
 * Legacy env keys remain:
 * - `ASTRA_POLICY_PERMISSION_RULES_JSON`, `ASTRA_FLAG_PERMISSION_RULES_JSON`
 */
export function mergeOpenClaudeStylePermissionRules(
  sessionRules: PermissionRulePayload[] | undefined,
): PermissionRulePayload[] {
  const policy = sanitizePermissionRules(parseJsonEnv('ASTRA_POLICY_PERMISSION_RULES_JSON'))
  const flag = sanitizePermissionRules(parseJsonEnv('ASTRA_FLAG_PERMISSION_RULES_JSON'))

  const userFile = loadRulesFromPathEnv('ASTRA_USER_PERMISSION_RULES_PATH')
  const userJson = sanitizePermissionRules(parseJsonEnv('ASTRA_USER_PERMISSION_RULES_JSON'))

  const projectFile = loadRulesFromPathEnv('ASTRA_PROJECT_PERMISSION_RULES_PATH')
  const projectJson = sanitizePermissionRules(parseJsonEnv('ASTRA_PROJECT_PERMISSION_RULES_JSON'))

  const local = sanitizePermissionRules(parseJsonEnv('ASTRA_LOCAL_PERMISSION_RULES_JSON'))
  const cli = sanitizePermissionRules(parseJsonEnv('ASTRA_CLI_PERMISSION_RULES_JSON'))
  const command = sanitizePermissionRules(parseJsonEnv('ASTRA_COMMAND_PERMISSION_RULES_JSON'))
  const experiment = sanitizePermissionRules(parseJsonEnv('ASTRA_EXPERIMENT_PERMISSION_RULES_JSON'))

  const session = sanitizePermissionRules(sessionRules)

  // Scratchpad auto-allow rides on the **policy** layer (highest
  // precedence) so it cannot be overridden by a stricter user / session
  // deny lower in the chain. The scratchpad's whole premise is "no
  // prompts inside this subtree"; surfacing the prompt back would defeat
  // the cross-sub-agent workflow.
  const scratchpadRules = buildScratchpadPermissionRules(getWorkspacePath() ?? undefined)

  return [
    ...scratchpadRules,
    ...policy,
    ...flag,
    ...userFile,
    ...userJson,
    ...projectFile,
    ...projectJson,
    ...local,
    ...cli,
    ...command,
    ...experiment,
    ...session,
  ]
}
