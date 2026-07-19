/**
 * Lightweight string-level OS wrap (bwrap / sandbox-exec) when ASRT is unavailable or fails.
 */

import { getSandboxConfig, isCommandExcluded, isSandboxEnabled } from './sandbox-config'

/**
 * Wrap a command string with sandbox enforcement (string-level wrapper).
 * Returns the original command if sandbox is disabled or command is excluded.
 * On Windows, this is a no-op (app-layer enforcement only).
 */
export function wrapWithSandbox(command: string, _binShell?: string): string {
  if (!isSandboxEnabled() || isCommandExcluded(command)) {
    return command
  }

  if (process.platform === 'win32') {
    return command
  }

  if (process.platform === 'linux') {
    try {
      return wrapWithBubblewrap(command)
    } catch {
      return command
    }
  }

  if (process.platform === 'darwin') {
    try {
      return wrapWithSandboxExec(command)
    } catch {
      return command
    }
  }

  return command
}

function wrapWithBubblewrap(command: string): string {
  const config = getSandboxConfig()
  const args = ['bwrap']
  args.push('--bind', '/', '/')
  for (const denyPath of config.filesystem.denyWrite) {
    args.push('--ro-bind', '/dev/null', denyPath)
  }
  if (!config.network.allowLocalBinding) {
    args.push('--unshare-net')
  }
  args.push('--unshare-pid')
  args.push('--proc', '/proc')
  args.push('--dev', '/dev')
  args.push('--die-with-parent')
  args.push('--')
  args.push('/bin/sh', '-c', command)
  return args.join(' ')
}

function wrapWithSandboxExec(command: string): string {
  return `sandbox-exec -p '(version 1) (deny default) (allow process-exec*) (allow network-outbound)' -- /bin/sh -c '${command.replace(/'/g, "'\"'\"'")}'`
}
