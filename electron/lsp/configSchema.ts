/**
 * Zod validation for LSP server entries (.lsp.json / lsp-config.json).
 */

import { z } from 'zod'

const extensionToLanguageSchema = z.record(z.string(), z.string()).refine(
  (o) => Object.keys(o).length > 0,
  { message: 'extensionToLanguage must not be empty' },
)

export const lspServerConfigSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    workspaceFolder: z.string().optional(),
    extensionToLanguage: extensionToLanguageSchema,
    initializationOptions: z.record(z.string(), z.unknown()).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    maxRestarts: z.number().int().nonnegative().optional(),
    startupTimeout: z.number().int().positive().optional(),
    transport: z.enum(['stdio', 'socket']).optional(),
    // Audit #16 — let user configs declare a bundled script path under
    // `bundled-lsp/node_modules/<bundledPackage>/<bundledScript>`.
    bundledPackage: z.string().min(1).optional(),
    bundledScript: z.string().min(1).optional(),
    restartOnCrash: z.unknown().optional(),
    shutdownTimeout: z.unknown().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.transport === 'socket') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'transport "socket" is not implemented (stdio only)',
        path: ['transport'],
      })
    }
    // restartOnCrash and shutdownTimeout are accepted as passthrough fields.
    // Rejecting them outright causes spurious parse failures when users copy
    // configs from other tools that include these keys.
    if (val.bundledPackage !== undefined && val.bundledScript === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'bundledPackage requires bundledScript (relative entry path under the package).',
        path: ['bundledScript'],
      })
    }
    if (val.bundledScript !== undefined && val.bundledPackage === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'bundledScript requires bundledPackage.',
        path: ['bundledPackage'],
      })
    }
  })

export type ParsedLspServerConfig = z.infer<typeof lspServerConfigSchema>

export function parseLspServerConfig(
  raw: unknown,
  context: string,
): ParsedLspServerConfig | null {
  const r = lspServerConfigSchema.safeParse(raw)
  if (!r.success) {
    console.warn(`[LSP] Invalid server config ${context}: ${r.error.message}`)
    return null
  }
  return r.data
}
