/**
 * Testing-only tool that always pops up a permission dialog when called by the model.
 * Used for end-to-end testing of the permission approval flow.
 *
 * Only enabled in non-production builds.
 */
import { z } from 'zod'
import { buildTool } from './buildTool'

const NAME = 'testing_permission'

const inputSchema = z.strictObject({}).passthrough().optional().or(z.strictObject({}))

export const testingPermissionTool = buildTool({
  name: NAME,
  description:
    'Test tool that always asks for permission before executing. Used for end-to-end testing of the permission approval flow.',
  inputSchema: [],
  zInputSchema: inputSchema,
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultChars: 100_000,
  isEnabled: () => process.env.NODE_ENV !== 'production',
  async call() {
    return {
      success: true,
      output: `${NAME} executed successfully`,
    }
  },
})
