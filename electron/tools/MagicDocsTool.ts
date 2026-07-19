import path from 'node:path'
import { z } from 'zod'
import { buildMagicDocs, writeMagicDocs } from '../services/MagicDocsService'
import { validatePathWithinWorkspace } from './workspaceState'
import { buildTool } from './buildTool'
import { validateRequiredStringFields } from './toolValidateCommon'

const magicDocsInputZod = z.object({
  workspacePath: z.string().describe('Project root path'),
  write: z.boolean().optional().describe('Whether to write result to a file (default false)'),
  outputPath: z.string().optional().describe('Relative output path (default docs/MAGIC_DOCS.md)'),
})

export const magicDocsTool = buildTool({
  name: 'MagicDocs',
  description:
    'Generate project documentation from directory structure. Can optionally write docs/MAGIC_DOCS.md.',
  inputSchema: [
    { name: 'workspacePath', type: 'string', description: 'Project root path', required: true },
    { name: 'write', type: 'boolean', description: 'Whether to write result to a file (default false)' },
    { name: 'outputPath', type: 'string', description: 'Relative output path (default docs/MAGIC_DOCS.md). Must be within workspace.' },
  ],
  zInputSchema: magicDocsInputZod,
  isReadOnly: false,
  searchHint: 'generate documentation MAGIC_DOCS project structure',
  validateInput: validateRequiredStringFields('workspacePath'),
  async call({ workspacePath, write, outputPath }) {
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
      return { success: false, error: 'workspacePath is required and must be a non-empty string.' }
    }
    const shouldWrite = write === true
    const outPath = typeof outputPath === 'string' ? outputPath : 'docs/MAGIC_DOCS.md'

    try {
      if (shouldWrite) {
        // Validate output path stays within workspace
        const resolvedOutput = outPath.startsWith('/')
          || /^[a-zA-Z]:[/\\]/.test(outPath)
          ? outPath
          : path.join(workspacePath, outPath)
        const pathCheck = validatePathWithinWorkspace(resolvedOutput)
        if (!pathCheck.safe) {
          return { success: false, error: `MagicDocs: output path blocked — ${pathCheck.reason}` }
        }

        // `writeMagicDocs` is now async (it `await`s the fileHistory
        // pre-write snapshot so the user can revert an unexpected
        // regeneration). The tool's `execute` is already async-friendly
        // — just await the result here.
        const result = await writeMagicDocs(workspacePath, outPath)
        return {
          success: true,
          output: `MagicDocs generated and written to ${result.outputPath}.\n\n${result.markdown.slice(0, 2000)}`,
        }
      }

      const result = buildMagicDocs(workspacePath)
      return { success: true, output: result.markdown }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  },
})
