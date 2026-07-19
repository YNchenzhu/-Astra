/**
 * upstream report §4.3 step 1 / §4.2 ToolSearch — block tool_use for deferred tools
 * that are not yet visible in the model tool list ({@link shouldExposeDeferredTool}).
 */

import type { Tool } from './types'
import { shouldExposeDeferredTool } from './deferredDiscovery'

export function getDeferredToolExecutionBlockMessage(tool: Tool): string | null {
  if (shouldExposeDeferredTool(tool)) {
    return null
  }
  return (
    `Tool "${tool.name}" is deferred and has not been discovered in this session. ` +
    `Call ToolSearch first (e.g. query \`select:${tool.name}\` or a keyword that matches this tool), then retry.`
  )
}
