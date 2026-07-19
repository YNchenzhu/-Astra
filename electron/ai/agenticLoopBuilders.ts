/**
 * Agentic loop — assistant-message content-block builders.
 *
 * Isolated so the main loop file doesn't carry Anthropic PTC / thinking
 * block formatting logic inline.
 */

export interface ThinkingBlock {
  thinking: string
  signature?: string
}

export interface ServerToolUseBlock {
  id: string
  name: 'code_execution'
  input: { code: string }
}

export interface CodeExecutionResultBlock {
  toolUseId: string
  stdout: string
  stderr: string
  returnCode: number
}

export interface ToolUseBlock {
  id: string
  name: string
  input: Record<string, unknown>
  thoughtSignature?: string
  /** F1 — OpenAI Responses API 加密 reasoning 负载（回放用，见 claudeToOpenAI2）。 */
  openai2Reasoning?: { id?: string; encrypted_content: string }
  caller?:
    | { type: 'direct' }
    | { type: 'code_execution_20260120'; tool_id: string }
}

/** Build the assistant content for a turn that produced NO tool_use blocks. */
export function buildNoToolUseAssistantContent(options: {
  thinkingBlocks: ThinkingBlock[]
  accumulatedText: string
  serverToolUseBlocks: ServerToolUseBlock[]
  codeExecutionResultBlocks: CodeExecutionResultBlock[]
}): Array<Record<string, unknown>> {
  const { thinkingBlocks, accumulatedText, serverToolUseBlocks, codeExecutionResultBlocks } = options
  const content: Array<Record<string, unknown>> = []
  // Thinking blocks must come first per Anthropic ordering. DeepSeek's
  // Anthropic-compat endpoint enforces echoing them back when thinking
  // mode is active on subsequent requests.
  for (const tb of thinkingBlocks) {
    content.push({
      type: 'thinking',
      thinking: tb.thinking,
      ...(tb.signature ? { signature: tb.signature } : {}),
    })
  }
  if (accumulatedText.trim()) {
    content.push({ type: 'text', text: accumulatedText })
  }
  for (const st of serverToolUseBlocks) {
    content.push({
      type: 'server_tool_use',
      id: st.id,
      name: st.name,
      input: { code: st.input.code },
    })
  }
  for (const cer of codeExecutionResultBlocks) {
    content.push({
      type: 'code_execution_tool_result',
      tool_use_id: cer.toolUseId,
      content: {
        type: 'code_execution_result',
        stdout: cer.stdout,
        stderr: cer.stderr,
        return_code: cer.returnCode,
        content: [],
      },
    })
  }
  return content
}

/** Build the assistant content for a turn that produced tool_use blocks. */
export function buildToolUseAssistantContent(options: {
  thinkingBlocks: ThinkingBlock[]
  accumulatedText: string
  serverToolUseBlocks: ServerToolUseBlock[]
  codeExecutionResultBlocks: CodeExecutionResultBlock[]
  toolUseBlocks: ToolUseBlock[]
}): Array<Record<string, unknown>> {
  const { thinkingBlocks, accumulatedText, serverToolUseBlocks, codeExecutionResultBlocks, toolUseBlocks } = options
  const assistantContent: Array<Record<string, unknown>> = []

  // Thinking blocks come first — Anthropic places them at the head of
  // an assistant message, and DeepSeek's Anthropic-compat endpoint 400s
  // ("content[].thinking in the thinking mode must be passed back to the
  // API") on the NEXT request if a previously-returned thinking block is
  // missing from this assistant turn's content.
  for (const tb of thinkingBlocks) {
    assistantContent.push({
      type: 'thinking',
      thinking: tb.thinking,
      ...(tb.signature ? { signature: tb.signature } : {}),
    })
  }

  // 2026-06 long-run pattern-reinforcement fix: when tool_use blocks are
  // present, do NOT persist the pre-tool text in the assistant message.
  // The text was already streamed to the user via `onTextDelta`, so UX is
  // unchanged. But persisting it creates a self-reinforcing
  // `[thinking, text, tool_use]` pattern in context history that primes the
  // model to produce longer and longer pre-tool declarations over successive
  // iterations, eventually culminating in text-only turns that declare
  // results without calling any tools (the "先声明结果再调工具" regression).
  // Stripping the text from persisted history breaks this cycle. Gated by
  // env var for rollback safety; default ON (strip).
  if (
    accumulatedText.trim() &&
    (toolUseBlocks.length === 0 || process.env.POLE_STRIP_PRE_TOOL_TEXT === '0')
  ) {
    assistantContent.push({
      type: 'text',
      text: accumulatedText,
    })
  }

  // PTC — server_tool_use (the Python that Claude wants to run) is emitted
  // by the model BEFORE the sandbox-originated tool_use calls. Preserve it
  // here so the transcript replays identically.
  for (const st of serverToolUseBlocks) {
    assistantContent.push({
      type: 'server_tool_use',
      id: st.id,
      name: st.name,
      input: { code: st.input.code },
    })
  }

  // PTC — code_execution_tool_result blocks land on the ASSISTANT turn
  // where the sandbox finished executing. They ride inside the same
  // assistant message as any follow-up text / server_tool_use.
  for (const cer of codeExecutionResultBlocks) {
    assistantContent.push({
      type: 'code_execution_tool_result',
      tool_use_id: cer.toolUseId,
      content: {
        type: 'code_execution_result',
        stdout: cer.stdout,
        stderr: cer.stderr,
        return_code: cer.returnCode,
        content: [],
      },
    })
  }

  for (const tu of toolUseBlocks) {
    assistantContent.push({
      type: 'tool_use',
      id: tu.id,
      name: tu.name,
      input: tu.input,
      ...(typeof tu.thoughtSignature === 'string' && tu.thoughtSignature.length > 0
        ? { thoughtSignature: tu.thoughtSignature }
        : {}),
      // F1 — persist the opaque Responses reasoning payload on the block so
      // claudeToOpenAI2 can replay it on the next request of this turn.
      ...(tu.openai2Reasoning ? { openai2Reasoning: tu.openai2Reasoning } : {}),
      // PTC — echo `caller` back verbatim so Anthropic can correlate this
      // tool_use with its originating `server_tool_use`.
      ...(tu.caller ? { caller: tu.caller } : {}),
    })
  }

  return assistantContent
}
