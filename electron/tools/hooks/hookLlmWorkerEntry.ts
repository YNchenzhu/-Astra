/**
 * Child-process entry for `prompt` / `agent` hooks (upstream §9.2 — isolated OS process).
 * stdin: JSON `{ "kind": "prompt" | "agent", "input": CommandHookInput }`
 * stdout: JSON {@link HookResult}
 */

import { writeSync } from 'node:fs'
import { stdin } from 'node:process'
import type { HookResult } from './types'
import { HOOK_EXIT_BLOCKING } from './types'
import type { CommandHookInput } from './execCommand'
import { execAgentHookModel, execPromptHookModel } from './hookLlmExecution'

type WorkerPayload = {
  kind: 'prompt' | 'agent'
  input: CommandHookInput
}

async function readStdinUtf8(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function writeResult(result: HookResult): void {
  try {
    writeSync(1, JSON.stringify(result))
  } finally {
    const code =
      result.exitCode === HOOK_EXIT_BLOCKING ? 2 : result.exitCode === 0 ? 0 : Math.min(255, result.exitCode)
    process.exit(code)
  }
}

async function main(): Promise<void> {
  let raw: string
  try {
    raw = await readStdinUtf8()
  } catch (e) {
    writeResult({
      exitCode: HOOK_EXIT_BLOCKING,
      stdout: '',
      stderr: `hook worker: failed to read stdin: ${e instanceof Error ? e.message : String(e)}`,
    })
    return
  }

  let payload: WorkerPayload
  try {
    payload = JSON.parse(raw) as WorkerPayload
  } catch (e) {
    writeResult({
      exitCode: HOOK_EXIT_BLOCKING,
      stdout: '',
      stderr: `hook worker: invalid JSON stdin: ${e instanceof Error ? e.message : String(e)}`,
    })
    return
  }

  if (payload.kind !== 'prompt' && payload.kind !== 'agent') {
    writeResult({
      exitCode: HOOK_EXIT_BLOCKING,
      stdout: '',
      stderr: 'hook worker: kind must be prompt or agent',
    })
    return
  }

  if (!payload.input || typeof payload.input !== 'object') {
    writeResult({
      exitCode: HOOK_EXIT_BLOCKING,
      stdout: '',
      stderr: 'hook worker: missing input',
    })
    return
  }

  try {
    const result =
      payload.kind === 'agent'
        ? await execAgentHookModel(payload.input)
        : await execPromptHookModel(payload.input)
    writeResult(result)
  } catch (e) {
    writeResult({
      exitCode: HOOK_EXIT_BLOCKING,
      stdout: '',
      stderr: `hook worker: ${e instanceof Error ? e.message : String(e)}`,
    })
  }
}

void main()
