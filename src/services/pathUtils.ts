/**
 * LSP / Monaco document URI → absolute file path with forward slashes.
 *
 * Handwritten implementation (not `node:url#fileURLToPath`) so the same
 * helper works identically in:
 *   - Electron main (Node)
 *   - Electron renderer (Chromium; `node:url`'s WHATWG URL polyfill throws on
 *     unusual `file://` forms like `file:///g%3A/...` that TS language
 *     servers emit, which used to silently fall through to returning the
 *     raw URI → broke every workspace-path filter downstream)
 *   - Node unit tests (no DOM)
 *
 * Accepts any of:
 *   - `file:///C:/foo/bar.ts`        (VS Code / Monaco, unencoded drive)
 *   - `file:///c%3A/foo/bar.ts`      (tsserver on Windows, percent-encoded `:`)
 *   - `file:///home/user/x.ts`       (POSIX)
 *   - `file:/path/x.ts`              (single-slash variant)
 *   - bare relative / absolute paths (returned with `\\` → `/` normalized)
 */
export function uriToAbsoluteFilePath(uri: string): string {
  const trimmed = uri.trim()
  if (!trimmed.toLowerCase().startsWith('file:')) {
    return trimmed.replace(/\\/g, '/')
  }

  // Strip the `file:` scheme prefix.
  let rest = trimmed.slice(5)

  // Strip the authority marker `//` (so both `file:///C:/...` → `/C:/...`
  // and `file:/path` → `/path` work). We drop *one* occurrence of `//` at
  // most, which also correctly handles `file://host/path` by folding the
  // rare non-empty authority into the path — acceptable for local fs use.
  if (rest.startsWith('//')) rest = rest.slice(2)

  // Percent-decode (`%3A` → `:`, `%20` → ` `, etc.).
  let decoded: string
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    // Malformed percent-escape — fall back to the raw string so we don't
    // lose the path entirely.
    decoded = rest
  }

  // Normalize any stray backslashes (unusual but possible in manually
  // crafted URIs) to forward slashes.
  decoded = decoded.replace(/\\/g, '/')

  // Windows drive-letter URIs come out as `/C:/foo/bar`; drop the leading
  // slash so the result matches what users actually see (`C:/foo/bar`).
  if (/^\/[a-zA-Z]:\//.test(decoded)) {
    return decoded.slice(1)
  }

  return decoded
}

/** Stable map key for diagnostics: lowercase, slashes, no duplicate segments (see normalizePath). */
export function diagnosticMapKey(pathOrUri: string): string {
  return normalizePath(uriToAbsoluteFilePath(pathOrUri))
}

export function normalizePath(path: string): string {
  const withSlash = path.replace(/\\+/g, '/')
  const compact = withSlash.replace(/\/+/g, '/')
  const trimmed = compact.endsWith('/') ? compact.slice(0, -1) : compact
  return trimmed.toLowerCase()
}

export function isAbsolutePath(path: string): boolean {
  const unix = path.replace(/\\+/g, '/')
  return /^[a-zA-Z]:\//.test(unix) || unix.startsWith('/')
}

export function isSamePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b)
}

/** Join workspace root with a relative path using forward slashes in the result (for absolute URL-like paths). */
export function joinWorkspaceRelative(rootPath: string | null, relativePath: string): string {
  if (!rootPath) return relativePath.replace(/\\/g, '/')
  const base = rootPath.replace(/[/\\]+$/, '')
  const rel = relativePath.replace(/^[/\\]+/, '').replace(/\\/g, '/')
  return `${base}/${rel}`.replace(/\\/g, '/')
}

/**
 * Normalize any workspace-relative or absolute path (or `file:` URI) to a single comparable
 * absolute form (forward slashes, no trailing slash). Used so tabs opened from the tree
 * (relative) match AI diff events (absolute resolved paths) and duplicate tabs are not created.
 */
export function toWorkspaceAbsoluteFilePath(pathStr: string, rootPath: string | null): string {
  const raw = uriToAbsoluteFilePath(pathStr.trim())
  if (!raw) return ''
  const unix = raw.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
  if (/^untitled-/i.test(unix)) {
    return unix
  }
  if (isAbsolutePath(unix)) {
    return unix
  }
  return joinWorkspaceRelative(rootPath, unix)
}

export function toRelativePath(filePath: string, rootPath: string | null): string {
  if (!rootPath) return filePath

  const fileUnix = filePath.replace(/\\+/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
  const rootUnix = rootPath.replace(/\\+/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
  const normalizedFile = normalizePath(fileUnix)
  const normalizedRoot = normalizePath(rootUnix)

  if (normalizedFile.startsWith(normalizedRoot + '/')) {
    // Slice from slash-normalized original path to preserve original letter case.
    return fileUnix.slice(rootUnix.length + 1)
  }

  return fileUnix
}
