/**
 * Registry tool factory + TOOL_DEFAULTS — audit alignment with
 * docs/ai-tool-accuracy-improvement-plan.txt (P0.1 upstream-style defaults).
 *
 * All AI-callable tools under electron/tools and electron/agents should be
 * created via buildRegistryTool() so defaults and validateInput are uniform.
 */

import type { Tool } from './types'
import type { ZodTypeAny } from 'zod'
import { validateNoOp } from './toolValidateCommon'

/** Plan §示例 2 / upstream TOOL_DEFAULTS (adapted to electron Tool shape). */
export const TOOL_DEFAULTS = {
  isEnabled: () => true,
  /** When false, prefer serial execution; omit on tool to fall back to agenticLoop heuristics. */
  isConcurrencySafe: false,
  isReadOnly: false,
  isDestructive: false,
  shouldDefer: false,
  alwaysLoad: false,
} as const

export type BuildRegistryToolConfig = {
  name: string
  /** Static API description. */
  description?: string
  /** Dynamic description (getter), e.g. Agent / Bash. */
  getDescription?: () => string
  inputSchema: Tool['inputSchema']
  execute: Tool['execute']
  isReadOnly: boolean
  isConcurrencySafe?: boolean | ((input: Record<string, unknown>) => boolean)
  isDestructive?: boolean
  shouldDefer?: boolean
  alwaysLoad?: boolean
  searchHint?: string
  aliases?: string[]
  validateInput?: Tool['validateInput']
  checkPermissions?: Tool['checkPermissions']
  /** Appended to API `description` (not shown in UI tooltips unless same source). */
  modelDescriptionExtension?: string
  isEnabled?: () => boolean
  maxResultChars?: number
  /** upstream §1.3 — Zod layer at registry.execute (before validateInput). */
  zInputSchema?: ZodTypeAny
}

/**
 * Merge TOOL_DEFAULTS with explicit fields and install optional description getter.
 */
export function buildRegistryTool(config: BuildRegistryToolConfig): Tool {
  if (!config.getDescription && config.description === undefined) {
    throw new Error(`buildRegistryTool(${config.name}): set description or getDescription`)
  }

  const isEnabled = config.isEnabled ?? TOOL_DEFAULTS.isEnabled
  const validateInput = config.validateInput ?? validateNoOp

  const base: Record<string, unknown> = {
    name: config.name,
    inputSchema: config.inputSchema,
    isReadOnly: config.isReadOnly,
    shouldDefer: config.shouldDefer ?? TOOL_DEFAULTS.shouldDefer,
    alwaysLoad: config.alwaysLoad ?? TOOL_DEFAULTS.alwaysLoad,
    searchHint: config.searchHint,
    aliases: config.aliases,
    validateInput,
    isEnabled,
    execute: config.execute,
  }

  if (config.isConcurrencySafe !== undefined) {
    base.isConcurrencySafe = config.isConcurrencySafe
  }

  if (config.isDestructive !== undefined) {
    base.isDestructive = config.isDestructive
  }

  if (config.maxResultChars !== undefined) {
    base.maxResultChars = config.maxResultChars
  }

  if (config.zInputSchema !== undefined) {
    base.zInputSchema = config.zInputSchema
  }

  if (config.checkPermissions !== undefined) {
    base.checkPermissions = config.checkPermissions
  }

  if (config.modelDescriptionExtension !== undefined) {
    base.modelDescriptionExtension = config.modelDescriptionExtension
  }

  if (config.getDescription) {
    Object.defineProperty(base, 'description', {
      get: config.getDescription,
      enumerable: true,
      configurable: true,
    })
  } else {
    base.description = config.description as string
  }

  return base as unknown as Tool
}
