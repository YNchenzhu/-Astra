/**
 * Zod-validated wrapper around `ipcMain.handle`.
 *
 * Electron IPC handlers have the signature
 *   `(event: IpcMainInvokeEvent, ...args: unknown[]) => unknown`
 * with zero runtime guarantee on the `args` shape. Prior to this wrapper the
 * main process trusted whatever the renderer (or anything bound to the preload)
 * happened to post. This collapsed two orthogonal responsibilities into every
 * handler body: type/shape coercion and the actual business logic.
 *
 * `validatedHandle` isolates the shape check. Each handler declares a Zod
 * schema that validates the *full args tuple* (everything the sender passes
 * after the IpcMainInvokeEvent). If the payload fails validation we reject the
 * invoke call with a structured error and never enter the handler body.
 *
 * Domain-level validation (path escaping, permission rules, workspace trust,
 * etc.) is NOT the responsibility of this wrapper — handlers still call
 * `sanitizeAndResolvePath`, `pathSecurityDenyReason`, etc. The wrapper only
 * guarantees that by the time a handler runs, its inputs conform to a typed
 * contract that both sides of the IPC boundary can reason about.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ZodType, z } from 'zod'
import { formatZodValidationError } from '../tools/formatZodValidationError'

/**
 * A Zod schema describing the args tuple passed to an IPC handler. We accept
 * any `ZodType` whose parsed output extends `readonly unknown[]`; in practice
 * this is always `z.tuple([...])`, but we avoid importing Zod's internal
 * `ZodTupleItems` which is not a stable export in Zod 4.
 */
export type IpcArgsSchema = ZodType<readonly unknown[], unknown>

/**
 * Register a typed IPC handler.
 *
 * @example
 *   import { z } from 'zod'
 *   validatedHandle('fs:read-file', z.tuple([z.string().min(1)]),
 *     async (_event, [filePath]) => readFileImpl(filePath))
 */
export function validatedHandle<S extends IpcArgsSchema, R>(
  channel: string,
  argsSchema: S,
  handler: (event: IpcMainInvokeEvent, args: z.infer<S>) => R | Promise<R>,
): void {
  ipcMain.handle(channel, async (event, ...rawArgs: unknown[]) => {
    const parsed = argsSchema.safeParse(rawArgs)
    if (!parsed.success) {
      const detail = formatZodValidationError(parsed.error)
      // Log channel + reason but never the payload itself — some channels
      // carry API keys or conversation content.
      console.warn(`[ipc] ${channel} payload rejected:\n${detail}`)
      throw new Error(`IPC validation failed for ${channel}: ${detail}`)
    }
    return handler(event, parsed.data as z.infer<S>)
  })
}
