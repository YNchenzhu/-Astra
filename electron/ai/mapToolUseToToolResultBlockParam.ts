/**
 * upstream `mapToolUseToToolResultBlockParam` analogue — single place to build Anthropic-style
 * `tool_result` user blocks from execution outcome (report §4.1 / §4.3 step 7).
 */

export type AnthropicToolResultBlockParam = {
  type: 'tool_result'
  tool_use_id: string
  content: string
  /** Present (true) only on failure blocks — see note in the builder below. */
  is_error?: boolean
}

export function mapToolUseToToolResultBlockParam(args: {
  toolUseId: string
  success: boolean
  output?: string
  error?: string
}): AnthropicToolResultBlockParam {
  const { toolUseId, success, output, error } = args
  if (success) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: output || 'Tool completed successfully.',
    }
  }
  // `is_error: true` is load-bearing, not cosmetic: the deterministic tool
  // ledger (`toolUseSummary.resultStatus`) and the LLM batch recap classify
  // a block as failed via this flag. Without it a failed call was reported
  // back to the model as `-> success` in the same user message — directly
  // contradicting the `Error:` content and training the model to ignore
  // the recovery hints inside it.
  //
  // The directive below is appended AFTER the error body (never before it),
  // for three reasons that the rest of the pipeline depends on:
  //   1. `Error:` MUST stay the first token — failure detection across the
  //      codebase keys on `content.trimStart().startsWith('Error:')`
  //      (toolExec.ts, streamingToolExecutor.ts, toolUseSummary.ts).
  //   2. `extractErrorSummaryFromToolResult` slices everything after
  //      `Error:` into the repeat-detection summary; keeping the real
  //      diagnosis first means distinct failures still produce distinct
  //      summaries.
  //   3. The ledger preview truncates to the first ~320 chars, so the
  //      actual diagnosis survives and only the constant directive tail is
  //      dropped.
  //
  // Why it exists: a bare `Error: <message>` is too easy for the model to
  // skim past — it would assume the edit landed / the action took effect
  // and end the turn. The explicit directive makes the failure semantics
  // unambiguous: the action did NOT happen, read the diagnosis, fix, retry.
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: `Error: ${error || 'Unknown error'}\n\n${TOOL_FAILURE_DIRECTIVE}`,
    is_error: true,
  }
}

/**
 * Appended to every genuine tool-execution failure block. Tool-agnostic on
 * purpose (the symptom is identical whether edit_file, bash, read_file, or an
 * MCP tool failed): the model must treat the call as not-done instead of
 * assuming its intended effect happened.
 */
export const TOOL_FAILURE_DIRECTIVE =
  'This tool call FAILED — it did not complete successfully and its intended effect did NOT take place ' +
  '(no file was written/changed, nothing was saved, the command did not run, etc.). ' +
  'Do NOT assume it worked and do NOT end the task. ' +
  'Read the diagnosis in the error above, fix the cause, then retry the call. ' +
  'If you cannot resolve it, report the problem to the user instead of silently continuing.'
