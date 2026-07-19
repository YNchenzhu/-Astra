/**
 * Sandbox module barrel export.
 *
 * Usage:
 *   import { setSandboxConfig, isSandboxEnabled } from './utils/sandbox'
 *   import { runSandboxedCommand, validateSandboxCommand } from './utils/sandbox'
 *   import { removeSandboxViolationTags } from './utils/sandbox'
 */

// Configuration
export { applySandboxFromSettingsRecord } from './applyFromSettings'
export {
  setSandboxConfig,
  getSandboxConfig,
  isSandboxEnabled,
  isPathDeniedForOperation,
  isCommandExcluded,
  addToExcludedCommands,
  recordViolation,
  getViolations,
  clearViolations,
  checkCommandDependency,
  checkSandboxDependencies,
  resetSandboxConfig,
} from './sandbox-config'

export type {
  SandboxConfig,
  SandboxFilesystemConfig,
  SandboxNetworkConfig,
  SandboxRipgrepConfig,
  SandboxViolationEvent,
  SandboxDependencyCheck,
  SandboxAskCallback,
} from './sandbox-config'

// Command execution
export {
  runSandboxedCommand,
  validateSandboxCommand,
  annotateStderrWithSandboxFailures,
  wrapWithSandbox,
  cleanupAfterSandboxCommand,
} from './sandbox-command'

export type { SandboxCommandOptions, SandboxCommandResult } from './sandbox-command'

// UI utilities
export {
  removeSandboxViolationTags,
  extractSandboxAnnotations,
  cleanSandboxAnnotations,
  formatViolationForDisplay,
  formatDependencyCheck,
  getSandboxStatusSummary,
} from './sandbox-ui-utils'
