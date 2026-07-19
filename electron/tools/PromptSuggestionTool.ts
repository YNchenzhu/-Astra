import { z } from 'zod'
import { getPromptSuggestions } from '../services/PromptSuggestionService'
import { buildTool } from './buildTool'
import { validateRequiredStringFields } from './toolValidateCommon'

const promptSuggestionInputZod = z.object({
  userMessage: z.string().describe('Current user request to analyze'),
  workspacePath: z.string().optional().describe('Optional workspace root path'),
  maxResults: z.number().optional().describe('Maximum suggestions (default 5)'),
})

export const promptSuggestionTool = buildTool({
  name: 'PromptSuggestion',
  description:
    'Generate prompt suggestions based on the user request and workspace structure. Useful for turning vague intents into strong actionable prompts.',
  inputSchema: [
    { name: 'userMessage', type: 'string', description: 'Current user request to analyze', required: true },
    { name: 'workspacePath', type: 'string', description: 'Optional workspace root path' },
    { name: 'maxResults', type: 'number', description: 'Maximum suggestions (default 5)' },
  ],
  zInputSchema: promptSuggestionInputZod,
  isReadOnly: true,
  isConcurrencySafe: true,
  searchHint: 'prompt ideas rewrite user intent',
  validateInput: validateRequiredStringFields('userMessage'),
  async call({ userMessage, workspacePath, maxResults }) {
    const suggestions = getPromptSuggestions(userMessage, workspacePath, maxResults)
    const lines = suggestions.map((s, i) => `${i + 1}. ${s.text}（${s.reason}）`)

    return {
      success: true,
      output: `Prompt suggestions:\n${lines.join('\n')}`,
    }
  },
})
