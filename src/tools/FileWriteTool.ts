/**
 * File Write Tool — renderer-side stub.
 *
 * Mirror of {@link BashTool} / {@link FileReadTool} rationale: real writes
 * happen in the main process (`electron/ai/toolWriteFile.ts`). The
 * renderer instance exists only so the Settings → Tools panel can list /
 * toggle this tool. The previous `fs/promises`-backed implementation was
 * wired through the deleted `src/services/agent/runAgent.ts` shim.
 */
import type { ITool, ToolInputSchema } from '../types/tool'

export class FileWriteTool implements ITool {
  name = 'write_file'
  description = 'Write content to a file'

  inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to the file',
      },
      content: {
        type: 'string',
        description: 'Content to write',
      },
    },
    required: ['path', 'content'],
  }

  async execute(_input: Record<string, unknown>): Promise<string> {
    throw new Error(
      'FileWriteTool.execute() called on the renderer. File writes run in ' +
        'the main process via electron/ai/toolWriteFile.ts; the ' +
        'renderer-side tool is metadata-only (Settings → Tools panel).',
    )
  }
}

export function createFileWriteTool(): FileWriteTool {
  return new FileWriteTool()
}
