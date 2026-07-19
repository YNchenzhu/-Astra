/**
 * Thin wrapper around the `rg` (ripgrep) binary.
 *
 * Spawns `rg` as a child process, collects stdout, and handles
 * exit codes: 0 = matches found, 1 = no matches (not an error), 2+ = real error.
 */

import { spawn } from 'node:child_process'
import { resolveRipgrepBin } from './ripgrepBin'

/**
 * Run ripgrep with the given arguments in `cwd`.
 * Returns the combined stdout as a string.
 * Throws on real errors (exit code >= 2) or if rg is not found.
 */
export async function ripGrep(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(resolveRipgrepBin(), args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    if (signal) {
      const onAbort = () => {
        child.kill('SIGTERM')
        reject(signal.reason ?? new Error('Aborted'))
      }
      if (signal.aborted) {
        child.kill('SIGTERM')
        reject(signal.reason ?? new Error('Aborted'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      child.once('close', () => signal.removeEventListener('abort', onAbort))
    }

    child.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new Error(
          'ripgrep (rg) not found. Install it: https://github.com/BurntSushi/ripgrep#installation'
        ))
      } else {
        reject(err)
      }
    })

    child.once('close', (exitCode) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')

      if (exitCode === 0 || exitCode === 1) {
        // 0 = matches found, 1 = no matches
        resolve(stdout)
      } else {
        reject(new Error(`rg exited with code ${exitCode}: ${stderr.trim() || stdout.trim()}`))
      }
    })
  })
}
