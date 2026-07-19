/**
 * Shared validateInput helpers — plan P1.4 (every tool exposes validateInput).
 */

import type { Tool } from './types'

export const validateNoOp: NonNullable<Tool['validateInput']> = async () => ({ valid: true })

export function validateRequiredStringFields(
  ...keys: string[]
): NonNullable<Tool['validateInput']> {
  return async (input) => {
    for (const key of keys) {
      const v = input[key]
      if (v === undefined || v === null) {
        return { valid: false, message: `${key} is required.` }
      }
      if (typeof v === 'string' && !v.trim()) {
        return { valid: false, message: `${key} must be a non-empty string.` }
      }
    }
    return { valid: true }
  }
}

export function validateOptionalString(
  key: string,
  label = key,
): NonNullable<Tool['validateInput']> {
  return async (input) => {
    const v = input[key]
    if (v === undefined || v === null) return { valid: true }
    if (typeof v !== 'string') {
      return { valid: false, message: `${label} must be a string when provided.` }
    }
    return { valid: true }
  }
}
