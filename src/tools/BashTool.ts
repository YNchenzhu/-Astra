/**
 * Bash Tool — renderer-side stub.
 *
 * The actual shell execution lives in `electron/tools/shellRunner.ts` and is
 * driven by the main-process agentic loop. This renderer-side class exists
 * solely so the Settings → Tools panel can list / toggle the tool from the
 * UI; its `execute()` method is NEVER invoked at runtime — the in-process
 * teammate runs through IPC (`ai:run-teammate` → `runAgenticLoop`) and uses
 * the main-process tool registry.
 *
 * Historically this file imported `child_process` and called `exec()`
 * directly; that path was wired into the now-deleted
 * `src/services/agent/runAgent.ts` shim. Keeping the imports led to
 * type-check failures in the renderer (which deliberately does not depend
 * on `@types/node`), so we strip them here. If a regression ever calls
 * `execute()` on the renderer instance, the throw makes it loud instead of
 * silently spawning a subprocess from the wrong process.
 */
import type { ITool, ToolInputSchema } from '../types/tool'

export class BashTool implements ITool {
  name = 'bash'
  description = 'Execute shell commands'

  inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute',
      },
      cwd: {
        type: 'string',
        description: 'Working directory (optional)',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 30000)',
      },
    },
    required: ['command'],
  }

  async execute(_input: Record<string, unknown>): Promise<string> {
    throw new Error(
      'BashTool.execute() called on the renderer. Bash runs in the main ' +
        'process via electron/tools/shellRunner.ts; the renderer-side tool ' +
        'is metadata-only (Settings → Tools panel). Route through ' +
        '`window.electronAPI.ai.runTeammate` or the main chat instead.',
    )
  }
}

export function createBashTool(): BashTool {
  return new BashTool()
}
