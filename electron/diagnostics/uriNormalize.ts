/**
 * URI / file-path normalization for the diagnostics hub.
 *
 * Goal: one canonical string key per document, across:
 *   - Monaco-sent `file:///…`
 *   - LSP `publishDiagnostics.uri`
 *   - tool-side absolute paths (Windows back-slashes, casing, trailing slash)
 *
 * This MUST stay symmetric with {@link ../../src/services/pathUtils.ts}
 * so the renderer and main process agree on keys.
 */

import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

/** Absolute forward-slash lower-case file path; safe as a Map key. */
export function diagnosticKeyFromUri(uri: string): string {
  return normalizeKey(uriToAbsolutePath(uri))
}

export function uriToAbsolutePath(uri: string): string {
  const trimmed = (uri || '').trim()
  if (!trimmed) return ''
  try {
    if (trimmed.startsWith('file:')) {
      return fileURLToPath(trimmed).replace(/\\/g, '/')
    }
  } catch {
    // fall through
  }
  return trimmed.replace(/\\/g, '/')
}

export function absolutePathToUri(absolutePath: string): string {
  try {
    return pathToFileURL(path.resolve(absolutePath)).href
  } catch {
    return absolutePath
  }
}

/** Canonical key: forward slashes, collapsed, no trailing slash, lower-cased. */
export function normalizeKey(input: string): string {
  if (!input) return ''
  const unix = input.replace(/\\+/g, '/').replace(/\/+/g, '/')
  const trimmed = unix.endsWith('/') && unix.length > 1 ? unix.slice(0, -1) : unix
  return trimmed.toLowerCase()
}

/** Derive a stable display URI (file://…) from any key, absolute path, or URI. */
export function toCanonicalUri(input: string): string {
  const trimmed = (input || '').trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('file:')) return trimmed
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/')) {
    return absolutePathToUri(trimmed)
  }
  return trimmed
}
