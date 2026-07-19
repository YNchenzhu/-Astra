/**
 * File Read Tool — renderer-side stub.
 *
 * Mirror of {@link BashTool} rationale: real reads happen in the main
 * process (`electron/ai/toolReadFile.ts`). The renderer instance exists
 * only so the Settings → Tools panel can list / toggle this tool. The
 * previous `fs/promises`-backed implementation was wired through the
 * deleted `src/services/agent/runAgent.ts` shim.
 */
import type { ITool, ToolInputSchema } from '../types/tool'

export class FileReadTool implements ITool {
  name = 'read_file'
  description = 'Read file contents from the filesystem'

  inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to the file',
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (1-based)',
      },
      limit: {
        type: 'number',
        description: 'Number of lines to read (default: 2000)',
      },
    },
    required: ['path'],
  }

  async execute(_input: Record<string, unknown>): Promise<string> {
    throw new Error(
      'FileReadTool.execute() called on the renderer. File reads run in the ' +
        'main process via electron/ai/toolReadFile.ts; the renderer-side ' +
        'tool is metadata-only (Settings → Tools panel).',
    )
  }
}

export function createFileReadTool(): FileReadTool {
  return new FileReadTool()
}
