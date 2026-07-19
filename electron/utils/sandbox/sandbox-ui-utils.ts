/**
 * UI utilities for sandbox violations and status display.
 *
 * These utilities format and clean sandbox-related information
 * for display in the renderer/UI layer.
 *
 * @module sandbox-ui-utils
 */

import type { SandboxViolationEvent, SandboxDependencyCheck } from './sandbox-config'

/**
 * Remove <sandbox_violations> tags from text.
 * Used to clean up error messages for display purposes.
 * Equivalent to upstream's removeSandboxViolationTags().
 */
export function removeSandboxViolationTags(text: string): string {
  return text.replace(/<sandbox_violations>[\s\S]*?<\/sandbox_violations>/g, '')
}

/**
 * Extract sandbox violation information from annotated stderr.
 * Parses [sandbox] annotations into structured data.
 */
export function extractSandboxAnnotations(stderr: string): string[] {
  const annotations: string[] = []
  const lines = stderr.split('\n')

  for (const line of lines) {
    const match = line.match(/\[sandbox\]\s*(.*)/)
    if (match?.[1]) {
      annotations.push(match[1].trim())
    }
  }

  return annotations
}

/**
 * Clean stderr by removing sandbox annotation lines.
 * Useful when showing raw error to the user separately
 * from sandbox-specific policy messages.
 */
export function cleanSandboxAnnotations(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !line.includes('[sandbox]'))
    .join('\n')
    .trim()
}

/**
 * Format a violation event for display in the UI.
 */
export function formatViolationForDisplay(event: SandboxViolationEvent): string {
  const time = new Date(event.timestamp).toLocaleTimeString()
  const type = event.violationType.toUpperCase()
  const status = event.ignored ? '(ignored)' : ''
  return `[${time}] ${type} ${status}\n  Command: ${event.command}\n  Details: ${event.details}`
}

/**
 * Format sandbox dependency check for display.
 */
export function formatDependencyCheck(check: SandboxDependencyCheck): string {
  const parts: string[] = []

  if (check.errors.length > 0) {
    parts.push('Errors:')
    for (const error of check.errors) {
      parts.push(`  ✗ ${error}`)
    }
  }

  if (check.warnings.length > 0) {
    parts.push('Warnings:')
    for (const warning of check.warnings) {
      parts.push(`  ⚠ ${warning}`)
    }
  }

  if (parts.length === 0) {
    return 'All dependencies available.'
  }

  return parts.join('\n')
}

/**
 * Generate a human-readable sandbox status summary.
 */
export function getSandboxStatusSummary(
  enabled: boolean,
  dependencyCheck: SandboxDependencyCheck,
): string {
  if (!enabled) {
    return 'Sandbox is disabled.'
  }

  if (dependencyCheck.errors.length > 0) {
    return `Sandbox enabled but has errors: ${dependencyCheck.errors.join(', ')}`
  }

  if (dependencyCheck.warnings.length > 0) {
    return `Sandbox is active with warnings: ${dependencyCheck.warnings.join(', ')}`
  }

  return 'Sandbox is active and fully operational.'
}
