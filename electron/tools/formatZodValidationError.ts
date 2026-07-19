import type { ZodError } from 'zod'

/**
 * Structured Zod error text for the model (field paths + messages).
 */
export function formatZodValidationError(err: ZodError): string {
  const lines = err.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    return `  - "${path}": ${issue.message}`
  })
  return `Input validation failed:\n${lines.join('\n')}`
}

export function formatDeferredToolSchemaHint(toolName: string, isDeferred?: boolean): string {
  if (!isDeferred) return ''
  return `\nHint: Tool "${toolName}" is loaded on demand. If you need the full parameter schema, you may use ToolSearch (optional); other tools remain directly callable without it.`
}
