/**
 * Parse `npx` argv for MCP presets (package name + args passed to server).
 * Used when rewriting npx → direct node entry in packaged builds.
 */

export function parseNpxMcpArgs(args: string[]): { pkgName: string; forwardedArgs: string[] } | null {
  let i = 0
  while (i < args.length) {
    const a = args[i]
    if (a === '-y' || a === '--yes') {
      i += 1
      continue
    }
    if (a === '-p' || a === '--package') {
      i += 2
      continue
    }
    if (a.startsWith('-')) {
      i += 1
      continue
    }
    return { pkgName: a, forwardedArgs: args.slice(i + 1) }
  }
  return null
}
