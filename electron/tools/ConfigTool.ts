/**
 * ConfigTool — get or set application configuration.
 *
 * Provides read/write access to settings like theme, model, provider, etc.
 * Read operations (no value provided) are read-only; write operations modify config.
 *
 * Writes are **in-memory only** (see `configStore`). Disk settings use main-process
 * `settings:set` / `星构Astra-settings.json` with their own persistence — there is no
 * file path here, so the same-path `withFileLock` used by Write/Edit does not apply.
 */

import { buildTool } from './buildTool'
import { configToolInputZod } from './toolInputZod'

// In-memory config store (synced from frontend settings)
const configStore: Record<string, unknown> = {
  providerId: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  maxTokens: 8192,
  outputStyle: 'default',
  language: '',
  enableTools: true,
  permissionMode: 'default',
}

// Config metadata: type, valid options, description
const configMeta: Record<string, {
  type: 'string' | 'number' | 'boolean'
  description: string
  enum?: string[]
}> = {
  providerId: {
    type: 'string',
    description: 'AI provider (anthropic, openai, openai2, gemini, bedrock, vertex, foundry, compatible, dashscope, minimax, zhipu, kimi, deepseek)',
    enum: ['anthropic', 'openai', 'openai2', 'gemini', 'bedrock', 'vertex', 'foundry', 'compatible', 'dashscope', 'minimax', 'zhipu', 'kimi', 'deepseek'],
  },
  model: {
    type: 'string',
    description: 'Model ID to use for generation',
  },
  maxTokens: {
    type: 'number',
    description: 'Maximum output tokens per response',
  },
  outputStyle: {
    type: 'string',
    description: 'Output verbosity style',
    enum: ['default', 'concise', 'explanatory'],
  },
  language: {
    type: 'string',
    description: 'Response language preference',
  },
  enableTools: {
    type: 'boolean',
    description: 'Whether tools are enabled for the AI',
  },
  permissionMode: {
    type: 'string',
    description: 'Permission mode',
    enum: ['default', 'plan', 'bypassPermissions', 'acceptEdits', 'dontAsk', 'auto', 'bubble'],
  },
}

export function setConfigValue(key: string, value: unknown): void {
  configStore[key] = value
}

export function getConfigStore(): Record<string, unknown> {
  return { ...configStore }
}

export const configTool = buildTool({
  name: 'Config',
  zInputSchema: configToolInputZod,
  description:
    'Get or set application configuration. Pass only "setting" to query the current value. ' +
    'Pass both "setting" and "value" to update it. Setting changes are non-persistent unless the user saves.',
  inputSchema: [
    { name: 'setting', type: 'string', description: 'Configuration key name (e.g. "model", "providerId", "outputStyle", "language")', required: true },
    { name: 'value', type: 'string', description: 'New value for the setting. Omit to query current value. Pass a string, number, or boolean as appropriate.' },
  ],
  isReadOnly: false,
  isConcurrencySafe: false,
  async call({ setting, value }) {
    if (!setting) {
      return { success: false, error: 'setting parameter is required' }
    }

    const meta = configMeta[setting]

    // Query mode — no value provided
    if (value === undefined || value === '') {
      const currentVal = configStore[setting]
      if (currentVal === undefined) {
        // List all available settings
        const keys = Object.keys(configMeta).map(k => `  - ${k}: ${configMeta[k].description}${configMeta[k].enum ? ` (options: ${configMeta[k].enum.join(', ')})` : ''}`)
        return {
          success: true,
          output: `Unknown setting "${setting}". Available settings:\n${keys.join('\n')}`,
        }
      }
      return {
        success: true,
        output: `${setting} = ${JSON.stringify(currentVal)}`,
      }
    }

    // Write mode — value provided
    if (!meta) {
      return { success: false, error: `Unknown setting "${setting}". Available: ${Object.keys(configMeta).join(', ')}` }
    }

    // Validate enum
    if (meta.enum && !meta.enum.includes(value)) {
      return { success: false, error: `Invalid value "${value}" for ${setting}. Valid options: ${meta.enum.join(', ')}` }
    }

    // Type coercion
    let coercedValue: unknown = value
    if (meta.type === 'number') {
      const num = Number(value)
      if (isNaN(num)) {
        return { success: false, error: `Value must be a number for ${setting}` }
      }
      coercedValue = num
    } else if (meta.type === 'boolean') {
      if (value === 'true') coercedValue = true
      else if (value === 'false') coercedValue = false
      else {
        return { success: false, error: `Value must be "true" or "false" for ${setting}` }
      }
    }

    const previousValue = configStore[setting]
    configStore[setting] = coercedValue

    return {
      success: true,
      output: `Updated ${setting}: ${JSON.stringify(previousValue)} → ${JSON.stringify(coercedValue)}`,
    }
  },
})
